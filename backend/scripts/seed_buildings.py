#!/usr/bin/env python3
"""
Seed the Postgres ``buildings`` table from a CSV.

Usage:
  DATABASE_URL=postgresql://... python scripts/seed_buildings.py
  DATABASE_URL=postgresql://... python scripts/seed_buildings.py --csv data/my_buildings.csv

To expand the list: edit data/buildings_seed.csv (or create your own CSV with columns
building_id, name, lat, lng) and run this script again. Existing buildings are
updated by matching building_id; new rows are inserted. Nothing is deleted, since
saved classes reference buildings by id.
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

backend = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend))

from src.data.seed_csv import SeedRow, read_seed_rows


async def upsert_buildings(database_url: str, rows: list[SeedRow]) -> None:
    import asyncpg

    conn = await asyncpg.connect(database_url)
    try:
        await conn.executemany(
            """
            INSERT INTO buildings (building_id, name, lat, lng)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (building_id) DO UPDATE
            SET name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng
            """,
            [(r.id, r.name, r.lat, r.lng) for r in rows],
        )
    finally:
        await conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed buildings into Postgres")
    parser.add_argument(
        "--csv",
        default=backend / "data" / "buildings_seed.csv",
        type=Path,
        help="CSV with columns: building_id, name, lat, lng",
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
        rows = [r for r in read_seed_rows(args.csv, id_col="building_id", name_col="name") if r.name]
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    asyncio.run(upsert_buildings(database_url, rows))
    print(f"Seeded {len(rows)} buildings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
