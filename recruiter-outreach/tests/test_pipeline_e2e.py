"""End to end: Apollo (mocked HTTP) -> Claude (fake client) -> real SMTP server on localhost."""
from __future__ import annotations

import email
import json
import socket
from datetime import datetime, timedelta, timezone
from email import policy

import pytest
from aiosmtpd.controller import Controller

from outreach.db import DB
from outreach.llm import LLM
from outreach.mailer import SmtpTransport
from outreach.pipeline import Pipeline
from outreach.review import build_review_page

from conftest import TODAY_UTC, FakeAnthropic, FakeApollo, FakeInbox, make_settings


class Sink:
    def __init__(self):
        self.messages: list[email.message.EmailMessage] = []
        self.envelopes = []

    async def handle_DATA(self, server, session, envelope):
        self.envelopes.append(envelope)
        self.messages.append(email.message_from_bytes(envelope.content, policy=policy.default))
        return "250 OK"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def smtp():
    sink = Sink()
    port = free_port()
    controller = Controller(sink, hostname="127.0.0.1", port=port)
    controller.start()
    yield sink, port
    controller.stop()


class Clock:
    def __init__(self, now: datetime):
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def build(app, smtp_port, *, mode="review", clock=None, inbox=None, fake_claude=None, **limits):
    app.settings = make_settings(mode=mode, sender={"smtp_port": smtp_port}, limits={"min_gap_seconds": 0,
                                 "max_gap_seconds": 0, **limits})
    db = DB(app.data_dir / "outreach.db")
    fake_apollo = FakeApollo()
    p = Pipeline(
        app, db,
        apollo=fake_apollo.client(enrich_budget=20),
        llm=LLM(app.settings.llm, client=fake_claude or FakeAnthropic()),
        transport=SmtpTransport(app.settings.sender),
        inbox=inbox or FakeInbox(),
        clock=clock or Clock(TODAY_UTC),
        sleep=lambda s: None,
        out=lambda line: None,
    )
    return p, fake_apollo


def test_full_lifecycle_review_mode(app, smtp):
    sink, port = smtp
    clock, inbox = Clock(TODAY_UTC), FakeInbox()
    p, fake_apollo = build(app, port, clock=clock, inbox=inbox)

    # Day 1: discover, research, draft. Review mode sends nothing until approved.
    report = p.run()
    assert report.discovered == 2 and report.researched == 1 and report.drafted == 2
    assert report.sent == 0 and not sink.messages
    drafts = p.db.messages(status="draft")
    assert len(drafts) == 2
    page = build_review_page(p.db, app.data_dir / "review.html").read_text()
    assert "riley.chen@acme.com" in page and "Dropped by verification" in page

    # Re-running is idempotent: no new Apollo spend, no duplicate drafts.
    calls_before = len(fake_apollo.calls)
    p.run()
    assert len(fake_apollo.calls) == calls_before and len(p.db.messages()) == 2

    # Approve and send: only one new contact per company per day.
    assert p.approve(all_clean=True) == [d["id"] for d in drafts]
    assert p.send() == 1
    first = sink.messages[0]
    assert first["To"] == "Riley Chen <riley.chen@acme.com>"
    assert first["Subject"] == "CS student interested in the Software Engineering Intern role"
    body = first.get_body(preferencelist=("plain",)).get_content().replace("\r\n", "\n")
    assert body.startswith("Hi Riley,\n\nMy name is Jordan") and "'" not in body.split("Warm Regards")[0]
    assert [a.get_filename() for a in first.iter_attachments()] == ["Jordan_Lee_Resume.pdf"]
    assert p.send() == 0  # the second Acme contact waits for tomorrow

    # Day 2: the second contact goes out.
    clock.now += timedelta(days=1)
    assert p.send() == 1 and sink.messages[1]["To"].addresses[0].addr_spec == "ana.gomez@acme.com"

    # A week later Riley has replied; only Ana gets the in-thread follow-up.
    clock.now = TODAY_UTC + timedelta(days=8)
    inbox.results = {"riley.chen@acme.com": "replied"}
    report = p.run()
    assert report.replies == 1 and report.followups_queued == 1
    followup = p.db.messages(kind="followup")[0]
    assert followup["status"] == "draft"
    p.approve([followup["id"]])
    assert p.send() == 1
    fu = sink.messages[2]
    assert fu["Subject"].startswith("Re: ") and fu["In-Reply-To"] == sink.messages[1]["Message-ID"]
    assert "> Hi Ana," in fu.get_body(preferencelist=("plain",)).get_content().replace("\r\n", "\n")

    rows = {r["slug"]: r for r in p.status_rows()}
    assert rows["acme-robotics-software-engineering-intern"]["sent"] == 3
    assert rows["acme-robotics-software-engineering-intern"]["replied"] == 1


