"""Send-window and business-day helpers. All stored timestamps are UTC ISO strings."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import SendWindow

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def parse_ts(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _hhmm(value: str) -> time:
    hour, minute = value.split(":")
    return time(int(hour), int(minute))


def in_send_window(now: datetime, window: SendWindow) -> bool:
    local = now.astimezone(ZoneInfo(window.timezone))
    if DAY_NAMES[local.weekday()] not in window.days:
        return False
    return _hhmm(window.start) <= local.time() < _hhmm(window.end)


def next_window_start(now: datetime, window: SendWindow) -> datetime:
    tz = ZoneInfo(window.timezone)
    local = now.astimezone(tz)
    for offset in range(0, 8):
        day = local.date() + timedelta(days=offset)
        if DAY_NAMES[day.weekday()] not in window.days:
            continue
        start = datetime.combine(day, _hhmm(window.start), tzinfo=tz)
        end = datetime.combine(day, _hhmm(window.end), tzinfo=tz)
        if offset == 0 and local >= end:
            continue
        return max(start, local) if offset == 0 else start
    raise ValueError("send window has no valid days")


def local_date(ts: datetime, tz_name: str) -> date:
    return ts.astimezone(ZoneInfo(tz_name)).date()


def business_days_between(start: date, end: date) -> int:
    """Number of Mon-Fri days after `start` up to and including `end`."""
    if end <= start:
        return 0
    days = 0
    current = start
    while current < end:
        current += timedelta(days=1)
        if current.weekday() < 5:
            days += 1
    return days
