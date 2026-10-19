from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from apollo_api import Apollo  # noqa: E402


class FakeApolloServer:
    """In-memory Apollo with the behaviors the vestige CLI learned live, including the
    full-state PUT that deletes any step left out of emailer_steps."""

    def __init__(self):
        self.calls: list[tuple[str, str, dict]] = []
        self.people = {
            "acme.com": [
                {"id": "p1", "first_name": "Riley", "last_name_obfuscated": "Ch***n", "title": "University Recruiter", "has_email": True},
                {"id": "p2", "first_name": "Sam", "title": "Technical Recruiter", "has_email": True},
                {"id": "p3", "first_name": "Ana", "title": "Senior Technical Recruiter", "has_email": True},
                {"id": "p4", "first_name": "Max", "title": "Executive Recruiter", "has_email": True},
                {"id": "p5", "first_name": "Lee", "title": "Software Engineer", "has_email": True},
                {"id": "p6", "first_name": "Kim", "title": "Campus Recruiter", "has_email": False},
            ],
            "tiny.io": [{"id": "f1", "first_name": "Dana", "title": "Co-Founder & CTO", "has_email": True}],
        }
        self.reveal = {
            "p1": {"id": "p1", "name": "Riley Chen", "first_name": "Riley", "last_name": "Chen", "title": "University Recruiter",
                   "email": "riley.chen@acme.com", "email_status": "verified", "organization": {"name": "Acme Robotics Inc"}},
            "p2": {"id": "p2", "name": "Sam Lee", "first_name": "Sam", "last_name": "Lee", "title": "Technical Recruiter",
                   "email": "sam@acme.com", "email_status": "extrapolated"},
            "p3": {"id": "p3", "name": "Ana Gomez", "first_name": "Ana", "last_name": "Gomez",
                   "title": "Senior Technical Recruiter", "email": "ana.gomez@acme.com", "email_status": "verified"},
            "f1": {"id": "f1", "name": "Dana Ito", "first_name": "Dana", "last_name": "Ito", "title": "Co-Founder & CTO",
                   "email": "dana@tiny.io", "email_status": "verified"},
        }
        self.mailboxes = [{"id": "mb1", "email": "me@school.edu", "type": "gmail", "active": True, "last_synced_at": "now"}]
        self.campaigns: dict[str, dict] = {}
        self.steps: dict[str, list[dict]] = {}
        self.templates: dict[str, dict] = {}
        self.contacts: dict[str, dict] = {}
        self.job_changed: set[str] = set()
        self._n = 0

    def _id(self, prefix: str) -> str:
        self._n += 1
        return f"{prefix}{self._n}"

    def _detail(self, cid: str) -> dict:
        steps = sorted(self.steps[cid], key=lambda s: s["position"])
        return {
            "emailer_campaign": self.campaigns[cid],
            "emailer_steps": [{"id": s["id"], "position": s["position"], "wait_time": s["wait_time"]} for s in steps],
            "emailer_touches": [{"id": s["touch_id"], "emailer_step_id": s["id"], "emailer_template_id": s["template_id"]}
                                for s in steps],
            "emailer_templates": [self.templates[s["template_id"]] for s in steps],
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Api-Key"] == "test-key"
        path = request.url.path.removeprefix("/api/v1/")
        body = json.loads(request.content) if request.content else {}
        self.calls.append((request.method, path, body))
        m = request.method
        if path == "auth/health":
            return httpx.Response(200, json={"healthy": True, "is_logged_in": True})
        if path == "mixed_people/api_search":
            domain = body["q_organization_domains_list"][0]
            words = {t.split()[-1].lower() for t in body["person_titles"]}
            hits = [p for p in self.people.get(domain, []) if any(w in p["title"].lower() for w in words)]
            start = (body["page"] - 1) * body["per_page"]
            return httpx.Response(200, json={"people": hits[start:start + body["per_page"]]})
        if path == "people/match":
            return httpx.Response(200, json={"person": self.reveal.get(body.get("id"), {})})
        if path == "email_accounts":
            return httpx.Response(200, json={"email_accounts": self.mailboxes})
        if path == "emailer_schedules":
            return httpx.Response(200, json={"emailer_schedules": [{"id": "sch1", "default": True}]})
        if path == "emailer_campaigns" and m == "POST":
            cid = self._id("c")
            self.campaigns[cid] = {"id": cid, "name": body["name"], "active": False}
            self.steps[cid] = []
            return httpx.Response(200, json={"emailer_campaign": self.campaigns[cid]})
        if path == "emailer_steps":
            cid = body["emailer_campaign_id"]
            sid, tid, tmpl = self._id("s"), self._id("t"), self._id("tm")
            self.templates[tmpl] = {"id": tmpl, "subject": "", "body_html": "", "attachment_ids": []}
            self.steps[cid].append({"id": sid, "touch_id": tid, "template_id": tmpl,
                                    "position": len(self.steps[cid]) + 1, "wait_time": body["wait_time"]})
            return httpx.Response(200, json={"emailer_step": {"id": sid}})
        if path.startswith("emailer_campaigns/") and path.endswith("/add_contact_ids"):
            cid = path.split("/")[1]
            skipped = {c: "contacts_with_job_change" for c in body["contact_ids"] if c in self.job_changed}
            added = [self.contacts[c] for c in body["contact_ids"] if c not in skipped]
            self.campaigns[cid].setdefault("enrolled", []).extend(c["id"] for c in added)
            return httpx.Response(200, json={"contacts": added, "skipped_contact_ids": skipped})
        if path.startswith("emailer_campaigns/") and m == "GET":
            cid = path.split("/")[1]
            if cid not in self.campaigns:
                return httpx.Response(404, json={"error": "not found"})
            return httpx.Response(200, json=self._detail(cid))
        if path.startswith("sequences/") and m == "PUT":
            cid = path.split("/")[1]
            keep = {s["id"] for s in body["emailer_steps"]}
            self.steps[cid] = [s for s in self.steps[cid] if s["id"] in keep]  # the live trap
            for spec in body["emailer_steps"]:
                step = next(s for s in self.steps[cid] if s["id"] == spec["id"])
                step["position"], step["wait_time"] = spec["position"], spec["wait_time"]
                t = spec["emailer_touches"][0]["emailer_template"]
                self.templates[t["id"]].update({"subject": t["subject"], "body_html": t["body_html"],
                                                "body_text": t["body_text"]})
            camp = self.campaigns[cid]
            camp["active"] = body.get("active", camp["active"])
            camp["schedule"] = body.get("emailer_schedule_id")
            camp["max_per_day"] = body.get("max_emails_per_day")
            return httpx.Response(200, json={"emailer_campaign": camp})
        if path == "contacts/search":
            hits = [c for c in self.contacts.values() if c["email"].lower() == body["q_keywords"].lower()]
            return httpx.Response(200, json={"contacts": hits})
        if path == "contacts":
            cid = self._id("ct")
            self.contacts[cid] = {"id": cid, **body}
            return httpx.Response(200, json={"contact": self.contacts[cid]})
        return httpx.Response(404, json={"error": f"no route {m} {path}"})

    def client(self) -> Apollo:
        return Apollo("test-key", http=httpx.Client(transport=httpx.MockTransport(self.handler)), sleep=lambda s: None)

    def reveals(self) -> int:
        return sum(1 for _m, p, _b in self.calls if p == "people/match")


@pytest.fixture
def server() -> FakeApolloServer:
    return FakeApolloServer()


# ---------------------------------------------------------------------------- fake Claude

FACT_URL = "https://acme.com/blog/picking-robot"

GOOD = {
    "subject": "Penn CS student interested in the Software Engineering Intern role",
    "email1_paragraphs": [
        "My name is Jordan and I am a student studying Computer Science at Example University. I recently applied "
        "to the Software Engineering Intern role at Acme Robotics, and I wanted to introduce myself to the team.",
        "The reason I would love to join Acme Robotics is that robots that pick and pack orders could make same day "
        "shipping normal for small shops. Acme recently launched a picking robot that learns new items from a few "
        "photos, which means a warehouse can add products without reprogramming anything.",
        "Specifically, at Example Startup I built a weekly Python pipeline that turned support tickets into product "
        "fixes, and I only kept patterns that held up across several weeks before suggesting a change.",
        "I have attached my resume, and I would be grateful to be considered or pointed to the right person.",
    ],
    "email2_paragraphs": ["I wanted to follow up on my note about the Software Engineering Intern role. I would "
                          "still love to help with the picking robot work, and a pointer to the right person "
                          "would mean a lot if that is not you."],
    "fact_url_used": FACT_URL + "/",
}


def _text(text, citations=None):
    return SimpleNamespace(type="text", text=text, citations=citations)


def _usage(searches=0):
    return SimpleNamespace(input_tokens=1000, output_tokens=200,
                           server_tool_use=SimpleNamespace(web_search_requests=searches))


class FakeClaude:
    def __init__(self, drafts=None):
        self.requests: list[dict] = []
        self.rounds = 0
        bad = json.loads(json.dumps(GOOD))
        bad["email1_paragraphs"][2] = bad["email1_paragraphs"][2].replace("built", "spearheaded")
        bad["subject"] = "Acme's internship"
        self.drafts = drafts or [bad, GOOD]
        self.draft_calls = 0
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **kw):
        self.requests.append(kw)
        assert kw["model"] == "claude-opus-5-5" and kw["fallbacks"] == "default"
        if kw.get("tools"):
            self.rounds += 1
            if self.rounds == 1:
                return SimpleNamespace(stop_reason="pause_turn", usage=_usage(1), content=[
                    SimpleNamespace(type="web_search_tool_result", content=[
                        SimpleNamespace(url=FACT_URL, title="Acme blog", page_age="2026-09-02")]),
                    _text("Partial. ")])
            return SimpleNamespace(stop_reason="end_turn", usage=_usage(1), content=[_text("Acme launched a robot.")])
        schema = kw["output_config"]["format"]["schema"]
        if "facts" in schema["properties"]:
            data = {"company_summary": "Acme builds warehouse robots.", "team_focus": "Perception.",
                    "facts": [{"fact": "Acme launched a picking robot.", "why_it_matters": "Faster restocking.",
                               "source_url": FACT_URL + "?utm_source=x", "source_title": "Acme blog",
                               "published": "2026-09-02"},
                              {"fact": "Invented.", "why_it_matters": "-", "source_url": "https://fake.example/x",
                               "source_title": "?", "published": "2026-09-01"}],
                    "posting_keywords": ["Python"], "eligibility_flags": ["None found"]}
        else:
            data = self.drafts[min(self.draft_calls, len(self.drafts) - 1)]
            self.draft_calls += 1
        return SimpleNamespace(stop_reason="end_turn", usage=_usage(), content=[_text(json.dumps(data))])


PROFILE_MD = (HERE / "profile.example.md").read_text()


@pytest.fixture
def workdir(tmp_path, monkeypatch):
    """A data directory with the example profile and one Acme target."""
    monkeypatch.setenv("OUTBOUND_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("APOLLO_API_KEY", "test-key")
    (tmp_path / "sequences").mkdir()
    (tmp_path / "profile.md").write_text(PROFILE_MD)
    (tmp_path / "targets.csv").write_text(
        "enabled,company,domain,role,track,applied,posting_url,location,alt_domains,notes,slug\n"
        'yes,Acme Robotics,acme.com,Software Engineering Intern,swe,yes,,"San Francisco, CA",,,\n'
        "no,Globex,globex.com,PM Intern,pm,no,,,,,\n")
    return tmp_path
