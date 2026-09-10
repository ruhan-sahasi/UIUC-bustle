import jwt
from jwt import PyJWKClient, PyJWKClientError, PyJWKError
from fastapi import HTTPException, Request
from settings import get_settings

# Cached per JWKS URL; PyJWKClient caches the fetched keys internally
_jwks_clients: dict[str, PyJWKClient] = {}


def _extract_bearer(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authentication token")
    return auth[len("Bearer "):]


def _asymmetric_key(token: str, supabase_url: str):
    url = supabase_url.rstrip("/") + "/auth/v1/.well-known/jwks.json"
    client = _jwks_clients.get(url)
    if client is None:
        client = PyJWKClient(url, cache_keys=True)
        _jwks_clients[url] = client
    return client.get_signing_key_from_jwt(token).key


def get_current_user(request: Request) -> str:
    """FastAPI dependency. Verifies Supabase JWT and returns user_id (UUID string).

    Supports both Supabase signing schemes: legacy HS256 (shared secret via
    SUPABASE_JWT_SECRET) and the current asymmetric keys (ES256/RS256, verified
    against the project's public JWKS — requires SUPABASE_URL).

    get_settings() is called inside the function (not at module level) so tests can
    patch env vars without stale cached values.
    """
    settings = get_settings()
    token = _extract_bearer(request)
    try:
        alg = jwt.get_unverified_header(token).get("alg", "")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    if alg == "HS256":
        if not settings.supabase_jwt_secret:
            raise HTTPException(status_code=503, detail="Auth not configured — set SUPABASE_JWT_SECRET environment variable")
        key = settings.supabase_jwt_secret
        algorithms = ["HS256"]
    elif alg in ("ES256", "RS256"):
        if not settings.supabase_url:
            raise HTTPException(status_code=503, detail="Auth not configured — set SUPABASE_URL environment variable for JWKS verification")
        try:
            key = _asymmetric_key(token, settings.supabase_url)
        except (jwt.InvalidTokenError, PyJWKClientError, PyJWKError):
            # No matching signing key for this token's kid (forged / stale /
            # wrong-project token) — that's a rejected token (401), not a
            # backend outage. PyJWKClientError/PyJWKError are NOT subclasses of
            # InvalidTokenError, so they must be caught explicitly.
            raise HTTPException(status_code=401, detail="Invalid token")
        except Exception:
            # Genuine inability to reach/parse the JWKS endpoint.
            raise HTTPException(status_code=503, detail="Unable to fetch JWT signing keys")
        algorithms = [alg]
    else:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        payload = jwt.decode(
            token,
            key,
            algorithms=algorithms,
            audience="authenticated",
            # Bind the token to THIS project's Supabase Auth server. Blocks
            # signed-but-foreign tokens (e.g. another project sharing a leaked
            # secret) from being accepted here.
            issuer=settings.supabase_url.rstrip("/") + "/auth/v1",
            # Reject tokens missing an expiry, subject, or issuer rather than
            # silently accepting them (defense-in-depth on top of signature
            # verification).
            options={"require": ["exp", "sub", "iss"]},
        )
        # Supabase encodes the Postgres role in the token; an "anon" token is
        # validly signed but must never authenticate as a user.
        if payload.get("role") is not None and payload["role"] != "authenticated":
            raise HTTPException(status_code=401, detail="Invalid token")
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
        return user_id
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
