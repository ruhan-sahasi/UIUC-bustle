"""
Claude AI client for UIUC Bus App.
Wraps anthropic.Anthropic to provide domain-specific AI capabilities.

Every method here is best-effort: AI output is decoration on top of a
deterministic result, so a failure must degrade to a useful fallback rather
than propagate. Failures are logged per-cause so AI health is observable
instead of being flattened into one anonymous warning.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-4-6"

# --- Privacy limits for prompt content sent to the Anthropic API ---
# Coordinates are rounded to 3 decimal places (~110 m) — plenty of precision
# for bus recommendations without transmitting an exact position. Free-text
# fields are capped so unbounded client input cannot flow to a third party
# (and cannot balloon token spend).
COORD_DECIMALS = 3
MAX_FREETEXT_CHARS = 500
MAX_NAME_CHARS = 100
MAX_MODE_CHARS = 50

# A "lat,lng"-looking pair. Rewritten only when at least one side carries
# excess precision (4+ decimal places), so ordinary short numbers and
# already-rounded pairs pass through byte-identical.
_COORD_PAIR_RE = re.compile(r"(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)")


def _round_coord_pairs(text: str) -> str:
    """Round any 'lat,lng' pairs embedded in text to COORD_DECIMALS places."""

    def _repl(m: re.Match[str]) -> str:
        # A pair leaks even when only one side is over-precise (e.g. a pin
        # snapped to a grid on one axis: "40.1092345,-88.22").
        if all(
            len(g.split(".", 1)[1]) <= COORD_DECIMALS
            for g in (m.group(1), m.group(2))
        ):
            return m.group(0)
        return (
            f"{float(m.group(1)):.{COORD_DECIMALS}f},"
            f"{float(m.group(2)):.{COORD_DECIMALS}f}"
        )

    return _COORD_PAIR_RE.sub(_repl, text)


def _truncate(text: str, limit: int) -> str:
    """Hard-cap a free-text field before it is interpolated into a prompt."""
    return text if len(text) <= limit else text[:limit]


# Activity entries arrive from the client as arbitrary dicts. Only the fields
# the fitness-report prompt actually needs are forwarded; everything else
# (ids, dates, origin location, unknown keys) stays out of the API call.
_EOD_NUMERIC_FIELDS = ("distanceM", "stepCount", "durationSeconds", "caloriesBurned")


def _sanitize_activity_entry(entry: dict) -> dict:
    out: dict[str, Any] = {}
    mode = entry.get("walkingModeId") or entry.get("mode")
    if isinstance(mode, str) and mode:
        out["mode"] = _truncate(mode, MAX_MODE_CHARS)
    for key in _EOD_NUMERIC_FIELDS:
        val = entry.get(key)
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            out[key] = round(val, 1)
    dest = entry.get("to")
    if isinstance(dest, str) and dest:
        # Round before truncating so a cap can never slice a coordinate
        # pair mid-number and leave full precision behind.
        out["to"] = _truncate(_round_coord_pairs(dest), MAX_NAME_CHARS)
    return out

# These calls are one-shot generations of at most 512 tokens and sit on a
# user-facing request path. The SDK default is a 600s read timeout with 2
# retries, which lets a single hung upstream stall a request for 30 minutes.
REQUEST_TIMEOUT_SECONDS = 8.0
MAX_RETRIES = 1


def _text_of(msg: Any) -> str:
    """Return the first text block, ignoring any non-text content blocks."""
    for block in getattr(msg, "content", None) or []:
        if getattr(block, "type", None) == "text":
            return block.text
    return ""


def _parse_json_object(raw: str) -> dict[str, Any]:
    """
    Parse a JSON object from a model response.

    The prompts ask for bare JSON, but models occasionally wrap output in a
    markdown fence. Recover from that rather than discarding a good response.
    """
    text = raw.strip()
    if text.startswith("```"):
        # Drop the opening fence ("```" or "```json") and the closing fence;
        # json.loads tolerates the surrounding newlines that remain.
        text = text[3:]
        if text.startswith("json"):
            text = text[4:]
        if text.endswith("```"):
            text = text[:-3]
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError(f"expected a JSON object, got {type(data).__name__}")
    return data


class ClaudeClient:
    def __init__(self, api_key: str):
        import anthropic

        self._client = anthropic.Anthropic(
            api_key=api_key,
            timeout=REQUEST_TIMEOUT_SECONDS,
            max_retries=MAX_RETRIES,
        )

    def close(self) -> None:
        """Release the underlying HTTP connection pool."""
        try:
            self._client.close()
        except Exception:  # pragma: no cover - close must never raise
            pass

    def __enter__(self) -> "ClaudeClient":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def _log_failure(self, op: str, exc: Exception) -> None:
        """Log an AI failure under a cause-specific event name."""
        import anthropic

        # AuthenticationError and RateLimitError subclass APIStatusError, so
        # the specific checks must come before the generic status branch.
        if isinstance(exc, anthropic.AuthenticationError):
            # Distinct level: a revoked or unbilled key disables every AI
            # feature silently, since all call sites fall back cleanly.
            logger.error("claude_auth_failed op=%s", op)
        elif isinstance(exc, anthropic.RateLimitError):
            response = getattr(exc, "response", None)
            retry_after = response.headers.get("retry-after") if response is not None else None
            logger.warning("claude_rate_limited op=%s retry_after=%s", op, retry_after)
        elif isinstance(exc, anthropic.APIConnectionError):
            # Covers APITimeoutError too: the 8s budget above was exhausted.
            logger.warning("claude_unreachable op=%s error=%s", op, exc)
        elif isinstance(exc, anthropic.APIStatusError):
            logger.warning("claude_api_error op=%s status=%s", op, exc.status_code)
        elif isinstance(exc, (json.JSONDecodeError, ValueError)):
            logger.warning("claude_bad_json op=%s error=%s", op, exc)
        else:
            logger.warning("claude_error op=%s type=%s error=%s", op, type(exc).__name__, exc)

    def _ask(self, system: str, user: str, max_tokens: int = 512) -> str:
        """Make a single Claude call and return the text response."""
        msg = self._client.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        if getattr(msg, "stop_reason", None) == "max_tokens":
            # Truncated output cannot be valid JSON; say so explicitly rather
            # than letting json.loads fail with a confusing parse error.
            raise ValueError(f"response truncated at max_tokens={max_tokens}")
        return _text_of(msg)

    def get_best_route(
        self,
        origin: str,
        destination: str,
        route_options: list[dict[str, Any]],
        user_context: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Rank route options and return ai_explanation for the best one.
        Returns: { ranked_options: [...], ai_explanation: str }
        """
        identity = list(range(len(route_options)))
        system = (
            "You are a campus transit assistant for UIUC. Given route options "
            "to a destination, rank them and explain the best choice concisely. "
            "Respond ONLY with valid JSON: {\"ranked_order\": [0,1,2], \"ai_explanation\": \"...\"}. "
            "ranked_order must be a permutation of every option index, each used exactly once. "
            "Keep ai_explanation under 100 chars."
        )
        # Privacy: origin arrives as a raw "lat,lng" string from the caller;
        # round it (and any coordinates in a custom destination name) before
        # it leaves for the API. destination_name is unbounded client text.
        user = (
            f"Origin: {_round_coord_pairs(origin)}\n"
            f"Destination: {_truncate(_round_coord_pairs(destination), MAX_NAME_CHARS)}\n"
            f"Context: {json.dumps(user_context)}\n"
            f"Options:\n{json.dumps(route_options, indent=2)}"
        )
        try:
            raw = self._ask(system, user, max_tokens=256)
            data = _parse_json_object(raw)
            ranked = data.get("ranked_order", identity)
            # A non-permutation would silently drop or duplicate routes for the
            # user, so reject anything that is not an exact reordering. The
            # element check keeps floats and bools (which compare equal to
            # ints) from reaching the caller's list indexing.
            if not (
                isinstance(ranked, list)
                and all(isinstance(i, int) and not isinstance(i, bool) for i in ranked)
                and sorted(ranked) == identity
            ):
                logger.warning("claude_bad_ranking op=get_best_route ranked=%s", ranked)
                ranked = identity
            explanation = data.get("ai_explanation", "")
            return {
                "ranked_order": ranked,
                "ai_explanation": explanation if isinstance(explanation, str) else "",
            }
        except Exception as e:
            self._log_failure("get_best_route", e)
            return {
                "ranked_order": identity,
                "ai_explanation": "",
            }

    def get_after_class_plan(
        self,
        freetext_plan: str,
        completed_classes: list[dict],
        available_routes: list[dict],
        activity_today: list[dict],
    ) -> dict[str, Any]:
        """
        Return a structured evening plan.
        Returns: { narrative: str, destination_sequence: [{dest, options}] }
        """
        system = (
            "You are a helpful campus life assistant for UIUC students. "
            "Given a student's evening plans, create a logical destination sequence. "
            "Respond ONLY with valid JSON: "
            "{\"narrative\": \"...\", \"destination_sequence\": [{\"dest\": \"...\", \"options\": []}]}."
        )
        # Privacy: cap the free-text plan here as well as at the API layer, so
        # this builder is safe regardless of what a caller passes.
        freetext_plan = _truncate(freetext_plan, MAX_FREETEXT_CHARS)
        user = (
            f"Student's plan: \"{freetext_plan}\"\n"
            f"Classes completed today: {json.dumps(completed_classes)}\n"
            f"Available routes: {json.dumps(available_routes)}\n"
            f"Activity today: {json.dumps(activity_today)}"
        )
        try:
            raw = self._ask(system, user, max_tokens=512)
            data = _parse_json_object(raw)
            return {
                "narrative": data.get("narrative", ""),
                "destination_sequence": data.get("destination_sequence", []),
            }
        except Exception as e:
            self._log_failure("get_after_class_plan", e)
            return {
                "narrative": f"Here's a plan for: {freetext_plan}",
                "destination_sequence": [{"dest": freetext_plan, "options": []}],
            }

    def get_eod_activity_report(
        self,
        activity_entries: list[dict],
        walking_mode: str,
        total_stats: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Return an end-of-day activity report.
        Returns: { report: str, encouragement: str, highlights: [str] }
        """
        system = (
            "You are an encouraging fitness coach for a UIUC student. "
            "Summarize their walking activity for the day warmly and motivationally. "
            "Respond ONLY with valid JSON: "
            "{\"report\": \"...\", \"encouragement\": \"...\", \"highlights\": [\"...\"]}."
        )
        steps = total_stats.get("steps", 0)
        calories = total_stats.get("calories", 0)
        distance_m = total_stats.get("distance_m", 0)
        # Privacy: entries are arbitrary client dicts (ids, dates, origin
        # place names, anything). Forward only the whitelisted activity
        # fields the coaching prompt actually uses.
        walks = [_sanitize_activity_entry(e) for e in activity_entries[:5] if isinstance(e, dict)]
        user = (
            f"Today's activity: {len(activity_entries)} walks, "
            f"{steps} steps, {calories:.0f} kcal burned, {distance_m:.0f} m walked.\n"
            f"Walks: {json.dumps(walks)}"
        )
        try:
            raw = self._ask(system, user, max_tokens=400)
            data = _parse_json_object(raw)
            return {
                "report": data.get("report", ""),
                "encouragement": data.get("encouragement", ""),
                "highlights": data.get("highlights", []),
            }
        except Exception as e:
            self._log_failure("get_eod_activity_report", e)
            return {
                "report": f"You walked {distance_m:.0f} m, burned {calories:.0f} kcal, and took {steps} steps today!",
                "encouragement": "Keep up the great work!",
                "highlights": [],
            }

    def get_walk_encouragement(
        self,
        mode: str,
        distance_m: float,
        calories: float,
        dest_name: str,
    ) -> str:
        """Return a short one-liner encouragement after completing a walk."""
        system = (
            "You are an upbeat campus fitness coach. "
            "Give a single short encouraging sentence (under 80 chars) after a student completes a walk. "
            "Respond with just the sentence, no quotes."
        )
        # Privacy: dest_name is client text and may be a raw "lat,lng" label
        # for a custom pin; cap it and round any embedded coordinates.
        safe_dest = _truncate(_round_coord_pairs(dest_name), MAX_NAME_CHARS)
        user = (
            f"Student completed a {_truncate(mode, MAX_MODE_CHARS)} walk of "
            f"{distance_m:.0f} m to {safe_dest}, burning {calories:.1f} kcal."
        )
        try:
            return self._ask(system, user, max_tokens=60).strip()
        except Exception as e:
            self._log_failure("get_walk_encouragement", e)
            return f"Great job walking to {dest_name}!"