def test_auto_mode_sends_clean_drafts_and_respects_window(app, smtp):
    sink, port = smtp
    saturday = Clock(datetime(2026, 10, 17, 14, 0, tzinfo=timezone.utc))
    p, _ = build(app, port, mode="auto", clock=saturday)
    report = p.run()
    assert report.approved == 2 and report.sent == 0
    assert any("outside the send window" in n for n in report.notes)
    saturday.now = datetime(2026, 10, 19, 13, 0, tzinfo=timezone.utc)  # Monday 09:00 New York
    assert p.send() == 1 and len(sink.messages) == 1


def test_auto_mode_holds_drafts_with_eligibility_flags(app, smtp):
    _, port = smtp
    claude = FakeAnthropic()
    claude.extraction["eligibility_flags"] = ["Graduate students only"]
    p, _ = build(app, port, mode="auto", fake_claude=claude)
    p.run(send=False)
    held = p.db.messages(status="draft")
    assert len(held) == 2 and "eligibility" in held[0]["error"]


def test_daily_cap_and_bounce_handling(app, smtp):
    sink, port = smtp
    inbox = FakeInbox()
    p, _ = build(app, port, inbox=inbox, daily_send_cap=1, new_contacts_per_company_per_day=5)
    p.run(send=False)
    p.approve(all_clean=True)
    assert p.send() == 1 and p.send() == 0
    assert any("daily cap" in n for n in p.report.notes)

    inbox.results = {"riley.chen@acme.com": "bounced"}
    p.sync_inbox()
    assert p.db.is_suppressed("riley.chen@acme.com")
    assert p.db.contact_by_email("riley.chen@acme.com")["status"] == "bounced"
    assert p.db.targets()[0]["discovery_state"] == "pending"  # will look for a replacement


def test_followups_wait_for_inbox_check(app, smtp):
    _, port = smtp

    class BrokenInbox:
        def scan(self, contacts):
            raise RuntimeError("no IMAP password")

    clock = Clock(TODAY_UTC)
    p, _ = build(app, port, clock=clock, inbox=BrokenInbox(), new_contacts_per_company_per_day=5)
    p.run(send=False)
    p.approve(all_clean=True)
    p.send()
    clock.now += timedelta(days=10)
    report = p.run(send=False)
    assert report.followups_queued == 0
    assert any("follow-ups skipped" in n for n in report.notes)


def test_dry_run_writes_eml_without_marking_sent(app):
    app.settings = make_settings(limits={"min_gap_seconds": 0, "max_gap_seconds": 0})
    db = DB(app.data_dir / "outreach.db")
    p = Pipeline(app, db, apollo=FakeApollo().client(), llm=LLM(app.settings.llm, client=FakeAnthropic()),
                 inbox=FakeInbox(), clock=lambda: TODAY_UTC, sleep=lambda s: None, out=lambda s: None, dry_run=True)
    p.run(send=False)
    p.approve(all_clean=True)
    assert p.send() == 1
    assert list((app.data_dir / "outbox").glob("*.eml"))
    assert not p.db.messages(status="sent") and len(p.db.messages(status="approved")) == 2


def test_usage_is_recorded(app, smtp):
    _, port = smtp
    p, _ = build(app, port)
    p._llm.on_usage = lambda op, units: p.db.record_usage("anthropic", op, units)
    p._apollo.on_usage = lambda op, units: p.db.record_usage("apollo", op, units)
    p.run(send=False)
    totals = p.db.usage_totals()
    assert totals["anthropic"]["web_search_requests"] == 2
    assert totals["apollo"]["emails"] >= 2
    meta = json.loads(p.db.messages()[0]["meta_json"])
    assert meta["fact_urls_used"] and meta["contact_source"] == "recruiter"
