#!/usr/bin/env python3
"""
Load stops from a CSV file into the Postgres ``stops`` table.

CSV must have columns: stop_id, stop_name, lat, lng (header row expected).
A GTFS stops.txt (stop_lat / stop_lon) is detected automatically.

Usage:
  DATABASE_URL=postgresql://... python scripts/load_stops.py
  DATABASE_URL=postgresql://... python scripts/load_stops.py --csv path/to/stops.txt --replace

Note: the API seeds stops from data/gtfs.db on startup when the table is empty,
so this script is only needed to load a custom stop list.
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

backend = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend))

from src.data.seed_csv import read_seed_rows


async def _load(database_url: str, rows: list, replace: bool) -> None:
    import asyncpg

    conn = await asyncpg.connect(database_url)
    try:
        async with conn.transaction():
            if replace:
                await conn.execute("DELETE FROM stops")
            await conn.executemany(
                """
                INSERT INTO stops (stop_id, stop_name, lat, lng)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (stop_id) DO UPDATE
                SET stop_name = EXCLUDED.stop_name, lat = EXCLUDED.lat, lng = EXCLUDED.lng
                """,
                [(r.id, r.name, r.lat, r.lng) for r in rows],
            )
    finally:
        await conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Load a stops CSV into Postgres")
    parser.add_argument(
        "--csv",
        default=backend / "data" / "stops_placeholder.csv",
        type=Path,
        help="CSV (stop_id, stop_name, lat, lng) or GTFS stops.txt",
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Delete existing stops before loading (default: upsert)",
    )
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL is not set.", file=sys.stderr)
        return 1
    if not args.csv.exists():
        print(f"Error: CSV not found: {args.csv}", file=sys.stderr)
        return 1

    try:
        rows = list(read_seed_rows(args.csv, id_col="stop_id", name_col="stop_name"))
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    asyncio.run(_load(database_url, rows, args.replace))
    print(f"Loaded {len(rows)} stops")
    return 0


if __name__ == "__main__":
    sys.exit(main())
