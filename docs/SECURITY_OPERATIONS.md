# Security operations checklist

Operator checklist for hardening the UIUC Bustle production deployment. Work top to bottom; each item is independently verifiable. Never paste secret values into chat logs, issues, or commits — refer to them by name.

## Railway environment

- [ ] **1. Enable trusted proxy headers → real per-client rate limiting.**
  Set in the Railway service:
  ```
  FORWARDED_ALLOW_IPS=*
  TRUST_PROXY_HEADERS=true
  ```
  Railway's edge proxy is the sole ingress, so trusting `*` is safe there (do NOT set this on a deployment that is directly reachable). This makes uvicorn resolve the client address from the rightmost untrusted `X-Forwarded-For` entry, which activates genuine per-IP 100/minute buckets instead of one shared bucket keyed on the proxy's IP.
  **Verify:** from two different networks, hammer any rate-limited endpoint — each client should hit its own independent `429`, not share one. Then send a request with a spoofed leftmost header (`X-Forwarded-For: 1.2.3.4, <real>`) and confirm the spoofed `1.2.3.4` does NOT get a fresh bucket (rightmost resolution ignores client-supplied leftmost entries).

- [ ] **2. Pin the public base URL.**
  ```
  PUBLIC_BASE_URL=https://uiuc-bustle-production.up.railway.app
  ```
  Kills Host-header-derived share URLs: without it, share-trip links are built from the request `Host` header, which an attacker can set to a phishing domain.

- [ ] **3. Turn on the API-key gate (AFTER the app release with origin-pinning + the fixed SecureStore key ships).**
  ```
  API_KEY_REQUIRED=true
  API_KEYS=<newly generated 32-byte hex key>
  ```
  Generate with `python -c "import secrets; print(secrets.token_hex(32))"` and ship the key in the app build. This gates the billed Google Places / OSRM / Nominatim proxy endpoints. Do not enable before the compatible mobile build is out, or every installed client breaks. Clients send it as `X-API-Key` only (Bearer is not accepted).

## Key rotation and Sentry

- [ ] **4. Rotate `MTD_API_KEY`** at https://developer.cumtd.com — AFTER the Sentry-scrubbing deploy is live (the key has been reaching Sentry span data, so the current value must be treated as exposed). Update the Railway env with the new key. Also review Sentry project membership and remove anyone who no longer needs access.

- [ ] **8. Post-deploy Sentry spot-check.** After the next deploy, open recent transactions/events and confirm:
  - no `key=` query parameters in span data,
  - no raw share tokens in paths (they should appear as `<redacted>`),
  - mobile breadcrumbs have query strings stripped.

## Local machine

- [ ] **5. Lock down env files:**
  ```bash
  chmod 600 backend/.env mobile/.env
  ```

- [ ] **9. Rebuild the backend venv from pinned requirements** (current venv has drifted: PyJWT 2.9.0 vs pinned 2.10.1, `cryptography` missing):
  ```bash
  cd backend && rm -rf .venv && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
  ```

## GitHub

- [ ] **6. Branch protection on `main`:** require at least 1 human review before merge (hard backstop for the daily automated agent). Also set default GitHub Actions workflow token permissions to **read-only** (Settings → Actions → General → Workflow permissions).

## Railway service settings

- [ ] **7. Health check path** = `/health/ready` (readiness — verifies the database is reachable), not `/health`.
