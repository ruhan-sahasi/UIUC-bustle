"""Regression tests for every finding the adversarial review confirmed."""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import httpx
import pytest

import draft
import outbound
from apollo_api import Apollo, ApolloError, ApolloStop
from common import load_targets, read_csv
from conftest import GOOD, FakeClaude
from draft import LLM, assemble, lint_sequence, research
from hunt import hunt, rank
from lint import count_numbers, lint_email, lint_subject
from profile_md import load_profile
from sequences import Sequence, enroll, parse_md, sync_sequence

_RealLLM = draft.LLM
SLUG = "acme-robotics-software-engineering-intern"


@pytest.fixture
def cli(server, workdir, monkeypatch):
    monkeypatch.setattr(outbound, "apollo", server.client)
    monkeypatch.setattr(draft, "LLM", lambda: _RealLLM(FakeClaude()))
    monkeypatch.setenv("APOLLO_MAILBOX_ID", "mb1")
    return server


def link_profile(workdir, url="https://drive.example/cv"):
    path = workdir / "profile.md"
    path.write_text(path.read_text().replace("Resume: attach", f"Resume: {url}"))


def run(*argv):
    return outbound.main(list(argv))


# ---------------------------------------------------------------------------- resume safety

def test_switching_to_link_mode_after_drafting_blocks_launch(cli, workdir, capsys):
    assert run("run") == 0                      # drafted in attach mode: "I have attached my resume"
    link_profile(workdir)                       # then switched, as profile.md suggests
    assert run("lint", "--target", SLUG) == 1
    assert run("launch", "--target", SLUG, "--yes") == 1
    out = capsys.readouterr().out
    assert "needs the line" in out and "says the resume is attached" in out
    assert not cli.campaigns


def test_link_copy_in_attach_mode_is_flagged(workdir):
    link_profile(workdir)
    profile, target = load_profile(), load_targets()[0]
    paras = [p.replace("I have attached my resume, and I", "I") for p in GOOD["email1_paragraphs"]]
    seq = Sequence("Penn CS student, SWE intern role", list(assemble(profile, "swe", paras, GOOD["email2_paragraphs"])), [0, 5])
    assert lint_sequence(seq, profile=profile, target=target) == []
    (workdir / "profile.md").write_text((workdir / "profile.md").read_text().replace("Resume: https://drive.example/cv", "Resume: attach"))
    assert any(v.rule == "resume" for v in lint_sequence(seq, profile=load_profile(), target=target))


def test_yes_never_answers_the_resume_question(cli, workdir, capsys):
    run("run")
    run("launch", "--target", SLUG, "--yes")                # pass 1: paused sequence
    campaign = next(iter(cli.campaigns.values()))
    campaign["active"] = True                               # turned on, resume NOT attached
    assert run("launch", "--target", SLUG, "--yes") == 1
    out = capsys.readouterr().out
    assert "does not report an attachment" in out and "--resume-attached" in out
    assert "enrolled" not in campaign
    assert run("launch", "--target", SLUG, "--yes", "--resume-attached") == 0   # explicit statement goes ahead
    assert len(campaign["enrolled"]) == 2


def test_create_activate_and_enroll_have_the_same_guards(cli, workdir, capsys):
    run("run")
    assert run("create", "--target", SLUG, "--activate") == 1          # attach mode, no resume yet
    assert "must carry your resume" in capsys.readouterr().out and not cli.campaigns
    assert run("create", "--target", SLUG) == 0
    out = capsys.readouterr().out
    assert "Attach" in out and "before anyone is enrolled" in out
    campaign = next(iter(cli.campaigns.values()))
    assert run("enroll", "--target", SLUG, "--yes") == 1                # paused + no resume
    campaign["active"] = True
    assert run("enroll", "--target", SLUG, "--yes") == 1                # still no resume
    path = workdir / "sequences" / f"{SLUG}.md"
    path.write_text(path.read_text().replace("Thank you,\n> Jordan", "Thanks again,\n> Jordan"))
    assert run("enroll", "--target", SLUG, "--yes", "--resume-attached") == 1   # copy edited since push
    assert "changed since it was pushed" in capsys.readouterr().out
    assert "enrolled" not in campaign


