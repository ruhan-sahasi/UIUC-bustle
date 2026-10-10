"""Apollo.io API client.

Two-step flow, which is how Apollo's current API is designed:
  1. People API Search (POST /mixed_people/api_search) finds people by company domain and title.
     It is free (no credits) but returns no emails and obfuscated last names.
  2. Bulk People Enrichment (POST /people/bulk_match, up to 10 people per call) reveals the work
     email and its verification status. This step costs credits, so the pipeline only enriches
     the top-ranked candidates and stops at a per-run budget.

Auth is the X-Api-Key header. Apollo uses fixed per-minute windows for rate limits, so a 429 is
retried after the Retry-After header (or a short backoff).
"""
from __future__ import annotations

import time
from typing import Any, Callable

import httpx


class ApolloError(Exception):
    pass


class ApolloBudgetExceeded(ApolloError):
    pass


class ApolloClient:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://api.apollo.io/api/v1",
        http: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
        max_retries: int = 4,
        enrich_budget: int | None = None,
        on_usage: Callable[[str, dict], None] | None = None,
    ):
        if not api_key:
            raise ApolloError("No Apollo API key. Set APOLLO_API_KEY in recruiter-outreach/.env.")
        self.base_url = base_url.rstrip("/")
        self.http = http or httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0))
        self.sleep = sleep
        self.max_retries = max_retries
        self.enrich_budget = enrich_budget
        self.enriched = 0
        self.on_usage = on_usage
        self.headers = {
            "X-Api-Key": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Cache-Control": "no-cache",
        }

    # ------------------------------------------------------------------ transport
    def _request(self, method: str, path: str, *, params: Any = None, json: Any = None) -> dict:
        url = f"{self.base_url}{path}"
        for attempt in range(self.max_retries + 1):
            try:
                resp = self.http.request(method, url, params=params, json=json, headers=self.headers)
            except httpx.TransportError as exc:
                if attempt == self.max_retries:
                    raise ApolloError(f"Network error calling Apollo {path}: {exc}") from exc
                self.sleep(min(30, 2 ** attempt * 2))
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == self.max_retries:
                    raise ApolloError(f"Apollo {path} kept failing (HTTP {resp.status_code}): {resp.text[:300]}")
                retry_after = resp.headers.get("retry-after")
                wait = float(retry_after) if retry_after and retry_after.replace(".", "", 1).isdigit() else min(60, 5 * 2 ** attempt)
                self.sleep(wait)
                continue
            if resp.status_code in (401, 403):
                raise ApolloError(
                    f"Apollo refused {path} (HTTP {resp.status_code}). Check that the key is a master API key "
                    f"and that your plan includes this endpoint. Response: {resp.text[:300]}"
                )
            if resp.status_code >= 400:
                raise ApolloError(f"Apollo {path} returned HTTP {resp.status_code}: {resp.text[:500]}")
            try:
                return resp.json()
            except ValueError as exc:
                raise ApolloError(f"Apollo {path} returned non-JSON: {resp.text[:200]}") from exc
        raise ApolloError(f"Apollo {path} failed after retries")

    # ------------------------------------------------------------------ endpoints
    def health(self) -> dict:
        return self._request("GET", "/auth/health")

    def search_people(
        self,
        *,
        domains: list[str],
        titles: list[str],
        locations: list[str] | None = None,
        include_similar_titles: bool = True,
        page: int = 1,
        per_page: int = 25,
    ) -> dict:
        """Free search. Returns {"people": [...], "total_entries": N, ...}; no emails."""
        params: list[tuple[str, str | int]] = []
        params += [("q_organization_domains_list[]", d) for d in domains]
        params += [("person_titles[]", t) for t in titles]
        params += [("person_locations[]", loc) for loc in (locations or [])]
        params += [
            ("include_similar_titles", "true" if include_similar_titles else "false"),
            ("page", page),
            ("per_page", per_page),
        ]
        data = self._request("POST", "/mixed_people/api_search", params=params)
        if self.on_usage:
            self.on_usage("search", {"calls": 1, "results": len(data.get("people") or [])})
        return data

    def bulk_enrich(self, details: list[dict], *, reveal_personal_emails: bool = False) -> list[dict | None]:
        """Reveal emails for up to 10 people per call. Each detail is e.g. {"id": apollo_person_id}.

        Returns one entry per input (None where Apollo found no match). Raises ApolloBudgetExceeded
        before spending past the per-run enrichment budget.
        """
        out: list[dict | None] = []
        for start in range(0, len(details), 10):
            chunk = details[start:start + 10]
            if self.enrich_budget is not None and self.enriched + len(chunk) > self.enrich_budget:
                raise ApolloBudgetExceeded(
                    f"Enrichment budget of {self.enrich_budget} per run reached "
                    f"(raise limits.apollo_enrich_per_run to allow more)."
                )
            data = self._request(
                "POST",
                "/people/bulk_match",
                params={"reveal_personal_emails": "true" if reveal_personal_emails else "false",
                        "reveal_phone_number": "false"},
                json={"details": chunk},
            )
            self.enriched += len(chunk)
            matches = data.get("matches") or []
            # Apollo returns matches in input order; pad in case it drops trailing misses.
            matches = list(matches) + [None] * (len(chunk) - len(matches))
            out.extend(matches[: len(chunk)])
            if self.on_usage:
                self.on_usage("bulk_match", {
                    "calls": 1,
                    "people": len(chunk),
                    "credits_consumed": data.get("credits_consumed", 0) or 0,
                    "emails": sum(1 for m in matches if m and m.get("email")),
                })
        return out

    def find_domain(self, company: str) -> str | None:
        """Resolve a company name to its primary domain via organization search."""
        data = self._request(
            "POST", "/mixed_companies/search",
            params={"q_organization_name": company, "page": 1, "per_page": 1},
        )
        orgs = data.get("organizations") or data.get("accounts") or []
        if not orgs:
            return None
        org = orgs[0]
        return org.get("primary_domain") or org.get("domain") or _domain_from_url(org.get("website_url"))


def _domain_from_url(url: str | None) -> str | None:
    if not url:
        return None
    host = httpx.URL(url if "://" in url else f"https://{url}").host
    return host.removeprefix("www.") or None
