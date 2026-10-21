from datetime import date

import pytest

from common import ConfigError, confirm, load_targets, read_csv
from conftest import FACT_URL, GOOD, FakeClaude
from draft import LLM, assemble, lint_sequence, normalize_url, research, verify_facts, write
from hunt import cut, hunt, rank
from lint import count_numbers, expand_contractions, lint_email
from profile_md import load_profile
from sequences import Sequence, enroll, parse_md, render_md, sync_sequence

EXAMPLE = (__import__("conftest").HERE / "sequences" / "example.md").read_text()


# ---------------------------------------------------------------------------- targets and profile

def test_targets_csv_parsing(workdir):
    (workdir / "targets.csv").write_text("﻿" + (workdir / "targets.csv").read_text())  # Numbers adds a BOM
    targets = load_targets()
    assert [t.slug for t in targets] == ["acme-robotics-software-engineering-intern"]
    assert targets[0].applied and targets[0].domains == ["acme.com"]
    assert len(load_targets(enabled_only=False)) == 2


def test_targets_csv_errors(workdir):
    (workdir / "targets.csv").write_text("enabled,company,domain,role\nyes,Acme,,Intern\n")
    with pytest.raises(ConfigError, match="domain"):
        load_targets()
    (workdir / "targets.csv").write_text("enabled,company,domain,role\nyes,Acme,acme.com,Intern\nyes,Acme,acme.com,Intern\n")
    with pytest.raises(ConfigError, match="duplicate"):
        load_targets()


def test_profile_example_parses(workdir):
    p = load_profile()
    assert p.first_name == "Jordan" and p.opening.startswith("My name is Jordan")
    assert p.resume("swe") == "attach" and not p.resume_is_link("swe")
    assert p.resume_file("swe").endswith("Jordan_Lee_Resume_swe.pdf")
    assert p.signature_lines[0] == "Jordan Lee" and "Example Startup" in p.experiences
    assert p.banned_topics == ["Exact test counts"] and p.extra_banned_words == ["synergy", "rockstar"]


def test_confirm_requires_typed_yes():
    assert confirm("Send?", input_fn=lambda q: "yes")
    assert not confirm("Send?", input_fn=lambda q: "y")
    assert confirm("Send?", assume_yes=True)


# ---------------------------------------------------------------------------- sequence copy

def test_example_sequence_parses_and_lints_clean(workdir):
    seq = parse_md(EXAMPLE)
    assert seq.subject.startswith("CS student") and len(seq.emails) == 2 and seq.days == [0, 5] and seq.waits == [0, 5]
    assert seq.emails[0].startswith("Hi {first},") and "Research notes" in seq.notes
    target = load_targets()[0]
    target.company = "Example Corp"
    assert lint_sequence(seq, profile=load_profile(), target=target) == []


def test_render_parse_round_trip():
    seq = Sequence(subject="S", emails=["Hi {first},\n\nOne.", "Hi {first},\n\nTwo."], days=[0, 4], notes="Research notes\n\nx")
    back = parse_md(render_md(seq, title="T", header_lines=["h"]))
    assert (back.subject, back.emails, back.days) == (seq.subject, seq.emails, seq.days)


def test_parse_errors():
    with pytest.raises(ValueError, match="Subject line"):
        parse_md("## Email 1 (day 0)\n> hi")
    with pytest.raises(ValueError, match="starts with '>'"):
        parse_md("## Subject line\nS\n## Email 1 (day 0)\n> Hi\nnot quoted")
    with pytest.raises(ValueError, match="no body"):
        parse_md("## Subject line\nS\n## Email 1 (day 0)\n\n")
    with pytest.raises(ValueError, match="numbered"):
        parse_md("## Subject line\nS\n## Email 2 (day 0)\n> hi")


def test_lint_rules():
    base = parse_md(EXAMPLE).emails[0]
    fixed = ["Thank you for reading and I look forward to hearing back!", "Warm Regards,", "Jordan Lee",
             "(555) 555-0100 | jordan@example.edu", "linkedin.com/in/jordan-lee | github.com/jordan-lee"]
    kw = dict(where="email 1", first_touch=True, company="Example Corp", fixed_lines=fixed,
              opening="My name is Jordan and I am a student studying Computer Science at Example University.")
    assert lint_email(base, **kw) == []
    rules = lambda body: {v.rule for v in lint_email(body, **kw)}  # noqa: E731
    assert "forbidden_char" in rules(base.replace("I recently", "I’ve recently"))
    assert "merge_field" in rules(base.replace("{first}", "{first_name}"))
    assert "merge_field" in rules(base.replace("Hi {first},", "Hi {{first_name}},"))
    assert "greeting" in rules(base.replace("Hi {first},", "Hello there,"))
    assert "links" in rules(base.replace("I have attached my resume", "See https://x.com/cv"))
    assert "banned_word" in rules(base.replace("built", "leveraged"))
    assert "graduation" in rules(base.replace("I recently applied", "I graduate in May 2028 and recently applied"))
    assert "parentheses" in rules(base.replace("small shops", "small shops (mostly)"))
    assert lint_email(base.replace("I have attached my resume", "My resume: https://cv.link/me"),
                      **kw, allowed_links=["https://cv.link/me"]) == []
    follow = parse_md(EXAMPLE).emails[1]
    assert lint_email(follow, where="email 2", first_touch=False, company="Example Corp",
                      fixed_lines=["Thank you,", "Jordan"]) == []
    assert "exclamation" in {v.rule for v in lint_email(base.replace("team.", "team!"), **kw)}


