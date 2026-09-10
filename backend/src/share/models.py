from __future__ import annotations
from typing import Optional
from pydantic import BaseModel, Field, field_validator


VALID_PHASES = frozenset({"walking", "waiting", "on_bus", "arrived"})

# Upper bound for eta_epoch: 2100-01-01T00:00:00Z. Unbounded ints (e.g. 2**70)
# overflow asyncpg's BIGINT binding and surface as a 500 instead of a 422.
ETA_EPOCH_MAX = 4102444800


class NoNulModel(BaseModel):
    """Base model that rejects NUL bytes in any string field.

    Postgres TEXT columns refuse \x00, so without this a crafted payload turns
    into an asyncpg DataError → 500 instead of a clean validation error.
    """

    @field_validator("*", mode="before")
    @classmethod
    def _reject_nul_bytes(cls, v):
        if isinstance(v, str) and "\x00" in v:
            raise ValueError("must not contain NUL bytes")
        return v


class CreateShareTripRequest(NoNulModel):
    # Capped at the model layer so oversized input is rejected before it can
    # reach SQLite; the route only truncated `destination`, leaving the other
    # three fields as an unauthenticated path to fill the disk.
    destination: str = Field(..., max_length=200)
    route_id: Optional[str] = Field(None, max_length=64)
    route_name: Optional[str] = Field(None, max_length=120)
    stop_name: Optional[str] = Field(None, max_length=120)
    phase: str = "walking"
    eta_epoch: Optional[int] = Field(None, ge=0, le=ETA_EPOCH_MAX)


class CreateShareTripResponse(BaseModel):
    token: str
    # Secret edit capability — returned only to the trip creator; required in
    # the X-Edit-Token header to PATCH the trip. Never shown on the share page.
    edit_token: str
    # None when PUBLIC_BASE_URL is unset (never derived from the Host header).
    url: Optional[str] = None


class PatchShareTripRequest(NoNulModel):
    phase: Optional[str] = None
    eta_epoch: Optional[int] = Field(None, ge=0, le=ETA_EPOCH_MAX)


class ShareTripStatusResponse(BaseModel):
    destination: Optional[str] = None
    route_id: Optional[str] = None
    route_name: Optional[str] = None
    stop_name: Optional[str] = None
    phase: Optional[str] = None
    eta_epoch: Optional[int] = None
    expired: bool = False
