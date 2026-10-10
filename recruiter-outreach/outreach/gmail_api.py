"""Optional Gmail API transport and inbox scan, for accounts where SMTP App Passwords are disabled
(common on university Google Workspace accounts).

Setup once: create an OAuth "Desktop app" client in Google Cloud Console with the Gmail API enabled,
save it as config/gmail_client_secret.json, then run `outreach check`; a browser window asks for
consent and the token is cached in config/gmail_token.json. Requires `pip install -e ".[gmail]"`.
"""
from __future__ import annotations

import base64
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

from .config import ConfigError
from .inbox import is_auto_reply_headers

SCOPES = [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.readonly",
]


def gmail_service(config_dir: Path):
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise ConfigError('Gmail API delivery needs extra packages: pip install -e ".[gmail]"') from exc
    token = config_dir / "gmail_token.json"
    secret = config_dir / "gmail_client_secret.json"
    creds = Credentials.from_authorized_user_file(str(token), SCOPES) if token.exists() else None
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not secret.exists():
                raise ConfigError(f"Missing {secret}. Download an OAuth Desktop client JSON from Google Cloud Console.")
            creds = InstalledAppFlow.from_client_secrets_file(str(secret), SCOPES).run_local_server(port=0)
        token.write_text(creds.to_json())
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


class GmailApiTransport:
    name = "gmail_api"

    def __init__(self, config_dir: Path, service=None, *, as_draft: bool = False):
        self.config_dir = config_dir
        self._service = service
        self.as_draft = as_draft

    @property
    def service(self):
        if self._service is None:
            self._service = gmail_service(self.config_dir)
        return self._service

    def deliver(self, msg: EmailMessage, *, thread_id: str | None = None) -> dict | None:
        body: dict = {"raw": base64.urlsafe_b64encode(msg.as_bytes()).decode()}
        if thread_id:
            body["threadId"] = thread_id
        users = self.service.users()
        if self.as_draft:
            draft = users.drafts().create(userId="me", body={"message": body}).execute()
            return {"gmail_draft_id": draft.get("id"), "thread_id": draft.get("message", {}).get("threadId")}
        sent = users.messages().send(userId="me", body=body).execute()
        return {"gmail_id": sent.get("id"), "thread_id": sent.get("threadId")}

    def check(self) -> None:
        self.service.users().getProfile(userId="me").execute()

    def close(self) -> None:
        return None


class GmailApiInbox:
    def __init__(self, config_dir: Path, service=None):
        self._transport = GmailApiTransport(config_dir, service)

    def scan(self, contacts: list[tuple[str, datetime]]) -> dict[str, str]:
        if not contacts:
            return {}
        users = self._transport.service.users()
        results: dict[str, str] = {}
        earliest = int(min(since for _, since in contacts).timestamp())
        bounce = users.messages().list(userId="me", q=f"from:(mailer-daemon OR postmaster) after:{earliest}",
                                       maxResults=100).execute()
        for ref in bounce.get("messages", []):
            full = users.messages().get(userId="me", id=ref["id"], format="full").execute()
            text = _gmail_text(full).lower()
            for email, _ in contacts:
                if email.lower() in text:
                    results[email] = "bounced"
        for email, since in contacts:
            if email in results:
                continue
            found = users.messages().list(userId="me", q=f"from:{email} after:{int(since.timestamp())}",
                                          maxResults=5).execute()
            refs = found.get("messages", [])
            if not refs:
                continue
            kinds = []
            for ref in refs:
                meta = users.messages().get(userId="me", id=ref["id"], format="metadata",
                                            metadataHeaders=["Subject", "Auto-Submitted", "X-Autoreply"]).execute()
                headers = {h["name"].lower(): h["value"] for h in meta.get("payload", {}).get("headers", [])}
                kinds.append("auto_reply" if is_auto_reply_headers(headers) else "replied")
            results[email] = "replied" if "replied" in kinds else "auto_reply"
        return results


def _gmail_text(message: dict) -> str:
    out = [message.get("snippet", "")]
    stack = [message.get("payload", {})]
    while stack:
        part = stack.pop()
        data = part.get("body", {}).get("data")
        if data:
            out.append(base64.urlsafe_b64decode(data + "==").decode(errors="ignore"))
        stack.extend(part.get("parts", []) or [])
    return "\n".join(out)
