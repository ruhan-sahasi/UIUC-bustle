from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from outreach.apollo import ApolloClient  # noqa: E402
from outreach.config import AppConfig, Profile, Settings, StyleRules, Target  # noqa: E402
from outreach.db import DB  # noqa: E402

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
TODAY_UTC = datetime(2026, 10, 13, 13, 30, tzinfo=timezone.utc)  # Tue 09:30 in New York


@pytest.fixture
def resume(tmp_path: Path) -> Path:
    path = tmp_path / "resume.pdf"
    path.write_bytes(PDF)
    return path


def make_profile(resume: Path) -> Profile:
    return Profile(
        name="Jordan Lee",
        first_name="Jordan",
        school="Example University",
        opening_sentence="My name is Jordan and I am a student studying Computer Science at Example University.",
        graduation="May 2028",
        signature_lines=["(555) 555-0100 | jordan@example.edu"],
        home_cities=["San Francisco"],
        resumes={"swe": str(resume), "pm": str(resume), "consulting": str(resume)},
        resume_attachment_name="Jordan_Lee_Resume.pdf",
        experiences=[
            {"id": "pipeline", "summary": "Built a weekly Python pipeline over 1,000 tickets.",
             "approved_wording": ["I built a weekly Python pipeline that turned tickets into product fixes"]},
            {"id": "evals", "summary": "Built an evaluation pipeline for LLMs.", "tracks": ["swe"]},
        ],
        style=StyleRules(banned_topics=["UFC", "Vestige"], min_words=60, max_words=200),
    )