def test_text_helpers():
    assert expand_contractions("I'm sure it’s fine. Don't worry.") == "I am sure it is fine. Do not worry."
    assert count_numbers("Summer 2027 at a16z, 23% faster, 1,000 emails") == 2


# ---------------------------------------------------------------------------- hunt and cut

def test_rank_prefers_university_recruiters_and_drops_noise(server, workdir):
    target = load_targets()[0]
    ids = [p["id"] for _s, p in rank(server.people["acme.com"], target, "recruiter")]
    assert ids[0] == "p1" and "p4" not in ids and "p5" not in ids and "p6" not in ids


def test_hunt_reveals_until_two_usable_and_resumes_free(server, workdir):
    target = load_targets()[0]
    report = hunt(server.client(), [target], per_company=2, max_reveals=10, sleep=lambda s: None, log=lambda s: None)
    rows = read_csv(workdir / "contacts.csv")
    assert report.found[target.slug] == 2
    usable = [r["email"] for r in rows if r["email_status"] == "verified"]
    assert usable == ["riley.chen@acme.com", "ana.gomez@acme.com"]
    spent = server.reveals()
    hunt(server.client(), [target], per_company=2, max_reveals=10, sleep=lambda s: None, log=lambda s: None)
    assert server.reveals() == spent  # nothing paid twice


def test_hunt_cap_and_fallback(server, workdir):
    target = load_targets()[0]
    report = hunt(server.client(), [target], per_company=2, max_reveals=1, sleep=lambda s: None, log=lambda s: None)
    assert report.revealed == 1 and any("--max" in n for n in report.notes)
    target.domain, target.slug = "tiny.io", "tiny"
    hunt(server.client(), [target], per_company=1, max_reveals=5, sleep=lambda s: None, log=lambda s: None)
    row = [r for r in read_csv(workdir / "contacts.csv") if r["target"] == "tiny"][0]
    assert row["source"] == "fallback" and row["email"] == "dana@tiny.io"


def test_cut_skips_enrolled(server, workdir):
    target = load_targets()[0]
    hunt(server.client(), [target], sleep=lambda s: None, log=lambda s: None)
    (workdir / "enrolled.csv").write_text("date,target,campaign_id,contact_id,name,email,title,status,detail\n"
                                          "x,y,c,ct,Riley,riley.chen@acme.com,t,enrolled,\n")
    assert cut([target]) == {target.slug: 1}
    batch = read_csv(workdir / f"batch-{target.slug}.csv")
    assert [b["email"] for b in batch] == ["ana.gomez@acme.com"] and batch[0]["company"] == "Acme Robotics"


# ---------------------------------------------------------------------------- Apollo sequences

def test_sync_sequence_full_state_and_update(server):
    a = server.client()
    seq = parse_md(EXAMPLE)
    cid, active, steps = sync_sequence(a, seq, name="Job outreach - Example", max_per_day=10)
    assert not active and [s.wait for s in steps] == [0, 5] and steps[1].subject == ""
    put = next(b for m, p, b in server.calls if m == "PUT")
    assert put["emailer_schedule_id"] == "sch1" and put["max_emails_per_day"] == 10
    t1 = put["emailer_steps"][0]["emailer_touches"][0]
    assert t1["type"] == "new_thread" and t1["status"] == "approved"
    assert "{{first_name}}" in t1["emailer_template"]["body_text"] and "<p>" in t1["emailer_template"]["body_html"]
    assert put["emailer_steps"][1]["emailer_touches"][0]["type"] == "reply_to_thread"
    # Re-sync with one email: the second step goes away, nothing new is created.
    one = Sequence(subject=seq.subject, emails=seq.emails[:1], days=[0])
    cid2, active, steps = sync_sequence(a, one, name="ignored", campaign_id=cid, activate=True)
    assert cid2 == cid and active and len(steps) == 1 and len(server.campaigns) == 1


