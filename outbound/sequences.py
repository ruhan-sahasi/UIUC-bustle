"""Sequence copy (sequences/<target>.md) and the Apollo side: create, enroll, mailboxes, stats.

The markdown file is the single source of truth, in the vestige outbound format:

    ## Subject line
    Penn CS student interested in the Software Engineering Intern role

    ## Email 1 (day 0)
    > Hi {first},
    > ...

    ## Email 2 (day 5, reply in the same thread)
    > ...

Merge fields: {first} -> {{first_name}}, {last} -> {{last_name}}, {company} -> {{company}}.
Email 1 opens a new thread with the subject; later emails reply in the same thread after the gap
between their day numbers. Any other section (like the research notes) is never sent.
"""
from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from apollo_api import Apollo, ApolloError
from common import data_dir, read_csv, write_csv

ENROLLED_COLUMNS = ["date", "target", "campaign_id", "contact_id", "name", "email", "title", "status", "detail"]
CAMPAIGN_COLUMNS = ["target", "campaign_id", "name", "copy_hash", "updated_at"]


@dataclass
class Sequence:
    subject: str
    emails: list[str]
    days: list[int]
    notes: str = ""

    @property
    def waits(self) -> list[int]:
        out = []
        for i, day in enumerate(self.days):
            out.append(0 if i == 0 else max(1, day - self.days[i - 1]))
        return out


def parse_md(text: str, *, source: str = "sequence") -> Sequence:
    sections = re.split(r"^## ", text, flags=re.M)
    subject_sec = next((s for s in sections if s.lower().startswith("subject line")), None)
    if subject_sec is None:
        raise ValueError(f'{source}: no "## Subject line" section')
    subject_lines = [line.strip() for line in subject_sec.splitlines()[1:] if line.strip() and not line.startswith(">")]
    subject = subject_lines[0] if subject_lines else ""
    found: list[tuple[int, int, str]] = []
    for sec in sections:
        m = re.match(r"Email\s+(\d+)\b(.*)", sec)
        if not m:
            continue
        number = int(m.group(1))
        day_match = re.search(r"\bday\s+(\d+)", m.group(2), re.I)
        body = "\n".join(re.sub(r"^> ?", "", line) for line in sec.splitlines()[1:] if line.startswith(">")).strip()
        if not body:
            raise ValueError(f"{source}: email {number} has no body (each line of a body starts with >)")
        found.append((number, int(day_match.group(1)) if day_match else -1, body))
    if not found:
        raise ValueError(f'{source}: no "## Email 1" section')
    found.sort()
    if [n for n, _, _ in found] != list(range(1, len(found) + 1)):
        raise ValueError(f"{source}: emails must be numbered 1, 2, 3 in order")
    days, last = [], None
    for _number, day, _ in found:
        if day < 0:
            day = 0 if last is None else last + 5
        days.append(day)
        last = day
    notes = next((s for s in sections if s.lower().startswith("research notes")), "")
    return Sequence(subject=subject, emails=[b for _, _, b in found], days=days, notes=notes)


def render_md(seq: Sequence, *, title: str, header_lines: list[str]) -> str:
    parts = [f"# {title}", "", *header_lines, "", "## Subject line", "", seq.subject, ""]
    for i, (body, day) in enumerate(zip(seq.emails, seq.days), start=1):
        when = f"day {day}" if i == 1 else f"day {day}, reply in the same thread"
        quoted = "\n".join(f"> {line}" if line else ">" for line in body.splitlines())
        parts += [f"## Email {i} ({when})", "", quoted, ""]
    if seq.notes:
        parts += ["## " + seq.notes.strip(), ""]
    return "\n".join(parts).rstrip() + "\n"


def merge_fields(text: str) -> str:
    return (text.replace("{first}", "{{first_name}}").replace("{last}", "{{last_name}}")
            .replace("{company}", "{{company}}"))


def to_html(text: str) -> str:
    paragraphs = re.split(r"\n\s*\n", text.strip())
    return "\n".join("<p>" + html.escape(p, quote=False).replace("\n", "<br>") + "</p>" for p in paragraphs)


