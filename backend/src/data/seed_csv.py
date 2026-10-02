"""CSV parsing shared by the seed scripts (stops, buildings).

Kept free of any database code so it can be unit tested directly.
"""
import csv
import math
from pathlib import Path
from typing import Iterator, NamedTuple, Optional


class SeedRow(NamedTuple):
    id: str
    name: str
    lat: float
    lng: float


def _norm(header: str) -> str:
    return header.lstrip("\ufeff").strip().lower()


def _coord(raw: Optional[str], lo: float, hi: float) -> Optional[float]:
    try:
        value = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or not lo <= value <= hi:
        return None
    return value


def read_seed_rows(
    path: Path,
    id_col: str,
    name_col: str,
    lat_cols: tuple[str, ...] = ("lat", "stop_lat"),
    lng_cols: tuple[str, ...] = ("lng", "stop_lon"),
) -> Iterator[SeedRow]:
    """Yield valid rows from a CSV, normalizing headers (case, whitespace, BOM).

    The first header present from ``lat_cols``/``lng_cols`` is used, so both our
    own seed CSVs (lat/lng) and a raw GTFS stops.txt (stop_lat/stop_lon) work.
    Rows with a blank id or a missing / out-of-range coordinate are skipped.
    Raises ValueError when the required columns are absent.
    """
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        headers = [_norm(h) for h in (reader.fieldnames or [])]
        lat_col = next((c for c in lat_cols if c in headers), None)
        lng_col = next((c for c in lng_cols if c in headers), None)
        if id_col not in headers or lat_col is None or lng_col is None:
            raise ValueError(
                f"CSV must have {id_col} and latitude/longitude columns; got {headers}"
            )
        for raw in reader:
            row = {_norm(k): (v or "") for k, v in raw.items() if k is not None}
            row_id = row.get(id_col, "").strip()
            lat = _coord(row.get(lat_col), -90.0, 90.0)
            lng = _coord(row.get(lng_col), -180.0, 180.0)
            if not row_id or lat is None or lng is None:
                continue
            yield SeedRow(row_id, row.get(name_col, "").strip(), lat, lng)
