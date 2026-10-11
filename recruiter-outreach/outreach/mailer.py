"""Build the outgoing MIME message and hand it to a transport.

Transports:
  smtp      - send directly (Gmail with an App Password, Outlook, or any SMTP server)
  drafts    - IMAP APPEND into the Drafts folder, so the email waits in the mailbox and is sent by
              hand from the mail app (nothing leaves without a click)
  gmail_api - send through the Gmail API with OAuth (for accounts where App Passwords are disabled)
  file      - write .eml files to data/outbox (dry runs and tests)
"""
from __future__ import annotations

import imaplib
import smtplib
import ssl
import time
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path
from typing import Protocol

from .config import ConfigError, SenderConfig, Settings


class DeliveryError(Exception):
    pass


class RecipientRejected(DeliveryError):
    """The server refused the address outright: treat it as a bounce."""


class AuthFailed(DeliveryError):
    """Bad credentials: stop the whole run instead of failing every message."""


@dataclass
class OutgoingEmail:
    to_email: str
    to_name: str
    subject: str
    body: str
    attachment_path: Path | None
    attachment_name: str
    in_reply_to: str | None = None
    references: str | None = None


def build_mime(sender: SenderConfig, email: OutgoingEmail) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = formataddr((sender.name, sender.email))
    msg["To"] = formataddr((email.to_name, email.to_email)) if email.to_name else email.to_email
    msg["Subject"] = email.subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=sender.email.rsplit("@", 1)[-1])
    if sender.bcc_self:
        msg["Bcc"] = sender.email
    if email.in_reply_to:
        msg["In-Reply-To"] = email.in_reply_to
        msg["References"] = email.references or email.in_reply_to
    msg.set_content(email.body)
    if email.attachment_path:
        path = Path(email.attachment_path).expanduser()
        if not path.exists():
            raise DeliveryError(f"Resume not found at {path}")
        data = path.read_bytes()
        if not data.startswith(b"%PDF"):
            raise DeliveryError(f"{path} does not look like a PDF")
        msg.add_attachment(data, maintype="application", subtype="pdf", filename=email.attachment_name)
    return msg


class Transport(Protocol):
    name: str

    def deliver(self, msg: EmailMessage, *, thread_id: str | None = None) -> dict | None: ...

    def close(self) -> None: ...


class SmtpTransport:
    name = "smtp"

    def __init__(self, sender: SenderConfig, *, timeout: float = 60.0):
        if not sender.smtp_host or not sender.smtp_port:
            raise ConfigError("sender.smtp_host and sender.smtp_port are required for smtp delivery")
        self.sender = sender
        self.timeout = timeout
        self._conn: smtplib.SMTP | None = None

    def _connect(self) -> smtplib.SMTP:
        s = self.sender
        ctx = ssl.create_default_context()
        try:
            if s.smtp_security == "ssl":
                conn: smtplib.SMTP = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=self.timeout, context=ctx)
            else:
                conn = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=self.timeout)
                if s.smtp_security == "starttls":
                    conn.starttls(context=ctx)
        except (smtplib.SMTPServerDisconnected, ConnectionError, TimeoutError, OSError) as exc:
            if isinstance(exc, ssl.SSLCertVerificationError):
                raise DeliveryError(
                    f"TLS certificate check failed for {s.smtp_host}: {exc}. On macOS with python.org Python, "
                    "run 'Install Certificates.command' from the Python folder in Applications."
                ) from exc
            other = "port 587 with smtp_security: starttls" if s.smtp_port == 465 else "port 465 with smtp_security: ssl"
            raise DeliveryError(
                f"Could not open a mail connection to {s.smtp_host}:{s.smtp_port} ({exc}). This network may block "
                f"that port. Try {other} under sender in settings.yaml, another network, or delivery: gmail_api."
            ) from exc
        if s.smtp_security != "none" or s.password:
            if not s.password:
                raise AuthFailed(f"No mailbox password. Set {s.password_env} in recruiter-outreach/.env.")
            try:
                conn.login(s.username, s.password)
            except smtplib.SMTPAuthenticationError as exc:
                raise AuthFailed(
                    f"SMTP login failed for {s.username}: {exc.smtp_error!r}. For Gmail, use an App Password "
                    "(Google Account > Security > 2-Step Verification > App passwords)."
                ) from exc
        return conn

    def deliver(self, msg: EmailMessage, *, thread_id: str | None = None) -> dict | None:
        for attempt in range(2):
            try:
                if self._conn is None:
                    self._conn = self._connect()
                refused = self._conn.send_message(msg)
                if refused:
                    raise RecipientRejected(f"server refused {list(refused)}")
                return None
            except smtplib.SMTPRecipientsRefused as exc:
                raise RecipientRejected(str(exc.recipients)) from exc
            except smtplib.SMTPServerDisconnected:
                self._conn = None
                if attempt == 1:
                    raise DeliveryError("SMTP server disconnected twice")
            except smtplib.SMTPResponseException as exc:
                if exc.smtp_code in (550, 551, 553):
                    raise RecipientRejected(f"{exc.smtp_code} {exc.smtp_error!r}") from exc
                raise DeliveryError(f"SMTP error {exc.smtp_code}: {exc.smtp_error!r}") from exc

    def check(self) -> None:
        self._connect().quit()

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.quit()
            except Exception:
                pass
            self._conn = None


