"""Exploit-reproduction tests for JWT issuer/role binding (PR-3).

Real HS256 tokens signed with the test secret — jwt.decode is NOT mocked, so
these exercise the actual verification path in src.auth.jwt.
"""
import time

import jwt as pyjwt
import pytest
from fastapi import HTTPException
from starlette.requests import Request

SECRET = "test-secret"
SUPABASE_URL = "https://proj.supabase.co"
ISSUER = f"{SUPABASE_URL}/auth/v1"


def _make_request(authorization: str = "") -> Request:
    """Build a minimal Starlette Request with the given Authorization header."""
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": [(b"authorization", authorization.encode())] if authorization else [],
        "query_string": b"",
    }
    return Request(scope)


def _mint(**overrides) -> str:
    """Mint a legitimately-shaped Supabase HS256 access token; overrides tweak
    or (with value None) drop individual claims."""
    claims = {
        "sub": "user-uuid-123",
        "aud": "authenticated",
        "iss": ISSUER,
        "role": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    for k, v in overrides.items():
        if v is None:
            claims.pop(k, None)
        else:
            claims[k] = v
    return pyjwt.encode(claims, SECRET, algorithm="HS256")


@pytest.fixture()
def jwt_module(monkeypatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("SUPABASE_URL", SUPABASE_URL)
    from src.auth import jwt as jwt_module
    import importlib; importlib.reload(jwt_module)
    return jwt_module


class TestIssuerBinding:
    def test_correct_issuer_returns_user_id(self, jwt_module):
        req = _make_request(f"Bearer {_mint()}")
        assert jwt_module.get_current_user(req) == "user-uuid-123"

    def test_wrong_issuer_raises_401(self, jwt_module):
        # EXPLOIT: on main this token is ACCEPTED (no issuer= passed to
        # jwt.decode), so a validly-signed token from a different Auth server
        # authenticates. Post-fix it must be rejected.
        token = _mint(iss="https://evil.supabase.co/auth/v1")
        req = _make_request(f"Bearer {token}")
        with pytest.raises(HTTPException) as exc:
            jwt_module.get_current_user(req)
        assert exc.value.status_code == 401
        assert "Invalid token" in exc.value.detail

    def test_missing_issuer_raises_401(self, jwt_module):
        # EXPLOIT: on main "iss" is not in the require list, so a token with
        # no issuer claim at all is accepted.
        token = _mint(iss=None)
        req = _make_request(f"Bearer {token}")
        with pytest.raises(HTTPException) as exc:
            jwt_module.get_current_user(req)
        assert exc.value.status_code == 401


class TestRoleBinding:
    def test_anon_role_raises_401(self, jwt_module):
        # EXPLOIT: on main the role claim is never checked, so an anon-role
        # token with a sub claim authenticates as that user.
        token = _mint(role="anon")
        req = _make_request(f"Bearer {token}")
        with pytest.raises(HTTPException) as exc:
            jwt_module.get_current_user(req)
        assert exc.value.status_code == 401
        assert "Invalid token" in exc.value.detail

    def test_service_role_raises_401(self, jwt_module):
        token = _mint(role="service_role")
        req = _make_request(f"Bearer {token}")
        with pytest.raises(HTTPException) as exc:
            jwt_module.get_current_user(req)
        assert exc.value.status_code == 401

    def test_missing_role_still_accepted(self, jwt_module):
        # Tokens without a role claim (non-Supabase-shaped but validly signed
        # and issuer-bound) keep working — the role check only rejects an
        # explicit non-"authenticated" role.
        token = _mint(role=None)
        req = _make_request(f"Bearer {token}")
        assert jwt_module.get_current_user(req) == "user-uuid-123"