def test_put_without_steps_is_refused(server):
    from apollo_api import ApolloError

    with pytest.raises(ApolloError, match="full emailer_steps"):
        server.client().put_sequence("c1", {"active": True})


def test_enroll_reuses_contacts_logs_skips_and_never_repeats(server, workdir):
    a = server.client()
    cid, _, _ = sync_sequence(a, parse_md(EXAMPLE), name="x")
    server.contacts["ct0"] = {"id": "ct0", "email": "riley.chen@acme.com"}
    server.job_changed.add("ct0")
    rows = [{"name": "Riley Chen", "first": "Riley", "last": "Chen", "email": "riley.chen@acme.com", "company": "Acme", "title": "UR"},
            {"name": "Ana Gomez", "first": "Ana", "last": "Gomez", "email": "ana.gomez@acme.com", "company": "Acme", "title": "TR"}]
    result = enroll(a, slug="acme", campaign_id=cid, rows=rows, mailbox_id="mb1", log=lambda s: None)
    assert [r["email"] for r in result.enrolled] == ["ana.gomez@acme.com"]
    assert "contacts_with_job_change" in result.skipped[0]["detail"]
    add = next(b for m, p, b in server.calls if p.endswith("add_contact_ids"))
    assert add["send_email_from_email_account_id"] == "mb1" and add["sequence_active_in_other_campaigns"] is False
    again = enroll(a, slug="acme", campaign_id=cid, rows=rows[1:], mailbox_id="mb1", log=lambda s: None)
    assert again.enrolled == [] and sum(1 for _m, p, _b in server.calls if p.endswith("add_contact_ids")) == 1


# ---------------------------------------------------------------------------- Claude research and writing

def test_verify_facts_and_url_normalization():
    assert normalize_url("http://www.Acme.com/x/?utm_source=a&id=3#t") == "https://acme.com/x?id=3"
    sources = {normalize_url("https://a.com/1"): {}}
    kept, dropped = verify_facts([
        {"fact": "ok", "source_url": "https://a.com/1", "published": "2026-08-01"},
        {"fact": "old", "source_url": "https://a.com/1", "published": "2024-01-01"},
        {"fact": "fake", "source_url": "https://a.com/2", "published": "2026-08-01"},
    ], sources, today=date(2026, 10, 19))
    assert [f["fact"] for f in kept] == ["ok"] and {d["fact"] for d in dropped} == {"old", "fake"}


def test_research_and_write(workdir):
    claude = FakeClaude()
    llm = LLM(claude)
    target, profile = load_targets()[0], load_profile()
    found = research(llm, target, profile, today=date(2026, 10, 19))
    assert len([r for r in claude.requests if r.get("tools")]) == 2  # paused once, resumed
    assert [f["source_url"] for f in found.data["facts"]] == [FACT_URL + "?utm_source=x"]
    assert found.dropped[0]["reason"].startswith("source URL") and found.data["eligibility_flags"] == []
    seq, problems = write(llm, target, profile, found, log=lambda s: None)
    assert problems == [] and claude.draft_calls == 2
    assert "spearheaded" in claude.requests[-1]["messages"][0]["content"]  # violations went back to Claude
    assert seq.emails[0].startswith("Hi {first},\n\nMy name is Jordan") and seq.days == [0, 5]
    assert seq.emails[0].rstrip().endswith("github.com/jordan-lee") and seq.emails[1].endswith("Thank you,\nJordan")


def test_resume_link_mode_adds_the_link(workdir):
    (workdir / "profile.md").write_text((workdir / "profile.md").read_text().replace(
        "Resume: attach", "Resume: https://drive.example/cv"))
    profile, target = load_profile(), load_targets()[0]
    paras = [p.replace("I have attached my resume, and I", "I") for p in GOOD["email1_paragraphs"]]
    body1, body2 = assemble(profile, "swe", paras, GOOD["email2_paragraphs"])
    assert "My resume: https://drive.example/cv" in body1
    assert lint_sequence(Sequence("Penn CS student, SWE intern role", [body1, body2], [0, 5]),
                         profile=profile, target=target) == []


def test_off_domain_emails_are_explained_and_alt_domains_recover_them(server, workdir):
    server.reveal["p3"]["email"] = "ana.gomez@acmewireless.com"
    target = load_targets()[0]
    lines = []
    report = hunt(server.client(), [target], per_company=2, max_reveals=3, sleep=lambda s: None, log=lines.append)
    assert any("acmewireless.com is not in this target's domains" in line for line in lines)
    assert any("alt_domains" in n and "acmewireless.com" in n for n in report.notes)
    target.alt_domains = ["acmewireless.com"]
    assert cut([target]) == {target.slug: 2}