class ImapDraftsTransport:
    """Put each email in the Drafts folder instead of sending it."""

    name = "drafts"

    def __init__(self, sender: SenderConfig, imap_factory=imaplib.IMAP4_SSL):
        if not sender.imap_host:
            raise ConfigError("sender.imap_host is required for drafts delivery")
        self.sender = sender
        self.imap_factory = imap_factory
        self._conn = None

    def _connect(self):
        s = self.sender
        if not s.password:
            raise AuthFailed(f"No mailbox password. Set {s.password_env} in recruiter-outreach/.env.")
        conn = self.imap_factory(s.imap_host, s.imap_port)
        try:
            conn.login(s.username, s.password)
        except imaplib.IMAP4.error as exc:
            raise AuthFailed(f"IMAP login failed for {s.username}: {exc}") from exc
        return conn

    def deliver(self, msg: EmailMessage, *, thread_id: str | None = None) -> dict | None:
        if self._conn is None:
            self._conn = self._connect()
        folder = self.sender.drafts_folder or "Drafts"
        quoted = f'"{folder}"' if " " in folder or "[" in folder else folder
        typ, data = self._conn.append(quoted, r"(\Draft)", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
        if typ != "OK":
            raise DeliveryError(f"IMAP APPEND to {folder} failed: {data}")
        return {"drafted": True}

    def check(self) -> None:
        conn = self._connect()
        conn.logout()

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.logout()
            except Exception:
                pass
            self._conn = None


class FileTransport:
    name = "file"

    def __init__(self, outbox: Path):
        self.outbox = outbox
        self.outbox.mkdir(parents=True, exist_ok=True)
        self.delivered: list[Path] = []

    def deliver(self, msg: EmailMessage, *, thread_id: str | None = None) -> dict | None:
        to = str(msg["To"]).split("<")[-1].rstrip(">").replace("@", "_at_")
        path = self.outbox / f"{time.strftime('%Y%m%d-%H%M%S')}-{to}.eml"
        n = 1
        while path.exists():
            path = path.with_name(f"{path.stem}-{n}.eml")
            n += 1
        path.write_bytes(msg.as_bytes())
        self.delivered.append(path)
        return {"eml": str(path)}

    def check(self) -> None:
        return None

    def close(self) -> None:
        return None


def make_transport(settings: Settings, data_dir: Path, config_dir: Path, *, dry_run: bool = False) -> Transport:
    if dry_run or settings.delivery == "file":
        return FileTransport(data_dir / "outbox")
    if settings.delivery == "smtp":
        return SmtpTransport(settings.sender)
    if settings.delivery == "drafts":
        return ImapDraftsTransport(settings.sender)
    if settings.delivery == "gmail_api":
        from .gmail_api import GmailApiTransport

        return GmailApiTransport(config_dir)
    raise ConfigError(f"unknown delivery {settings.delivery!r}")
