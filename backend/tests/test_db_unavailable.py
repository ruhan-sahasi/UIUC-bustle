"""Every DB-backed route answers 503, not 500, while the pool is down."""
from unittest.mock import patch

import pytest
from starlette.testclient import TestClient

import main
from src.data.db import DatabaseUnavailable


def _no_pool():
    raise DatabaseUnavailable("Database pool not initialized")


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("get", "/crowding/route/22", None),
        ("get", "/crowding/bus123?route_id=22", None),
        ("get", "/share/trips/abcdef123456/status", None),
    ],
)
def test_db_down_is_503(method, path, body):
    client = TestClient(main.app, raise_server_exceptions=False)
    with patch.object(main, "get_pool", _no_pool):
        r = getattr(client, method)(path, json=body) if body else getattr(client, method)(path)
    assert r.status_code == 503
    assert r.json() == {"detail": "Database unavailable"}


def test_database_unavailable_is_still_a_runtime_error():
    # Existing `except RuntimeError` blocks around get_pool() rely on this.
    assert issubclass(DatabaseUnavailable, RuntimeError)
