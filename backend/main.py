import asyncio
import hashlib
import logging
import math
import re
import time
import weakref
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from settings import get_settings
from src.data.db import init_pool, close_pool, get_pool
from src.data.buildings_repo import (
    list_buildings, get_building, search_buildings,
    create_class, delete_class, list_classes, update_class, BuildingRecord, ClassRecord
)
from src.data.stops_repo import search_nearby
from src.data.crowding_repo import (
    insert_report, get_recent_reports,
    check_rate_limit, get_reports_by_route, delete_old_reports,
    compute_weighted_level,
)
from src.data.crowding_estimate import estimate_crowding_level
from src.auth.jwt import get_current_user
from src.middleware import OptionalAPIKeyMiddleware, RequestLoggingMiddleware, get_valid_api_keys
from src.middleware.request_logging import _redact_path
from src.monitoring import get_metrics
from src.mtd.client import MTDClient
from src.mtd.models import DeparturesResponse, NearbyStopsResponse, StopInfo
from src.recommendation.models import RecommendationOption, RecommendationRequest, RecommendationResponse
from src.recommendation.service import compute_recommendations
from src.share.models import (
    CreateShareTripRequest,
    CreateShareTripResponse,
    NoNulModel,
    PatchShareTripRequest,
    ShareTripStatusResponse,
    VALID_PHASES,
)
from src.share.repo import (
    create_shared_trip,
    delete_expired_shared_trips,
    get_shared_trip_status,
    patch_shared_trip,
)
from src.share.page import build_share_page
from src.schedule.models import (
    BuildingsListResponse,
    BuildingResponse,
    ClassResponse,
    ClassesListResponse,
    CreateClassRequest,
    UpdateClassRequest,
)

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration

settings = get_settings()

def _sentry_traces_sampler(sampling_context: dict) -> float:
    """Exclude health/metrics endpoints from performance tracing.
    Uses .get() defensively — asgi_scope is absent for non-HTTP contexts (e.g. startup tasks).
    """
    path = (sampling_context.get("asgi_scope") or {}).get("path", "")
    if path in ("/health", "/metrics"):
        return 0.0
    return 0.1


# Any `key=` query pair (MTD_API_KEY, Google keys) must never reach Sentry.
_SENTRY_KEY_PAIR_RE = re.compile(r"(?i)(key=)[^&\s]+")


def _scrub_sentry_url(url: str) -> str:
    """Redact share tokens in the path and any key= query value."""
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(url)
    query = _SENTRY_KEY_PAIR_RE.sub(r"\1<redacted>", parts.query)
    return urlunsplit((parts.scheme, parts.netloc, _redact_path(parts.path), query, ""))


def _sentry_before_send(event: dict, hint: dict) -> dict:
    request = event.get("request") or {}
    if request.get("url"):
        request["url"] = _scrub_sentry_url(str(request["url"]))
        event["request"] = request
    return event


def _sentry_before_send_transaction(event: dict, hint: dict) -> dict:
    event = _sentry_before_send(event, hint)
    for span in event.get("spans") or []:
        data = span.get("data") or {}
        description = str(span.get("description") or "")
        # The MTD API takes its key as a query parameter; httpx spans record it
        # in http.query/url. Strip both for any span touching developer.cumtd.com.
        if "developer.cumtd.com" in description or "developer.cumtd.com" in str(data.get("url", "")):
            data.pop("http.query", None)
            data.pop("url", None)
            span["description"] = description.partition("?")[0]
        for k, v in list(data.items()):
            if isinstance(v, str) and _SENTRY_KEY_PAIR_RE.search(v):
                data[k] = _SENTRY_KEY_PAIR_RE.sub(r"\1<redacted>", v)
        span["data"] = data
    return event


if settings.sentry_dsn:
    # Guard ensures sentry_dsn is non-empty before init; empty string raises BadDsn.
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        integrations=[FastApiIntegration()],
        traces_sampler=_sentry_traces_sampler,
        send_default_pii=False,
        before_send=_sentry_before_send,
        before_send_transaction=_sentry_before_send_transaction,
    )

BACKEND_ROOT = Path(__file__).resolve().parent
GTFS_DB = BACKEND_ROOT / "data" / "gtfs.db"

# Structured logging: include module and level; handlers can add JSON later
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s %(name)s %(message)s",
)
# httpx logs every request at INFO as `HTTP Request: GET <full url>`, and the
# MTD API requires its key as a query parameter. At INFO that writes MTD_API_KEY
# into application logs (and Sentry breadcrumbs) on every departures fetch.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

def _client_ip(request: Request) -> str:
    """Resolve the client IP for rate limiting / dedup.

    X-Forwarded-For is client-forgeable: honoring an attacker-chosen hop lets a
    single machine rotate identities to bypass rate limits and poison the
    crowding dedup. Only when TRUST_PROXY_HEADERS is set (app behind a proxy
    that appends the real peer) do we read XFF — and then the RIGHTMOST entry,
    the one appended by our own proxy, never the client-supplied leftmost.
    """
    if settings.trust_proxy_headers:
        forwarded = request.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def _log_safe(s: object, limit: int = 64) -> str:
    """Make a user-supplied value safe to log: truncate and strip CR/LF (log injection)."""
    if s is None:
        return ""
    return str(s)[:limit].replace("\r", "").replace("\n", " ")


limiter = Limiter(key_func=_client_ip, default_limits=["100/minute"])

# Input validation bounds (public robustness)
LAT_MIN, LAT_MAX = -90.0, 90.0
LNG_MIN, LNG_MAX = -180.0, 180.0
RADIUS_M_MIN, RADIUS_M_MAX = 100, 5000
DEPARTURES_MINUTES_MIN, DEPARTURES_MINUTES_MAX = 1, 120
STOP_ID_MAX_LEN = 64
STOP_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_:\-]+$")  # ':' — MTD child stop points (e.g. IU:1)


def _validate_lat_lng(lat: float, lng: float) -> None:
    if not (LAT_MIN <= lat <= LAT_MAX):
        raise HTTPException(status_code=400, detail=f"lat must be between {LAT_MIN} and {LAT_MAX}")
    if not (LNG_MIN <= lng <= LNG_MAX):
        raise HTTPException(status_code=400, detail=f"lng must be between {LNG_MIN} and {LNG_MAX}")


# Geo-fence: reject coordinates more than ~150 km from UIUC campus centre.
# Prevents wasted Nominatim/OSRM quota and protects against out-of-region abuse.
_UIUC_LAT, _UIUC_LNG = 40.1020, -88.2272
_GEO_FENCE_DEG = 1.35  # ~150 km at this latitude


def _validate_uiuc_region(lat: float, lng: float) -> None:
    if abs(lat - _UIUC_LAT) > _GEO_FENCE_DEG or abs(lng - _UIUC_LNG) > _GEO_FENCE_DEG:
        raise HTTPException(status_code=400, detail="Coordinates are outside the supported region.")


# Bounded cache helper — evict oldest entry when cap is reached.
_CACHE_MAX = 1000


def _cache_put(cache: dict, key: str, value: object) -> None:
    if len(cache) >= _CACHE_MAX:
        try:
            del cache[next(iter(cache))]
        except StopIteration:
            pass
    cache[key] = value


# Allowed characters for Google Place IDs (alphanumeric + hyphen + underscore).
_PLACE_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{10,250}$")


