"""Auth-middleware log redaction: 401 warnings must never leak share tokens.

The auth-failure warning in src.middleware.auth used to log the raw request
path, so a rejected request to /share/trips/<token>/status put the capability
token straight into the logs — defeating the redaction in request_logging.py.
These tests exercise a 401 against a token-bearing path and assert the token
never reaches the log record. /metrics is also no longer auth-exempt.
"""
import logging

from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from src.middleware.auth import AUTH_EXEMPT_PATHS, OptionalAPIKeyMiddleware

RAW_TOKEN = "RAWTOKEN1234567890"


def _make_client() -> TestClient:
    async def ok(request):
        return PlainTextResponse("ok")

    app = Starlette(
        routes=[
            Route("/share/trips/{token}/status", ok),
            Route("/metrics", ok),
            Route("/health", ok),
        ]
    )
    app.add_middleware(
        OptionalAPIKeyMiddleware,
        api_key_required=True,
        api_keys={"valid-test-key"},
    )
    return TestClient(app)


class TestAuthFailureLogRedaction:
    def test_401_warning_does_not_log_share_token(self, caplog):
        client = _make_client()
        with caplog.at_level(logging.WARNING, logger="src.middleware.auth"):
            response = client.get(f"/share/trips/{RAW_TOKEN}/status")
        assert response.status_code == 401
        # The raw capability token must never appear anywhere in the log output.
        assert RAW_TOKEN not in caplog.text
        # The redaction marker proves the path was logged in redacted form.
        assert "/share/trips/<redacted>" in caplog.text

    def test_401_warning_still_identifies_route_shape(self, caplog):
        client = _make_client()
        with caplog.at_level(logging.WARNING, logger="src.middleware.auth"):
            client.get(f"/share/trips/{RAW_TOKEN}/status")
        assert "auth_failed" in caplog.text


class TestMetricsRequireAPIKey:
    def test_metrics_not_in_exempt_paths(self):
        assert "/metrics" not in AUTH_EXEMPT_PATHS
        assert "/health" in AUTH_EXEMPT_PATHS
        assert "/health/ready" in AUTH_EXEMPT_PATHS

    def test_metrics_without_key_returns_401(self):
        client = _make_client()
        response = client.get("/metrics")
        assert response.status_code == 401

    def test_metrics_with_valid_key_returns_200(self):
        client = _make_client()
        response = client.get("/metrics", headers={"X-API-Key": "valid-test-key"})
        assert response.status_code == 200

    def test_health_remains_exempt(self):
        client = _make_client()
        assert client.get("/health").status_code == 200
