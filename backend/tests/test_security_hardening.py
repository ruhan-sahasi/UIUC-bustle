# backend/tests/test_security_hardening.py
"""Security-hardening regression tests (PR-1).

Covers the share-trip edit-capability split, input bounds (eta_epoch, NUL
bytes), the request body size cap, and the Host-header-free share URL.
DB-backed tests use the pg_pool fixture and skip when Postgres is absent;
the validation/middleware tests run without a database.
"""
from unittest.mock import patch

from httpx import AsyncClient, ASGITransport

import main
from src.share.models import ETA_EPOCH_MAX


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test")


async def _create(ac: AsyncClient) -> dict:
    r = await ac.post("/share/trips", json={"destination": "Siebel", "phase": "walking"})
    assert r.status_code == 200
    return r.json()


# ── Edit-capability split ───────────────────────────────────────────────────

async def test_patch_without_edit_token_is_404(pg_pool):
    """The public read token alone must no longer be able to mutate the trip."""
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            created = await _create(ac)
            r = await ac.patch(f"/share/trips/{created['token']}", json={"phase": "arrived"})
            assert r.status_code == 404
            # And the trip was NOT mutated.
            status = (await ac.get(f"/share/trips/{created['token']}/status")).json()
            assert status["phase"] == "walking"


async def test_patch_with_read_token_as_edit_token_is_404(pg_pool):
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            created = await _create(ac)
            r = await ac.patch(
                f"/share/trips/{created['token']}",
                json={"phase": "arrived"},
                headers={"X-Edit-Token": created["token"]},
            )
            assert r.status_code == 404


async def test_patch_with_edit_token_succeeds(pg_pool):
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            created = await _create(ac)
            r = await ac.patch(
                f"/share/trips/{created['token']}",
                json={"phase": "on_bus"},
                headers={"X-Edit-Token": created["edit_token"]},
            )
            assert r.status_code == 200
            status = (await ac.get(f"/share/trips/{created['token']}/status")).json()
            assert status["phase"] == "on_bus"


async def test_read_paths_need_only_public_token(pg_pool):
    """/t/{token} page and /share/trips/{token}/status stay readable with the read token."""
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            created = await _create(ac)
            page = await ac.get(f"/t/{created['token']}")
            assert page.status_code == 200
            status = await ac.get(f"/share/trips/{created['token']}/status")
            assert status.status_code == 200
            assert status.json()["expired"] is False


async def test_create_returns_edit_token_and_no_host_derived_url(pg_pool):
    """With PUBLIC_BASE_URL unset the url must be null — never built from the
    client-controlled Host header — and the creator gets the edit capability."""
    assert main.settings.public_base_url == ""
    with patch("main.get_pool", return_value=pg_pool):
        async with _client() as ac:
            created = await _create(ac)
    assert created["url"] is None
    assert len(created["edit_token"]) >= 16
    assert created["edit_token"] != created["token"]


# ── Input bounds (no DB needed: rejected before the handler runs) ───────────

async def test_eta_epoch_overflow_rejected_422():
    """2**70 previously overflowed asyncpg's BIGINT binding into a 500."""
    async with _client() as ac:
        r = await ac.post(
            "/share/trips",
            json={"destination": "Siebel", "phase": "walking", "eta_epoch": 2**70},
        )
    assert r.status_code == 422


async def test_eta_epoch_at_bound_is_shape_valid():
    """ETA at the documented max passes validation (may still 500 later without
    a DB pool — validation is what is under test, so only assert not-422)."""
    async with _client() as ac:
        try:
            r = await ac.post(
                "/share/trips",
                json={"destination": "Siebel", "phase": "walking", "eta_epoch": ETA_EPOCH_MAX},
            )
            assert r.status_code != 422
        except RuntimeError:
            pass  # no pool configured in this environment — validation passed


async def test_nul_byte_in_string_rejected_422():
    async with _client() as ac:
        r = await ac.post(
            "/share/trips",
            json={"destination": "Siebel\x00Center", "phase": "walking"},
        )
    assert r.status_code == 422


async def test_nul_byte_in_crowding_report_rejected_422():
    async with _client() as ac:
        r = await ac.post(
            "/crowding/report",
            json={"vehicle_id": "V\x001", "route_id": "22", "crowding_level": 3},
        )
    assert r.status_code == 422


async def test_oversized_body_rejected_413():
    big = "x" * (main.MAX_BODY_BYTES + 1)
    async with _client() as ac:
        r = await ac.post(
            "/share/trips",
            content=('{"destination": "' + big + '"}').encode(),
            headers={"Content-Type": "application/json"},
        )
    assert r.status_code == 413
