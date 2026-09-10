"""Postgres-backed tests for the crowding_repo DB helpers.

The pure decay algorithm is covered separately in test_crowding_decay.py; these
exercise the asyncpg queries (insert, recency window, per-token rate limit,
route grouping, cleanup).
"""
from src.data.crowding_repo import (
    insert_report,
    get_recent_reports,
    check_rate_limit,
    get_reports_by_route,
    delete_old_reports,
)


async def test_insert_and_get_recent(pg_pool):
    await insert_report(pg_pool, "V1", "22", None, 3, "tok-a", 40.1, -88.2)
    reports = await get_recent_reports(pg_pool, "V1")
    assert len(reports) == 1
    assert reports[0]["crowding_level"] == 3
    # TIMESTAMPTZ comes back timezone-aware from asyncpg.
    assert reports[0]["reported_at"].tzinfo is not None


async def test_get_recent_filters_by_vehicle(pg_pool):
    await insert_report(pg_pool, "V1", "22", None, 2, "t", None, None)
    await insert_report(pg_pool, "V2", "22", None, 4, "t", None, None)
    assert len(await get_recent_reports(pg_pool, "V1")) == 1


async def test_check_rate_limit(pg_pool):
    assert await check_rate_limit(pg_pool, "tok", "V1") is False
    await insert_report(pg_pool, "V1", "22", None, 2, "tok", None, None)
    assert await check_rate_limit(pg_pool, "tok", "V1") is True
    # A different token (different user) is not rate-limited for the same bus.
    assert await check_rate_limit(pg_pool, "other", "V1") is False


async def test_get_reports_by_route_grouped(pg_pool):
    await insert_report(pg_pool, "V1", "5", None, 1, "t", None, None)
    await insert_report(pg_pool, "V2", "5", None, 4, "t", None, None)
    # Different token: insert_report now atomically suppresses a same-token
    # duplicate for the same vehicle inside the 10-minute window.
    await insert_report(pg_pool, "V1", "5", None, 2, "t2", None, None)
    grouped = await get_reports_by_route(pg_pool, "5")
    assert set(grouped.keys()) == {"V1", "V2"}
    assert len(grouped["V1"]) == 2
    assert len(grouped["V2"]) == 1


async def test_delete_old_reports(pg_pool):
    await insert_report(pg_pool, "V1", "22", None, 3, "t", None, None)  # fresh
    # Backdate a second report 5 hours into the past.
    await pg_pool.execute(
        "INSERT INTO crowding_reports (vehicle_id, route_id, crowding_level, reported_at) "
        "VALUES ('V1', '22', 2, now() - interval '5 hours')"
    )
    deleted = await delete_old_reports(pg_pool, older_than_hours=2)
    assert deleted == 1
    # The fresh one survives.
    assert len(await get_recent_reports(pg_pool, "V1")) == 1
