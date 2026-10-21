"""The whole pipeline through the real CLI: run -> launch -> stats, in both resume modes."""
from __future__ import annotations

import pytest

import draft
import outbound
from common import read_csv
from conftest import FakeClaude


_RealLLM = draft.LLM


@pytest.fixture
def cli(server, workdir, monkeypatch):
    monkeypatch.setattr(outbound, "apollo", server.client)
    monkeypatch.setattr(draft, "LLM", lambda: _RealLLM(FakeClaude()))
    monkeypatch.setenv("APOLLO_MAILBOX_ID", "mb1")
    return server


def run(*argv):
    return outbound.main(list(argv))


def slug():
    return "acme-robotics-software-engineering-intern"


def test_link_mode_end_to_end(cli, workdir, capsys, monkeypatch):
    (workdir / "profile.md").write_text((workdir / "profile.md").read_text().replace(
        "Resume: attach", "Resume: https://drive.example/cv"))
    from conftest import GOOD

    link_draft = {**GOOD, "email1_paragraphs": [p.replace("I have attached my resume, and I", "I")
                                                for p in GOOD["email1_paragraphs"]]}
    monkeypatch.setattr(draft, "LLM", lambda: _RealLLM(FakeClaude(drafts=[link_draft])))
    assert run("run") == 0
    out = capsys.readouterr().out
    assert "2 recruiter(s) ready, copy clean" in out
    assert (workdir / "sequences" / f"{slug()}.md").exists()
    assert len(read_csv(workdir / f"batch-{slug()}.csv")) == 2

    assert run("launch", "--target", slug(), "--yes") == 0
    campaign = next(iter(cli.campaigns.values()))
    assert campaign["active"] and len(campaign["enrolled"]) == 2
    assert [r["status"] for r in read_csv(workdir / "enrolled.csv")] == ["enrolled", "enrolled"]
    body = cli.templates[cli.steps[campaign["id"]][0]["template_id"]]["body_text"]
    assert "My resume: https://drive.example/cv" in body and "{{first_name}}" in body

    # Re-running launch has nobody new to email and sends nothing.
    assert run("launch", "--target", slug(), "--yes") == 1
    assert len(campaign["enrolled"]) == 2
    assert run("stats") == 0
    assert "active, 2 enrolled" in capsys.readouterr().out


def test_attach_mode_two_pass_launch(cli, workdir, capsys, monkeypatch):
    assert run("run") == 0
    capsys.readouterr()

    # Pass 1: creates the sequence paused and explains the two clicks.
    assert run("launch", "--target", slug(), "--yes") == 0
    out = capsys.readouterr().out
    assert "Created the sequence in Apollo, paused" in out and "Jordan_Lee_Resume_swe.pdf" in out
    campaign = next(iter(cli.campaigns.values()))
    assert not campaign["active"] and "enrolled" not in campaign

    # Still paused: refuses.
    assert run("launch", "--target", slug(), "--yes") == 1
    assert "sequence is paused" in capsys.readouterr().out

    # Edited copy after the push: refuses until it is pushed again.
    path = workdir / "sequences" / f"{slug()}.md"
    original = path.read_text()
    path.write_text(original.replace("Thank you,\n> Jordan", "Thanks again,\n> Jordan"))
    campaign["active"] = True
    assert run("launch", "--target", slug(), "--yes") == 1
    assert "changed since it was pushed" in capsys.readouterr().out
    path.write_text(original)

    # Resume attached and sequence on: no attachment reported -> asks; typed "no" stops everything.
    monkeypatch.setattr(outbound, "confirm", lambda q, assume_yes=False: False)
    assert run("launch", "--target", slug()) == 1
    assert "enrolled" not in campaign

    # Apollo reports the attachment: launch enrolls after the final confirm, without re-pushing copy.
    cli.templates[cli.steps[campaign["id"]][0]["template_id"]]["attachment_ids"] = ["file1"]
    puts_before = sum(1 for m, _p, _b in cli.calls if m == "PUT")
    monkeypatch.setattr(outbound, "confirm", lambda q, assume_yes=False: True)
    assert run("launch", "--target", slug()) == 0
    assert len(campaign["enrolled"]) == 2
    assert sum(1 for m, _p, _b in cli.calls if m == "PUT") == puts_before  # the attachment was never at risk


def test_launch_blocks_on_style_issues_and_missing_mailbox(cli, workdir, capsys, monkeypatch):
    run("run")
    path = workdir / "sequences" / f"{slug()}.md"
    path.write_text(path.read_text().replace("I recently applied", "I’ve recently applied"))
    assert run("lint", "--target", slug()) == 1
    assert run("launch", "--target", slug(), "--yes") == 1
    assert "has issues" in capsys.readouterr().out
    path.write_text(path.read_text().replace("I’ve recently applied", "I recently applied"))
    monkeypatch.setenv("APOLLO_MAILBOX_ID", "nope")
    assert run("launch", "--target", slug(), "--yes") == 1
    assert "mailboxes --save" in capsys.readouterr().out
    assert not cli.campaigns


def test_check_and_mailboxes_save(cli, workdir, capsys, monkeypatch):
    monkeypatch.delenv("APOLLO_MAILBOX_ID")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    assert run("check", "--offline") == 1
    out = capsys.readouterr().out
    assert "[ok] Apollo key" in out and "pick one: python3 outbound.py mailboxes --save" in out
    assert run("mailboxes", "--save", "mb1") == 0
    assert "APOLLO_MAILBOX_ID=mb1" in (workdir / ".env").read_text()
    assert run("mailboxes", "--save", "bogus") == 1


def test_follow_up_off_drafts_and_pushes_one_email(cli, workdir):
    profile = workdir / "profile.md"
    profile.write_text(profile.read_text().replace("Follow-up: yes", "Follow-up: no"))
    assert run("run") == 0
    text = (workdir / "sequences" / f"{slug()}.md").read_text()
    assert "## Email 1" in text and "## Email 2" not in text
    assert run("create", "--target", slug()) == 0
    campaign = next(iter(cli.campaigns.values()))
    assert len(cli.steps[campaign["id"]]) == 1


def test_deleting_email_2_from_the_copy_removes_the_step_in_apollo(cli, workdir):
    assert run("run") == 0
    assert run("create", "--target", slug()) == 0
    campaign = next(iter(cli.campaigns.values()))
    assert len(cli.steps[campaign["id"]]) == 2
    path = workdir / "sequences" / f"{slug()}.md"
    text = path.read_text()
    path.write_text(text[:text.index("## Email 2")] + text[text.index("## Research notes"):])
    assert run("create", "--target", slug()) == 0
    assert len(cli.steps[campaign["id"]]) == 1