async def _seed_stops_from_gtfs() -> None:
    """Populate the Postgres stops table from the baked-in GTFS snapshot.

    The stops table starts empty on a fresh database and nothing else writes
    to it (the upsert path was never wired up), so /stops/nearby would return
    no results forever. Runs once: skipped when the table already has rows.
    """
    import sqlite3

    pool = get_pool()
    # Child stop points (colon-suffixed, e.g. IU:1) fail STOP_ID_PATTERN on the
    # departures endpoint and duplicate their parent in nearby results — remove
    # any previously seeded ones, then seed parents only
    await pool.execute("DELETE FROM stops WHERE stop_id LIKE '%:%'")
    if await pool.fetchval("SELECT COUNT(*) FROM stops"):
        return
    if not GTFS_DB.exists():
        logger.warning("telemetry stops_seed_skipped reason=gtfs_db_missing")
        return
    conn = sqlite3.connect(str(GTFS_DB))
    try:
        rows = conn.execute(
            "SELECT stop_id, stop_name, stop_lat, stop_lon FROM gtfs_stops"
            " WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL"
            " AND stop_id NOT LIKE '%:%'"
        ).fetchall()
    finally:
        conn.close()
    await pool.executemany(
        "INSERT INTO stops (stop_id, stop_name, lat, lng) VALUES ($1, $2, $3, $4)"
        " ON CONFLICT (stop_id) DO NOTHING",
        [(r[0], r[1] or r[0], float(r[2]), float(r[3])) for r in rows],
    )
    logger.info("telemetry stops_seeded count=%d", len(rows))


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.database_url:
        await init_pool(settings.database_url)
        try:
            await _seed_stops_from_gtfs()
        except Exception as e:
            # Never block boot on seeding — nearby stops just stay empty until fixed
            logger.warning("telemetry stops_seed_error error=%s", str(e))
    app.state.mtd_client = MTDClient(api_key=settings.mtd_api_key) if settings.mtd_api_key else None

    # crowding_reports / shared_trips live in Postgres (migration 0003), so the
    # cleanup loop only runs when a database is configured.
    async def _crowding_cleanup():
        while True:
            try:
                deleted = await delete_old_reports(get_pool(), older_than_hours=2)
                if deleted:
                    logger.info("telemetry crowding_cleanup deleted=%d", deleted)
            except Exception as e:
                logger.warning("telemetry crowding_cleanup_error error=%s", str(e))
            try:
                # Hard-delete shared trips 24h past expiry: lazy read-time cleanup
                # only fires for tokens that are polled again, so abandoned rows
                # otherwise accumulate destination data forever.
                swept = await delete_expired_shared_trips(get_pool())
                if swept:
                    logger.info("telemetry shared_trips_cleanup deleted=%d", swept)
            except Exception as e:
                logger.warning("telemetry shared_trips_cleanup_error error=%s", str(e))
            await asyncio.sleep(3600)

    cleanup_task = asyncio.create_task(_crowding_cleanup()) if settings.database_url else None

    yield

    if cleanup_task:
        cleanup_task.cancel()
    app.state.mtd_client = None
    if settings.database_url:
        await close_pool()


# Interactive docs and the OpenAPI schema are an unnecessary reconnaissance
# surface in production — only serve them in debug mode.
_docs_kwargs = {} if settings.debug else {"docs_url": None, "redoc_url": None, "openapi_url": None}
app = FastAPI(title=settings.app_name, debug=settings.debug, lifespan=lifespan, **_docs_kwargs)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.exception_handler(Exception)
def unhandled_exception_handler(request: Request, exc: Exception):
    """Return consistent JSON error for unhandled exceptions (500). Skip validation/HTTP errors."""
    from fastapi.exceptions import RequestValidationError
    if isinstance(exc, (HTTPException, RequestValidationError)):
        raise exc
    logger.exception("telemetry unhandled_exception path=%s", _redact_path(request.url.path))
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected error occurred. Please try again later."},
    )


# Largest request body accepted anywhere on this API (biggest legitimate
# payload is a few KB of EOD report entries). Bigger bodies are rejected before
# the JSON parser ever buffers them.
MAX_BODY_BYTES = 65536


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject requests whose declared Content-Length exceeds MAX_BODY_BYTES with 413."""

    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get("content-length", "")
        if content_length.isdigit() and int(content_length) > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Request body too large."})
        return await call_next(request)


# Order: add_middleware prepends, so the last added is outermost:
# CORS -> Auth -> RequestLogging -> SlowAPI -> BodySizeLimit -> routes.
# slowapi applies `default_limits` only from inside SlowAPIMiddleware (the
# decorator covers decorated routes only). Without it the 100/minute default
# silently covered none of the undecorated routes. Innermost-but-one so its
# 429s are still logged/counted by RequestLogging and get CORS headers; the
# body-size guard sits innermost so oversized bodies still count against the
# limiter and get logged.
app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(SlowAPIMiddleware)
app.add_middleware(RequestLoggingMiddleware)
app.add_middleware(
    OptionalAPIKeyMiddleware,
    api_key_required=settings.api_key_required,
    api_keys=get_valid_api_keys(settings.api_keys),
)
_cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
if not _cors_origins and settings.debug:
    # In debug/dev mode with no explicit origins configured, allow localhost only
    _cors_origins = ["http://localhost:8081", "http://localhost:3000", "http://localhost:19006"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,  # credentials=True + wildcard origin is a CORS misconfiguration
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key", "X-Edit-Token"],
)


@app.get("/favicon.ico", include_in_schema=False)
@limiter.exempt
def favicon(request: Request):
    """Return 204 so browser favicon requests don't log 404."""
    return Response(status_code=204)


@app.get("/health")
@limiter.exempt
def health(request: Request):
    logger.info("telemetry route=health")
    return {"status": "ok"}


# /health/ready memo: (weakref to the pool it was measured against, monotonic
# timestamp, ok). Keyed on the pool identity so a reconnected pool invalidates
# the cache; 5s TTL stops the limiter-exempt probe from being a free
# per-request `SELECT 1` amplifier against the database.
_READY_CACHE_TTL = 5.0
_ready_cache: dict = {"pool_ref": None, "at": 0.0, "ok": False}


@app.get("/health/ready")
@limiter.exempt
async def health_ready(request: Request):
    """Readiness probe: verifies the database is reachable (vs. /health, which is
    a liveness probe that only confirms the process is up). Result memoized 5s."""
    try:
        pool = get_pool()
    except Exception as e:
        logger.warning("telemetry route=health_ready status=unavailable error=%s", str(e))
        raise HTTPException(status_code=503, detail="Database not ready")
    now = time.monotonic()
    cached_ref = _ready_cache["pool_ref"]
    if cached_ref is not None and cached_ref() is pool and now - _ready_cache["at"] < _READY_CACHE_TTL:
        if _ready_cache["ok"]:
            return {"status": "ready"}
        raise HTTPException(status_code=503, detail="Database not ready")
    ok = True
    try:
        await pool.fetchval("SELECT 1")
    except Exception as e:
        ok = False
        logger.warning("telemetry route=health_ready status=unavailable error=%s", str(e))
    try:
        _ready_cache.update(pool_ref=weakref.ref(pool), at=now, ok=ok)
    except TypeError:
        pass  # non-weakref-able pool stand-ins (plain objects in tests) — skip memo
    if not ok:
        raise HTTPException(status_code=503, detail="Database not ready")
    return {"status": "ready"}


@app.get("/metrics")
@limiter.exempt
def metrics(request: Request):
    """Simple metrics for monitoring (request counts, uptime). Production: use Prometheus exporter if needed."""
    return get_metrics()


# --- Geocoding (for "Where to?" search: address/place name → lat/lng) ---
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
GEOCODE_USER_AGENT = "UIUC-Bus-App/1.0 (uiuc-bus-app-dev)"
# Wider C-U viewbox: lon_min, lat_max, lon_max, lat_min
NOMINATIM_VIEWBOX = "-88.30,40.15,-88.17,40.07"
_LOCATION_HINTS = frozenset(["champaign", "urbana", "illinois", " il,", "uiuc", "university of illinois"])
GEOCODE_CACHE_TTL = 86400  # 24 hours in seconds
GEOCODE_CACHE_MAX = 1000

