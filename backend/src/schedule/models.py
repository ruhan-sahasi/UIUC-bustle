"""Pydantic models for buildings and schedule/classes."""
import re
from pydantic import BaseModel, Field, field_validator, model_validator

from src.data.buildings_repo import VALID_DAYS
from src.share.models import NoNulModel


class BuildingResponse(BaseModel):
    building_id: str
    name: str
    lat: float
    lng: float


class BuildingsListResponse(BaseModel):
    buildings: list[BuildingResponse]


# HH:MM (24h) or H:MM on input; always stored zero-padded so the text column
# sorts chronologically ("09:30" < "10:00", unlike "9:30").
TIME_LOCAL_PATTERN = re.compile(r"^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$")

_TITLE_MAX = 120
_NAME_MAX = 200
_BUILDING_ID_MAX = 64


def _normalize_time(v: str | None, field: str) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not TIME_LOCAL_PATTERN.match(v):
        raise ValueError(f"{field} must be in HH:MM format (24-hour), e.g. 09:30 or 14:00.")
    h, m = v.split(":")
    return f"{int(h):02d}:{m}"


def _normalize_title(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        raise ValueError("Title must not be empty.")
    if len(v) > _TITLE_MAX:
        raise ValueError(f"Title must be {_TITLE_MAX} characters or fewer.")
    return v


def _normalize_days(v: list[str] | None) -> list[str] | None:
    if v is None:
        return None
    out: list[str] = []
    for d in v:
        d = (d or "").strip().upper()
        if d not in VALID_DAYS:
            raise ValueError(f"Invalid day '{d}'. Use: MON, TUE, WED, THU, FRI, SAT, SUN.")
        if d not in out:
            out.append(d)
    if not out:
        raise ValueError("At least one day must be provided.")
    return out


def _blank_to_none(v: str | None) -> str | None:
    if v is None:
        return None
    return v.strip() or None


def _check_end_after_start(start: str | None, end: str | None) -> None:
    # Both are zero-padded HH:MM by now, so string order is time order.
    if start and end and end <= start:
        raise ValueError("end_time_local must be after start_time_local.")


class _ClassFields(NoNulModel):
    """Field shapes and validators shared by create and update."""

    title: str | None = None
    days_of_week: list[str] | None = None
    start_time_local: str | None = None
    end_time_local: str | None = None
    building_id: str | None = Field(default=None, max_length=_BUILDING_ID_MAX)
    destination_lat: float | None = Field(default=None, ge=-90, le=90)
    destination_lng: float | None = Field(default=None, ge=-180, le=180)
    destination_name: str | None = Field(default=None, max_length=_NAME_MAX)

    @field_validator("title")
    @classmethod
    def _title(cls, v: str | None) -> str | None:
        return _normalize_title(v)

    @field_validator("days_of_week")
    @classmethod
    def _days(cls, v: list[str] | None) -> list[str] | None:
        return _normalize_days(v)

    @field_validator("start_time_local")
    @classmethod
    def _start(cls, v: str | None) -> str | None:
        return _normalize_time(v, "start_time_local")

    @field_validator("end_time_local", mode="before")
    @classmethod
    def _end(cls, v: str | None) -> str | None:
        return _normalize_time(_blank_to_none(v), "end_time_local")

    @field_validator("building_id", "destination_name", mode="before")
    @classmethod
    def _optional_text(cls, v: str | None) -> str | None:
        return _blank_to_none(v)


class CreateClassRequest(_ClassFields):
    title: str
    days_of_week: list[str]
    start_time_local: str

    @model_validator(mode="after")
    def require_building_or_destination(self):
        has_building = bool(self.building_id)
        has_dest = self.destination_lat is not None and self.destination_lng is not None
        if not has_building and not has_dest:
            raise ValueError("Provide building_id or destination_lat and destination_lng (e.g. from address search).")
        if has_building and has_dest:
            raise ValueError("Provide either building_id or destination coordinates, not both.")
        _check_end_after_start(self.start_time_local, self.end_time_local)
        return self


class UpdateClassRequest(_ClassFields):
    @model_validator(mode="after")
    def end_after_start(self):
        # Only checkable when the PATCH carries both times.
        _check_end_after_start(self.start_time_local, self.end_time_local)
        return self


class ClassResponse(BaseModel):
    class_id: str
    title: str
    days_of_week: list[str]
    start_time_local: str
    building_id: str
    destination_lat: float | None = None
    destination_lng: float | None = None
    destination_name: str | None = None
    end_time_local: str | None = None


class ClassesListResponse(BaseModel):
    classes: list[ClassResponse]
