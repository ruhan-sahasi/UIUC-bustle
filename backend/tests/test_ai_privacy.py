"""
Privacy tests for prompts sent to the Anthropic API from src/ai/**.

These tests exercise the prompt-builder methods on ClaudeClient directly with
a stubbed transport (no anthropic SDK call is ever made) and assert on the
exact prompt text that would leave the service:

- coordinates appear only rounded to 3 decimal places (~110 m),
- unbounded free-text fields are truncated,
- activity entries are whitelisted (ids, dates, origins, unknown keys such as
  emails never reach the prompt).
"""
from __future__ import annotations

import json
from types import SimpleNamespace

from src.ai.claude_client import (
    MAX_FREETEXT_CHARS,
    MAX_MODE_CHARS,
    MAX_NAME_CHARS,
    ClaudeClient,
    _round_coord_pairs,
    _sanitize_activity_entry,
    _truncate,
)


class _CapturingMessages:
    """Stub for anthropic client.messages that records create() kwargs."""

    def __init__(self, response_text: str):
        self.calls: list[dict] = []
        self._response_text = response_text

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=self._response_text)],
            stop_reason="end_turn",
        )


def _make_client(response_text: str) -> tuple[ClaudeClient, _CapturingMessages]:
    """Build a ClaudeClient without touching the anthropic SDK."""
    client = ClaudeClient.__new__(ClaudeClient)
    messages = _CapturingMessages(response_text)
    client._client = SimpleNamespace(messages=messages, close=lambda: None)
    return client, messages


def _sent_prompt(messages: _CapturingMessages) -> str:
    assert len(messages.calls) == 1
    return messages.calls[0]["messages"][0]["content"]


# --- helper-level tests -------------------------------------------------------

def test_round_coord_pairs_rounds_to_three_decimals():
    assert _round_coord_pairs("40.1092345,-88.2272819") == "40.109,-88.227"


def test_round_coord_pairs_handles_spacing_and_surrounding_text():
    out = _round_coord_pairs("pin at 40.1092345 , -88.2272819 on campus")
    assert out == "pin at 40.109,-88.227 on campus"


def test_round_coord_pairs_leaves_ordinary_numbers_alone():
    # Values with <= 3 decimals (already-rounded coords, kcal, minutes) and
    # lone numbers are untouched.
    text = "Walk of 812 m, 42.5 kcal, eta 12.0 min, at 40.109,-88.227"
    assert _round_coord_pairs(text) == text


def test_round_coord_pairs_rounds_when_only_one_side_is_precise():
    # A pair leaks the user's position even when only one axis is
    # over-precise (e.g. a pin snapped to a grid on the other axis).
    assert _round_coord_pairs("40.1092345,-88.22") == "40.109,-88.220"
    assert _round_coord_pairs("40.11, -88.2272819") == "40.110,-88.227"


def test_truncate_caps_and_preserves():
    assert _truncate("short", 10) == "short"
    assert _truncate("x" * 20, 10) == "x" * 10


def test_sanitize_activity_entry_whitelists_fields():
    entry = {
        "id": "9f8e7d6c-5b4a-3210-fedc-ba9876543210",
        "date": "2026-09-10",
        "walkingModeId": "brisk",
        "distanceM": 812.437,
        "stepCount": 1042,
        "durationSeconds": 640,
        "caloriesBurned": 42.5518,
        "from": "Private Apartment, 123 W. Secret St.",
        "to": "Grainger Engineering Library",
        "email": "student@illinois.edu",
    }
    out = _sanitize_activity_entry(entry)
    assert out == {
        "mode": "brisk",
        "distanceM": 812.4,
        "stepCount": 1042,
        "durationSeconds": 640,
        "caloriesBurned": 42.6,
        "to": "Grainger Engineering Library",
    }
    for leaked in ("id", "date", "from", "email"):
        assert leaked not in out


# --- get_best_route -----------------------------------------------------------

def test_get_best_route_rounds_origin_coordinates():
    client, messages = _make_client(
        json.dumps({"ranked_order": [0], "ai_explanation": "Fastest option."})
    )
    result = client.get_best_route(
        origin="40.1092345,-88.2272819",
        destination="Illini Union",
        route_options=[{"type": "bus", "eta_minutes": 8, "depart_in_minutes": 2, "summary": "Bus 22"}],
        user_context={},
    )
    prompt = _sent_prompt(messages)
    assert "40.109,-88.227" in prompt
    assert "40.1092345" not in prompt
    assert "-88.2272819" not in prompt
    # Feature intact: valid ranking and explanation still returned.
    assert result["ranked_order"] == [0]
    assert result["ai_explanation"] == "Fastest option."


