"""hunt: find the right recruiters at each target and reveal only the best few.
cut:  turn contacts.csv into an enroll-ready batch per target.

Same shape as the vestige `mfg-hunt` / `cut-mfg` engines: search is free, each reveal costs one
Apollo email credit, every revealing run takes a cap, and the output CSV is resumable by Apollo
person id so a re-run never pays twice for the same person.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from apollo_api import Apollo, ApolloStop
from common import Target, data_dir, on_domain, read_csv, split_name, write_csv

# Who to look for, in the order Apollo search is asked. Ranking below decides who gets revealed.
RECRUITER_TITLES = [
    "University Recruiter", "Campus Recruiter", "Early Career Recruiter", "Emerging Talent Recruiter",
    "University Programs", "Internship Program Manager", "Technical Recruiter", "Recruiter",
    "Talent Acquisition Partner", "Talent Acquisition", "Recruiting Manager", "Head of Talent",
]
# Startups often have no recruiter in Apollo; then the hiring side is the right person.
FALLBACK_TITLES = {
    "swe": ["Engineering Manager", "Head of Engineering", "VP Engineering", "CTO", "Co-Founder", "Founder"],
    "pm": ["Head of Product", "Product Manager", "VP Product", "Co-Founder", "Founder"],
    "consulting": ["Partner", "Principal", "Managing Director", "Director"],
}
# Never worth a credit.
EXCLUDE = re.compile(
    r"\bexecutive (search|recruit)|\b(clinical|nurs\w*|healthcare|retail|store|warehouse|driver|hourly|field)\b.*recruit"
    r"|\b(recruiting|talent|hr|people)\s+intern\b|\bformer\b|\bassistant to\b",
    re.I,
)
EARLY_CAREER = re.compile(
    r"\b(universit(y|ies)|campus|early[\s-]?(career|talent)|emerging talent|students?|internships?|"
    r"intern program|new grads?|graduate (recruit\w*|programs?)|college|entry[\s-]level)\b", re.I)
RECRUITING = re.compile(r"\b(recruit(er|ers|ing|ment)?|talent (acquisition|partner|sourc\w*)|sourcer)\b", re.I)
TRACK_WORDS = {
    "swe": re.compile(r"\b(technical|engineering|software|tech|r&d|ai|ml|machine learning|data|developer)\b", re.I),
    "pm": re.compile(r"\b(product|technical|tech)\b", re.I),
    "consulting": re.compile(r"\b(consulting|advisory|business|campus)\b", re.I),
}

CONTACT_COLUMNS = ["target", "status", "source", "score", "name", "first", "last", "title", "company", "email",
                   "email_status", "linkedin", "city", "state", "apollo_person_id", "revealed_at"]
BATCH_COLUMNS = ["name", "first", "last", "email", "company", "title"]


def is_recruiter(title: str) -> bool:
    return bool(RECRUITING.search(title or "") or EARLY_CAREER.search(title or ""))


def score(title: str, track: str, source: str, fallback_titles: list[str]) -> float:
    title = title or ""
    if source == "fallback":
        lowered = title.lower()
        for i, wanted in enumerate(fallback_titles):
            if wanted.lower() in lowered:
                return 40 - 5 * i
        return 5
    s = 0.0
    if EARLY_CAREER.search(title):
        s += 60
    if RECRUITING.search(title):
        s += 30
        if TRACK_WORDS.get(track) and TRACK_WORDS[track].search(title):
            s += 15
    if re.search(r"\bcoordinator\b", title, re.I):
        s -= 6
    if re.search(r"\b(head|director|lead|manager|senior|sr\.?|principal)\b", title, re.I):
        s += 3
    return s


def rank(people: list[dict], target: Target, source: str) -> list[tuple[float, dict]]:
    fallback = FALLBACK_TITLES.get(target.track, [])
    out, seen = [], set()
    for p in people:
        pid, title = p.get("id"), (p.get("title") or "").strip()
        if not pid or pid in seen or not title or EXCLUDE.search(title):
            continue
        seen.add(pid)
        if not p.get("has_email"):  # no email behind it (or unknown): revealing would waste a credit
            continue
        if source == "recruiter" and not is_recruiter(title):
            continue
        out.append((score(title, target.track, source, fallback), p))
    out.sort(key=lambda item: item[0], reverse=True)
    return out


def usable(row: dict, target: Target) -> bool:
    """A contact we would actually email: found, verified, and on the company's own domain."""
    return (row.get("status") == "found" and row.get("email_status") == "verified"
            and on_domain(row.get("email", ""), target.domains))


@dataclass
class HuntReport:
    revealed: int = 0
    found: dict[str, int] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)


def _search(apollo: Apollo, target: Target, titles: list[str], pages: int = 2) -> list[dict]:
    people: list[dict] = []
    for page in range(1, pages + 1):
        batch = apollo.search_people(domains=target.domains, titles=titles, page=page, per_page=25,
                                     locations=["United States"])
        people += batch
        if len(batch) < 25:
            break
    return people


