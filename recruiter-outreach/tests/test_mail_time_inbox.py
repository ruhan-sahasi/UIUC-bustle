import email
from datetime import date, datetime, timezone
from email import policy

import pytest

from outreach.config import SenderConfig, SendWindow
from outreach.inbox import ImapInbox, is_auto_reply_headers
from outreach.mailer import DeliveryError, FileTransport, OutgoingEmail, build_mime
from outreach.timeutil import business_days_between, in_send_window, next_window_start

SENDER = SenderConfig(name="Jordan Lee", email="jordan@example.edu")


def test_provider_presets():
    assert (SENDER.smtp_host, SENDER.smtp_port, SENDER.smtp_security) == ("smtp.gmail.com", 465, "ssl")
    outlook = SenderConfig(name="x", email="x@y.edu", provider="outlook")
    assert outlook.smtp_security == "starttls" and outlook.imap_host == "outlook.office365.com"


def test_build_mime_with_attachment_and_threading(resume, tmp_path):
    msg = build_mime(SENDER, OutgoingEmail(
        to_email="riley@acme.com", to_name="Riley Chen", subject="Re: Hello", body="Hi Riley,\n\nText",
        attachment_path=resume, attachment_name="Jordan_Lee_Resume.pdf", in_reply_to="<abc@example.edu>"))
    assert msg["To"] == "Riley Chen <riley@acme.com>"
    assert msg["In-Reply-To"] == "<abc@example.edu>" and msg["References"] == "<abc@example.edu>"
    assert msg["Message-ID"].endswith("@example.edu>")
    parsed = email.message_from_bytes(msg.as_bytes(), policy=policy.default)
    attachments = list(parsed.iter_attachments())
    assert [a.get_filename() for a in attachments] == ["Jordan_Lee_Resume.pdf"]
    assert attachments[0].get_content_type() == "application/pdf"
    out = FileTransport(tmp_path / "outbox")
    info = out.deliver(msg)
    assert info["eml"].endswith(".eml") and len(out.delivered) == 1


def test_build_mime_rejects_missing_or_non_pdf(tmp_path):
    with pytest.raises(DeliveryError, match="not found"):
        build_mime(SENDER, OutgoingEmail("a@b.com", "", "s", "b", tmp_path / "nope.pdf", "r.pdf"))
    txt = tmp_path / "r.pdf"
    txt.write_text("hello")
    with pytest.raises(DeliveryError, match="PDF"):
        build_mime(SENDER, OutgoingEmail("a@b.com", "", "s", "b", txt, "r.pdf"))


def test_send_window_in_new_york():
    w = SendWindow()
    assert in_send_window(datetime(2026, 10, 13, 13, 0, tzinfo=timezone.utc), w)        # Tue 09:00 EDT
    assert not in_send_window(datetime(2026, 10, 13, 16, 0, tzinfo=timezone.utc), w)    # Tue 12:00 EDT
    assert not in_send_window(datetime(2026, 10, 16, 13, 0, tzinfo=timezone.utc), w)    # Friday
    assert in_send_window(datetime(2026, 11, 3, 14, 0, tzinfo=timezone.utc), w)         # Tue 09:00 EST
    nxt = next_window_start(datetime(2026, 10, 15, 17, 0, tzinfo=timezone.utc), w)      # Thu afternoon
    assert (nxt.weekday(), nxt.hour, nxt.minute) == (0, 8, 30)                          # next Monday 08:30


def test_business_days():
    assert business_days_between(date(2026, 10, 13), date(2026, 10, 20)) == 5   # Tue -> next Tue
    assert business_days_between(date(2026, 10, 16), date(2026, 10, 19)) == 1   # Fri -> Mon
    assert business_days_between(date(2026, 10, 13), date(2026, 10, 13)) == 0


def test_auto_reply_detection():
    assert is_auto_reply_headers({"Auto-Submitted": "auto-replied"})
    assert is_auto_reply_headers({"Subject": "Automatic reply: Intern role"})
    assert not is_auto_reply_headers({"Subject": "Re: Intern role", "Auto-Submitted": "no"})


class FakeImap:
    def __init__(self, host, port):
        self.selected = None

    def login(self, user, password):
        assert password == "pw"

    def select(self, folder, readonly=False):
        self.selected = folder
        return "OK", [b"1"]

    def search(self, charset, *criteria):
        sender = criteria[1].strip('"')
        ids = {"mailer-daemon": b"9", "riley@acme.com": b"1", "ana@acme.com": b"2"}.get(sender, b"")
        return "OK", [ids]

    def fetch(self, mid, what):
        if mid == b"9":
            return "OK", [(b"9", b"Delivery to bad@acme.com failed permanently.")]
        if mid == b"2":
            return "OK", [(b"2", b"Subject: Out of Office: back Monday\r\n\r\n")]
        return "OK", [(b"1", b"Subject: Re: Software Engineering Intern\r\n\r\n")]

    def logout(self):
        pass


def test_imap_inbox_scan(monkeypatch):
    monkeypatch.setenv("OUTREACH_EMAIL_PASSWORD", "pw")
    inbox = ImapInbox(SENDER, imap_factory=FakeImap)
    since = datetime(2026, 10, 1, tzinfo=timezone.utc)
    result = inbox.scan([("riley@acme.com", since), ("ana@acme.com", since), ("bad@acme.com", since),
                         ("quiet@acme.com", since)])
    assert result == {"bad@acme.com": "bounced", "riley@acme.com": "replied", "ana@acme.com": "auto_reply"}


def test_gmail_api_transport_threads_followups(resume):
    from types import SimpleNamespace

    from outreach.gmail_api import GmailApiTransport

    sent = []

    class Call:
        def __init__(self, result):
            self.result = result

        def execute(self):
            return self.result

    messages = SimpleNamespace(send=lambda userId, body: sent.append(body) or Call({"id": "m1", "threadId": "t1"}))
    service = SimpleNamespace(users=lambda: SimpleNamespace(messages=lambda: messages))
    transport = GmailApiTransport(config_dir=None, service=service)
    msg = build_mime(SENDER, OutgoingEmail("a@acme.com", "A", "Re: s", "b", resume, "r.pdf"))
    assert transport.deliver(msg, thread_id="t0") == {"gmail_id": "m1", "thread_id": "t1"}
    assert sent[0]["threadId"] == "t0" and sent[0]["raw"]


def test_greeting_name_capitalizes():
    from outreach.writer import greeting_name

    assert greeting_name("riley") == "Riley" and greeting_name("ANNE-MARIE") == "Anne-Marie"
    assert greeting_name("McKenzie") == "McKenzie" and greeting_name("") == "there"
