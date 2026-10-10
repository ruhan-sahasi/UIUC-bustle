"""SQLite ledger: every target, contact, research brief, message and send lives here.

The ledger is what makes the pipeline idempotent: each stage only picks up rows that the
previous stage finished and that do not already have output, so `outreach run` can be
re-run (or crash halfway) without double-spending Apollo credits or double-emailing anyone.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS targets (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    domain TEXT,
    track TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,
    enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL,
    discovery_state TEXT NOT NULL DEFAULT 'pending',   -- pending | done | no_contacts | failed
    research_state TEXT NOT NULL DEFAULT 'pending',    -- pending | done | no_facts | failed
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY,
    target_id INTEGER NOT NULL REFERENCES targets(id),
    apollo_id TEXT,
    first_name TEXT,
    last_name TEXT,
    title TEXT,
    email TEXT,
    email_status TEXT,
    linkedin_url TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    score REAL,
    source TEXT,                                        -- recruiter | fallback
    status TEXT NOT NULL DEFAULT 'new',                 -- new | drafted | contacted | replied | bounced | do_not_contact
    raw_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (target_id, apollo_id)
);
-- One person is only ever emailed about one role, even if they recruit for several.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_unique ON contacts(lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS research (
    target_id INTEGER PRIMARY KEY REFERENCES targets(id),
    brief TEXT NOT NULL,
    data_json TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    dropped_json TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    kind TEXT NOT NULL,                                 -- initial | followup
    parent_id INTEGER REFERENCES messages(id),
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    attachment TEXT,
    lint_json TEXT NOT NULL DEFAULT '[]',
    meta_json TEXT NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,                               -- draft | needs_attention | approved | rejected | sent | failed
    message_id TEXT,
    sent_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (contact_id, kind)
);

CREATE TABLE IF NOT EXISTS suppression (
    value TEXT PRIMARY KEY,                             -- an email address or a bare domain
    reason TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT,
    detail TEXT
);

CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    service TEXT NOT NULL,                              -- apollo | anthropic
    operation TEXT NOT NULL,
    units_json TEXT NOT NULL
);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class DB:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ------------------------------------------------------------------ helpers
    def _exec(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        cur = self.conn.execute(sql, tuple(params))
        self.conn.commit()
        return cur

    def _all(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        return list(self.conn.execute(sql, tuple(params)).fetchall())

    def _one(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
        return self.conn.execute(sql, tuple(params)).fetchone()

    def _update(self, table: str, row_id: int, fields: dict[str, Any]) -> None:
        if not fields:
            return
        fields = {**fields, "updated_at": utcnow()} if table != "research" else fields
        cols = ", ".join(f"{k} = ?" for k in fields)
        self._exec(f"UPDATE {table} SET {cols} WHERE id = ?", [*fields.values(), row_id])

    # ------------------------------------------------------------------ targets
    def upsert_target(self, target) -> int:
        now = utcnow()
        cfg = target.model_dump_json()
        existing = self._one("SELECT id FROM targets WHERE slug = ?", [target.slug])
        if existing:
            self._exec(
                "UPDATE targets SET company=?, role=?, domain=?, track=?, priority=?, enabled=?, "
                "config_json=?, updated_at=? WHERE id=?",
                [target.company, target.role, target.domain, target.track, target.priority,
                 int(target.enabled), cfg, now, existing["id"]],
            )
            return existing["id"]
        cur = self._exec(
            "INSERT INTO targets (slug, company, role, domain, track, priority, enabled, config_json, "
            "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [target.slug, target.company, target.role, target.domain, target.track, target.priority,
             int(target.enabled), cfg, now, now],
        )
        return cur.lastrowid

    def targets(self, *, enabled_only: bool = True, slug: str | None = None) -> list[sqlite3.Row]:
        sql = "SELECT * FROM targets WHERE 1=1"
        params: list[Any] = []
        if enabled_only:
            sql += " AND enabled = 1"
        if slug:
            sql += " AND slug = ?"
            params.append(slug)
        return self._all(sql + " ORDER BY priority, id", params)

    def target(self, target_id: int) -> sqlite3.Row:
        return self._one("SELECT * FROM targets WHERE id = ?", [target_id])

    def update_target(self, row_id: int, /, **fields) -> None:
        self._update("targets", row_id, fields)

    # ------------------------------------------------------------------ contacts
    def add_contact(self, target_id: int, person: dict, *, score: float, source: str) -> int | None:
        """Insert an enriched person. Returns None if this email is already in the ledger."""
        email = (person.get("email") or "").strip().lower() or None
        if email and self._one("SELECT id FROM contacts WHERE lower(email) = ?", [email]):
            return None
        now = utcnow()
        try:
            cur = self._exec(
                "INSERT INTO contacts (target_id, apollo_id, first_name, last_name, title, email, email_status, "
                "linkedin_url, city, state, country, score, source, raw_json, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [target_id, person.get("id"), person.get("first_name"), person.get("last_name"),
                 person.get("title"), email, person.get("email_status"), person.get("linkedin_url"),
                 person.get("city"), person.get("state"), person.get("country"), score, source,
                 json.dumps(person), now, now],
            )
        except sqlite3.IntegrityError:
            return None
        return cur.lastrowid

    def contacts(self, *, target_id: int | None = None, status: str | None = None) -> list[sqlite3.Row]:
        sql = "SELECT * FROM contacts WHERE 1=1"
        params: list[Any] = []
        if target_id is not None:
            sql += " AND target_id = ?"
            params.append(target_id)
        if status:
            sql += " AND status = ?"
            params.append(status)
        return self._all(sql + " ORDER BY target_id, score DESC, id", params)

    def contact(self, contact_id: int) -> sqlite3.Row:
        return self._one("SELECT * FROM contacts WHERE id = ?", [contact_id])

    def contact_by_email(self, email: str) -> sqlite3.Row | None:
        return self._one("SELECT * FROM contacts WHERE lower(email) = ?", [email.lower()])

    def update_contact(self, row_id: int, /, **fields) -> None:
        self._update("contacts", row_id, fields)

    # ------------------------------------------------------------------ research
    def save_research(self, target_id: int, *, brief: str, data: dict, sources: list, dropped: list,
                      model: str) -> None:
        self._exec(
            "INSERT OR REPLACE INTO research (target_id, brief, data_json, sources_json, dropped_json, model, "
            "created_at) VALUES (?,?,?,?,?,?,?)",
            [target_id, brief, json.dumps(data), json.dumps(sources), json.dumps(dropped), model, utcnow()],
        )

    def research(self, target_id: int) -> dict | None:
        row = self._one("SELECT * FROM research WHERE target_id = ?", [target_id])
        if not row:
            return None
        return {
            "brief": row["brief"],
            "data": json.loads(row["data_json"]),
            "sources": json.loads(row["sources_json"]),
            "dropped": json.loads(row["dropped_json"]),
            "model": row["model"],
            "created_at": row["created_at"],
        }

    def delete_research(self, target_id: int) -> None:
        self._exec("DELETE FROM research WHERE target_id = ?", [target_id])

    # ------------------------------------------------------------------ messages
    def create_message(self, *, contact_id: int, kind: str, subject: str, body: str, attachment: str | None,
                       lint: list, meta: dict, attempts: int, status: str, parent_id: int | None = None) -> int:
        now = utcnow()
        cur = self._exec(
            "INSERT INTO messages (contact_id, kind, parent_id, subject, body, attachment, lint_json, meta_json, "
            "attempts, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [contact_id, kind, parent_id, subject, body, attachment, json.dumps(lint), json.dumps(meta),
             attempts, status, now, now],
        )
        return cur.lastrowid

    def message(self, message_id: int) -> sqlite3.Row | None:
        return self._one("SELECT * FROM messages WHERE id = ?", [message_id])

    def message_for(self, contact_id: int, kind: str) -> sqlite3.Row | None:
        return self._one("SELECT * FROM messages WHERE contact_id = ? AND kind = ?", [contact_id, kind])

    def messages(self, *, status: str | Iterable[str] | None = None, kind: str | None = None) -> list[sqlite3.Row]:
        sql = "SELECT * FROM messages WHERE 1=1"
        params: list[Any] = []
        if status:
            statuses = [status] if isinstance(status, str) else list(status)
            sql += f" AND status IN ({','.join('?' * len(statuses))})"
            params += statuses
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        return self._all(sql + " ORDER BY id", params)

    def update_message(self, row_id: int, /, **fields) -> None:
        self._update("messages", row_id, fields)

    def delete_message(self, message_id: int) -> None:
        self._exec("DELETE FROM messages WHERE id = ?", [message_id])

    def sent_messages(self) -> list[sqlite3.Row]:
        return self._all(
            "SELECT m.*, c.target_id, c.email FROM messages m JOIN contacts c ON c.id = m.contact_id "
            "WHERE m.status = 'sent' ORDER BY m.sent_at"
        )

    # ------------------------------------------------------------------ suppression
    def suppress(self, value: str, reason: str) -> None:
        self._exec(
            "INSERT OR REPLACE INTO suppression (value, reason, created_at) VALUES (?,?,?)",
            [value.strip().lower(), reason, utcnow()],
        )

    def is_suppressed(self, email: str) -> bool:
        email = email.strip().lower()
        domain = email.split("@")[-1]
        return bool(self._one("SELECT 1 FROM suppression WHERE value IN (?, ?)", [email, domain]))

    def suppression(self) -> list[sqlite3.Row]:
        return self._all("SELECT * FROM suppression ORDER BY created_at")

    # ------------------------------------------------------------------ events and usage
    def log(self, kind: str, ref: str | None = None, detail: Any = None, *, ts: str | None = None) -> None:
        if detail is not None and not isinstance(detail, str):
            detail = json.dumps(detail, default=str)
        self._exec("INSERT INTO events (ts, kind, ref, detail) VALUES (?,?,?,?)", [ts or utcnow(), kind, ref, detail])

    def events(self, limit: int = 50) -> list[sqlite3.Row]:
        return self._all("SELECT * FROM events ORDER BY id DESC LIMIT ?", [limit])

    def last_event_ts(self, kind: str) -> str | None:
        row = self._one("SELECT ts FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1", [kind])
        return row["ts"] if row else None

    def record_usage(self, service: str, operation: str, units: dict) -> None:
        self._exec(
            "INSERT INTO usage (ts, service, operation, units_json) VALUES (?,?,?,?)",
            [utcnow(), service, operation, json.dumps(units)],
        )

    def usage_totals(self) -> dict[str, dict[str, float]]:
        totals: dict[str, dict[str, float]] = {}
        for row in self._all("SELECT service, units_json FROM usage"):
            bucket = totals.setdefault(row["service"], {})
            for key, value in json.loads(row["units_json"]).items():
                if isinstance(value, (int, float)):
                    bucket[key] = bucket.get(key, 0) + value
        return totals