def test_link_launch_will_not_resume_a_sequence_paused_by_hand(cli, workdir, capsys):
    link_profile(workdir)
    link_draft = {**GOOD, "email1_paragraphs": [p.replace("I have attached my resume, and I", "I")
                                                for p in GOOD["email1_paragraphs"]]}
    outbound_draft = lambda: _RealLLM(FakeClaude(drafts=[link_draft]))  # noqa: E731
    draft.LLM = outbound_draft
    try:
        run("run", "--per-company", "1")
    finally:
        draft.LLM = _RealLLM
    assert run("launch", "--target", SLUG, "--yes") == 0
    campaign = next(iter(cli.campaigns.values()))
    campaign["active"] = False                       # paused in the Apollo UI
    run("run")                                       # a second recruiter lands in the batch
    assert run("launch", "--target", SLUG, "--yes") == 1
    assert "paused in Apollo" in capsys.readouterr().out and not campaign["active"]


# ---------------------------------------------------------------------------- Apollo robustness

def scripted(responses):
    calls = []

    def handler(request):
        calls.append(request)
        item = responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    return Apollo("k", http=httpx.Client(transport=httpx.MockTransport(handler)), sleep=lambda s: None), calls


def test_429_waits_three_times_then_stops():
    a, calls = scripted([httpx.Response(429)] * 3 + [httpx.Response(200, json={"ok": 1})])
    assert a.call("GET", "auth/health") == {"ok": 1} and len(calls) == 4
    a, calls = scripted([httpx.Response(429)] * 4)
    with pytest.raises(ApolloStop, match="rate limit"):
        a.call("GET", "auth/health")


def test_post_is_not_resent_after_a_read_timeout_but_connect_errors_retry():
    a, calls = scripted([httpx.ReadTimeout("slow")])
    with pytest.raises(ApolloError, match="check Apollo"):
        a.call("POST", "emailer_campaigns/c1/add_contact_ids", {"contact_ids": ["x"]})
    assert len(calls) == 1
    a, calls = scripted([httpx.ConnectError("down"), httpx.Response(200, json={"ok": 1})])
    assert a.call("POST", "contacts", {}) == {"ok": 1} and len(calls) == 2
    a, calls = scripted([httpx.ReadTimeout("slow"), httpx.Response(200, json={"ok": 1})])
    assert a.call("GET", "email_accounts") == {"ok": 1}


def test_rate_limit_during_hunt_stops_without_poisoning_contacts(server, workdir):
    target = load_targets()[0]
    real_match = Apollo.match

    def limited(self, **kw):
        raise ApolloStop("rate limited")

    Apollo.match = limited
    try:
        with pytest.raises(ApolloStop):
            hunt(server.client(), [target], log=lambda s: None)
    finally:
        Apollo.match = real_match
    assert read_csv(workdir / "contacts.csv") == []
    report = hunt(server.client(), [target], log=lambda s: None)   # limit lifted: the best people are still there
    assert report.found[target.slug] == 2


def test_odd_reveal_errors_are_retried_next_run(server, workdir):
    target = load_targets()[0]
    real_match, state = Apollo.match, {"n": 0}

    def flaky(self, **kw):
        state["n"] += 1
        if kw.get("id") == "p1" and state["n"] == 1:
            raise ApolloError("HTTP 500")
        return real_match(self, **kw)

    Apollo.match = flaky
    try:
        hunt(server.client(), [target], per_company=2, log=lambda s: None)
        rows = read_csv(workdir / "contacts.csv")
        assert "riley.chen@acme.com" not in [r["email"] for r in rows]
        hunt(server.client(), [target], per_company=3, log=lambda s: None)
    finally:
        Apollo.match = real_match
    assert "riley.chen@acme.com" in [r["email"] for r in read_csv(workdir / "contacts.csv")]


def test_unknown_has_email_is_not_revealed(workdir):
    target = load_targets()[0]
    people = [{"id": "a", "title": "Recruiter", "has_email": None}, {"id": "b", "title": "Recruiter"},
              {"id": "c", "title": "Recruiter", "has_email": True}]
    assert [p["id"] for _s, p in rank(people, target, "recruiter")] == ["c"]


def test_failed_add_contact_ids_is_recorded_and_never_offered_again(server, workdir):
    a = server.client()
    cid, _, _ = sync_sequence(a, parse_md(EXAMPLE), name="x")
    real = Apollo.add_contacts
    Apollo.add_contacts = lambda self, *args, **kw: (_ for _ in ()).throw(ApolloError("timeout"))
    rows = [{"name": "Ana", "first": "Ana", "last": "G", "email": "ana.gomez@acme.com", "company": "Acme", "title": "TR"}]
    try:
        with pytest.raises(ApolloError):
            enroll(a, slug=SLUG, campaign_id=cid, rows=rows, mailbox_id="mb1", log=lambda s: None)
    finally:
        Apollo.add_contacts = real
    ledger = read_csv(workdir / "enrolled.csv")
    assert [r["status"] for r in ledger] == ["enroll_unknown"]
    again = enroll(a, slug=SLUG, campaign_id=cid, rows=rows, mailbox_id="mb1", log=lambda s: None)
    assert again.enrolled == [] and not any(p.endswith("add_contact_ids") for _m, p, _b in server.calls)


