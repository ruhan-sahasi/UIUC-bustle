# Production deployment checklist

## Environment variables

Copy and adjust for production. Development defaults are fine for local use.

| Variable | Default | Production |
|---------|---------|------------|
| `CORS_ORIGINS` | (empty — all cross-origin requests blocked) | Comma-separated origins, e.g. `https://yourapp.com` |
| `API_KEY_REQUIRED` | `false` | `true` to require API key |
| `API_KEYS` | (empty) | Comma-separated keys when `API_KEY_REQUIRED=true` |
| `DEBUG` | `false` | Keep `false` |
| `MTD_API_KEY` | (empty) | Your MTD developer key |

## Monitoring

- **Request logging**: Every request is logged with `method`, `path`, `status`, `duration_ms`, `client` (IP). Use structured logging (e.g. JSON) by configuring Python `logging` handlers.
- **Metrics**: `GET /metrics` returns JSON with `requests_total`, `requests_2xx`, `requests_4xx`, `requests_5xx`, `uptime_seconds`. Exempt from rate limit and API key. For production, consider a Prometheus exporter or your APM’s agent instead of this in-memory counter.
- **Health**: `GET /health` (liveness) and `GET /health/ready` (readiness — verifies the database is reachable) are both exempt from rate limit and auth. Point load balancer / Railway health checks at `/health/ready`.

## CORS

- **Default**: `CORS_ORIGINS` is empty, which blocks **all** cross-origin requests (deny-all). With `DEBUG=true` and no origins set, the app falls back to the local dev origins (`http://localhost:8081`, `http://localhost:3000`, `http://localhost:19006`).
- **Production**: Set `CORS_ORIGINS` to a comma-separated list of allowed origins (no spaces), e.g.:
  ```bash
  CORS_ORIGINS=https://yourapp.com,https://admin.yourapp.com
  ```
- The app does not allow wildcard subdomains; list each origin explicitly.

## Optional API key auth

When you need to restrict access or support multiple tenants:

1. Set in `.env`:
   ```bash
   API_KEY_REQUIRED=true
   API_KEYS=your-secret-key,another-key
   ```
2. Clients must send the header `X-API-Key: your-secret-key`. `Authorization: Bearer` is **not** accepted for API keys — the `Authorization` header is reserved for Supabase user JWTs and is never treated as an API key.
3. **Exempt paths** (no key required): `/health`, `/health/ready`, `/metrics`.
4. Invalid or missing key → `401` with `{"detail": "Invalid or missing API key. Provide X-API-Key header."}`.

**Mobile app**: In Settings, enter the API key and save; the app sends it on all API requests when set.

## Security notes

- Run behind a reverse proxy (e.g. nginx, Caddy) for TLS and to set `X-Forwarded-For` / `X-Forwarded-Proto`.
- Keep `DEBUG=false` in production.
- Store `API_KEYS` and `MTD_API_KEY` in secrets (env or secret manager), not in code.
- Rate limiting is per-IP (100/minute) — but per-IP only works when proxy headers are trusted. The limiter keys on `request.client.host`, which is the proxy's IP unless the ASGI server rewrites it from `X-Forwarded-For`. On Railway (Railway's edge is the sole ingress), set `FORWARDED_ALLOW_IPS=*` and `TRUST_PROXY_HEADERS=true` so uvicorn uses the rightmost untrusted entry of `X-Forwarded-For` as the client address. Without this, every client shares one 100/minute bucket. Never trust the **leftmost** XFF entry — it is client-supplied and spoofable; uvicorn's rightmost-based resolution is what makes the limit unforgeable. If you use API keys, consider per-key limits in the future.

## Railway Deployment

### One-time setup

1. Create a Railway account at https://railway.app
2. New project → "Deploy from GitHub repo" → select `rsahasi/UIUC-bustle`
3. In service settings, set **Root Directory** to `backend/`
4. Add a **PostgreSQL** database (New → Database → PostgreSQL). Railway injects
   `DATABASE_URL` automatically. All persistent data — buildings, schedule,
   stops, crowding reports, and shared trips — lives here, so no volume is needed.
5. Add **Environment Variables**:
   - `MTD_API_KEY=<your key>`
   - `CLAUDE_API_KEY=<your key>`
   - `SUPABASE_JWT_SECRET=<your secret>` and `SUPABASE_URL=<your project url>`
   - `SENTRY_DSN=<your dsn>` (optional)
   - `CORS_ORIGINS=https://<your-subdomain>.up.railway.app`
   - `PUBLIC_BASE_URL=https://<your-subdomain>.up.railway.app` (share links; do not rely on the Host header)
   - `FORWARDED_ALLOW_IPS=*` and `TRUST_PROXY_HEADERS=true` (Railway edge is the only ingress; enables real per-client rate limiting)
   - `API_KEY_REQUIRED=true` and `API_KEYS=<generated 32-byte hex key>` — required in production to gate the billed Google/OSRM/Nominatim proxy endpoints. (Only leave `API_KEY_REQUIRED=false` temporarily if the shipped mobile build does not yet send the key; flip it on with the app release that does.)
6. Set **Health Check Path** to `/health/ready` (verifies the database is reachable)
7. Deploy — Railway builds the Docker image (running `load_gtfs.py` during the
   build) and runs `alembic upgrade head` on start, creating all tables.

### After deploy

1. Copy your `*.up.railway.app` URL from the Railway dashboard
2. Add to `mobile/.env`:
   ```
   EXPO_PUBLIC_API_BASE_URL=https://<your-subdomain>.up.railway.app
   ```
3. Reload the app — it will now talk to the Railway backend

### Re-deploying

Push to `main` — Railway auto-deploys. GTFS is re-downloaded on every build.

### Updating GTFS data

The GTFS feed is baked into the Docker image at build time. To get a fresh feed:
- Push any change to `main` (or trigger a manual deploy in Railway dashboard)
- Railway rebuilds the image and re-runs `load_gtfs.py`
