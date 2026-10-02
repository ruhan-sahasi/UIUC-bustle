from datetime import datetime, timezone, date, timedelta
from zoneinfo import ZoneInfo
import pytest
from src.data.crowding_estimate import estimate_crowding_level, is_campus_route

CHICAGO = ZoneInfo("America/Chicago")

def _dt(hour: int, weekday: int = 0) -> datetime:
    d = date(2026, 3, 10)  # A Monday (weekday=0)
    days_offset = (weekday - d.weekday()) % 7
    d = d + timedelta(days=days_offset)
    return datetime(d.year, d.month, d.day, hour, 0, 0, tzinfo=CHICAGO)

def test_peak_morning_weekday():
    result = estimate_crowding_level("22S", _dt(8, weekday=0))
    assert result["level"] >= 3

def test_peak_afternoon_weekday():
    result = estimate_crowding_level("22S", _dt(17, weekday=2))
    assert result["level"] >= 3

def test_late_night():
    result = estimate_crowding_level("ANY", _dt(23, weekday=0))
    assert result["level"] <= 2

def test_weekend_lower():
    weekday_peak = estimate_crowding_level("22S", _dt(8, weekday=1))
    weekend_same_time = estimate_crowding_level("22S", _dt(8, weekday=6))
    assert weekend_same_time["level"] <= weekday_peak["level"]

def test_source_is_estimated():
    result = estimate_crowding_level("22S", _dt(8))
    assert result["source"] == "estimated"
    assert result["confidence"] == "estimated"

def test_midday_moderate():
    result = estimate_crowding_level("22S", _dt(12, weekday=1))
    assert 1 <= result["level"] <= 3


def test_utc_instant_is_judged_in_local_time():
    # Tue 2026-03-10 17:30 CDT == 22:30 UTC. Read as UTC it looks like late night.
    utc = datetime(2026, 3, 10, 22, 30, tzinfo=timezone.utc)
    assert estimate_crowding_level("22", utc)["level"] == 4


def test_friday_evening_utc_does_not_flip_to_weekend():
    # Fri 2026-03-13 19:30 CDT == Sat 00:30 UTC; still a weekday locally.
    utc = datetime(2026, 3, 14, 0, 30, tzinfo=timezone.utc)
    assert utc.weekday() == 5
    assert estimate_crowding_level("22", utc)["level"] == 1


@pytest.mark.parametrize("route", ["22", "22S", "1", "13N", "ILLINI", "Illini Limited", "YELLOW", "silver_evening"])
def test_campus_routes_match(route):
    assert is_campus_route(route)


@pytest.mark.parametrize("route", ["10", "12", "100", "120", "TEAL", "GREEN", "", "unknown"])
def test_non_campus_routes_do_not_prefix_match(route):
    assert not is_campus_route(route)
