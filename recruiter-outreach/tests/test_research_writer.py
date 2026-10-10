from datetime import date

from outreach.llm import LLM
from outreach.research import normalize_url, research_target, verify_facts
from outreach.writer import assemble_body, write_followup, write_initial

from conftest import FACT_URL, FakeAnthropic, make_profile, make_settings, make_target


def test_normalize_url():
    assert normalize_url("http://www.Acme.com/blog/x/?utm_source=a&id=3#top") == "https://acme.com/blog/x?id=3"


def test_verify_facts_drops_unretrieved_old_and_undated():
    sources = {normalize_url("https://a.com/1"): {}, normalize_url("https://a.com/2"): {}}
    data = {"facts": [
        {"fact": "ok", "source_url": "https://a.com/1", "published": "2026-08-01"},
        {"fact": "old", "source_url": "https://a.com/2", "published": "2024-01-01"},
        {"fact": "fake", "source_url": "https://a.com/3", "published": "2026-08-01"},
        {"fact": "undated", "source_url": "https://a.com/1", "published": "unknown"},
        {"fact": "month only", "source_url": "https://a.com/1", "published": "2026-07"},
    ]}
    kept, dropped = verify_facts(data, sources, today=date(2026, 10, 10), max_age_days=365)
    assert [f["fact"] for f in kept] == ["ok", "month only"]
    assert {d["fact"] for d in dropped} == {"old", "fake", "undated"}


def test_research_resumes_pause_turn_and_verifies(resume):
    fake = FakeAnthropic()
    llm = LLM(make_settings().llm, client=fake)
    result = research_target(llm, make_target(), make_profile(resume), make_settings(), today=date(2026, 10, 13))
    research_calls = [r for r in fake.requests if r.get("tools")]
    assert len(research_calls) == 2                                   # paused once, then resumed
    assert research_calls[1]["messages"][1]["role"] == "assistant"
    assert {t["type"] for t in research_calls[0]["tools"]} == {"web_search_20260209", "web_fetch_20260209"}
    assert [f["fact"][:12] for f in result.data["facts"]] == ["Acme launche"]
    reasons = {d["source_url"]: d["reason"] for d in result.dropped}
    assert "older than" in reasons["https://news.example.com/acme-2023"]
    assert "not retrieved" in reasons["https://acme.com/made-up"]
    assert [m["id"] for m in result.data["matching_experiences"]] == ["pipeline"]  # unknown id removed
    assert "Partial brief." in result.brief and llm.usage.web_search_requests == 2


def test_writer_retries_until_lint_passes(resume):
    fake = FakeAnthropic()
    llm = LLM(make_settings().llm, client=fake)
    research = {"facts": [{"fact": "f", "why_it_matters": "w", "source_url": FACT_URL, "source_title": "t",
                           "published": "2026-09-02"}]}
    draft = write_initial(llm, profile=make_profile(resume), settings=make_settings(), target=make_target(),
                          research=research, contact={"first_name": "Riley", "title": "University Recruiter"})
    assert draft.clean and draft.attempts == 2
    retry_prompt = fake.requests[-1]["messages"][0]["content"]
    assert "seamless" in retry_prompt and "apostrophe" in retry_prompt
    assert draft.body.startswith("Hi Riley,\n\nMy name is Jordan")
    assert draft.body.rstrip().endswith("(555) 555-0100 | jordan@example.edu")
    assert "Warm Regards,\nJordan Lee" in draft.body


def test_writer_gives_up_after_max_attempts(resume):
    bad = {"subject": "Hi", "paragraphs": ["Hi Riley, I'm great!"], "fact_urls_used": ["https://evil.com"],
           "experience_ids_used": ["nope"]}
    fake = FakeAnthropic(drafts=[bad])
    llm = LLM(make_settings().llm, client=fake)
    draft = write_initial(llm, profile=make_profile(resume), settings=make_settings(), target=make_target(),
                          research={"facts": []}, contact={"first_name": None, "title": "CTO"})
    assert not draft.clean and draft.attempts == 3
    assert {"facts", "experiences", "structure"} <= {v.rule for v in draft.violations}
    assert draft.body.startswith("Hi there,")


def test_near_home_and_followup(resume):
    profile = make_profile(resume)
    body = assemble_body(profile, "Riley", ["One.", "Two."])
    assert body.startswith("Hi Riley,\n\nOne.\n\nTwo.\n\nThank you for reading")
    subject, text = write_followup(profile, target=make_target(), contact={"first_name": "Riley"},
                                   original_subject="Intern role", original_body="Hi Riley,\n\nLine",
                                   original_sent_at="2026-10-13T13:30:00+00:00", sender_name="Jordan Lee",
                                   sender_email="jordan@example.edu")
    assert subject == "Re: Intern role"
    assert "Software Engineering Intern role at Acme Robotics" in text
    assert "> Hi Riley," in text and "'" not in text.split("On ")[0]