# Overpass API for local POI search (restaurants, shops, etc.)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# Bounding box covering all of Champaign-Urbana: lat_min,lon_min,lat_max,lon_max
OVERPASS_BBOX = "40.08,-88.28,40.15,-88.18"

# Cache: query_string → (result_dict, expires_at)
_geocode_cache: dict[str, tuple[dict, float]] = {}
# Rate limiter: max 1 Nominatim request per second
_nominatim_semaphore = asyncio.Semaphore(1)


async def _nominatim_lookup(query: str) -> dict:
    """Call Nominatim with a 1 req/sec rate limit and 24h result cache."""
    import httpx

    # Cache hit
    if query in _geocode_cache:
        result, expires_at = _geocode_cache[query]
        if time.time() < expires_at:
            return result

    async with _nominatim_semaphore:
        # Double-check cache inside semaphore (another coroutine may have filled it)
        if query in _geocode_cache:
            result, expires_at = _geocode_cache[query]
            if time.time() < expires_at:
                return result

        # Add Champaign, IL context if the query has no location hints
        contextual_query = query
        if not any(h in query.lower() for h in _LOCATION_HINTS):
            contextual_query = f"{query}, Champaign, IL"

        try:
            async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": GEOCODE_USER_AGENT}) as client:
                r = await client.get(
                    NOMINATIM_URL,
                    params={
                        "q": contextual_query,
                        "format": "json",
                        "limit": 1,
                        "viewbox": NOMINATIM_VIEWBOX,
                        "bounded": "0",
                    },
                )
                r.raise_for_status()
                data = r.json()
        except Exception as e:
            raise RuntimeError(f"Nominatim request failed: {e}") from e

        # Rate-limit: wait 1.05s before releasing the semaphore so next caller is safe
        await asyncio.sleep(1.05)

    if not data:
        raise LookupError(f'No results for "{query[:80]}".')

    first = data[0]
    result = {
        "lat": float(first.get("lat", 0)),
        "lng": float(first.get("lon", 0)),
        "display_name": first.get("display_name", ""),
    }

    # Evict oldest entry if at capacity
    if len(_geocode_cache) >= GEOCODE_CACHE_MAX:
        oldest_key = min(_geocode_cache, key=lambda k: _geocode_cache[k][1])
        _geocode_cache.pop(oldest_key, None)

    _geocode_cache[query] = (result, time.time() + GEOCODE_CACHE_TTL)
    return result


_nominatim_quick_cache: dict[str, tuple[float, list]] = {}
_NOMINATIM_QUICK_TTL = 300  # 5 minutes


async def _nominatim_quick(query: str, limit: int = 3) -> list[dict]:
    """Nominatim search for autocomplete — short timeout, 5-min cache, 1 req/sec rate limit."""
    import httpx

    # Fix 4: Nominatim is useless for very short queries; skip below 4 chars
    if len(query) < 4:
        return []

    cache_key = query.lower()
    now = time.time()
    if cache_key in _nominatim_quick_cache:
        expires_at, cached_results = _nominatim_quick_cache[cache_key]
        if now < expires_at:
            return cached_results[:limit]

    contextual = query if any(h in query.lower() for h in _LOCATION_HINTS) else f"{query}, Champaign, IL"
    try:
        async with _nominatim_semaphore:
            # Double-check cache inside semaphore
            if cache_key in _nominatim_quick_cache:
                expires_at, cached_results = _nominatim_quick_cache[cache_key]
                if now < expires_at:
                    return cached_results[:limit]

            async with httpx.AsyncClient(timeout=3.0, headers={"User-Agent": GEOCODE_USER_AGENT}) as client:
                r = await client.get(
                    NOMINATIM_URL,
                    params={"q": contextual, "format": "json", "limit": limit,
                            "viewbox": NOMINATIM_VIEWBOX, "bounded": "1"},
                )
                r.raise_for_status()
                data = r.json()
            # Rate-limit: wait 1.05s before releasing semaphore
            await asyncio.sleep(1.05)
    except Exception:
        return []

    results = []
    for item in data[:limit]:
        display = item.get("display_name", "")
        short_name = display.split(",")[0].strip()
        results.append({
            "type": "place",
            "name": short_name,
            "display_name": display,
            "lat": float(item.get("lat", 0)),
            "lng": float(item.get("lon", 0)),
        })

    _cache_put(_nominatim_quick_cache, cache_key, (now + _NOMINATIM_QUICK_TTL, results))
    return results[:limit]


async def _overpass_poi_search(query: str, limit: int = 5) -> list[dict]:
    """
    Search Champaign-Urbana POIs via OpenStreetMap Overpass API.
    Uses the first 4 chars as a prefix regex to tolerate typos in the suffix
    (e.g. "sakanaya" → prefix "saka" → finds "Sakayana"), then ranks results
    by string similarity to the full query.
    """
    import re
    import httpx
    from difflib import SequenceMatcher

    if len(query) < 2:
        return []

    # Build prefix pattern from first 4 significant chars (tolerates typos after
    # char 4). Strip everything but alphanumerics/spaces BEFORE escaping: the
    # prefix is interpolated into a quoted Overpass QL regex, so quotes and
    # backslashes in user input could otherwise break out of the pattern.
    sanitized = re.sub(r"[^A-Za-z0-9 ]", "", query)
    prefix = re.escape(sanitized[:4])
    if not prefix.strip():
        return []
    # Overpass QL: search nodes + ways with matching name, case-insensitive (,i flag)
    overpass_q = (
        f'[out:json][timeout:6];'
        f'(node["name"~"{prefix}",i]({OVERPASS_BBOX});'
        f'way["name"~"{prefix}",i]({OVERPASS_BBOX}););'
        f'out center {limit * 5};'
    )
    try:
        async with httpx.AsyncClient(timeout=7.0, headers={"User-Agent": GEOCODE_USER_AGENT}) as client:
            r = await client.post(OVERPASS_URL, data={"data": overpass_q})
            r.raise_for_status()
            elements = r.json().get("elements", [])
    except Exception as e:
        logger.warning("overpass_poi_search_error query_len=%d error=%s", len(query), _log_safe(e, 200))
        return []

    def similarity(name: str) -> float:
        return SequenceMatcher(None, query.lower(), name.lower()).ratio()

    scored: list[tuple[float, dict]] = []
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name", "")
        if not name:
            continue
        lat = el.get("lat") or el.get("center", {}).get("lat", 0)
        lng = el.get("lon") or el.get("center", {}).get("lon", 0)
        if not lat or not lng:
            continue
        addr_parts = [
            tags.get("addr:housenumber", ""),
            tags.get("addr:street", ""),
            tags.get("addr:city", "Champaign"),
        ]
        addr = " ".join(p for p in addr_parts if p).strip()
        category = tags.get("amenity") or tags.get("shop") or tags.get("tourism") or ""
        scored.append((similarity(name), {
            "type": "place",
            "name": name,
            "display_name": f"{name}, {addr}" if addr else name,
            "secondary_text": addr or category,
            "lat": float(lat),
            "lng": float(lng),
        }))

    scored.sort(key=lambda x: x[0], reverse=True)
    # Filter: require some word in the result name starts with the query prefix.
    # This eliminates "Airport & Willow" for "portillo" (no word starts with "port")
    # while correctly passing "Portillo's" ("portillo's" starts with "port"),
    # "Raising Cane's" for "raising cane" ("raising" starts with "rais"), etc.
    q_prefix = query[:min(4, len(query))].lower()
    threshold = 0.35 if len(query) <= 4 else 0.45

    filtered = []
    for score, item in scored:
        if score < threshold:
            continue
        name_words = item["name"].lower().split()
        any_word_starts = any(w.startswith(q_prefix) for w in name_words)
        if any_word_starts:
            filtered.append(item)

    return filtered[:limit]