def hunt(apollo: Apollo, targets: list[Target], *, per_company: int = 2, max_reveals: int = 10,
         path: Path | None = None, pause: float = 0.8, sleep: Callable[[float], None] | None = None,
         log: Callable[[str], None] = print) -> HuntReport:
    sleep = sleep or time.sleep
    path = path or (data_dir() / "contacts.csv")
    rows = read_csv(path)
    # Errored reveals are retried on a later run; only real Apollo answers count as known.
    rows = [r for r in rows if not r.get("status", "").startswith("error")]
    known = {r["apollo_person_id"] for r in rows if r.get("apollo_person_id")}
    report = HuntReport()
    try:
        for target in targets:
            have = sum(1 for r in rows if r.get("target") == target.slug and usable(r, target))
            if have >= per_company:
                report.found[target.slug] = have
                continue
            ranked = rank(_search(apollo, target, RECRUITER_TITLES), target, "recruiter")
            source = "recruiter"
            if not ranked:
                fallback = FALLBACK_TITLES.get(target.track, [])
                ranked = rank(_search(apollo, target, fallback, pages=1), target, "fallback")
                source = "fallback"
                if ranked:
                    log(f"[hunt] {target.slug}: no recruiters in Apollo, trying hiring-side titles")
            for s, p in ranked:
                if have >= per_company or report.revealed >= max_reveals:
                    break
                if p["id"] in known:
                    continue
                try:
                    person = apollo.match(id=p["id"])
                except ApolloStop:
                    raise  # rate limit, bad key, no credits: stop the run, keep what was paid for
                except Exception as exc:  # one odd answer should not end the run; retried next time
                    log(f"[hunt] {target.slug}: reveal of {p.get('first_name', '')} failed ({str(exc)[:80]}), "
                        "will retry next run")
                    continue
                known.add(p["id"])
                report.revealed += 1
                first, last = person["first_name"], person["last_name"]
                if not first:
                    first, last = split_name(person["name"])
                row = {
                    "target": target.slug, "status": "found" if person["email"] else "no_email", "source": source,
                    "score": f"{s:.0f}", "name": person["name"] or p.get("first_name", ""), "first": first,
                    "last": last, "title": person["title"] or p.get("title", ""),
                    "company": person["company"] or target.company, "email": person["email"],
                    "email_status": person["email_status"], "linkedin": person["linkedin"], "city": person["city"],
                    "state": person["state"], "apollo_person_id": p["id"],
                    "revealed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
                rows.append(row)
                good = usable(row, target)
                have += good
                log(f"[hunt] {target.slug}: {row['name']} | {row['title']} | {row['email'] or 'no email'} "
                    f"({row['email_status'] or '-'}){'' if good else '  (not usable)'}")
                sleep(pause)
            report.found[target.slug] = have
            if have == 0:
                report.notes.append(f"{target.slug}: no verified recruiter email yet (check the domain in targets.csv)")
            if report.revealed >= max_reveals:
                report.notes.append(f"stopped at --max {max_reveals} reveals; run hunt again to continue")
                break
    finally:
        write_csv(path, rows, CONTACT_COLUMNS)  # keep what was paid for, even if a later call fails
    return report


def enrolled_emails(path: Path | None = None) -> set[str]:
    """Everyone enrolled anywhere, or whose enrollment outcome is unknown: never offered again."""
    path = path or (data_dir() / "enrolled.csv")
    return {r["email"].lower() for r in read_csv(path)
            if r.get("email") and r.get("status") in ("enrolled", "enroll_unknown")}


def cut(targets: list[Target], *, contacts_path: Path | None = None, enrolled_path: Path | None = None,
        out_dir: Path | None = None, per_company: int = 2) -> dict[str, int]:
    """Write batch-<slug>.csv per target: usable contacts not already enrolled anywhere."""
    out_dir = out_dir or data_dir()
    contacts = read_csv(contacts_path or (data_dir() / "contacts.csv"))
    done = enrolled_emails(enrolled_path)
    counts = {}
    for target in targets:
        best: dict[str, dict] = {}
        for c in contacts:
            if c.get("target") != target.slug or not usable(c, target):
                continue
            email = c["email"].lower()
            if email in done or email in best:
                continue
            best[email] = c
        chosen = sorted(best.values(), key=lambda c: float(c.get("score") or 0), reverse=True)[:per_company]
        rows = [{"name": c["name"], "first": c["first"], "last": c["last"], "email": c["email"],
                 "company": target.company, "title": c["title"]} for c in chosen]
        write_csv(out_dir / f"batch-{target.slug}.csv", rows, BATCH_COLUMNS)
        counts[target.slug] = len(rows)
    return counts
