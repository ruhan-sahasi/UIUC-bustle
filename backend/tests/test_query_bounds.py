"""Query-parameter bounds on the public lookup endpoints."""
from unittest.mock import AsyncMock, patch

from starlette.testclient import TestClient

import main


def test_stops_nearby_requires_coordinates():
    # Missing lat/lng used to default to 0,0 and fail the region check with a
    # misleading "outside the supported region" message.
    r = TestClient(main.app).get("/stops/nearby")
    assert r.status_code == 422


def test_autocomplete_negative_limit_is_clamped():
    search = AsyncMock(return_value=[])
    # Stub the external geocoders so the test never touches the network.
    with patch.object(main, "get_pool", return_value=object()), \
         patch.object(main, "search_buildings", search), \
         patch.object(main.settings, "google_places_api_key", ""), \
         patch.object(main, "_overpass_poi_search", AsyncMock(return_value=[])), \
         patch.object(main, "_nominatim_quick", AsyncMock(return_value=[])):
        r = TestClient(main.app).get("/autocomplete", params={"q": "siebel", "limit": -1})
    assert r.status_code == 200
    search.assert_awaited_once()
    assert search.await_args.args[2] == 1  # LIMIT 1, not LIMIT -1