@app.get("/autocomplete")
@limiter.limit("60/minute")
async def autocomplete(request: Request, q: str = "", limit: int = 8):
    """
    Combined autocomplete: local buildings (FTS5) + Google Places in parallel.
    Falls back to Nominatim if no Google Places key configured.
    Returns { results: [{type, name, display_name?, secondary_text?, lat, lng, building_id?, place_id?}] }.
    Buildings shown first; Places backfill remaining slots.
    """
    query = (q or "").strip()
    if not query or len(query) < 2:
        return {"results": []}
    if len(query) > 200:
        raise HTTPException(status_code=400, detail="Query too long")

    # Parallel: buildings + Google Places (or Overpass POI + Nominatim fallback)
    try:
        pool = get_pool()
        buildings_task = asyncio.create_task(search_buildings(pool, query, min(5, limit)))
    except RuntimeError:
        buildings_task = asyncio.create_task(asyncio.sleep(0))
    google_key = getattr(settings, "google_places_api_key", "")
    if google_key:
        places_task = asyncio.create_task(_google_places_quick(query, limit=4))
    else:
        # Run Overpass (fuzzy POI) + Nominatim (address) in parallel, merge results
        async def _combined_fallback(q: str, lim: int) -> list[dict]:
            overpass_results, nominatim_results = await asyncio.gather(
                _overpass_poi_search(q, limit=lim),
                _nominatim_quick(q, limit=2),
            )
            seen: set[str] = set()
            merged: list[dict] = []
            for item in overpass_results + nominatim_results:
                key = item["name"].lower()
                if key not in seen:
                    seen.add(key)
                    merged.append(item)
            return merged[:lim]
        places_task = asyncio.create_task(_combined_fallback(query, 4))

    buildings_raw, places_raw = await asyncio.gather(buildings_task, places_task)

    # Fix 3: Score-based interleaving — smarter ranking than buildings-always-first
    scored: list[tuple[float, dict]] = []
    seen_names: set[str] = set()
    query_lower = query.lower()

    for b in (buildings_raw or []):
        key = b.name.lower()
        if key in seen_names:
            continue
        seen_names.add(key)
        # Base score 0.4 for buildings + prefix bonus
        score = 0.4 + (0.3 if key.startswith(query_lower) else 0.0)
        scored.append((score, {"type": "building", "name": b.name, "lat": b.lat, "lng": b.lng, "building_id": b.building_id}))

    for item in (places_raw or []):
        key = item["name"].lower()
        if key in seen_names:
            continue
        seen_names.add(key)
        # Base score 0.5 for Places (geo-filtered by Google) + prefix bonus
        score = 0.5 + (0.3 if key.startswith(query_lower) else 0.0)
        scored.append((score, item))

    scored.sort(key=lambda x: x[0], reverse=True)
    results = [item for _, item in scored[:limit]]

    return {"results": results}


@app.get("/geocode")
@limiter.limit("30/minute")
async def geocode(request: Request, q: str = ""):
    """
    Resolve a place name or address to coordinates (uses OpenStreetMap Nominatim).
    Results cached for 24h; Nominatim rate-limited to 1 req/sec.
    Returns first result as { lat, lng, display_name } or 404 if none.
    """
    query = (q or "").strip()
    if not query or len(query) < 2:
        raise HTTPException(status_code=400, detail="Provide a search query (e.g. McDonald's Champaign, or an address).")
    if len(query) > 200:
        raise HTTPException(status_code=400, detail="Query too long")
    try:
        result = await _nominatim_lookup(query)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.warning("telemetry geocode_error q_len=%d error=%s", len(query), _log_safe(e, 200))
        raise HTTPException(status_code=502, detail="Geocoding service unavailable. Try again.") from e
    return result


@app.get("/stops/nearby", response_model=NearbyStopsResponse)
async def stops_nearby(request: Request, lat: float = 0.0, lng: float = 0.0, radius_m: int = 800):
    _validate_lat_lng(lat, lng)
    _validate_uiuc_region(lat, lng)
    if not (RADIUS_M_MIN <= radius_m <= RADIUS_M_MAX):
        raise HTTPException(
            status_code=400,
            detail=f"radius_m must be between {RADIUS_M_MIN} and {RADIUS_M_MAX}",
        )
    logger.info("telemetry route=stops_nearby radius_m=%s", radius_m)
    try:
        pool = get_pool()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database unavailable")
    stops = await search_nearby(pool, lat, lng, radius_m, limit=10)
    return NearbyStopsResponse(
        stops=[StopInfo(stop_id=s.stop_id, stop_name=s.stop_name, lat=s.lat, lng=s.lng) for s in stops]
    )


@app.get("/stops/{stop_id}/departures", response_model=DeparturesResponse)
async def get_departures(request: Request, stop_id: str, minutes: int = 60):
    if not stop_id or len(stop_id) > STOP_ID_MAX_LEN or not STOP_ID_PATTERN.match(stop_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid stop_id (alphanumeric, underscore, hyphen only; max 64 chars).",
        )
    if not (DEPARTURES_MINUTES_MIN <= minutes <= DEPARTURES_MINUTES_MAX):
        raise HTTPException(
            status_code=400,
            detail=f"minutes must be between {DEPARTURES_MINUTES_MIN} and {DEPARTURES_MINUTES_MAX}",
        )
    logger.info("telemetry route=departures stop_id=%s minutes=%s", stop_id, minutes)
    client: MTDClient | None = getattr(app.state, "mtd_client", None)
    if not client:
        raise HTTPException(
            status_code=503,
            detail="MTD API key not configured. Set MTD_API_KEY in the environment.",
        )
    try:
        data = await client.get_departures_by_stop(stop_id=stop_id, minutes=minutes)
        deps = data.get("departures", [])
        source = "realtime" if any(d.get("is_realtime") for d in deps) else "scheduled"
        return DeparturesResponse(**data, source=source, generated_at=int(time.time()))
    except RuntimeError as e:
        # Log the internal detail server-side, but return a generic message so we
        # never risk leaking the upstream request URL (which carries MTD_API_KEY).
        logger.warning("telemetry departures_route_error stop_id=%s error=%s", stop_id, str(e))
        raise HTTPException(
            status_code=502,
            detail="Failed to fetch departures from transit API. Please try again.",
        ) from e
    except Exception as e:
        logger.warning("telemetry departures_route_error stop_id=%s error=%s", stop_id, str(e))
        raise HTTPException(
            status_code=502,
            detail="Failed to fetch departures from transit API. Please try again.",
        ) from e


# --- Live vehicle positions ---


@app.get("/vehicles")
async def get_vehicles(request: Request, route_id: str = ""):
    """Return vehicles currently in service. Optional ?route_id= filter. 10s TTL cache."""
    logger.info("telemetry route=vehicles route_id=%s", _log_safe(route_id) or "all")
    client: MTDClient | None = getattr(app.state, "mtd_client", None)
    if not client:
        raise HTTPException(
            status_code=503,
            detail="MTD API key not configured. Set MTD_API_KEY in the environment.",
        )
    try:
        vehicles = await client.get_vehicles_in_service(route_id=route_id or None)
        return {"vehicles": vehicles}
    except Exception as e:
        logger.warning("telemetry vehicles_error error=%s", str(e))
        raise HTTPException(status_code=502, detail="Failed to fetch vehicle positions.") from e


# --- Crowding reports ---