# --------------------------------------------------------------------------- campaigns ledger


def campaign_row(slug: str, path: Path | None = None) -> dict:
    rows = read_csv(path or (data_dir() / "campaigns.csv"))
    return next((r for r in rows if r.get("target") == slug and r.get("campaign_id")), {})


def campaign_for(slug: str, path: Path | None = None) -> str | None:
    return campaign_row(slug, path).get("campaign_id") or None


def remember_campaign(slug: str, campaign_id: str, name: str, copy_hash: str = "", path: Path | None = None) -> None:
    path = path or (data_dir() / "campaigns.csv")
    rows = [r for r in read_csv(path) if r.get("target") != slug]
    rows.append({"target": slug, "campaign_id": campaign_id, "name": name, "copy_hash": copy_hash,
                 "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    write_csv(path, rows, CAMPAIGN_COLUMNS)


# --------------------------------------------------------------------------- Apollo


@dataclass
class StepSummary:
    position: int
    wait: int
    subject: str
    body_chars: int
    attachments: int


def _attachment_count(template: dict) -> int:
    count = 0
    for key, value in template.items():
        if "attachment" in key.lower() and value:
            count += len(value) if isinstance(value, (list, tuple)) else 1
    return count


def attachment_counts(apollo: Apollo, campaign_id: str) -> list[int]:
    """Attachments Apollo reports per email, in order. Files can only be attached in the Apollo UI."""
    detail = apollo.campaign(campaign_id)
    templates = {t["id"]: t for t in detail.get("emailer_templates") or []}
    touches = {t["emailer_step_id"]: t for t in detail.get("emailer_touches") or []}
    out = []
    for step in sorted(detail.get("emailer_steps") or [], key=lambda s: s.get("position", 0)):
        template = templates.get((touches.get(step["id"]) or {}).get("emailer_template_id"), {})
        out.append(_attachment_count(template))
    return out


def sync_sequence(apollo: Apollo, seq: Sequence, *, name: str, campaign_id: str | None = None,
                  activate: bool = False, max_per_day: int | None = None, include_signature: bool = False,
                  sleep: Callable[[float], None] = lambda s: None) -> tuple[str, bool, list[StepSummary]]:
    """Create the sequence (or fill an existing one) from the copy, in one full-state PUT."""
    if campaign_id is None:
        campaign_id = apollo.create_campaign(name)["id"]
    detail = apollo.campaign(campaign_id)
    while len(detail.get("emailer_steps") or []) < len(seq.emails):
        apollo.add_step(campaign_id)
        sleep(0.3)
        detail = apollo.campaign(campaign_id)
    steps = sorted(detail["emailer_steps"], key=lambda s: s.get("position", 0))[: len(seq.emails)]
    touch_by_step = {t["emailer_step_id"]: t for t in detail.get("emailer_touches") or []}
    emailer_steps = []
    for i, step in enumerate(steps):
        touch = touch_by_step.get(step["id"])
        if not touch:
            raise ApolloError(f"step {step['id']} has no touch; open the sequence in Apollo and check its steps")
        body = merge_fields(seq.emails[i])
        emailer_steps.append({
            "id": step["id"], "position": i + 1, "type": "auto_email", "wait_mode": "day",
            "wait_time": seq.waits[i],
            "emailer_touches": [{
                "id": touch["id"], "type": "new_thread" if i == 0 else "reply_to_thread",
                "include_signature": include_signature, "status": "approved",
                "emailer_template": {
                    "id": touch["emailer_template_id"],
                    "subject": merge_fields(seq.subject) if i == 0 else "",
                    "body_html": to_html(body),
                    "body_text": body,
                },
            }],
        })
    put: dict = {"emailer_steps": emailer_steps}
    default = next((s for s in apollo.schedules() if s.get("default")), None)
    if default:
        put["emailer_schedule_id"] = default["id"]  # without a schedule a sequence never sends
    if activate:
        put["active"] = True
    if max_per_day:
        put["max_emails_per_day"] = max_per_day
    apollo.put_sequence(campaign_id, put)

    after = apollo.campaign(campaign_id)
    templates = {t["id"]: t for t in after.get("emailer_templates") or []}
    touches = {t["emailer_step_id"]: t for t in after.get("emailer_touches") or []}
    summary = []
    for step in sorted(after.get("emailer_steps") or [], key=lambda s: s.get("position", 0)):
        touch = touches.get(step["id"]) or {}
        template = templates.get(touch.get("emailer_template_id"), {})
        summary.append(StepSummary(step.get("position", 0), step.get("wait_time", 0), template.get("subject", ""),
                                   len(template.get("body_html") or ""), _attachment_count(template)))
    active = bool((after.get("emailer_campaign") or {}).get("active"))
    return campaign_id, active, summary


def mailboxes(apollo: Apollo) -> list[dict]:
    out = []
    for a in apollo.email_accounts():
        if a.get("needs_reauth_at"):
            state = f"NEEDS REAUTH since {a['needs_reauth_at']}"
        elif a.get("active"):
            state = f"active (last sync {a.get('last_synced_at')})"
        else:
            state = f"inactive ({a.get('inactive_reason') or 'unknown'})"
        out.append({"id": a.get("id"), "email": a.get("email"), "type": a.get("type"), "state": state,
                    "usable": bool(a.get("active")) and not a.get("needs_reauth_at")})
    return out


@dataclass
class EnrollResult:
    enrolled: list[dict] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)


def enroll(apollo: Apollo, *, slug: str, campaign_id: str, rows: list[dict], mailbox_id: str,
           enrolled_path: Path | None = None, log: Callable[[str], None] = print,
           sleep: Callable[[float], None] = lambda s: None) -> EnrollResult:
    enrolled_path = enrolled_path or (data_dir() / "enrolled.csv")
    ledger = read_csv(enrolled_path)
    already = {r["email"].lower() for r in ledger if r.get("status") == "enrolled" and r.get("email")}
    result = EnrollResult()
    by_id: dict[str, dict] = {}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for row in rows:
        email = (row.get("email") or "").strip()
        if not email or email.lower() in already:
            continue
        try:
            contact = apollo.find_contact(email) or apollo.create_contact(
                first=row.get("first", ""), last=row.get("last", ""), email=email,
                company=row.get("company", ""), title=row.get("title", ""))
        except ApolloError as exc:
            result.skipped.append({**row, "detail": f"contact failed: {exc}"})
            continue
        if contact.get("id"):
            by_id[contact["id"]] = row
        sleep(0.4)
    if by_id:
        response = apollo.add_contacts(campaign_id, list(by_id), mailbox_id)
        skipped = response.get("skipped_contact_ids") or {}
        for cid, row in by_id.items():
            if cid in skipped:
                reason = skipped[cid]
                reason = reason if isinstance(reason, str) else json.dumps(reason)
                result.skipped.append({**row, "contact_id": cid, "detail": f"skipped by Apollo: {reason}"})
            else:
                result.enrolled.append({**row, "contact_id": cid})
    for status, items in (("enrolled", result.enrolled), ("skipped", result.skipped)):
        for item in items:
            ledger.append({"date": now, "target": slug, "campaign_id": campaign_id, "contact_id": item.get("contact_id", ""),
                           "name": item.get("name", ""), "email": item.get("email", ""), "title": item.get("title", ""),
                           "status": status, "detail": item.get("detail", "")})
            log(f"[enroll] {status}: {item.get('name')} <{item.get('email')}> {item.get('detail', '')}".rstrip())
    write_csv(enrolled_path, ledger, ENROLLED_COLUMNS)
    return result


STAT_KEYS = ["unique_scheduled", "unique_delivered", "unique_bounced", "unique_opened", "unique_replied",
             "unique_demoed", "unique_unsubscribed", "unique_clicked"]


def stats(apollo: Apollo, campaign_id: str) -> dict:
    detail = apollo.campaign(campaign_id)
    c = detail.get("emailer_campaign") or {}
    out = {"name": c.get("name"), "active": c.get("active")}
    out.update({k.removeprefix("unique_"): c[k] for k in STAT_KEYS if k in c})
    return out