def test_get_best_route_rounds_coords_inside_destination_and_caps_length():
    client, messages = _make_client(
        json.dumps({"ranked_order": [0], "ai_explanation": ""})
    )
    long_dest = "Dropped pin 40.1234567,-88.7654321 " + "A" * 300
    client.get_best_route(
        origin="40.1000000,-88.2000000",
        destination=long_dest,
        route_options=[{"type": "walk", "eta_minutes": 5, "depart_in_minutes": 0, "summary": "Walk"}],
        user_context={},
    )
    prompt = _sent_prompt(messages)
    assert "40.123,-88.765" in prompt
    assert "40.1234567" not in prompt
    dest_line = next(l for l in prompt.splitlines() if l.startswith("Destination: "))
    assert len(dest_line) - len("Destination: ") <= MAX_NAME_CHARS


# --- get_after_class_plan -----------------------------------------------------

def test_get_after_class_plan_truncates_oversized_freetext():
    client, messages = _make_client(
        json.dumps({"narrative": "ok", "destination_sequence": []})
    )
    plan = "gym then library " * 100  # 1700 chars, well over the cap
    client.get_after_class_plan(
        freetext_plan=plan,
        completed_classes=[],
        available_routes=[],
        activity_today=[],
    )
    prompt = _sent_prompt(messages)
    assert plan not in prompt
    assert plan[:MAX_FREETEXT_CHARS] in prompt
    assert plan[: MAX_FREETEXT_CHARS + 1] not in prompt


def test_get_after_class_plan_short_freetext_unchanged():
    client, messages = _make_client(
        json.dumps({"narrative": "ok", "destination_sequence": []})
    )
    client.get_after_class_plan(
        freetext_plan="gym then dinner on Green Street",
        completed_classes=[],
        available_routes=[],
        activity_today=[],
    )
    assert 'Student\'s plan: "gym then dinner on Green Street"' in _sent_prompt(messages)


# --- get_eod_activity_report --------------------------------------------------

def test_get_eod_report_strips_ids_dates_origins_and_unknown_fields():
    client, messages = _make_client(
        json.dumps({"report": "r", "encouragement": "e", "highlights": []})
    )
    entries = [
        {
            "id": "9f8e7d6c-5b4a-3210-fedc-ba9876543210",
            "date": "2026-09-10",
            "walkingModeId": "walk",
            "distanceM": 500.0,
            "stepCount": 700,
            "durationSeconds": 420,
            "caloriesBurned": 25.0,
            "from": "Home Apartment",
            "to": "Main Library",
            "email": "student@illinois.edu",
            "token": "sekret-token-value",
        }
    ]
    client.get_eod_activity_report(
        activity_entries=entries,
        walking_mode="mixed",
        total_stats={"steps": 700, "calories": 25.0, "distance_m": 500.0},
    )
    prompt = _sent_prompt(messages)
    assert "9f8e7d6c" not in prompt
    assert "2026-09-10" not in prompt
    assert "Home Apartment" not in prompt
    assert "student@illinois.edu" not in prompt
    assert "sekret-token-value" not in prompt
    # Purpose-relevant fields still flow.
    assert "Main Library" in prompt
    assert "700" in prompt


def test_get_eod_report_truncates_long_destination_and_skips_non_dicts():
    client, messages = _make_client(
        json.dumps({"report": "r", "encouragement": "e", "highlights": []})
    )
    long_to = "B" * 300
    client.get_eod_activity_report(
        activity_entries=[{"to": long_to, "stepCount": 10}, "not-a-dict", 42],
        walking_mode="mixed",
        total_stats={"steps": 10, "calories": 1.0, "distance_m": 10.0},
    )
    prompt = _sent_prompt(messages)
    assert long_to not in prompt
    assert "B" * MAX_NAME_CHARS in prompt
    assert "not-a-dict" not in prompt


# --- get_walk_encouragement ---------------------------------------------------

def test_get_walk_encouragement_rounds_coordinate_dest_and_caps_fields():
    client, messages = _make_client("Nice walk!")
    result = client.get_walk_encouragement(
        mode="m" * 200,
        distance_m=812.0,
        calories=42.5,
        dest_name="40.1092345,-88.2272819",
    )
    prompt = _sent_prompt(messages)
    assert "40.109,-88.227" in prompt
    assert "40.1092345" not in prompt
    assert "m" * 200 not in prompt
    assert "m" * MAX_MODE_CHARS in prompt
    assert result == "Nice walk!"


def test_get_walk_encouragement_truncates_long_dest_name():
    client, messages = _make_client("Nice walk!")
    client.get_walk_encouragement(
        mode="walk",
        distance_m=100.0,
        calories=5.0,
        dest_name="D" * 300,
    )
    prompt = _sent_prompt(messages)
    assert "D" * 300 not in prompt
    assert "D" * MAX_NAME_CHARS in prompt