def test_campaign_id_is_saved_before_the_sync_can_fail(cli, workdir):
    run("run")
    real = Apollo.put_sequence
    Apollo.put_sequence = lambda self, *a, **k: (_ for _ in ()).throw(ApolloError("HTTP 500"))
    try:
        assert run("launch", "--target", SLUG, "--yes") == 1
    finally:
        Apollo.put_sequence = real
    assert run("launch", "--target", SLUG, "--yes") == 0
    assert len(cli.campaigns) == 1  # the retry filled the same sequence


def test_slug_is_pinned_so_editing_the_role_keeps_the_target(cli, workdir):
    run("run")
    rows = read_csv(workdir / "targets.csv")
    assert rows[0]["slug"] == SLUG
    text = (workdir / "targets.csv").read_text().replace("Software Engineering Intern,", "Software Engineering Intern Summer 2027,")
    (workdir / "targets.csv").write_text(text)
    assert load_targets()[0].slug == SLUG


# ---------------------------------------------------------------------------- copy rules

def test_subject_gets_the_full_rules():
    def rules(subject):
        return {v.rule for v in lint_subject(subject, company="Acme", banned_topics=["Vestige"], graduation="May 2028")}
    assert "parentheses" in rules("Penn CS student (Summer 2027) for the SWE role")
    assert "graduation" in rules("Penn CS class of 2028, SWE intern")
    assert "banned_topic" in rules("Vestige founder interested in SWE")
    assert "banned_word" in rules("Penn CS student passionate about robots")
    assert "forbidden_char" in rules("Penn CS student - SWE intern")
    assert "merge_field" in rules("Penn CS student interested in {company_name}")
    assert rules("Penn CS student interested in the Software Engineering Intern role") == set()


EXAMPLE = (__import__("conftest").HERE / "sequences" / "example.md").read_text()
FIXED = ["Thank you for reading and I look forward to hearing back!", "Warm Regards,", "Jordan Lee",
         "(555) 555-0100 | jordan@example.edu", "linkedin.com/in/jordan-lee | github.com/jordan-lee"]
KW = dict(where="email 1", first_touch=True, company="Example Corp", fixed_lines=FIXED, graduation="May 2028",
          opening="My name is Jordan and I am a student studying Computer Science at Example University.")


def rules(body, **extra):
    return {v.rule for v in lint_email(body, **{**KW, **extra})}


def test_text_after_the_signature_is_checked():
    base = parse_md(EXAMPLE).emails[0]
    assert rules(base) == set()
    assert {"forbidden_char", "graduation"} <= rules(base + "\nP.S. I’m class of 2028 and graduate soon")


def test_unquoted_and_misheaded_lines_fail_loudly():
    with pytest.raises(ValueError, match="starts with '>'"):
        parse_md(EXAMPLE.replace("> Specifically, at Example", "Specifically, at Example"))
    merged = EXAMPLE.replace("## Email 2 (day 5", "### Email 2 (day 5")
    assert len(parse_md(merged).emails) == 2  # ### still counts as a heading
    with pytest.raises(ValueError, match="looks like an email"):
        parse_md(EXAMPLE.replace("## Email 2 (day 5, reply in the same thread)", "## Follow-up (day 5)"))
    with pytest.raises(ValueError, match="which day"):
        parse_md(EXAMPLE.replace("## Email 2 (day 5, reply in the same thread)", "## Email 2 (reply)"))
    crlf = parse_md(EXAMPLE.replace("\n", "\r\n"))
    assert crlf.days == [0, 5] and "\r" not in crlf.emails[0]


def test_resume_url_does_not_count_as_a_number_or_tilde():
    base = parse_md(EXAMPLE).emails[0]
    url = "https://www.seas.upenn.edu/~jlee/1Bx9resume.pdf"
    body = base.replace("I have attached my resume, and I", "I") .replace(
        "\n\nThank you for reading", f"\n\nMy resume: {url}\n\nThank you for reading")
    assert rules(body, allowed_links=[url]) == set()


