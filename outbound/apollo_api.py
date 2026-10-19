"""Apollo.io REST client. Every endpoint here is one the vestige outbound CLI verified live.

Search (mixed_people/api_search) is free and returns obfuscated people. Revealing a person
(people/match by id) costs one email credit, which is why every revealing command has a cap.
Sequences are driven through emailer_campaigns / emailer_steps / sequences, and Apollo sends the
emails itself from a mailbox you connect inside Apollo.
"""
from __future__ import annotations

import time
from typing import Any, Callable

import httpx

BASE = "https://api.apollo.io/api/v1"


class ApolloError(Exception):
    pass


class Apollo:
    def __init__(self, api_key: str, *, http: httpx.Client | None = None,
                 sleep: Callable[[float], None] = time.sleep, base: str = BASE):
        if not api_key:
            raise ApolloError("No APOLLO_API_KEY. Add it to outbound/.env (Apollo: Settings > Integrations > API).")
        self.key = api_key
        self.http = http or httpx.Client(timeout=httpx.Timeout(45.0, connect=15.0))
        self.sleep = sleep
        self.base = base.rstrip("/")
        self.reveals = 0

    def call(self, method: str, path: str, body: dict | None = None, params: dict | None = None,
             _retried: bool = False) -> dict:
        url = f"{self.base}/{path.lstrip('/')}"
        headers = {"X-Api-Key": self.key, "Content-Type": "application/json", "Cache-Control": "no-cache"}
        try:
            resp = self.http.request(method, url, json=body, params=params, headers=headers)
        except httpx.TransportError as exc:
            if _retried:
                raise ApolloError(f"{method} {path}: network error {exc}") from exc
            self.sleep(5)
            return self.call(method, path, body, params, _retried=True)
        if resp.status_code == 429 and not _retried:
            # Apollo rate limits use fixed one-minute windows.
            self.sleep(65)
            return self.call(method, path, body, params, _retried=True)
        try:
            data = resp.json()
        except ValueError:
            data = {"raw": resp.text[:300]}
        if resp.status_code in (401, 403):
            raise ApolloError(
                f"{method} {path} -> HTTP {resp.status_code}: Apollo refused the key or your plan lacks this "
                f"endpoint. Use a master API key. {str(data)[:200]}"
            )
        if resp.status_code >= 400:
            raise ApolloError(f"{method} {path} -> HTTP {resp.status_code}: {str(data)[:300]}")
        return data

    # ------------------------------------------------------------------ people
    def health(self) -> dict:
        return self.call("GET", "auth/health")

    def org(self, domain: str) -> dict:
        return self.call("GET", "organizations/enrich", params={"domain": domain}).get("organization") or {}

    def search_people(self, *, domains: list[str], titles: list[str], page: int = 1, per_page: int = 25,
                      locations: list[str] | None = None) -> list[dict]:
        body: dict[str, Any] = {"q_organization_domains_list": domains, "person_titles": titles,
                                "page": page, "per_page": per_page}
        if locations:
            body["person_locations"] = locations
        return self.call("POST", "mixed_people/api_search", body).get("people") or []

    def match(self, *, id: str | None = None, first: str | None = None, last: str | None = None,
              domain: str | None = None, org: str | None = None) -> dict:
        """Reveal one person. Costs one email credit when Apollo returns an email."""
        body: dict[str, Any] = {"reveal_personal_emails": False}
        for key, value in (("id", id), ("first_name", first), ("last_name", last), ("domain", domain),
                           ("organization_name", org)):
            if value:
                body[key] = value
        person = self.call("POST", "people/match", body).get("person") or {}
        self.reveals += 1
        organization = person.get("organization") or {}
        return {
            "id": person.get("id", ""),
            "name": person.get("name") or " ".join(x for x in (person.get("first_name"), person.get("last_name")) if x),
            "first_name": person.get("first_name") or "",
            "last_name": person.get("last_name") or "",
            "title": person.get("title") or "",
            "company": organization.get("name") or "",
            "email": person.get("email") or "",
            "email_status": person.get("email_status") or "",
            "linkedin": person.get("linkedin_url") or "",
            "city": person.get("city") or "",
            "state": person.get("state") or "",
        }

    # ------------------------------------------------------------------ sequences
    def email_accounts(self) -> list[dict]:
        return self.call("GET", "email_accounts").get("email_accounts") or []

    def schedules(self) -> list[dict]:
        return self.call("GET", "emailer_schedules").get("emailer_schedules") or []

    def create_campaign(self, name: str) -> dict:
        return self.call("POST", "emailer_campaigns", {"name": name, "permissions": "team_can_use"})["emailer_campaign"]

    def campaign(self, campaign_id: str) -> dict:
        return self.call("GET", f"emailer_campaigns/{campaign_id}")

    def add_step(self, campaign_id: str) -> dict:
        return self.call("POST", "emailer_steps", {
            "emailer_campaign_id": campaign_id, "priority": "high", "type": "auto_email",
            "wait_mode": "day", "wait_time": 2, "exact_datetime": None, "note": None,
        })

    def put_sequence(self, campaign_id: str, body: dict) -> dict:
        # WARNING (learned live): this PUT treats the payload as the COMPLETE desired state.
        # Sending it without the full emailer_steps array deletes steps, partially, with no rollback.
        if "emailer_steps" not in body:
            raise ApolloError("refusing to PUT a sequence without its full emailer_steps array")
        return self.call("PUT", f"sequences/{campaign_id}", body)

    def find_contact(self, email: str) -> dict | None:
        found = self.call("POST", "contacts/search", {"q_keywords": email, "per_page": 3}).get("contacts") or []
        return next((c for c in found if (c.get("email") or "").lower() == email.lower()), None)

    def create_contact(self, *, first: str, last: str, email: str, company: str, title: str) -> dict:
        return self.call("POST", "contacts", {
            "first_name": first, "last_name": last, "email": email, "organization_name": company, "title": title,
        }).get("contact") or {}

    def add_contacts(self, campaign_id: str, contact_ids: list[str], mailbox_id: str) -> dict:
        return self.call("POST", f"emailer_campaigns/{campaign_id}/add_contact_ids", {
            "contact_ids": contact_ids,
            "emailer_campaign_id": campaign_id,
            "send_email_from_email_account_id": mailbox_id,
            "sequence_active_in_other_campaigns": False,
        })
