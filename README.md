# UIUC Bustle

[![CI](https://github.com/ruhan-sahasi/UIUC-bustle/actions/workflows/ci.yml/badge.svg)](https://github.com/ruhan-sahasi/UIUC-bustle/actions/workflows/ci.yml)

A campus bus + walk navigation app for University of Illinois Urbana-Champaign students. See nearby MTD stops with live departures, get route recommendations to your next class, and navigate on foot using a built-in map - no app switching.

<p align="center">
  <img src="assets/screenshots/home.png" width="300" alt="Home screen — route recommendations" />
</p>

```
mobile/      React Native app (Expo Router)
backend/     FastAPI Python API
```

---

## Requirements

| Tool | Version |
|------|---------|
| Python | 3.11+ |
| Node.js | 18+ |
| Expo CLI | via `npx` |
| iOS Simulator | Xcode 15+ (macOS only) |

---

## 1. Backend setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Environment variables

Copy the template and fill in your keys (see `backend/.env.example` for the full list with comments):

```bash
cp .env.example .env
```

The essentials for local development:

```env
# Postgres (create the DB, then run `alembic upgrade head` once)
DATABASE_URL=postgresql://localhost:5432/uiuc

# Required for live bus departures and vehicle positions
MTD_API_KEY=your_cumtd_api_key

# Optional — enables AI route ranking, walk encouragement, EOD reports
CLAUDE_API_KEY=your_anthropic_api_key

CORS_ORIGINS=http://localhost:8081,exp://localhost:8081
```

Get an MTD key free at [developer.cumtd.com](https://developer.cumtd.com).

### Database & seed data

```bash
# Create the schema (re-run after pulling new migrations)
alembic upgrade head

# Load MTD GTFS data into data/gtfs.db. On startup the API seeds the
# Postgres stops table from it whenever that table is empty.
python scripts/load_gtfs.py

# Seed UIUC campus buildings into Postgres from the bundled CSV
python scripts/seed_buildings.py

# (Optional) Refresh buildings from OpenStreetMap
python scripts/seed_buildings_from_osm.py
```

### Start the server

```bash
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

The API is now at `http://localhost:8000`. Check `http://localhost:8000/health`.

> **Note:** the `uvicorn` binary in `.venv/bin/` may break if the venv is moved.
> Always use `python -m uvicorn` to be safe.

### API reference & auth

- Interactive docs: `http://localhost:8000/docs` (OpenAPI/Swagger).
- **Liveness:** `GET /health` → `{"status": "ok"}` (process up).
- **Readiness:** `GET /health/ready` → `200` when the database is reachable, `503` otherwise.
- **Metrics:** `GET /metrics` (request counts, uptime).

Authentication:
- User-scoped endpoints (`/recommendation`, `/ai/*`, `/schedule/*`) require a Supabase
  JWT: send `Authorization: Bearer <token>`. Set `SUPABASE_JWT_SECRET` to enable.
- Optional API-key gate: set `API_KEY_REQUIRED=true` and `API_KEYS=...`, then send the
  `X-API-Key` header. `/health`, `/health/ready`, and `/metrics` are always exempt.
- Every response includes an `X-Request-ID` header for log correlation; supply your own
  to trace a request end-to-end.

---

## 2. Mobile setup

```bash
cd mobile
npm install
```

### Start (iOS simulator — recommended)

```bash
./start-sim.sh
```

This script:
- Boots the iPhone 16e simulator (UDID `7AC99C43`)
- Pins the GPS to **UIUC Illini Union** (40.1094, -88.2273) using a persistent location scenario so it survives app relaunches
- Starts the Expo dev server and opens the app

> To use a different simulator UDID, edit `UDID=` at the top of `start-sim.sh`.

### Start (manual / other device)

```bash
npx expo start --ios       # iOS simulator
npx expo start --android   # Android emulator
npx expo start             # Expo Go on physical device (scan QR)
```

Then open **Settings** tab in the app and set the API URL to your machine's local IP, e.g. `http://192.168.1.x:8000`.

### First run

1. Grant location permission when prompted
2. The Home tab shows nearby MTD stops with live departures
3. Type a building name (e.g. `Siebel`, `Lincoln Hall`) in **Where to?** — suggestions appear as you type
4. Tap a suggestion or press **Get routes** to see walk + bus options
5. Press **Start** to navigate with the built-in map

---

## 3. Running tests

```bash
# Backend — DB-backed tests skip unless TEST_DATABASE_URL points at a
# migrated Postgres (see the CI workflow for the exact setup)
cd backend
python -m pytest -q

# Mobile — unit tests and typecheck
cd mobile
npm test
npm run typecheck
```

---

## Features

| Feature | Description |
|---------|-------------|
| Live departures | Real-time MTD bus times at nearby stops (Live badge) |
| Route recommendations | Walk vs. bus options ranked by ETA to your next class |
| Building search | 636 UIUC buildings from OSM — instant suggestions as you type |
| Internal walk navigation | Full-screen map HUD with pedometer, calories, ETA — no app switching |
| Class schedule | Add classes with address search; get departure reminders |
| Activity tracking | Steps, distance, calories per walk; 7-day bar chart |
| AI report | End-of-day activity summary (requires `CLAUDE_API_KEY`) |
| Offline mode | Last-known stop/departure data shown when network is unavailable |

---

## Project structure

```
backend/
  main.py                        FastAPI app + all route handlers
  settings.py                    Pydantic settings (reads .env)
  alembic/                       Postgres schema migrations
  requirements.txt
  data/
    buildings_seed.csv           636 OSM buildings (regenerate with seed_buildings_from_osm.py)
    stops_placeholder.csv        Placeholder — replaced by load_stops.py
  scripts/
    load_stops.py                Load a custom stops CSV into Postgres
    seed_buildings_from_osm.py   Query Overpass API → buildings_seed.csv + Postgres
    seed_buildings.py            Seed Postgres buildings from an existing CSV
    load_gtfs.py                 Download GTFS zip → gtfs.db
  src/
    ai/                          Claude client, planner, encouragement
    data/                        Postgres repos (buildings, stops, crowding) + GTFS reader
    middleware/                  API key auth, request logging
    monitoring/                  Metrics endpoint
    mtd/                         MTD API client (departures, vehicles)
    recommendation/              Route scoring + heuristic engine
    schedule/                    Pydantic models for class schedule
  tests/                         pytest suite

mobile/
  app/
    (tabs)/
      index.tsx                  Home — stops, departures, recommendations, search
      schedule.tsx               Class schedule CRUD
      map.tsx                    Live map with stop + bus markers
      activity.tsx               Steps/kcal/distance + 7-day chart
      favorites.tsx              Saved stops and places
      settings.tsx               API URL, walking mode, buffer time
    walk-nav.tsx                 Walk navigation (map + HUD + pedometer)
    trip.tsx                     Stop departure board
    after-class-planner.tsx      Evening destination planner
  src/
    api/                         Typed fetch client + response types
    constants/                   Theme, walking modes (walk/brisk/speedwalk/jog)
    hooks/                       useApiBaseUrl, useRecommendationSettings, …
    notifications/               Class reminder scheduling (2-notification system)
    storage/                     AsyncStorage helpers (classes, favorites, cache)
    utils/                       Distance, calories, next-class logic
  start-sim.sh                   One-command dev launcher with pinned UIUC GPS
```

---

## Simulator location

The simulator defaults to SFO/Apple Park. `start-sim.sh` fixes this automatically. To pin manually:

```bash
xcrun simctl location <UDID> set 40.1094,-88.2273
```

Or use the persistent scenario (survives relaunches):

```bash
xcrun simctl location <UDID> start --speed=0.001 --interval=60 \
  40.1094,-88.2273 40.1094001,-88.2273001
```