def make_settings(**overrides) -> Settings:
    data = {
        "mode": "review",
        "delivery": "smtp",
        "sender": {"name": "Jordan Lee", "email": "jordan@example.edu", "provider": "custom",
                   "smtp_host": "127.0.0.1", "smtp_port": 2525, "smtp_security": "none",
                   "password_env": "OUTREACH_TEST_PASSWORD_UNSET"},
        "limits": {"min_gap_seconds": 0, "max_gap_seconds": 0},
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(data.get(key), dict):
            data[key] = {**data[key], **value}
        else:
            data[key] = value
    return Settings.model_validate(data)


def make_target(**overrides) -> Target:
    data = {"company": "Acme Robotics", "domain": "acme.com", "role": "Software Engineering Intern",
            "track": "swe", "location": "San Francisco, CA", "applied": True, "priority": 1}
    data.update(overrides)
    return Target.model_validate(data)


@pytest.fixture
def app(tmp_path: Path, resume: Path) -> AppConfig:
    return AppConfig(settings=make_settings(), profile=make_profile(resume), targets=[make_target()],
                     config_dir=tmp_path / "config", data_dir=tmp_path / "data")


@pytest.fixture
def db() -> DB:
    return DB(":memory:")


# ---------------------------------------------------------------------------- fake Apollo

SEARCH_PEOPLE = [
    {"id": "p1", "first_name": "Riley", "last_name_obfuscated": "Ch***n", "title": "University Recruiter", "has_email": True},
    {"id": "p2", "first_name": "Sam", "last_name_obfuscated": "Le***e", "title": "Technical Recruiter", "has_email": True},
    {"id": "p3", "first_name": "Ana", "last_name_obfuscated": "Go***z", "title": "Senior Technical Recruiter", "has_email": True},
    {"id": "p4", "first_name": "Max", "title": "Executive Recruiter", "has_email": True},
    {"id": "p5", "first_name": "Lee", "title": "Software Engineer", "has_email": True},
    {"id": "p6", "first_name": "Kim", "title": "Campus Recruiter", "has_email": False},
    {"id": "p7", "first_name": "Pat", "title": "Recruiting Coordinator", "has_email": True},
]

MATCHES = {
    "p1": {"id": "p1", "first_name": "Riley", "last_name": "Chen", "title": "University Recruiter",
           "email": "riley.chen@acme.com", "email_status": "verified", "city": "San Francisco"},
    "p2": {"id": "p2", "first_name": "Sam", "last_name": "Lee", "title": "Technical Recruiter",
           "email": "sam@acme.com", "email_status": "guessed"},
    "p3": {"id": "p3", "first_name": "Ana", "last_name": "Gomez", "title": "Senior Technical Recruiter",
           "email": "ana.gomez@acme.com", "email_status": "verified"},
    "p7": {"id": "p7", "first_name": "Pat", "last_name": "Kay", "title": "Recruiting Coordinator",
           "email": "pat@gmail.com", "email_status": "verified"},
}


class FakeApollo:
    def __init__(self, people=None, matches=None, fail_first_with_429: bool = False):
        self.people = SEARCH_PEOPLE if people is None else people
        self.matches = MATCHES if matches is None else matches
        self.calls: list[httpx.Request] = []
        self.fail_first = fail_first_with_429

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.fail_first:
            self.fail_first = False
            return httpx.Response(429, headers={"retry-after": "1"}, json={"error": "rate limited"})
        assert request.headers["X-Api-Key"] == "test-key"
        path = request.url.path
        if path.endswith("/mixed_people/api_search"):
            titles = request.url.params.get_list("person_titles[]")
            people = [p for p in self.people if any(t.split()[-1].lower() in p["title"].lower() for t in titles)]
            return httpx.Response(200, json={"people": people, "total_entries": len(people)})
        if path.endswith("/people/bulk_match"):
            details = json.loads(request.content)["details"]
            matches = [self.matches.get(d["id"]) for d in details]
            return httpx.Response(200, json={"matches": matches, "credits_consumed": sum(1 for m in matches if m)})
        if path.endswith("/auth/health"):
            return httpx.Response(200, json={"healthy": True, "is_logged_in": True})
        return httpx.Response(404, json={"error": "not found"})

    def client(self, **kwargs) -> ApolloClient:
        return ApolloClient("test-key", http=httpx.Client(transport=httpx.MockTransport(self.handler)),
                            sleep=lambda s: None, **kwargs)


# ---------------------------------------------------------------------------- fake Claude

FACT_URL = "https://acme.com/blog/warehouse-robots"
OLD_URL = "https://news.example.com/acme-2023"
INVENTED_URL = "https://acme.com/made-up"

GOOD_PARAGRAPHS = [
    "My name is Jordan and I am a student studying Computer Science at Example University. I recently applied "
    "to the Software Engineering Intern role at Acme Robotics, and I wanted to introduce myself to the team.",
    "The reason I would love to join Acme Robotics is that robots that pick and pack orders could make same day "
    "shipping normal for small shops. Acme recently launched a picking robot that learns new items from a few "
    "photos, which means a warehouse can add products without reprogramming anything.",
    "Specifically, I built a weekly Python pipeline that turned tickets into product fixes, and I only kept "
    "patterns that held up across several weeks before suggesting a change.",
    "I have attached my resume, and I would be grateful to be considered or pointed to the right person on the team.",
]


def _usage(**kw):
    base = dict(input_tokens=1000, output_tokens=200, cache_read_input_tokens=0, cache_creation_input_tokens=0,
                server_tool_use=SimpleNamespace(web_search_requests=kw.pop("searches", 0), web_fetch_requests=0))
    base.update(kw)
    return SimpleNamespace(**base)


def _text(text, citations=None):
    return SimpleNamespace(type="text", text=text, citations=citations)


class FakeMessages:
    def __init__(self, parent: "FakeAnthropic"):
        self.parent = parent

    def create(self, **kwargs):
        self.parent.requests.append(kwargs)
        assert kwargs["model"] == "claude-opus-5-5"
        assert kwargs.get("fallbacks") == "default"
        if kwargs.get("tools"):
            return self.parent.research_response(kwargs)
        schema = kwargs["output_config"]["format"]["schema"]
        if "facts" in schema["properties"]:
            return SimpleNamespace(content=[_text(json.dumps(self.parent.extraction))], stop_reason="end_turn",
                                   usage=_usage())
        self.parent.draft_calls += 1
        draft = self.parent.drafts[min(self.parent.draft_calls - 1, len(self.parent.drafts) - 1)]
        return SimpleNamespace(content=[_text(json.dumps(draft))], stop_reason="end_turn", usage=_usage())


class FakeAnthropic:
    """Stands in for anthropic.Anthropic(): research with a pause_turn, extraction, then drafts."""

    def __init__(self, *, drafts=None, pause_first: bool = True):
        self.requests: list[dict] = []
        self.draft_calls = 0
        self.research_rounds = 0
        self.pause_first = pause_first
        self.beta = SimpleNamespace(messages=FakeMessages(self))
        self.extraction = {
            "company_summary": "Acme builds warehouse robots.",
            "team_focus": "Robot perception.",
            "facts": [
                {"fact": "Acme launched a picking robot that learns new items from photos.",
                 "why_it_matters": "Warehouses add products without reprogramming.",
                 "source_url": FACT_URL + "?utm_source=x", "source_title": "Acme blog", "published": "2026-09-02"},
                {"fact": "Acme raised a seed round.", "why_it_matters": "Old news.", "source_url": OLD_URL,
                 "source_title": "News", "published": "2023-01-10"},
                {"fact": "Invented.", "why_it_matters": "Never retrieved.", "source_url": INVENTED_URL,
                 "source_title": "?", "published": "2026-09-01"},
            ],
            "posting_keywords": ["Python", "ROS"],
            "eligibility_flags": ["None found"],
            "matching_experiences": [{"id": "pipeline", "reason": "data pipelines"}, {"id": "ghost", "reason": "x"}],
            "office_city": "San Francisco",
        }
        bad = {"subject": "Penn student, Acme's internship", "paragraphs": [
            GOOD_PARAGRAPHS[0], GOOD_PARAGRAPHS[1].replace("normal", "seamless"), GOOD_PARAGRAPHS[2], GOOD_PARAGRAPHS[3]],
            "fact_urls_used": [FACT_URL], "experience_ids_used": ["pipeline"]}
        good = {"subject": "CS student interested in the Software Engineering Intern role",
                "paragraphs": GOOD_PARAGRAPHS, "fact_urls_used": [FACT_URL + "/"], "experience_ids_used": ["pipeline"]}
        self.drafts = drafts or [bad, good]

    def research_response(self, kwargs):
        self.research_rounds += 1
        if self.pause_first and self.research_rounds == 1:
            content = [
                SimpleNamespace(type="server_tool_use", id="s1", name="web_search", input={"query": "acme"}),
                SimpleNamespace(type="web_search_tool_result", tool_use_id="s1", content=[
                    SimpleNamespace(type="web_search_result", url=FACT_URL, title="Acme blog", page_age="2026-09-02"),
                ]),
                _text("Partial brief. "),
            ]
            return SimpleNamespace(content=content, stop_reason="pause_turn", usage=_usage(searches=1))
        assert kwargs["messages"][-1]["role"] == "assistant" or not self.pause_first
        content = [
            SimpleNamespace(type="web_search_tool_result", tool_use_id="s2", content=[
                SimpleNamespace(type="web_search_result", url=OLD_URL, title="News", page_age="2023-01-10")]),
            _text("Acme launched a picking robot.", citations=[SimpleNamespace(type="web_search_result_location",
                                                                               url=FACT_URL, title="Acme blog")]),
        ]
        return SimpleNamespace(content=content, stop_reason="end_turn", usage=_usage(searches=1))


@pytest.fixture
def fake_claude():
    return FakeAnthropic()


class FakeInbox:
    def __init__(self):
        self.results: dict[str, str] = {}
        self.scans: list[list] = []

    def scan(self, contacts):
        self.scans.append(contacts)
        return {e: k for e, k in self.results.items() if e in {c for c, _ in contacts}}