from pydantic import BaseModel as _PydanticBaseModel, Field as _PydanticField


class CrowdingReportRequest(NoNulModel):
    vehicle_id: str = _PydanticField(..., max_length=64)
    route_id: str = _PydanticField(..., max_length=64)
    trip_id: Optional[str] = _PydanticField(None, max_length=64)
    crowding_level: int
    lat: Optional[float] = None
    lon: Optional[float] = None
    user_token: Optional[str] = _PydanticField(None, max_length=128)


class CrowdingResponse(_PydanticBaseModel):
    level: int
    confidence: str
    source: str
    report_count: int


@app.post("/crowding/report")
@limiter.limit("30/minute")
async def submit_crowding_report(request: Request, body: CrowdingReportRequest):
    """Submit a crowding report. Rate limited. Server-side 10-min per-token rate limit."""
    if not 1 <= body.crowding_level <= 4:
        raise HTTPException(status_code=422, detail="crowding_level must be 1-4")
    if body.lat is not None or body.lon is not None:
        _validate_lat_lng(
            body.lat if body.lat is not None else 0.0,
            body.lon if body.lon is not None else 0.0,
        )
    # Derive the dedup identity server-side from the client IP rather than trusting
    # the client-supplied user_token (which could be omitted or rotated to bypass
    # the per-bus rate limit and poison the crowdsourced aggregate). _client_ip only
    # honors X-Forwarded-For (rightmost, proxy-appended hop) when TRUST_PROXY_HEADERS
    # is set — the leftmost hop is client-forgeable and allowed unlimited aggregate
    # poisoning from one machine.
    dedup_key = hashlib.sha256(_client_ip(request).encode("utf-8")).hexdigest()
    already_reported = await check_rate_limit(get_pool(), dedup_key, body.vehicle_id)
    if already_reported:
        raise HTTPException(status_code=429, detail="You already reported this bus recently. Try again in 10 minutes.")
    await insert_report(
        get_pool(),
        vehicle_id=body.vehicle_id,
        route_id=body.route_id,
        trip_id=body.trip_id,
        crowding_level=body.crowding_level,
        user_token=dedup_key,
        lat=body.lat,
        lon=body.lon,
    )
    reports = await get_recent_reports(get_pool(), body.vehicle_id)
    agg = compute_weighted_level(reports)
    current = {"level": agg.level, "confidence": agg.confidence, "source": agg.source, "report_count": agg.report_count} if agg else None
    logger.info("telemetry route=crowding_report vehicle=%s level=%d", _log_safe(body.vehicle_id), body.crowding_level)
    return {"success": True, "current_aggregate": current}


@app.get("/crowding/route/{route_id}")
async def get_route_crowding(request: Request, route_id: str):
    """Get crowding for all active vehicles on a route."""
    grouped = await get_reports_by_route(get_pool(), route_id)
    result = {}
    for vid, reports in grouped.items():
        agg = compute_weighted_level(reports)
        if agg:
            result[vid] = {"level": agg.level, "confidence": agg.confidence, "source": "crowdsourced", "report_count": agg.report_count}
    return {"route_id": route_id, "vehicles": result}


@app.get("/crowding/{vehicle_id}", response_model=CrowdingResponse)
async def get_vehicle_crowding(request: Request, vehicle_id: str, route_id: str = ""):
    """Get crowding for a vehicle. Falls back to schedule estimate if < 2 crowdsourced reports."""
    reports = await get_recent_reports(get_pool(), vehicle_id)
    agg = compute_weighted_level(reports)
    if agg and agg.report_count >= 2:
        return CrowdingResponse(level=agg.level, confidence=agg.confidence, source="crowdsourced", report_count=agg.report_count)
    estimate = estimate_crowding_level(route_id or "unknown", datetime.now(timezone.utc))
    return CrowdingResponse(level=estimate["level"], confidence=estimate["confidence"], source="estimated", report_count=agg.report_count if agg else 0)


# --- Buildings & Schedule (MVP: default user only) ---


@app.get("/buildings", response_model=BuildingsListResponse)
async def get_buildings(request: Request):
    """List all buildings. Seed data with scripts/seed_buildings.py first."""
    try:
        pool = get_pool()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database unavailable")
    buildings = await list_buildings(pool)
    return BuildingsListResponse(
        buildings=[
            BuildingResponse(building_id=b.building_id, name=b.name, lat=b.lat, lng=b.lng)
            for b in buildings
        ]
    )


@app.get("/buildings/search", response_model=BuildingsListResponse)
async def search_buildings_endpoint(request: Request, q: str = "", limit: int = 6):
    """Search buildings by name (pg_trgm). Returns up to `limit` results ranked by relevance."""
    try:
        pool = get_pool()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database unavailable")
    query = (q or "").strip()
    if not query or len(query) < 2:
        return BuildingsListResponse(buildings=[])
    if not (1 <= limit <= 20):
        limit = 6
    results = await search_buildings(pool, query, limit=limit)
    return BuildingsListResponse(
        buildings=[
            BuildingResponse(building_id=b.building_id, name=b.name, lat=b.lat, lng=b.lng)
            for b in results
        ]
    )


