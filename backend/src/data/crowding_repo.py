"""Crowding data repository — Postgres via the asyncpg pool.

Provides:
- Pure decay algorithm (compute_weighted_level / _weight) — no DB dependency
- Async DB helpers (insert_report, get_recent_reports, check_rate_limit,
  get_reports_by_route, delete_old_reports); insert_report enforces the
  per-token/vehicle rate-limit window atomically in a single statement

The crowding_reports table is created by Alembic migration 0003 (not here),
so reports persist in Postgres and are shared across instances.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, Optional, TypedDict

import asyncpg


# ---------------------------------------------------------------------------
# Pure decay algorithm (no DB dependency — fully unit-testable)
# ---------------------------------------------------------------------------

@dataclass
class CrowdingAggregate:
    level: int        # 1–4
    confidence: str   # "low" | "medium" | "high"
    source: Literal["crowdsourced"]  # always "crowdsourced" from this function
    report_count: int


class ReportRow(TypedDict):
    crowding_level: int
    reported_at: datetime


def _weight(reported_at: datetime) -> float:
    """Return the decay weight for a single report.

    Age is measured in minutes from now (UTC).
    - age > 60 min → 0.0
    - age > 40 min → 0.25
    - age > 20 min → 0.5
    - else         → 1.0

    Boundaries use strict > comparisons, so exactly 20/40/60 min fall in the
    *higher-weight* bucket.
    """
    now = datetime.now(timezone.utc)
    age_min = (now - reported_at).total_seconds() / 60.0
    if age_min > 60:
        return 0.0
    if age_min > 40:
        return 0.25
    if age_min > 20:
        return 0.5
    return 1.0


def compute_weighted_level(reports: list[ReportRow]) -> Optional[CrowdingAggregate]:
    """Compute a weighted crowding aggregate from a list of raw reports.

    Each report dict must contain:
        - "crowding_level": int (1–4)
        - "reported_at": datetime (timezone-aware)

    Returns None if there are no active (weight > 0) reports.
    """
    total_weight = 0.0
    weighted_sum = 0.0
    active_count = 0

    for report in reports:
        w = _weight(report["reported_at"])
        if w == 0.0:
            continue
        weighted_sum += report["crowding_level"] * w
        total_weight += w
        active_count += 1

    if active_count == 0:
        return None

    raw_level = weighted_sum / total_weight
    level = max(1, min(4, round(raw_level)))

    if active_count >= 5:
        confidence = "high"
    elif active_count >= 2:
        confidence = "medium"
    else:
        confidence = "low"

    return CrowdingAggregate(
        level=level,
        confidence=confidence,
        source="crowdsourced",
        report_count=active_count,
    )


# ---------------------------------------------------------------------------
# Async DB helpers (asyncpg pool)
#
# Time windows use `now() - make_interval(...)` evaluated in Postgres, and
# TIMESTAMPTZ columns come back from asyncpg as timezone-aware datetimes, so
# no client-side parsing/tz handling is needed.
# ---------------------------------------------------------------------------

async def insert_report(
    pool: asyncpg.Pool,
    vehicle_id: str,
    route_id: str,
    trip_id: Optional[str],
    crowding_level: int,
    user_token: Optional[str],
    lat: Optional[float],
    lon: Optional[float],
) -> bool:
    """Insert a new crowding report, atomically enforcing the rate-limit window.

    The insert and the per-token/vehicle duplicate check run as ONE conditional
    statement, so concurrent requests cannot race a check-then-insert (TOCTOU).
    The window matches check_rate_limit's default (10 minutes).

    Returns True if a row was inserted, False if the report was suppressed as a
    duplicate within the window. Callers may ignore the return value; a raced
    duplicate simply becomes a silent no-op.

    A transaction-scoped advisory lock on (token, vehicle) serializes truly
    simultaneous statements: WHERE NOT EXISTS alone is not atomic under READ
    COMMITTED (two concurrent inserts each see an empty window and both land).
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(coalesce($1, '') || ':' || $2, 0))",
                user_token, vehicle_id,
            )
            row = await conn.fetchrow(
                """
                INSERT INTO crowding_reports
                    (vehicle_id, route_id, trip_id, crowding_level,
                     anonymous_user_token, lat, lon)
                SELECT $1, $2, $3, $4, $5, $6, $7
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM   crowding_reports
                    WHERE  anonymous_user_token = $5
                      AND  vehicle_id = $1
                      AND  reported_at > now() - make_interval(mins => 10)
                )
                RETURNING 1
                """,
                vehicle_id, route_id, trip_id, crowding_level, user_token, lat, lon,
            )
    return row is not None


async def get_recent_reports(
    pool: asyncpg.Pool,
    vehicle_id: str,
    max_age_minutes: int = 60,
) -> list[dict]:
    """Return recent reports for a vehicle within the age window."""
    rows = await pool.fetch(
        """
        SELECT crowding_level, reported_at
        FROM   crowding_reports
        WHERE  vehicle_id = $1
          AND  reported_at > now() - make_interval(mins => $2)
        ORDER  BY reported_at DESC
        """,
        vehicle_id, max_age_minutes,
    )
    return [
        {"crowding_level": row["crowding_level"], "reported_at": row["reported_at"]}
        for row in rows
    ]


async def check_rate_limit(
    pool: asyncpg.Pool,
    user_token: str,
    vehicle_id: str,
    window_minutes: int = 10,
) -> bool:
    """Return True if the user already reported this vehicle within the window."""
    row = await pool.fetchrow(
        """
        SELECT 1
        FROM   crowding_reports
        WHERE  anonymous_user_token = $1
          AND  vehicle_id = $2
          AND  reported_at > now() - make_interval(mins => $3)
        LIMIT  1
        """,
        user_token, vehicle_id, window_minutes,
    )
    return row is not None


async def get_reports_by_route(
    pool: asyncpg.Pool,
    route_id: str,
    max_age_minutes: int = 60,
) -> dict[str, list[dict]]:
    """Return all recent reports for a route, grouped by vehicle_id."""
    rows = await pool.fetch(
        """
        SELECT vehicle_id, crowding_level, reported_at
        FROM   crowding_reports
        WHERE  route_id = $1
          AND  reported_at > now() - make_interval(mins => $2)
        ORDER  BY reported_at DESC
        """,
        route_id, max_age_minutes,
    )
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["vehicle_id"], []).append(
            {"crowding_level": row["crowding_level"], "reported_at": row["reported_at"]}
        )
    return grouped


async def delete_old_reports(
    pool: asyncpg.Pool,
    older_than_hours: int = 2,
) -> int:
    """Delete reports older than *older_than_hours* and return the row count."""
    result = await pool.execute(
        "DELETE FROM crowding_reports WHERE reported_at < now() - make_interval(hours => $1)",
        older_than_hours,
    )
    # asyncpg returns a status string like "DELETE 5".
    try:
        return int(result.split()[-1])
    except (ValueError, IndexError, AttributeError):
        return 0
