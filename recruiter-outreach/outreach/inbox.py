"""Read-only inbox scan: who replied, which addresses bounced, and which replies were auto-replies.

A real reply stops the follow-up and marks the contact `replied`. A bounce marks it `bounced` and
adds the address to the suppression list. An out-of-office auto-reply changes nothing.
"""
from __future__ import annotations

import email
import imaplib
from datetime import datetime

from .config import SenderConfig

AUTO_SUBJECT_HINTS = ("automatic reply", "auto reply", "autoreply", "out of office", "out of the office",
                      "away from the office", "on vacation", "ooo")


def is_auto_reply_headers(headers: dict[str, str]) -> bool:
    headers = {k.lower(): (v or "") for k, v in headers.items()}
    auto = headers.get("auto-submitted", "").lower()
    if auto and auto != "no":
        return True
    if headers.get("x-autoreply") or headers.get("x-autorespond"):
        return True
    subject = headers.get("subject", "").lower()
    return any(hint in subject for hint in AUTO_SUBJECT_HINTS)


def _imap_date(dt: datetime) -> str:
    return dt.strftime("%d-%b-%Y")


class ImapInbox:
    def __init__(self, sender: SenderConfig, imap_factory=imaplib.IMAP4_SSL):
        self.sender = sender
        self.imap_factory = imap_factory

    def _connect(self):
        s = self.sender
        if not s.imap_host:
            raise RuntimeError("sender.imap_host is not set; cannot scan the inbox")
        if not s.password:
            raise RuntimeError(f"No mailbox password. Set {s.password_env} in recruiter-outreach/.env.")
        conn = self.imap_factory(s.imap_host, s.imap_port)
        conn.login(s.username, s.password)
        return conn

    def scan(self, contacts: list[tuple[str, datetime]]) -> dict[str, str]:
        if not contacts:
            return {}
        conn = self._connect()
        try:
            folder = self.sender.inbox_folder or "INBOX"
            typ, _ = conn.select(f'"{folder}"' if " " in folder or "[" in folder else folder, readonly=True)
            if typ != "OK":
                conn.select("INBOX", readonly=True)
            results: dict[str, str] = {}
            earliest = min(since for _, since in contacts)
            for daemon in ("mailer-daemon", "postmaster"):
                typ, data = conn.search(None, "FROM", f'"{daemon}"', "SINCE", _imap_date(earliest))
                ids = data[0].split()[-100:] if typ == "OK" and data and data[0] else []
                for mid in ids:
                    typ, parts = conn.fetch(mid, "(BODY.PEEK[])")
                    raw = b"".join(p[1] for p in parts if isinstance(p, tuple))
                    text = raw.decode(errors="ignore").lower()
                    for addr, _ in contacts:
                        if addr.lower() in text:
                            results[addr] = "bounced"
            for addr, since in contacts:
                if addr in results:
                    continue
                typ, data = conn.search(None, "FROM", f'"{addr}"', "SINCE", _imap_date(since))
                ids = data[0].split()[-5:] if typ == "OK" and data and data[0] else []
                if not ids:
                    continue
                kinds = []
                for mid in ids:
                    typ, parts = conn.fetch(mid, "(BODY.PEEK[HEADER.FIELDS (SUBJECT AUTO-SUBMITTED X-AUTOREPLY)])")
                    raw = b"".join(p[1] for p in parts if isinstance(p, tuple))
                    msg = email.message_from_bytes(raw)
                    kinds.append("auto_reply" if is_auto_reply_headers(dict(msg.items())) else "replied")
                results[addr] = "replied" if "replied" in kinds else "auto_reply"
            return results
        finally:
            try:
                conn.logout()
            except Exception:
                pass
