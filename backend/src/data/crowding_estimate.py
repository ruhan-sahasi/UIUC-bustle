import re
from datetime import datetime
from zoneinfo import ZoneInfo

# Rush-hour windows below are wall-clock times in Champaign-Urbana.
_LOCAL_TZ = ZoneInfo("America/Chicago")

# Campus-heavy routes, by public number (with MTD's S/E/W direction or
# variant suffix stripped) and by the color name MTD uses for route_ids.
_CAMPUS_ROUTE_NUMBERS = frozenset({"1", "2", "13", "22"})
_CAMPUS_ROUTE_NAMES = frozenset({"YELLOW", "YELLOWHOPPER", "RED", "SILVER", "ILLINI"})
_ROUTE_NUMBER_RE = re.compile(r"^(\d+)[A-Z]?$")


def is_campus_route(route_id: str) -> bool:
    """Exact match on the route number or first word of the route name.

    A prefix test would make "1" match "10", "12", "100", and so on.
    """
    token = re.split(r"[\s_\-]+", route_id.strip().upper(), maxsplit=1)[0]
    m = _ROUTE_NUMBER_RE.match(token)
    if m:
        return m.group(1) in _CAMPUS_ROUTE_NUMBERS
    return token in _CAMPUS_ROUTE_NAMES


def estimate_crowding_level(route_id: str, now: datetime) -> dict:
    """Heuristic crowding estimate. Returns dict with level, confidence, source.

    ``now`` may be in any timezone (naive values are taken as local time); it is
    converted to Champaign time before the rush-hour windows are applied.
    """
    if now.tzinfo is not None:
        now = now.astimezone(_LOCAL_TZ)
    hour = now.hour
    weekday = now.weekday()  # 0=Mon, 6=Sun
    is_weekend = weekday >= 5
    is_campus = is_campus_route(route_id)

    if hour >= 22 or hour < 2:
        level = 1
    elif hour < 6:
        level = 1
    elif 7 <= hour < 9 and not is_weekend:
        level = 4 if is_campus else 3
    elif 16 <= hour < 18 and not is_weekend:
        level = 4 if is_campus else 3
    elif 9 <= hour < 16 and not is_weekend:
        level = 3 if is_campus else 2
    elif is_weekend and 9 <= hour < 21:
        level = 2
    else:
        level = 1

    return {"level": level, "confidence": "estimated", "source": "estimated"}
