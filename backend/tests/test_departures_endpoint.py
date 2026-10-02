"""Endpoint tests for /stops/{stop_id}/departures — source + generated_at signalling."""
from unittest.mock import AsyncMock

from starlette.testclient import TestClient

import main


def _client_with_departures(departures):
    mock_mtd = AsyncMock()
    mock_mtd.get_departures_by_stop = AsyncMock(
        return_value={"stop_id": "IT", "departures": departures}
    )
    main.app.state.mtd_client = mock_mtd
    return TestClient(main.app)


def _dep(is_realtime: bool):
    return {
        "route": "22", "headsign": "Illini", "expected_mins": 5,
        "expected_time_iso": None, "is_realtime": is_realtime,
    }


def test_departures_source_realtime_when_any_live():
    client = _client_with_departures([_dep(False), _dep(True)])
    try:
        r = client.get("/stops/IT/departures")
    finally:
        main.app.state.mtd_client = None
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "realtime"
    assert body["generated_at"] > 0


def test_departures_source_scheduled_when_none_live():
    client = _client_with_departures([_dep(False), _dep(False)])
    try:
        r = client.get("/stops/IT/departures")
    finally:
        main.app.state.mtd_client = None
    assert r.status_code == 200
    assert r.json()["source"] == "scheduled"


def test_departures_empty_is_scheduled():
    client = _client_with_departures([])
    try:
        r = client.get("/stops/IT/departures")
    finally:
        main.app.state.mtd_client = None
    assert r.status_code == 200
    assert r.json()["source"] == "scheduled"


def test_minutes_beyond_mtd_lookahead_are_clamped():
    client = _client_with_departures([_dep(True)])
    try:
        r = client.get("/stops/IT/departures", params={"minutes": 120})
        called_minutes = main.app.state.mtd_client.get_departures_by_stop.await_args
    finally:
        main.app.state.mtd_client = None
    assert r.status_code == 200
    assert 60 in called_minutes.args or called_minutes.kwargs.get("minutes") == 60
