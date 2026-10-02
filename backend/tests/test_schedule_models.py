"""Validation for the class create / update request models."""
import pytest
from pydantic import ValidationError

from src.schedule.models import CreateClassRequest, UpdateClassRequest

BASE = {"title": "CS 225", "days_of_week": ["mon", "WED"], "start_time_local": "9:30", "building_id": "siebel"}


def _create(**overrides):
    return CreateClassRequest(**{**BASE, **overrides})


def test_times_are_zero_padded():
    req = _create(end_time_local="10:45")
    assert req.start_time_local == "09:30"
    assert req.end_time_local == "10:45"
    assert UpdateClassRequest(start_time_local="8:05").start_time_local == "08:05"


def test_days_are_upper_cased_and_deduped():
    assert _create(days_of_week=["mon", "MON", " wed "]).days_of_week == ["MON", "WED"]


@pytest.mark.parametrize("bad", ["24:00", "9:3", "nine", "12:60", "x" * 300])
def test_rejects_malformed_end_time(bad):
    with pytest.raises(ValidationError, match="end_time_local"):
        _create(end_time_local=bad)


def test_blank_end_time_is_none():
    assert _create(end_time_local="  ").end_time_local is None


def test_end_must_follow_start():
    with pytest.raises(ValidationError, match="after start"):
        _create(start_time_local="10:00", end_time_local="9:00")
    with pytest.raises(ValidationError, match="after start"):
        UpdateClassRequest(start_time_local="10:00", end_time_local="10:00")


@pytest.mark.parametrize("lat,lng", [(91, -88.2), (40.1, -181), (float("nan"), -88.2)])
def test_rejects_out_of_range_destination(lat, lng):
    with pytest.raises(ValidationError):
        _create(building_id=None, destination_lat=lat, destination_lng=lng)


def test_rejects_nul_bytes():
    with pytest.raises(ValidationError, match="NUL"):
        _create(title="CS\x00225")


def test_rejects_oversized_strings():
    with pytest.raises(ValidationError):
        _create(building_id="b" * 65)
    with pytest.raises(ValidationError):
        _create(building_id=None, destination_lat=40.1, destination_lng=-88.2, destination_name="n" * 201)


def test_requires_exactly_one_destination_kind():
    with pytest.raises(ValidationError, match="Provide building_id"):
        _create(building_id="  ")
    with pytest.raises(ValidationError, match="not both"):
        _create(destination_lat=40.1, destination_lng=-88.2)


def test_update_ignores_unset_fields():
    assert UpdateClassRequest(title=" New ").model_dump(exclude_none=True) == {"title": "New"}
