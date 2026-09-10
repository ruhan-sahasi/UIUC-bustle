"""Exploit reproduction: TOCTOU on crowding report inserts.

Before the fix, main.py's check-then-insert (check_rate_limit followed by an
unconditional insert_report) let concurrent requests for the same
token+vehicle all pass the check and insert — 30 concurrent reports were
measured to produce 16 rows. insert_report is now a single conditional
INSERT ... SELECT ... WHERE NOT EXISTS, so exactly one row can land inside the
10-minute window regardless of concurrency.

Skips without TEST_DATABASE_URL. Uses its own pool (no TRUNCATE) and cleans up
only its own rows, so it is safe to run alongside other DB-backed tests.
"""
import asyncio
import os
import uuid

import pytest
import pytest_asyncio

from src.data.crowding_repo import insert_report

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL not set; Postgres-backed exploit test skipped",
)


@pytest_asyncio.fixture
async def pool():
    import asyncpg

    try:
        pool = await asyncpg.create_pool(
            os.environ["TEST_DATABASE_URL"], min_size=1, max_size=10
        )
    except Exception as e:  # noqa: BLE001 - any connection failure → skip
        pytest.skip(f"Postgres not available: {e}")
        return
    try:
        yield pool
    finally:
        await pool.close()


async def test_concurrent_reports_insert_exactly_one_row(pool):
    token = f"atomic-test-{uuid.uuid4()}"
    vehicle_id = f"VA-{uuid.uuid4().hex[:8]}"
    try:
        results = await asyncio.gather(
            *(
                insert_report(pool, vehicle_id, "22", None, 3, token, 40.1, -88.2)
                for _ in range(30)
            )
        )
        count = await pool.fetchval(
            "SELECT count(*) FROM crowding_reports "
            "WHERE anonymous_user_token = $1 AND vehicle_id = $2",
            token, vehicle_id,
        )
        # On pre-fix main the unconditional INSERT races the separate
        # check_rate_limit call: 30 concurrent reports produced 16 rows.
        assert count == 1
        # Exactly one call reports having inserted; the rest are no-ops.
        assert sum(1 for r in results if r) == 1
    finally:
        await pool.execute(
            "DELETE FROM crowding_reports WHERE anonymous_user_token = $1", token
        )


async def test_second_report_after_window_is_allowed(pool):
    """The suppression is scoped to the 10-minute window, not forever."""
    token = f"atomic-test-{uuid.uuid4()}"
    vehicle_id = f"VA-{uuid.uuid4().hex[:8]}"
    try:
        assert await insert_report(pool, vehicle_id, "22", None, 2, token, None, None) is True
        # Inside the window: suppressed.
        assert await insert_report(pool, vehicle_id, "22", None, 4, token, None, None) is False
        # Backdate the existing report past the window; a new one is accepted.
        await pool.execute(
            "UPDATE crowding_reports "
            "SET reported_at = now() - interval '11 minutes' "
            "WHERE anonymous_user_token = $1",
            token,
        )
        assert await insert_report(pool, vehicle_id, "22", None, 4, token, None, None) is True
    finally:
        await pool.execute(
            "DELETE FROM crowding_reports WHERE anonymous_user_token = $1", token
        )