@app.post("/schedule/classes", response_model=ClassResponse, status_code=201)
async def post_schedule_class(request: Request, body: CreateClassRequest, user_id: str = Depends(get_current_user)):
    """Create a class for the authenticated user."""
    try:
        pool = get_pool()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database unavailable")
    await pool.execute("INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", user_id)
    try:
        rec = await create_class(
            pool,
            title=body.title,
            days_of_week=body.days_of_week,
            start_time_local=body.start_time_local,
            building_id=body.building_id,
            destination_lat=body.destination_lat,
            destination_lng=body.destination_lng,
            destination_name=body.destination_name,
            end_time_local=body.end_time_local,
            user_id=user_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return ClassResponse(
        class_id=rec.class_id,
        title=rec.title,
        days_of_week=rec.days_of_week,
        start_time_local=rec.start_time_local,
        building_id=rec.building_id,
        destination_lat=rec.destination_lat,
        destination_lng=rec.destination_lng,
        destination_name=rec.destination_name,
        end_time_local=rec.end_time_local,
    )


@app.delete("/schedule/classes/{class_id}", status_code=204)
async def delete_schedule_class(request: Request, class_id: str, user_id: str = Depends(get_current_user)):
    """Delete a class belonging to the authenticated user."""
    try:
        pool = get_pool()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database unavailable")
    await pool.execute("INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", user_id)
    deleted = await delete_class(pool, class_id, user_id=user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Class not found.")


@app.patch("/schedule/classes/{class_id}", response_model=ClassResponse)
async def patch_schedule_class(request: Request, class_id: str, body: UpdateClassRequest, user_id: str = Depends(get_current_user)):
    """Update fields on a class belonging to the authenticated user."""
    try:
        pool = get_pool()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database unavailable")
    await pool.execute("INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", user_id)
    updates = body.model_dump(exclude_none=True)
    try:
        rec = await update_class(pool, class_id, user_id=user_id, updates=updates)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if rec is None:
        raise HTTPException(status_code=404, detail="Class not found.")
    return ClassResponse(
        class_id=rec.class_id,
        title=rec.title,
        days_of_week=rec.days_of_week,
        start_time_local=rec.start_time_local,
        building_id=rec.building_id,
        destination_lat=rec.destination_lat,
        destination_lng=rec.destination_lng,
        destination_name=rec.destination_name,
        end_time_local=rec.end_time_local,
    )


@app.get("/schedule/classes", response_model=ClassesListResponse)
async def get_schedule_classes(request: Request, user_id: str = Depends(get_current_user)):
    """List classes for the authenticated user."""
    try:
        pool = get_pool()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database unavailable")
    await pool.execute("INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", user_id)
    classes = await list_classes(pool, user_id=user_id)
    return ClassesListResponse(
        classes=[
            ClassResponse(
                class_id=c.class_id,
                title=c.title,
                days_of_week=c.days_of_week,
                start_time_local=c.start_time_local,
                building_id=c.building_id,
                destination_lat=c.destination_lat,
                destination_lng=c.destination_lng,
                destination_name=c.destination_name,
                end_time_local=c.end_time_local,
            )
            for c in classes
        ]
    )


# --- Recommendation (user location -> destination building) ---


def _get_departures_for_recommendation(stop_id: str) -> list[dict]:
    """Sync wrapper for recommendation engine — runs async client in a new event loop."""
    client: MTDClient | None = getattr(app.state, "mtd_client", None)
    if not client:
        return []
    try:
        loop = asyncio.new_event_loop()
        try:
            data = loop.run_until_complete(client.get_departures_by_stop(stop_id=stop_id, minutes=60))
        finally:
            loop.close()
        return data.get("departures") or []
    except Exception:
        return []


def _find_exit_stop_for_recommendation(route_id: str, from_stop_id: str, dest_lat: float, dest_lng: float, after_time: str) -> dict | None:
    """GTFS-based exit stop lookup for recommendation engine."""
    try:
        from src.data.gtfs_repo import find_best_exit_stop_for_route
        return find_best_exit_stop_for_route(GTFS_DB, route_id, from_stop_id, dest_lat, dest_lng, after_time)
    except Exception:
        return None


@app.post("/recommendation", response_model=RecommendationResponse)
async def post_recommendation(request: Request, body: RecommendationRequest, user=Depends(get_current_user)):
    """Return 2–3 options (WALK + BUS) from user location to destination (building or custom lat/lng)."""
    _validate_lat_lng(body.lat, body.lng)
    _validate_uiuc_region(body.lat, body.lng)

    try:
        pool = get_pool()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database unavailable")

    loop = asyncio.get_running_loop()

    if body.destination_lat is not None and body.destination_lng is not None:
        dest_lat, dest_lng = body.destination_lat, body.destination_lng
        dest_name = body.destination_name or "Destination"
        destination_building_id = "custom"
        logger.info("telemetry route=recommendation custom_destination")
    elif body.destination_building_id:
        building = await get_building(pool, body.destination_building_id)
        if building is None:
            raise HTTPException(
                status_code=400,
                detail=f"Building not found: {body.destination_building_id}.",
            )
        dest_lat, dest_lng, dest_name = building.lat, building.lng, building.name
        destination_building_id = body.destination_building_id
        logger.info("telemetry route=recommendation building_id=%s", destination_building_id)
    else:
        raise HTTPException(status_code=400, detail="Provide destination_building_id or destination_lat and destination_lng.")

    # Sync callbacks for compute_recommendations — submit coroutines to the running event loop
    def _get_building_cb(building_id: str):
        b = asyncio.run_coroutine_threadsafe(get_building(pool, building_id), loop).result()
        return (b.lat, b.lng, b.name) if b else None

    def _search_nearby_cb(lat: float, lng: float, radius_m: float, limit: int):
        stops = asyncio.run_coroutine_threadsafe(
            search_nearby(pool, lat, lng, radius_m, limit=limit), loop
        ).result()
        return [(s.stop_id, s.stop_name, s.lat, s.lng) for s in stops]

    try:
        options = await asyncio.to_thread(
            compute_recommendations,
            lat=body.lat,
            lng=body.lng,
            destination_building_id=destination_building_id,
            destination_lat=dest_lat,
            destination_lng=dest_lng,
            destination_name=dest_name,
            arrive_by_iso=body.arrive_by_iso,
            walking_speed_mps=body.walking_speed_mps,
            buffer_minutes=body.buffer_minutes,
            max_options=body.max_options,
            prefer_bus=body.prefer_bus,
            now=None,
            get_building=_get_building_cb,
            search_nearby_stops=_search_nearby_cb,
            get_departures=_get_departures_for_recommendation,
            find_exit_stop_fn=_find_exit_stop_for_recommendation,
        )
    except ValueError as e:
        if "invalid_arrive_by" in str(e):
            raise HTTPException(
                status_code=400,
                detail="Invalid arrive_by_iso. Use ISO 8601 (e.g. 2026-02-22T15:00:00Z).",
            ) from e
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("telemetry recommendation_error")
        raise HTTPException(
            status_code=503,
            detail="Route computation failed. Please try again in a moment.",
        ) from e

    option_objects = [RecommendationOption(**o) for o in options]

    # AI ranking: if Claude key configured, rank and annotate options
    claude_key = getattr(settings, "claude_api_key", "")
    if claude_key and option_objects:
        try:
            from src.ai.claude_client import ClaudeClient
            ai_client = ClaudeClient(api_key=claude_key)
            route_opts_for_ai = [
                {"type": o.type, "eta_minutes": o.eta_minutes, "depart_in_minutes": o.depart_in_minutes, "summary": o.summary}
                for o in option_objects
            ]
            # get_best_route uses the synchronous Anthropic SDK (a blocking HTTPS
            # call). Run it in a thread so it doesn't stall the event loop for
            # every other concurrent request while Claude responds.
            ai_result = await asyncio.to_thread(
                ai_client.get_best_route,
                origin=f"{body.lat},{body.lng}",
                destination=dest_name,
                route_options=route_opts_for_ai,
                user_context={},
            )
            ranked_order = ai_result.get("ranked_order", [])
            ai_explanation = ai_result.get("ai_explanation", "")
            # Only reorder if Claude returned a genuine permutation of the
            # option indices. The previous length-only check let a malformed
            # response like [0, 0] or [-1, 1] duplicate/drop options.
            if sorted(ranked_order) == list(range(len(option_objects))):
                option_objects = [option_objects[i] for i in ranked_order]
            if ai_explanation and option_objects:
                option_objects[0] = option_objects[0].model_copy(
                    update={"ai_explanation": ai_explanation, "ai_ranked": True}
                )
        except Exception:
            pass  # AI ranking failure is non-fatal

    return RecommendationResponse(options=option_objects, generated_at=int(time.time()))


# --- Walking directions proxy ---

# Cache: (rounded orig/dest) → (result, expires_at)
_walk_directions_cache: dict[str, tuple[dict, float]] = {}
WALK_DIRECTIONS_CACHE_TTL = 300  # 5 minutes


@app.get("/directions/walk")
@limiter.limit("60/minute")
async def directions_walk(request: Request, orig_lat: float, orig_lng: float, dest_lat: float, dest_lng: float):
    """Proxy walking directions via OSRM. Returns { coords: [[lat, lng], ...] }."""
    import httpx

    def _round5(v: float) -> float:
        return round(v, 5)

    cache_key = f"{_round5(orig_lat)},{_round5(orig_lng)}-{_round5(dest_lat)},{_round5(dest_lng)}"
    now = time.time()
    if cache_key in _walk_directions_cache:
        result, expires_at = _walk_directions_cache[cache_key]
        if now < expires_at:
            return result

    fallback = {"coords": [[orig_lat, orig_lng], [dest_lat, dest_lng]]}
    try:
        osrm_url = (
            f"http://router.project-osrm.org/route/v1/foot/"
            f"{orig_lng},{orig_lat};{dest_lng},{dest_lat}"
            f"?geometries=geojson&overview=full"
        )
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(osrm_url)
            r.raise_for_status()
            data = r.json()
        coordinates = data["routes"][0]["geometry"]["coordinates"]  # [[lng, lat], ...]
        coords = [[c[1], c[0]] for c in coordinates]  # reorder to [lat, lng]
        result = {"coords": coords}
    except Exception as e:
        logger.warning("telemetry osrm_error error=%s", str(e))
        result = fallback

    _cache_put(_walk_directions_cache, cache_key, (result, now + WALK_DIRECTIONS_CACHE_TTL))
    return result


# --- GTFS bus shape + stops ---


@app.get("/gtfs/route-stops")
def gtfs_route_stops(request: Request, route_id: str = "", from_stop_id: str = "", to_stop_id: str = "", after_time: str = ""):
    """Return bus trip shape and stops between two stops. Gracefully returns empty if GTFS DB missing."""
    from src.data.gtfs_repo import find_connecting_trips, get_shape_for_trip, get_stops_for_trip_between

    empty = {"trip_id": None, "stops": [], "shape_points": []}
    if not from_stop_id or not to_stop_id:
        return empty
    try:
        trips = find_connecting_trips(GTFS_DB, from_stop_id, to_stop_id, after_time or "00:00:00")
        if not trips:
            return empty
        trip = trips[0]
        trip_id = trip["trip_id"]
        stops = get_stops_for_trip_between(GTFS_DB, trip_id, from_stop_id, to_stop_id)
        shape = get_shape_for_trip(GTFS_DB, trip_id)
        return {
            "trip_id": trip_id,
            "stops": stops,
            "shape_points": [[lat, lng] for lat, lng in shape],
        }
    except Exception as e:
        logger.warning("telemetry gtfs_route_stops_error error=%s", str(e))
        return empty


# --- AI endpoints ---

@app.get("/gtfs/route-all-stops")
def gtfs_all_stops_for_route(request: Request, route_id: str = ""):
    """Return all stops in order for a given route_id (using longest canonical trip)."""
    from src.data.gtfs_repo import get_all_stops_for_route
    if not route_id:
        return {"stops": []}
    stops = get_all_stops_for_route(GTFS_DB, route_id)
    return {"stops": stops}


from pydantic import BaseModel as _BaseModel, Field as _Field


class AfterClassPlanRequest(_BaseModel):
    freetext_plan: str = _Field("", max_length=500)
    lat: float = 0.0
    lng: float = 0.0


class EodReportRequest(_BaseModel):
    entries: list[dict] = _Field([], max_length=50)
    total_steps: int = 0
    total_calories: float = 0.0
    total_distance_m: float = 0.0


class WalkCompleteRequest(_BaseModel):
    mode: str = _Field("walk", max_length=50)
    distance_m: float = 0.0
    calories: float = 0.0
    dest_name: str = _Field("", max_length=200)


@app.post("/ai/after-class-plan")
@limiter.limit("10/minute")
def post_after_class_plan(request: Request, body: AfterClassPlanRequest, user=Depends(get_current_user)):
    """Return a chained trip plan for after the last class. Phase 2: heuristic; Phase 3: Claude."""
    from src.ai.planner import heuristic_after_class_plan
    if not body.freetext_plan.strip():
        raise HTTPException(status_code=400, detail="Provide freetext_plan.")
    try:
        # Try Claude if configured
        claude_key = getattr(settings, "claude_api_key", "")
        if claude_key:
            from src.ai.claude_client import ClaudeClient
            client = ClaudeClient(api_key=claude_key)
            result = client.get_after_class_plan(
                freetext_plan=body.freetext_plan,
                completed_classes=[],
                available_routes=[],
                activity_today=[],
            )
            return result
    except Exception:
        pass
    return heuristic_after_class_plan(body.freetext_plan, body.lat, body.lng)


@app.post("/ai/eod-report")
@limiter.limit("10/minute")
def post_eod_report(request: Request, body: EodReportRequest, user=Depends(get_current_user)):
    """Return an AI end-of-day activity report. Requires CLAUDE_API_KEY."""
    claude_key = getattr(settings, "claude_api_key", "")
    if not claude_key:
        return {
            "report": (
                f"Today you walked {body.total_distance_m:.0f} m, burned "
                f"{body.total_calories:.0f} kcal, and took {body.total_steps} steps. "
                "Set CLAUDE_API_KEY to get a personalized AI narrative!"
            )
        }
    try:
        from src.ai.claude_client import ClaudeClient
        client = ClaudeClient(api_key=claude_key)
        result = client.get_eod_activity_report(
            activity_entries=body.entries,
            walking_mode="mixed",
            total_stats={
                "steps": body.total_steps,
                "calories": body.total_calories,
                "distance_m": body.total_distance_m,
            },
        )
        return result
    except Exception as e:
        logger.warning("telemetry eod_report_error error=%s", str(e))
        raise HTTPException(status_code=502, detail="Failed to generate AI report.") from e


# --- Google Places proxy ---

GOOGLE_PLACES_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete"
GOOGLE_PLACES_DETAILS_BASE = "https://places.googleapis.com/v1/places"
GOOGLE_PLACES_BIAS_LAT = 40.1020
GOOGLE_PLACES_BIAS_LNG = -88.2272
GOOGLE_PLACES_BIAS_RADIUS = 50000.0

# Short TTL autocomplete cache (10s) and long TTL details cache (24h)
_places_autocomplete_cache: dict[str, tuple[dict, float]] = {}
_places_details_cache: dict[str, tuple[dict, float]] = {}
PLACES_AUTOCOMPLETE_TTL = 10
PLACES_DETAILS_TTL = 86400


class PlacesAutocompleteRequest(_BaseModel):
    q: str = ""
    session_token: str = ""


@app.post("/places/autocomplete")
@limiter.limit("60/minute")
async def places_autocomplete(request: Request, body: PlacesAutocompleteRequest):
    """Proxy to Google Places API (New) autocomplete. Returns { predictions: [] }. Empty key → silent no-op."""
    import httpx

    api_key = getattr(settings, "google_places_api_key", "")
    query = (body.q or "").strip()
    if not api_key or not query or len(query) < 2:
        return {"predictions": []}
    if len(query) > 200:
        raise HTTPException(status_code=400, detail="Query too long (max 200 characters).")

    cache_key = query.lower()
    now = time.time()
    if cache_key in _places_autocomplete_cache:
        result, expires_at = _places_autocomplete_cache[cache_key]
        if now < expires_at:
            return result

    try:
        payload = {
            "input": query,
            "locationBias": {
                "circle": {
                    "center": {"latitude": GOOGLE_PLACES_BIAS_LAT, "longitude": GOOGLE_PLACES_BIAS_LNG},
                    "radius": GOOGLE_PLACES_BIAS_RADIUS,
                }
            },
        }
        if body.session_token:
            payload["sessionToken"] = body.session_token

        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(
                GOOGLE_PLACES_AUTOCOMPLETE_URL,
                json=payload,
                headers={
                    "X-Goog-Api-Key": api_key,
                    "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
                },
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        logger.warning("telemetry places_autocomplete_error q=%s error=%s", query[:50], str(e))
        return {"predictions": []}

    predictions = []
    for s in (data.get("suggestions") or []):
        pp = s.get("placePrediction") or {}
        place_id = pp.get("placeId") or ""
        sf = pp.get("structuredFormat") or {}
        main_text = (sf.get("mainText") or {}).get("text") or (pp.get("text") or {}).get("text") or ""
        secondary_text = (sf.get("secondaryText") or {}).get("text") or ""
        description = f"{main_text}, {secondary_text}".strip(", ")
        if place_id and main_text:
            predictions.append({
                "place_id": place_id,
                "main_text": main_text,
                "secondary_text": secondary_text,
                "description": description,
            })

    result = {"predictions": predictions}
    _cache_put(_places_autocomplete_cache, cache_key, (result, now + PLACES_AUTOCOMPLETE_TTL))
    return result


@app.get("/places/details")
@limiter.limit("30/minute")
async def places_details(request: Request, place_id: str = ""):
    """Resolve a Google Places place_id to lat/lng. Cached 24h."""
    import httpx

    api_key = getattr(settings, "google_places_api_key", "")
    if not api_key or not place_id:
        raise HTTPException(status_code=400, detail="place_id required and GOOGLE_PLACES_API_KEY must be set.")
    if not _PLACE_ID_RE.match(place_id):
        raise HTTPException(status_code=400, detail="Invalid place_id format.")

    now = time.time()
    if place_id in _places_details_cache:
        result, expires_at = _places_details_cache[place_id]
        if now < expires_at:
            return result

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(
                f"{GOOGLE_PLACES_DETAILS_BASE}/{place_id}",
                headers={
                    "X-Goog-Api-Key": api_key,
                    "X-Goog-FieldMask": "location,displayName",
                },
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        logger.warning("telemetry places_details_error place_id=%s error=%s", place_id[:50], str(e))
        raise HTTPException(status_code=502, detail="Failed to fetch place details.") from e

    loc = data.get("location") or {}
    display = (data.get("displayName") or {}).get("text") or ""
    result = {
        "lat": float(loc.get("latitude") or 0),
        "lng": float(loc.get("longitude") or 0),
        "display_name": display,
    }
    _cache_put(_places_details_cache, place_id, (result, now + PLACES_DETAILS_TTL))
    return result


async def _google_places_quick(query: str, limit: int = 3) -> list[dict]:
    """Fetch Google Places predictions for autocomplete merge. Returns [] if no key."""
    import httpx

    api_key = getattr(settings, "google_places_api_key", "")
    if not api_key or not query.strip():
        return []

    cache_key = query.lower()
    now = time.time()
    if cache_key in _places_autocomplete_cache:
        result, expires_at = _places_autocomplete_cache[cache_key]
        if now < expires_at:
            preds = result.get("predictions", [])[:limit]
            return [{"type": "google_place", "name": p["main_text"], "secondary_text": p.get("secondary_text", ""),
                     "lat": p.get("lat", 0.0), "lng": p.get("lng", 0.0), "place_id": p["place_id"]} for p in preds]

    try:
        payload = {
            "input": query,
            "locationBias": {
                "circle": {
                    "center": {"latitude": GOOGLE_PLACES_BIAS_LAT, "longitude": GOOGLE_PLACES_BIAS_LNG},
                    "radius": GOOGLE_PLACES_BIAS_RADIUS,
                }
            },
        }
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.post(
                GOOGLE_PLACES_AUTOCOMPLETE_URL,
                json=payload,
                headers={
                    "X-Goog-Api-Key": api_key,
                    "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.place.location",
                },
            )
            r.raise_for_status()
            data = r.json()
    except Exception:
        return []

    predictions = []
    for s in (data.get("suggestions") or []):
        pp = s.get("placePrediction") or {}
        place_id = pp.get("placeId") or ""
        sf = pp.get("structuredFormat") or {}
        main_text = (sf.get("mainText") or {}).get("text") or (pp.get("text") or {}).get("text") or ""
        secondary_text = (sf.get("secondaryText") or {}).get("text") or ""
        # Extract location coordinates if available
        place_loc = (pp.get("place") or {}).get("location") or {}
        lat = float(place_loc.get("latitude") or 0.0)
        lng = float(place_loc.get("longitude") or 0.0)
        if place_id and main_text:
            predictions.append({
                "place_id": place_id,
                "main_text": main_text,
                "secondary_text": secondary_text,
                "description": f"{main_text}, {secondary_text}".strip(", "),
                "lat": lat,
                "lng": lng,
            })

    cached_result = {"predictions": predictions}
    _places_autocomplete_cache[cache_key] = (cached_result, now + PLACES_AUTOCOMPLETE_TTL)
    return [{"type": "google_place", "name": p["main_text"], "secondary_text": p.get("secondary_text", ""),
             "lat": p.get("lat", 0.0), "lng": p.get("lng", 0.0), "place_id": p["place_id"]} for p in predictions[:limit]]


@app.post("/ai/walk-complete")
@limiter.limit("10/minute")
def post_walk_complete(request: Request, body: WalkCompleteRequest, user=Depends(get_current_user)):
    """Return a short encouragement message after completing a walk."""
    claude_key = getattr(settings, "claude_api_key", "")
    if not claude_key:
        return {"encouragement": f"Great job walking to {body.dest_name}! Keep it up!"}
    try:
        from src.ai.encouragement import get_walk_encouragement
        msg = get_walk_encouragement(
            mode=body.mode,
            distance_m=body.distance_m,
            calories=body.calories,
            dest_name=body.dest_name,
        )
        return {"encouragement": msg}
    except Exception as e:
        logger.warning("telemetry walk_complete_error error=%s", str(e))
        return {"encouragement": f"Great job walking to {body.dest_name}!"}


# ── Share My Trip ──────────────────────────────────────────────────────────────

@app.post("/share/trips", response_model=CreateShareTripResponse)
@limiter.limit("20/minute")
async def post_share_trip(request: Request, body: CreateShareTripRequest):
    """Create a new shared trip record. Returns token and shareable URL."""
    if body.phase not in VALID_PHASES:
        raise HTTPException(status_code=400, detail=f"phase must be one of {sorted(VALID_PHASES)}")
    token, edit_token = await create_shared_trip(
        get_pool(),
        destination=body.destination[:200],
        route_id=body.route_id,
        route_name=body.route_name,
        stop_name=body.stop_name,
        phase=body.phase,
        eta_epoch=body.eta_epoch,
    )
    # Never derive the link from the client-controlled Host header: a spoofed
    # Host would poison the URL the creator copies to friends. No configured
    # PUBLIC_BASE_URL -> url is null and the client builds its own link.
    if settings.public_base_url:
        url = f"{settings.public_base_url.rstrip('/')}/t/{token}"
    else:
        url = None
    return CreateShareTripResponse(token=token, edit_token=edit_token, url=url)


@app.patch("/share/trips/{token}")
@limiter.limit("60/minute")
async def patch_share_trip(request: Request, token: str, body: PatchShareTripRequest):
    """Update phase and/or eta for a shared trip.

    Requires the X-Edit-Token header (the writer credential returned at
    creation); the public read token alone must not be able to mutate the trip.
    Missing/wrong edit token, unknown token, and expired trip are all the same
    404 so the response is not an oracle.
    """
    if body.phase is not None and body.phase not in VALID_PHASES:
        raise HTTPException(status_code=400, detail=f"phase must be one of {sorted(VALID_PHASES)}")
    edit_token = request.headers.get("X-Edit-Token")
    updated = await patch_shared_trip(get_pool(), token, edit_token, body.phase, body.eta_epoch)
    if not updated:
        raise HTTPException(status_code=404, detail="Trip not found or has expired")
    return {"ok": True}


@app.get("/share/trips/{token}/status", response_model=ShareTripStatusResponse)
@limiter.limit("120/minute")
async def get_share_trip_status(request: Request, token: str):
    """Poll current state of a shared trip."""
    status = await get_shared_trip_status(get_pool(), token)
    if status is None:
        return ShareTripStatusResponse(expired=True)
    return ShareTripStatusResponse(**status)


@app.get("/t/{token}", response_class=HTMLResponse, include_in_schema=False)
@limiter.limit("60/minute")
def share_trip_page(request: Request, token: str):
    """Serve the recipient share page."""
    if not re.fullmatch(r'[A-Za-z0-9_\-]{6,64}', token):
        return HTMLResponse("<h1>Invalid link</h1>", status_code=400)
    return HTMLResponse(content=build_share_page(token))
