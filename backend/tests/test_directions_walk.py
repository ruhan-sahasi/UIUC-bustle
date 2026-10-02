"""/directions/walk: input validation and fallback caching."""
from unittest.mock import patch

import httpx
import pytest
from starlette.testclient import TestClient

import main

SIEBEL = (40.1138, -88.2249)
UNION = (40.1092, -88.2272)


@pytest.fixture(autouse=True)
def _clear_cache():
    main._walk_directions_cache.clear()
    yield
    main._walk_directions_cache.clear()


def _params(orig, dest):
    return {"orig_lat": orig[0], "orig_lng": orig[1], "dest_lat": dest[0], "dest_lng": dest[1]}


@pytest.mark.parametrize(
    "orig,dest",
    [
        (("nan", SIEBEL[1]), UNION),  # NaN used to 500 on JSON encode
        (SIEBEL, (89.0, 170.0)),  # far outside the region fence
        ((0.0, 0.0), UNION),
    ],
)
def test_rejects_bad_coordinates(orig, dest):
    client = TestClient(main.app)
    resp = client.get("/directions/walk", params=_params(orig, dest))
    assert resp.status_code == 400


def test_osrm_failure_returns_uncached_straight_line():
    class _Boom:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            raise httpx.ConnectError("down")

    client = TestClient(main.app)
    with patch.object(httpx, "AsyncClient", _Boom):
        resp = client.get("/directions/walk", params=_params(SIEBEL, UNION))
    assert resp.status_code == 200
    assert resp.json() == {"coords": [list(SIEBEL), list(UNION)]}
    assert main._walk_directions_cache == {}
