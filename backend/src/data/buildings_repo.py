import json
import uuid
from typing import NamedTuple, Optional
import asyncpg

VALID_DAYS = frozenset({"MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"})


class BuildingRecord(NamedTuple):
    building_id: str
    name: str
    lat: float
    lng: float


class ClassRecord(NamedTuple):
    class_id: str
    title: str
    days_of_week: list[str]
    start_time_local: str
    building_id: str
    user_id: str
    destination_lat: Optional[float] = None
    destination_lng: Optional[float] = None
    destination_name: Optional[str] = None
    end_time_local: Optional[str] = None


def _row_to_building(row) -> BuildingRecord:
    return BuildingRecord(
        building_id=row["building_id"],
        name=row["name"],
        lat=row["lat"],
        lng=row["lng"],
    )


def _row_to_class(row) -> ClassRecord:
    try:
        days = json.loads(row["days_of_week"]) if row["days_of_week"] else []
    except (json.JSONDecodeError, TypeError):
        days = []
    return ClassRecord(
        class_id=row["class_id"],
        title=row["title"],
        days_of_week=days,
        start_time_local=row["start_time_local"],
        building_id=row["building_id"],
        user_id=row["user_id"],
        destination_lat=row["destination_lat"],
        destination_lng=row["destination_lng"],
        destination_name=row["destination_name"],
        end_time_local=row["end_time_local"],
    )


# Placeholder row (at 0,0) that schedule_classes.building_id points at when a
# class has a free-form destination instead of a campus building. It is not a
# real place, so it never appears in listings or lookups.
CUSTOM_BUILDING_ID = "custom"


async def list_buildings(pool: asyncpg.Pool) -> list[BuildingRecord]:
    rows = await pool.fetch(
        "SELECT building_id, name, lat, lng FROM buildings WHERE building_id != $1 ORDER BY name",
        CUSTOM_BUILDING_ID,
    )
    return [_row_to_building(r) for r in rows]


async def get_building(pool: asyncpg.Pool, building_id: str) -> Optional[BuildingRecord]:
    if building_id == CUSTOM_BUILDING_ID:
        return None
    row = await pool.fetchrow(
        "SELECT building_id, name, lat, lng FROM buildings WHERE building_id = $1",
        building_id,
    )
    return _row_to_building(row) if row else None


async def search_buildings(
    pool: asyncpg.Pool, query: str, limit: int = 6
) -> list[BuildingRecord]:
    """Search buildings by name using pg_trgm. Replaces both search_buildings and search_buildings_fts."""
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped}%"
    rows = await pool.fetch(
        """
        SELECT building_id, name, lat, lng
        FROM buildings
        WHERE building_id != 'custom'
          AND (name ILIKE $1 ESCAPE '\\' OR similarity(name, $2) > 0.2)
        ORDER BY similarity(name, $2) DESC
        LIMIT $3
        """,
        pattern,
        query,
        limit,
    )
    return [_row_to_building(r) for r in rows]


async def create_class(
    pool: asyncpg.Pool,
    *,
    title: str,
    days_of_week: list[str],
    start_time_local: str,
    building_id: Optional[str] = None,
    user_id: str,
    class_id: Optional[str] = None,
    destination_lat: Optional[float] = None,
    destination_lng: Optional[float] = None,
    destination_name: Optional[str] = None,
    end_time_local: Optional[str] = None,
) -> ClassRecord:
    if class_id is None:
        class_id = str(uuid.uuid4())
    if building_id is None:
        building_id = CUSTOM_BUILDING_ID

    await pool.execute(
        """
        INSERT INTO schedule_classes
          (class_id, user_id, title, days_of_week, start_time_local, building_id,
           destination_lat, destination_lng, destination_name, end_time_local)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        """,
        class_id,
        user_id,
        title,
        json.dumps(days_of_week),
        start_time_local,
        building_id,
        destination_lat,
        destination_lng,
        destination_name,
        end_time_local,
    )
    return ClassRecord(
        class_id=class_id,
        title=title,
        days_of_week=days_of_week,
        start_time_local=start_time_local,
        building_id=building_id,
        user_id=user_id,
        destination_lat=destination_lat,
        destination_lng=destination_lng,
        destination_name=destination_name,
        end_time_local=end_time_local,
    )


async def delete_class(
    pool: asyncpg.Pool, class_id: str, user_id: str
) -> bool:
    result = await pool.execute(
        "DELETE FROM schedule_classes WHERE class_id = $1 AND user_id = $2",
        class_id,
        user_id,
    )
    return result == "DELETE 1"


async def list_classes(
    pool: asyncpg.Pool, user_id: str
) -> list[ClassRecord]:
    rows = await pool.fetch(
        "SELECT * FROM schedule_classes WHERE user_id = $1 ORDER BY start_time_local, title",
        user_id,
    )
    return [_row_to_class(r) for r in rows]


_UPDATABLE_FIELDS = frozenset({
    "title", "building_id", "days_of_week",
    "start_time_local", "end_time_local", "destination_lat", "destination_lng",
    "destination_name",
})


async def update_class(
    pool: asyncpg.Pool, class_id: str, user_id: str, updates: dict
) -> ClassRecord | None:
    """Update a class by ID and user_id. Returns updated record or None if not found."""
    # Only keep safe, known fields that are not None
    safe = {k: v for k, v in updates.items() if k in _UPDATABLE_FIELDS and v is not None}
    if not safe:
        # Nothing to update — return the existing record
        row = await pool.fetchrow(
            "SELECT * FROM schedule_classes WHERE class_id = $1 AND user_id = $2",
            class_id,
            user_id,
        )
        return _row_to_class(row) if row else None

    # Serialize days_of_week to JSON string if present
    if "days_of_week" in safe and isinstance(safe["days_of_week"], list):
        safe["days_of_week"] = json.dumps(safe["days_of_week"])

    set_clauses = []
    params: list = []
    for i, (col, val) in enumerate(safe.items(), start=1):
        set_clauses.append(f"{col} = ${i}")
        params.append(val)

    # class_id and user_id are the last params
    params.append(class_id)
    params.append(user_id)
    cid_param = len(params) - 1
    uid_param = len(params)

    sql = (
        f"UPDATE schedule_classes SET {', '.join(set_clauses)} "
        f"WHERE class_id = ${cid_param} AND user_id = ${uid_param} "
        f"RETURNING *"
    )
    row = await pool.fetchrow(sql, *params)
    return _row_to_class(row) if row else None
