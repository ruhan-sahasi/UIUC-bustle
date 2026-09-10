# backend/tests/test_hardening_followup.py
"""Second-wave hardening regression tests.

Covers the share-page security headers (no database needed — /t/{token}
renders without touching the pool) and the per-user schedule row cap
(Postgres-backed via the pg_pool fixture; skips when the test DB is absent).
"""
import os
import uuid
from unittest.mock import patch

from httpx import AsyncClient, ASGITransport
from starlette.testclient import TestClient

import main
from src.data.buildings_repo import create_class


# ── Share page security headers ─────────────────────────────────────────────

VALID_SHAPED_TOKEN = "abcDEF123456_-abcDEF12"  # matches [A-Za-z0-9_\-]{6,64}


def _assert_share_security_headers(resp) -> None:
    csp = resp.headers.get("Content-Security-Policy", "")
    assert csp, "share page must carry a Content-Security-Policy"
    assert "default-src 'none'" in csp
    assert "style-src 'unsafe-inline'" in csp
    assert "script-src 'unsafe-inline'" in csp
    assert "connect-src 'self'" in csp  # the page polls /share/trips/<t>/status
    assert "frame-ancestors 'none'" in csp  # no clickjacking overlays
    assert resp.headers.get("Referrer-Policy") == "no-referrer"
    assert resp.headers.get("X-Content-Type-Options") == "nosniff"
    # Live trip data behind a secret URL must never land in shared caches.
    assert resp.headers.get("Cache-Control") == "no-store"


def test_share_page_carries_security_headers():
    client = TestClient(main.app)
    resp = client.get(f"/t/{VALID_SHAPED_TOKEN}")
    assert resp.status_code == 200
    _assert_share_security_headers(resp)


def test_share_page_invalid_token_carries_security_headers():
    """The 'Invalid link' 400 page is HTML too and gets the same header set."""
    client = TestClient(main.app)
    resp = client.get("/t/no")  # too short for the token shape
    assert resp.status_code == 400
    _assert_share_security_headers(resp)


def test_share_page_has_meta_referrer_no_referrer():
    """Belt-and-braces: the HTML itself opts out of referrer leakage, so the
    secret token URL stays private even if the header is stripped upstream."""
    client = TestClient(main.app)
    resp = client.get(f"/t/{VALID_SHAPED_TOKEN}")
    assert resp.status_code == 200
    assert '<meta name="referrer" content="no-referrer">' in resp.text


# ── Per-user schedule row cap (Postgres-backed) ─────────────────────────────

def _client() -> AsyncClient:
    # ASGI transport keeps the app on the test's own event loop so the asyncpg
    # pool from pg_pool is safe to use (see test_share.py for the rationale).
    return AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test")


async def test_class_create_capped_at_100_per_user(pg_pool):
    """The 100th class is accepted; the 101st is rejected with 422 and no row
    is inserted past the cap."""
    user_id = f"cap-test-{uuid.uuid4()}"
    auth_headers = {"Authorization": "Bearer faketoken"}
    try:
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": "test-secret"}), \
             patch("src.auth.jwt.jwt.get_unverified_header", return_value={"alg": "HS256"}), \
             patch("src.auth.jwt.jwt.decode", return_value={"sub": user_id}), \
             patch.object(main, "get_pool", return_value=pg_pool):
            await pg_pool.execute(
                "INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", user_id
            )
            # Seed to one under the cap via the repo helper (avoids 99 HTTP
            # round-trips and the rate limiter), then exercise the endpoint
            # for the boundary rows.
            for i in range(main.MAX_CLASSES_PER_USER - 1):
                await create_class(
                    pg_pool,
                    title=f"Class {i}",
                    days_of_week=["MON"],
                    start_time_local="09:00",
                    user_id=user_id,
                )
            body = {
                "title": "Boundary class",
                "days_of_week": ["MON"],
                "start_time_local": "10:00",
                "building_id": "custom",
            }
            async with _client() as ac:
                at_cap = await ac.post("/schedule/classes", json=body, headers=auth_headers)
                assert at_cap.status_code == 201  # 100th row: still allowed
                over_cap = await ac.post("/schedule/classes", json=body, headers=auth_headers)
            assert over_cap.status_code == 422
            detail = over_cap.json()["detail"]
            assert "100" in detail and "limit" in detail.lower()
            count = await pg_pool.fetchval(
                "SELECT COUNT(*) FROM schedule_classes WHERE user_id = $1", user_id
            )
            assert count == main.MAX_CLASSES_PER_USER
    finally:
        await pg_pool.execute("DELETE FROM schedule_classes WHERE user_id = $1", user_id)
        await pg_pool.execute("DELETE FROM users WHERE user_id = $1", user_id)


async def test_class_create_under_cap_unaffected(pg_pool):
    """A user with a normal schedule is not impacted by the cap check."""
    user_id = f"cap-test-{uuid.uuid4()}"
    try:
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": "test-secret"}), \
             patch("src.auth.jwt.jwt.get_unverified_header", return_value={"alg": "HS256"}), \
             patch("src.auth.jwt.jwt.decode", return_value={"sub": user_id}), \
             patch.object(main, "get_pool", return_value=pg_pool):
            async with _client() as ac:
                r = await ac.post(
                    "/schedule/classes",
                    json={
                        "title": "CS 101",
                        "days_of_week": ["MON", "WED"],
                        "start_time_local": "09:00",
                        "building_id": "custom",
                    },
                    headers={"Authorization": "Bearer faketoken"},
                )
            assert r.status_code == 201
            assert r.json()["title"] == "CS 101"
    finally:
        await pg_pool.execute("DELETE FROM schedule_classes WHERE user_id = $1", user_id)
        await pg_pool.execute("DELETE FROM users WHERE user_id = $1", user_id)
