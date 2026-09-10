# backend/tests/test_share.py
"""Tests for share-trip repo + endpoints (Postgres-backed)."""
from unittest.mock import patch

from httpx import AsyncClient, ASGITransport

import main
from src.share.repo import create_shared_trip, get_shared_trip_status, patch_shared_trip


def _client() -> AsyncClient:
    # ASGI transport runs the app on the test's own event loop, so the asyncpg
    # pool (created on that loop) is safe to use — unlike Starlette's TestClient,
    # which spins a separate loop and would trip asyncpg's cross-loop guard.
    return AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test")


# ── Repo unit tests (direct pool) ───────────────────────────────────────────

async def test_create_and_get_trip(pg_pool):
    token, edit_token = await create_shared_trip(pg_pool, "Siebel Center", "22", "Illini", "Green & Wright", "walking", 9999999999)
    assert len(token) >= 16  # high-entropy token (token_urlsafe(16) ≈ 22 chars)
    assert len(edit_token) >= 16 and edit_token != token
    status = await get_shared_trip_status(pg_pool, token)
    assert status is not None
    assert status["destination"] == "Siebel Center"
    assert status["phase"] == "walking"
    assert status["expired"] is False


async def test_patch_phase(pg_pool):
    token, edit_token = await create_shared_trip(pg_pool, "Siebel Center", "22", "Illini", "Stop A", "walking", None)
    assert await patch_shared_trip(pg_pool, token, edit_token, "on_bus", 9999999999) is True
    status = await get_shared_trip_status(pg_pool, token)
    assert status["phase"] == "on_bus"
    assert status["eta_epoch"] == 9999999999


async def test_patch_arrived_soft_expires(pg_pool):
    token, edit_token = await create_shared_trip(pg_pool, "Siebel", None, None, None, "on_bus", None)
    await patch_shared_trip(pg_pool, token, edit_token, "arrived", None)
    status = await get_shared_trip_status(pg_pool, token)
    assert status["expired"] is True


async def test_get_nonexistent_token(pg_pool):
    assert await get_shared_trip_status(pg_pool, "notfound") is None


async def test_patch_nonexistent_returns_false(pg_pool):
    assert await patch_shared_trip(pg_pool, "notfound", "sometoken", "on_bus", None) is False


# ── Endpoint integration tests (httpx ASGI) ─────────────────────────────────

async def test_post_share_trip(pg_pool):
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            r = await ac.post("/share/trips", json={
                "destination": "Siebel Center",
                "route_id": "22",
                "route_name": "Illini",
                "stop_name": "Green & Wright",
                "phase": "walking",
                "eta_epoch": 4102444800,
            })
    assert r.status_code == 200
    data = r.json()
    assert "token" in data
    assert len(data["token"]) >= 16
    # PUBLIC_BASE_URL is unset in tests, so url must be null (never derived
    # from the Host header); the creator gets the edit capability instead.
    assert data["url"] is None
    assert len(data["edit_token"]) >= 16


async def test_post_share_trip_invalid_phase(pg_pool):
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            r = await ac.post("/share/trips", json={"destination": "Siebel", "phase": "teleporting"})
    assert r.status_code == 400


async def test_patch_share_trip(pg_pool):
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            created = (await ac.post("/share/trips", json={"destination": "Siebel", "phase": "walking"})).json()
            token = created["token"]
            r = await ac.patch(f"/share/trips/{token}", json={"phase": "on_bus"},
                               headers={"X-Edit-Token": created["edit_token"]})
    assert r.status_code == 200


async def test_patch_expired_returns_404(pg_pool):
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            r = await ac.patch("/share/trips/notfound", json={"phase": "on_bus"})
    assert r.status_code == 404


async def test_get_status(pg_pool):
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            token = (await ac.post("/share/trips", json={"destination": "Siebel", "phase": "walking", "eta_epoch": 4102444800})).json()["token"]
            r = await ac.get(f"/share/trips/{token}/status")
    assert r.status_code == 200
    data = r.json()
    assert data["destination"] == "Siebel"
    assert data["expired"] is False


async def test_get_status_unknown_token_returns_expired(pg_pool):
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            r = await ac.get("/share/trips/unknownXX/status")
    assert r.status_code == 200
    assert r.json()["expired"] is True


async def test_share_page_html(pg_pool):
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            token = (await ac.post("/share/trips", json={"destination": "Siebel", "phase": "walking"})).json()["token"]
            r = await ac.get(f"/t/{token}")
    assert r.status_code == 200
    assert "UIUC Bustle" in r.text
    assert token in r.text
