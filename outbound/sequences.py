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
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from apollo_api import Apollo, ApolloError
from common import data_dir, read_csv, write_csv

ENROLLED_COLUMNS = ["date", "target", "campaign_id", "contact_id", "name", "email", "title", "status", "detail"]
# A person with any of these in enrolled.csv is never offered again.
BLOCKING_STATUSES = {"enrolled", "enroll_unknown"}
CAMPAIGN_COLUMNS = ["target", "campaign_id", "name", "copy_hash", "updated_at"]


@dataclass
class Sequence:
    subject: str
    emails: list[str]
    days: list[int]
    notes: str = ""
    preamble: str = ""

    @property
    def waits(self) -> list[int]:
        out = []
        for i, day in enumerate(self.days):
            out.append(0 if i == 0 else max(1, day - self.days[i - 1]))
        return out


HEADING = re.compile(r"^\s*#{1,6}\s*(.+?)\s*$")


def parse_md(text: str, *, source: str = "sequence") -> Sequence:
    """Parse the copy. Anything that could silently change what is sent is an error, not a guess."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    sections: list[tuple[str, int, list[str]]] = []  # (title, line number, lines)
    preamble: list[str] = []
    for n, line in enumerate(text.split("\n"), start=1):
        m = HEADING.match(line)
        if m and not line.lstrip().startswith(">"):
            sections.append((m.group(1), n, []))
        elif sections:
            sections[-1][2].append(line)
        else:
            preamble.append(line)
    subject, emails, notes = None, [], ""
    for title, n, lines in sections:
        lowered = title.lower()
        if lowered.startswith("subject"):
            inline = re.sub(r"(?i)^subject( line)?\s*:?\s*", "", title).strip()
            rest = [line.strip() for line in lines if line.strip()]
            subject = inline or (re.sub(r"^>\s?", "", rest[0]).strip() if rest else "")
            subject = re.sub(r"(?i)^subject\s*:\s*", "", subject)
        elif re.match(r"(?i)email\s*\d+\b", title):
            number = int(re.match(r"(?i)email\s*(\d+)", title).group(1))
            day = re.search(r"(?i)\bday\s+(\d+)", title)
            body_lines = []
            for offset, line in enumerate(lines, start=1):
                stripped = line.strip()
                if not stripped:
                    continue
                if not stripped.startswith(">"):
                    raise ValueError(f"{source} line {n + offset}: every line of an email starts with '>' "
                                     f"(this one would be dropped): {stripped[:60]!r}")
                body_lines.append(re.sub(r"^>\s?", "", stripped).rstrip())
            body = "\n".join(body_lines).strip()
            body = re.sub(r"\n{3,}", "\n\n", body)
            if not body:
                raise ValueError(f"{source} line {n}: email {number} has no body (each line starts with >)")
            emails.append((number, int(day.group(1)) if day else None, body, n))
        elif lowered.startswith("research notes"):
            notes = "\n".join([title, *lines]).strip()
        elif lowered.startswith("sequence"):
            preamble += lines
        elif re.search(r"(?i)\b(email|follow[- ]?up|touch)\b", title) and not lowered.startswith("sequence"):
            raise ValueError(f"{source} line {n}: heading {title!r} looks like an email but is not "
                             "'## Email N (day D)'; rename it or it would not be sent")
    if subject is None:
        raise ValueError(f'{source}: no "## Subject line" section')
    if not emails:
        raise ValueError(f'{source}: no "## Email 1 (day 0)" section')
    emails.sort()
    if [e[0] for e in emails] != list(range(1, len(emails) + 1)):
        raise ValueError(f"{source}: emails must be numbered 1, 2, 3 in order")
    days = []
    for number, day, _body, n in emails:
        if day is None:
            if number != 1:
                raise ValueError(f"{source} line {n}: say which day email {number} goes out, e.g. (day 5)")
            day = 0
        if days and day <= days[-1]:
            raise ValueError(f"{source} line {n}: email {number} must come on a later day than email {number - 1}")
        days.append(day)
    return Sequence(subject=subject, emails=[e[2] for e in emails], days=days, notes=notes,
                    preamble="\n".join(preamble).strip())


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
                  on_created: Callable[[str], None] | None = None,
                  sleep: Callable[[float], None] | None = None) -> tuple[str, bool, list[StepSummary]]:
    """Create the sequence (or fill an existing one) from the copy, in one full-state PUT.

    on_created runs the moment a new campaign exists, so a failure later in the sync never leaves an
    orphan that the next run would duplicate."""
    sleep = sleep or time.sleep
    if campaign_id is None:
        campaign_id = apollo.create_campaign(name)["id"]
        if on_created:
            on_created(campaign_id)
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
           sleep: Callable[[float], None] | None = None) -> EnrollResult:
    """Enroll rows into the campaign. The ledger is written even if Apollo fails halfway: rows whose
    outcome is unknown are recorded as enroll_unknown and are never offered again until checked."""
    sleep = sleep or time.sleep
    enrolled_path = enrolled_path or (data_dir() / "enrolled.csv")
    ledger = read_csv(enrolled_path)
    already = {r["email"].lower() for r in ledger if r.get("status") in BLOCKING_STATUSES and r.get("email")}
    result = EnrollResult()
    unknown: list[dict] = []
    by_id: dict[str, dict] = {}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
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
            try:
                response = apollo.add_contacts(campaign_id, list(by_id), mailbox_id)
            except Exception as exc:
                unknown = [{**row, "contact_id": cid, "detail": f"add_contact_ids failed ({exc}); check the "
                            "sequence in Apollo before retrying"} for cid, row in by_id.items()]
                raise
            skipped = response.get("skipped_contact_ids") or {}
            for cid, row in by_id.items():
                if cid in skipped:
                    reason = skipped[cid] if isinstance(skipped[cid], str) else json.dumps(skipped[cid])
                    result.skipped.append({**row, "contact_id": cid, "detail": f"skipped by Apollo: {reason}"})
                else:
                    result.enrolled.append({**row, "contact_id": cid})
    finally:
        for status, items in (("enrolled", result.enrolled), ("skipped", result.skipped), ("enroll_unknown", unknown)):
            for item in items:
                ledger.append({"date": now, "target": slug, "campaign_id": campaign_id,
                               "contact_id": item.get("contact_id", ""), "name": item.get("name", ""),
                               "email": item.get("email", ""), "title": item.get("title", ""), "status": status,
                               "detail": item.get("detail", "")})
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
