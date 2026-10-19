"""Shared helpers: data paths, .env loading, CSV files, targets, and the one confirm prompt.

Everything this pipeline knows lives in plain files next to this script, so you can open any of
them in Numbers or a text editor:

    targets.csv              the roles you applied to and want to reach a recruiter about
    profile.md               who you are and the only facts the writer may use
    contacts.csv             every person Apollo revealed (resumable, one row per person)
    batch-<target>.csv       the enroll-ready cut for one target
    sequences/<target>.md    the email copy for one target (single source of truth)
    campaigns.csv            which Apollo sequence belongs to which target
    enrolled.csv             who was enrolled where and when (never enrolled twice)

The personal files are gitignored; only the code and the *.example files are committed.
"""
from __future__ import annotations

import csv
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

HERE = Path(__file__).resolve().parent


def data_dir() -> Path:
    return Path(os.environ.get("OUTBOUND_DATA_DIR") or HERE)


# --------------------------------------------------------------------------- .env


def load_env(path: Path | None = None) -> None:
    """KEY=VALUE lines from outbound/.env. Never overrides a variable that is already set."""
    path = path or (data_dir() / ".env")
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


def set_env_value(key: str, value: str, path: Path | None = None) -> None:
    """Write or replace one KEY=VALUE line in outbound/.env."""
    path = path or (data_dir() / ".env")
    lines = path.read_text().splitlines() if path.exists() else []
    out, replaced = [], False
    for line in lines:
        if line.split("=", 1)[0].strip() == key:
            out.append(f"{key}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(f"{key}={value}")
    path.write_text("\n".join(out) + "\n")
    os.environ[key] = value


# --------------------------------------------------------------------------- CSV


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    # utf-8-sig: Numbers and Excel add a byte-order mark when they export CSV.
    with path.open(newline="", encoding="utf-8-sig") as f:
        return [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in csv.DictReader(f)]


def write_csv(path: Path, rows: Iterable[dict], columns: list[str]) -> None:
    """Atomic write, so a crash mid-run never leaves a half-written ledger."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({c: row.get(c, "") for c in columns})
    tmp.replace(path)


def truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"y", "yes", "true", "1", "x"}


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60]


def clean_domain(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"^https?://", "", value).removeprefix("www.")
    return value.split("/")[0]


def email_domain(email: str) -> str:
    return email.rsplit("@", 1)[-1].strip().lower() if "@" in email else ""


def on_domain(email: str, domains: list[str]) -> bool:
    host = email_domain(email)
    return bool(host) and any(host == d or host.endswith("." + d) for d in domains if d)


def split_name(full: str) -> tuple[str, str]:
    parts = (full or "").strip().split()
    if not parts:
        return "", ""
    return parts[0], parts[-1] if len(parts) > 1 else ""


# --------------------------------------------------------------------------- targets

TARGET_COLUMNS = ["enabled", "company", "domain", "role", "track", "applied", "posting_url", "location",
                  "alt_domains", "notes", "slug"]


@dataclass
class Target:
    company: str
    domain: str
    role: str
    track: str = "swe"
    applied: bool = False
    enabled: bool = True
    posting_url: str = ""
    location: str = ""
    notes: str = ""
    alt_domains: list[str] = field(default_factory=list)
    slug: str = ""

    def __post_init__(self) -> None:
        self.domain = clean_domain(self.domain)
        self.alt_domains = [clean_domain(d) for d in self.alt_domains if d.strip()]
        self.track = (self.track or "swe").strip().lower()
        if not self.slug:
            self.slug = slugify(f"{self.company} {self.role}")

    @property
    def domains(self) -> list[str]:
        return [d for d in [self.domain, *self.alt_domains] if d]


class ConfigError(Exception):
    pass


def load_targets(path: Path | None = None, *, enabled_only: bool = True) -> list[Target]:
    path = path or (data_dir() / "targets.csv")
    if not path.exists():
        raise ConfigError(f"Missing {path}. Copy targets.example.csv to targets.csv and add the roles you applied to.")
    targets = []
    for n, row in enumerate(read_csv(path), start=2):
        if not row.get("company") and not row.get("role"):
            continue
        if not row.get("company") or not row.get("role"):
            raise ConfigError(f"targets.csv line {n}: company and role are both required")
        if not row.get("domain"):
            raise ConfigError(f"targets.csv line {n} ({row['company']}): add the company email domain, e.g. nvidia.com")
        t = Target(
            company=row["company"], domain=row["domain"], role=row["role"], track=row.get("track", "swe"),
            applied=truthy(row.get("applied")), enabled=truthy(row.get("enabled", "yes") or "yes"),
            posting_url=row.get("posting_url", ""), location=row.get("location", ""), notes=row.get("notes", ""),
            alt_domains=re.split(r"[;\s]+", row.get("alt_domains", "")), slug=row.get("slug", ""),
        )
        if t.track not in {"swe", "pm", "consulting"}:
            raise ConfigError(f"targets.csv line {n}: track must be swe, pm, or consulting (got {t.track!r})")
        targets.append(t)
    slugs = [t.slug for t in targets]
    dupes = sorted({s for s in slugs if slugs.count(s) > 1})
    if dupes:
        raise ConfigError(f"targets.csv has duplicate targets {dupes}; give one of them a distinct slug")
    return [t for t in targets if t.enabled] if enabled_only else targets


def pin_slugs(path: Path | None = None) -> list[str]:
    """Write each target's slug into targets.csv once, so editing the role wording later cannot
    silently turn one target into a new one (new sequence, new reveals, more recruiters)."""
    path = path or (data_dir() / "targets.csv")
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8-sig") as f:
        raw_rows = list(csv.reader(f))
    if not raw_rows:
        return []
    header = [h.strip() for h in raw_rows[0]]
    if any(not h for h in header) or len(set(header)) != len(header):
        raise ConfigError("targets.csv has a blank or repeated column name in its first row; fix the header "
                          "(columns: " + ", ".join(TARGET_COLUMNS) + ")")
    rows = []
    for n, values in enumerate(raw_rows[1:], start=2):
        if len(values) > len(header) and any(v.strip() for v in values[len(header):]):
            raise ConfigError(f"targets.csv line {n} has more cells than columns; a comma inside a value needs "
                              "quotes, e.g. \"Software Engineer Intern, Summer 2027\"")
        rows.append({h: (values[i] if i < len(values) else "") for i, h in enumerate(header)})
    pinned = []
    for row in rows:
        if (row.get("slug") or "").strip() or not row.get("company", "").strip() or not row.get("role", "").strip():
            continue
        row["slug"] = slugify(f"{row['company'].strip()} {row['role'].strip()}")
        pinned.append(row["slug"])
    if pinned:
        write_csv(path, rows, header if "slug" in header else [*header, "slug"])
    return pinned


def pick_targets(targets: list[Target], slug: str | None) -> list[Target]:
    if not slug:
        return targets
    chosen = [t for t in targets if t.slug == slug]
    if not chosen:
        known = ", ".join(t.slug for t in targets) or "(none enabled)"
        raise ConfigError(f"no enabled target {slug!r}. Enabled targets: {known}")
    return chosen


# --------------------------------------------------------------------------- confirm


def confirm(question: str, *, assume_yes: bool = False, input_fn: Callable[[str], str] = input) -> bool:
    """The one confirm before anything leaves: the person has to type yes."""
    if assume_yes:
        return True
    if not sys.stdin.isatty() and input_fn is input:
        print(f"{question}\nNot running in a terminal, so nothing was sent. Re-run with --yes to confirm.")
        return False
    return input_fn(f"{question} Type yes to continue: ").strip().lower() == "yes"
