#!/usr/bin/env python3
"""
Query Overpass API for named buildings within UIUC campus bounds, then seed the Postgres buildings table.

Usage:
  python scripts/seed_buildings_from_osm.py
  python scripts/seed_buildings_from_osm.py --csv data/buildings_seed.csv --dry-run

Without --dry-run, DATABASE_URL must be set.

Campus bbox: lat 40.095–40.120, lon -88.248–-88.215 (covers main UIUC campus).
Expected yield: 80–150 buildings.
"""
import argparse
import asyncio
import csv
import os
import re
import sys
import time
from pathlib import Path

backend = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend))

from scripts.seed_buildings import upsert_buildings  # noqa: E402
from src.data.seed_csv import SeedRow  # noqa: E402

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# UIUC main campus bounding box
LAT_MIN, LAT_MAX = 40.095, 40.120
LNG_MIN, LNG_MAX = -88.248, -88.215

# Overpass QL: fetch ways+relations with both "name" and "building" tags; include center coords
OVERPASS_QUERY = f"""
[out:json][timeout:60];
(
  way["building"]["name"]({LAT_MIN},{LNG_MIN},{LAT_MAX},{LNG_MAX});
  relation["building"]["name"]({LAT_MIN},{LNG_MIN},{LAT_MAX},{LNG_MAX});
  node["building"]["name"]({LAT_MIN},{LNG_MIN},{LAT_MAX},{LNG_MAX});
);
out center tags;
"""

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(name: str) -> str:
    return _SLUG_RE.sub("_", name.lower()).strip("_")[:64]


def fetch_buildings() -> list[dict]:
    """Call Overpass API and return list of {name, lat, lng} dicts."""
    import urllib.request
    import json

    data = OVERPASS_QUERY.encode("utf-8")
    req = urllib.request.Request(
        OVERPASS_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
        method="POST",
    )
    print("Querying Overpass API for UIUC campus buildings…", flush=True)
    with urllib.request.urlopen(req, timeout=90) as resp:
        raw = json.loads(resp.read())

    elements = raw.get("elements", [])
    print(f"  Got {len(elements)} raw elements from Overpass.", flush=True)

    seen_ids: set[str] = set()
    buildings: list[dict] = []

    for el in elements:
        name = (el.get("tags") or {}).get("name", "").strip()
        if not name:
            continue

        # Get coordinates: nodes have lat/lon directly; ways/relations have center
        if el["type"] == "node":
            lat = el.get("lat")
            lng = el.get("lon")
        else:
            center = el.get("center") or {}
            lat = center.get("lat")
            lng = center.get("lon")

        if lat is None or lng is None:
            continue

        building_id = slugify(name)
        if not building_id:
            continue

        # Deduplicate by slug (keep first occurrence)
        if building_id in seen_ids:
            # Try appending OSM id to make unique
            building_id = f"{building_id}_{el['id']}"
        seen_ids.add(building_id)

        buildings.append({"building_id": building_id, "name": name, "lat": lat, "lng": lng})

    return buildings


def write_csv(buildings: list[dict], csv_path: Path) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["building_id", "name", "lat", "lng"])
        writer.writeheader()
        for b in sorted(buildings, key=lambda x: x["name"]):
            writer.writerow(b)
    print(f"  Wrote {len(buildings)} rows to {csv_path}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed UIUC buildings from OpenStreetMap via Overpass API")
    parser.add_argument("--csv", default=backend / "data" / "buildings_seed.csv", type=Path, help="Output CSV path")
    parser.add_argument("--dry-run", action="store_true", help="Print results but don't write to DB")
    args = parser.parse_args()

    t0 = time.time()
    try:
        buildings = fetch_buildings()
    except Exception as e:
        print(f"ERROR fetching from Overpass: {e}", file=sys.stderr)
        return 1

    if not buildings:
        print("No buildings found. Check bounding box or Overpass query.", file=sys.stderr)
        return 1

    print(f"  Found {len(buildings)} unique named buildings in {time.time() - t0:.1f}s.", flush=True)

    # Always write CSV for reproducibility
    write_csv(buildings, args.csv)

    if args.dry_run:
        print("Dry run — skipping DB write.")
        for b in buildings[:10]:
            print(f"  {b['building_id']:40s} {b['name']}")
        if len(buildings) > 10:
            print(f"  … and {len(buildings) - 10} more")
        return 0

    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL is not set (or pass --dry-run).", file=sys.stderr)
        return 1
    rows = [SeedRow(b["building_id"], b["name"], b["lat"], b["lng"]) for b in buildings]
    asyncio.run(upsert_buildings(database_url, rows))
    print(f"Seeded {len(rows)} buildings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
