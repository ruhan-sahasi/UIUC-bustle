"""Optional API key auth: when API_KEY_REQUIRED=true, require X-API-Key header."""
import logging
import secrets
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from src.middleware.request_logging import _redact_path

logger = logging.getLogger(__name__)

AUTH_EXEMPT_PATHS = {"/health", "/health/ready"}


def get_valid_api_keys(api_keys_str: str) -> set[str]:
    return {k.strip() for k in api_keys_str.split(",") if k.strip()}


def extract_api_key(request: Request) -> str | None:
    # Only accept explicit X-API-Key header, never treat Bearer JWTs as API keys
    key = request.headers.get("X-API-Key")
    if key:
        return key.strip()
    return None


class OptionalAPIKeyMiddleware(BaseHTTPMiddleware):
    """When api_key_required is True, reject requests without a valid API key (except exempt paths)."""

    def __init__(self, app, api_key_required: bool, api_keys: set[str]):
        super().__init__(app)
        self.api_key_required = api_key_required
        self.valid_keys = api_keys

    def _is_valid_key(self, key: str) -> bool:
        # Constant-time comparison against each valid key to avoid leaking key
        # bytes through response timing. `any(...)` over compare_digest keeps each
        # individual comparison timing-safe.
        return any(secrets.compare_digest(key, valid) for valid in self.valid_keys)

    async def dispatch(self, request: Request, call_next):
        if request.url.path in AUTH_EXEMPT_PATHS:
            return await call_next(request)
        if not self.api_key_required:
            return await call_next(request)
        key = extract_api_key(request)
        if not key or not self._is_valid_key(key):
            logger.warning("telemetry auth_failed path=%s", _redact_path(request.url.path))
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or missing API key. Provide X-API-Key header."},
            )
        return await call_next(request)
