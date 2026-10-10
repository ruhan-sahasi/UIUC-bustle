"""Thin wrapper around the Anthropic SDK used by the research and writing steps.

- Every call goes through `client.beta.messages.create` so the server-side refusal fallback
  (`fallbacks: "default"`) can be enabled with one setting.
- Thinking is always on for Claude Opus 5.5; depth is controlled with `output_config.effort`.
- Structured results use `output_config.format` with a JSON schema, so replies always parse.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

from .config import LLMConfig

FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LLMError(Exception):
    pass


@dataclass
class UsageTotals:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    web_search_requests: int = 0
    web_fetch_requests: int = 0
    calls: int = 0
    by_call: list[dict] = field(default_factory=list)

    def add(self, usage: Any, label: str) -> dict:
        def g(obj: Any, name: str) -> int:
            return int(getattr(obj, name, 0) or 0) if obj is not None else 0

        server = getattr(usage, "server_tool_use", None)
        row = {
            "label": label,
            "input_tokens": g(usage, "input_tokens"),
            "output_tokens": g(usage, "output_tokens"),
            "cache_read_input_tokens": g(usage, "cache_read_input_tokens"),
            "cache_creation_input_tokens": g(usage, "cache_creation_input_tokens"),
            "web_search_requests": g(server, "web_search_requests"),
            "web_fetch_requests": g(server, "web_fetch_requests"),
        }
        for key, value in row.items():
            if key != "label":
                setattr(self, key, getattr(self, key) + value)
        self.calls += 1
        self.by_call.append(row)
        return row


class LLM:
    def __init__(self, cfg: LLMConfig, client: Any = None, on_usage: Callable[[str, dict], None] | None = None):
        self.cfg = cfg
        if client is None:
            import anthropic

            client = anthropic.Anthropic()
        self.client = client
        self.usage = UsageTotals()
        self.on_usage = on_usage

    def create(self, *, label: str, **kwargs: Any) -> Any:
        kwargs.setdefault("model", self.cfg.model)
        kwargs.setdefault("max_tokens", 16000)
        # Top-level automatic prompt caching: the system prompt and tool list are stable per
        # profile, so repeated drafts for many contacts reuse the cached prefix.
        kwargs.setdefault("cache_control", {"type": "ephemeral"})
        if self.cfg.fallbacks:
            kwargs["betas"] = [*kwargs.get("betas", []), FALLBACK_BETA]
            kwargs["fallbacks"] = "default"
        try:
            response = self.client.beta.messages.create(**kwargs)
        except Exception as exc:  # surface SDK errors with the step that failed
            import anthropic

            if isinstance(exc, anthropic.AuthenticationError):
                raise LLMError("Anthropic rejected the API key. Set ANTHROPIC_API_KEY in recruiter-outreach/.env.") from exc
            if isinstance(exc, anthropic.APIStatusError):
                raise LLMError(f"Claude API error during {label} (HTTP {exc.status_code}): {exc.message}") from exc
            if isinstance(exc, anthropic.APIConnectionError):
                raise LLMError(f"Could not reach the Claude API during {label}: {exc}") from exc
            raise
        row = self.usage.add(getattr(response, "usage", None), label)
        if self.on_usage:
            self.on_usage(label, row)
        if response.stop_reason == "refusal":
            details = getattr(response, "stop_details", None)
            raise LLMError(f"Claude declined the {label} request ({getattr(details, 'category', None)}).")
        return response

    def json(self, *, label: str, system: str, user: str, schema: dict, effort: str,
             max_tokens: int = 16000) -> dict:
        response = self.create(
            label=label,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            max_tokens=max_tokens,
        )
        if response.stop_reason == "max_tokens":
            raise LLMError(f"{label}: the reply hit max_tokens before the JSON was complete")
        text = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError(f"{label}: reply was not valid JSON: {text[:200]}") from exc

    def estimated_cost(self) -> float:
        u = self.usage
        input_cost = (u.input_tokens + 1.25 * u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens)
        return (input_cost * self.cfg.price_input_per_mtok + u.output_tokens * self.cfg.price_output_per_mtok) / 1e6 \
            + u.web_search_requests * self.cfg.price_per_web_search