def test_stems_bullets_and_filing_names():
    base = parse_md(EXAMPLE).emails[0]
    assert "banned_word" in rules(base.replace("built", "was utilizing"))
    assert "banned_word" in rules(base.replace("small shops", "small shops on the cutting edge"))
    assert "banned_word" not in rules(base.replace("small shops", "small shops with dynamic pricing"))
    assert count_numbers("SEC 10-K and 10-Q filings, 3 models") == 1
    assert "forbidden_char" not in rules(base.replace("Specifically, at", "- Specifically, at"))
    assert "graduation" not in rules(base.replace("recently launched", "in June 2026 launched"))


def test_profile_closing_and_signature_are_checked(workdir, capsys):
    path = workdir / "profile.md"
    path.write_text(path.read_text().replace("Closing: Thank you for reading and I look forward to hearing back!",
                                             "Closing: I’d love to hear back"))
    assert run("check", "--offline") == 1
    assert "curly apostrophe" in capsys.readouterr().out


# ---------------------------------------------------------------------------- Claude research and writing

def test_zero_verified_facts_blocks_launch_until_reviewed(cli, workdir, capsys, monkeypatch):
    claude = FakeClaude()
    real_create = claude.create

    def no_facts(**kw):
        response = real_create(**kw)
        schema = (kw.get("output_config") or {}).get("format", {}).get("schema", {})
        if "facts" in schema.get("properties", {}):
            import json
            data = json.loads(response.content[0].text)
            data["facts"] = []
            response.content[0].text = json.dumps(data)
        return response

    claude.create = no_facts
    claude.beta.messages.create = no_facts
    monkeypatch.setattr(draft, "LLM", lambda: _RealLLM(claude))
    run("run")
    system = next(r["system"][0]["text"] for r in claude.requests if not r.get("tools") and "email1" in str(r))
    assert "no verified facts" in system
    path = workdir / "sequences" / f"{SLUG}.md"
    assert "NO VERIFIED FACT" in path.read_text()
    assert run("launch", "--target", SLUG, "--yes") == 1
    path.write_text("\n".join(l for l in path.read_text().splitlines() if not l.startswith("NO VERIFIED FACT")))
    assert run("lint", "--target", SLUG) == 0


def test_one_target_failing_does_not_stop_the_others(cli, workdir, capsys, monkeypatch):
    (workdir / "targets.csv").write_text((workdir / "targets.csv").read_text().replace("no,Globex", "yes,Globex"))
    claude = FakeClaude()
    real_create = claude.create

    def refuse_acme(**kw):
        if kw.get("tools") and "Acme" in kw["messages"][0]["content"]:
            return SimpleNamespace(stop_reason="refusal", content=[], usage=None)
        return real_create(**kw)

    claude.create = refuse_acme
    claude.beta.messages.create = refuse_acme
    monkeypatch.setattr(draft, "LLM", lambda: _RealLLM(claude))
    assert run("draft") == 1
    out = capsys.readouterr().out
    assert f"{SLUG}: skipped" in out and "Not drafted" in out
    assert (workdir / "sequences" / "globex-pm-intern.md").exists()


def test_paused_turns_accumulate_and_cutoffs_are_flagged(workdir):
    claude = FakeClaude()
    rounds = []

    def scripted(kw, n):
        rounds.append([m for m in kw["messages"]])
        block = SimpleNamespace(type="text", text=f"part {n}. ", citations=None)
        stop = "pause_turn" if n < 3 else "max_tokens"
        return SimpleNamespace(stop_reason=stop, content=[block], usage=None)

    claude.research_override = scripted
    found = research(LLM(claude), load_targets()[0], load_profile(), today=date(2026, 10, 19))
    third = rounds[2][1]["content"]
    assert [b.text for b in third] == ["part 1. ", "part 2. "]   # both earlier rounds resent
    assert found.incomplete.startswith("the research reply was cut off")
    assert claude.requests[0]["max_tokens"] == 64000


def test_cost_counts_cache_tokens():
    llm = LLM(FakeClaude())
    llm.usage.update(input_tokens=1_000_000, cache_creation_input_tokens=1_000_000, cache_read_input_tokens=1_000_000,
                     output_tokens=0, web_search_requests=0)
    assert round(llm.cost(), 2) == 9.20


def test_writer_only_sees_experiences_for_the_track(workdir):
    path = workdir / "profile.md"
    path.write_text(path.read_text() + "\n")
    text = path.read_text().replace("## Never mention", "### Stock pitches (consulting)\nPitched Bloom Energy.\n\n## Never mention")
    path.write_text(text)
    profile = load_profile()
    assert "Bloom Energy" in profile.experiences_for("consulting")
    assert "Bloom Energy" not in profile.experiences_for("swe") and "Example Startup" in profile.experiences_for("swe")
