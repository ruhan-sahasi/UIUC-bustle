"""Pick the right people to email at a company, then spend Apollo credits only on them.

Ranking favors university / early-career recruiters, then recruiters whose title matches the
track (technical recruiter for SWE, product for PM), then general talent acquisition. If a
company has no recruiters in Apollo (common at startups), it falls back to hiring-side titles
such as engineering managers or founders.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

from .apollo import ApolloBudgetExceeded, ApolloClient
from .config import Settings, Target

EARLY_CAREER = re.compile(
    r"\b(universit(y|ies)|campus|early[\s-]?(career|talent)|emerging talent|students?|internships?|"
    r"intern program|new grads?|graduate (recruit\w*|programs?)|college|entry[\s-]level)\b",
    re.I,
)
RECRUITING = re.compile(r"\b(recruit(er|ers|ing|ment)?|talent (acquisition|partner|sourc\w*)|sourcer)\b", re.I)
COORDINATOR = re.compile(r"\bcoordinator\b", re.I)
SENIOR = re.compile(r"\b(head|director|lead|manager|senior|sr\.?|principal)\b", re.I)
TRACK_WORDS = {
    "swe": re.compile(r"\b(technical|engineering|software|tech|r&d|ai|ml|machine learning|data|developer)\b", re.I),
    "pm": re.compile(r"\b(product|technical|tech)\b", re.I),
    "consulting": re.compile(r"\b(consulting|advisory|business|campus)\b", re.I),
}


@dataclass
class Candidate:
    person: dict
    score: float
    source: str  # recruiter | fallback
    reasons: list[str] = field(default_factory=list)

    @property
    def apollo_id(self) -> str | None:
        return self.person.get("id")


def is_recruiter_title(title: str) -> bool:
    return bool(RECRUITING.search(title or "") or EARLY_CAREER.search(title or ""))


def score_recruiter(title: str, track: str) -> tuple[float, list[str]]:
    score, reasons = 0.0, []
    if EARLY_CAREER.search(title):
        score += 60
        reasons.append("early-career/university")
    if RECRUITING.search(title):
        score += 30
        reasons.append("recruiting")
        if TRACK_WORDS.get(track, re.compile(r"$^")).search(title):
            score += 15
            reasons.append(f"{track} focus")
    if COORDINATOR.search(title):
        score -= 6
        reasons.append("coordinator")
    if SENIOR.search(title):
        score += 3
    return score, reasons


def score_fallback(title: str, fallback_titles: list[str]) -> tuple[float, list[str]]:
    lowered = (title or "").lower()
    for index, wanted in enumerate(fallback_titles):
        if wanted.lower() in lowered:
            return 40 - 5 * index, [f"fallback: {wanted}"]
    return 5, ["fallback: similar title"]


def location_bonus(person: dict, target_location: str | None) -> float:
    if not target_location:
        return 0.0
    tokens = {t.strip().lower() for t in re.split(r"[,/]", target_location) if t.strip()}
    fields = {str(person.get(k) or "").lower() for k in ("city", "state", "country")}
    return 8.0 if tokens & fields else 0.0


def rank(people: list[dict], *, target: Target, settings: Settings, source: str) -> list[Candidate]:
    excludes = [re.compile(p, re.I) for p in settings.apollo.exclude_title_patterns]
    fallback_titles = settings.apollo.fallback_titles.get(target.track, [])
    out: list[Candidate] = []
    seen: set[str] = set()
    for person in people:
        pid = person.get("id")
        title = (person.get("title") or "").strip()
        if not pid or pid in seen or not title:
            continue
        seen.add(pid)
        if person.get("has_email") is False:
            continue
        if any(p.search(title) for p in excludes):
            continue
        if source == "recruiter":
            if not is_recruiter_title(title):
                continue
            score, reasons = score_recruiter(title, target.track)
        else:
            score, reasons = score_fallback(title, fallback_titles)
        score += location_bonus(person, target.location)
        out.append(Candidate(person=person, score=score, source=source, reasons=reasons))
    out.sort(key=lambda c: c.score, reverse=True)
    return out


def email_matches_domain(email: str, domains: list[str]) -> bool:
    host = email.rsplit("@", 1)[-1].lower()
    return any(host == d or host.endswith("." + d) for d in domains)


def _search_all(apollo: ApolloClient, *, target: Target, settings: Settings, titles: list[str],
                similar: bool) -> list[dict]:
    people: list[dict] = []
    for page in range(1, settings.apollo.max_pages + 1):
        data = apollo.search_people(
            domains=target.domains,
            titles=titles,
            locations=settings.apollo.person_locations,
            include_similar_titles=similar,
            page=page,
            per_page=settings.apollo.per_page,
        )
        batch = data.get("people") or []
        people.extend(batch)
        total = data.get("total_entries") or (data.get("pagination") or {}).get("total_entries") or 0
        if len(batch) < settings.apollo.per_page or len(people) >= total:
            break
    return people


def _enrich_until(apollo: ApolloClient, candidates: list[Candidate], *, need: int, target: Target,
                  settings: Settings, skip: Callable[[str], bool]) -> tuple[list[Candidate], bool]:
    """Enrich candidates in rank order until `need` are accepted. Returns (accepted, budget_hit)."""
    accepted: list[Candidate] = []
    accept_status = {s.lower() for s in settings.apollo.accept_email_status}
    queue = [c for c in candidates if not skip_known(c, skip)]
    while queue and len(accepted) < need:
        batch_size = min(10, max(2, (need - len(accepted)) * 2))
        batch, queue = queue[:batch_size], queue[batch_size:]
        try:
            matches = apollo.bulk_enrich([
                {k: v for k, v in {"id": c.apollo_id, "first_name": c.person.get("first_name"),
                                   "domain": target.domain}.items() if v}
                for c in batch
            ])
        except ApolloBudgetExceeded:
            return accepted, True
        for cand, match in zip(batch, matches):
            if not match:
                continue
            email = (match.get("email") or "").strip()
            status = (match.get("email_status") or "").lower()
            if not email or status not in accept_status:
                continue
            if not email_matches_domain(email, target.domains):
                continue
            if skip(email):
                continue
            cand.person = {**cand.person, **{k: v for k, v in match.items() if v not in (None, "")}}
            accepted.append(cand)
            if len(accepted) >= need:
                break
    return accepted, False


def skip_known(candidate: Candidate, skip: Callable[[str], bool]) -> bool:
    """Skip a candidate before paying to enrich them if search already exposed a known email."""
    email = candidate.person.get("email")
    return bool(email) and skip(email)


@dataclass
class DiscoveryResult:
    found: list[Candidate]
    budget_hit: bool
    recruiters_seen: int
    fallback_used: bool


def discover(apollo: ApolloClient, target: Target, settings: Settings, *, need: int,
             skip: Callable[[str], bool] = lambda _email: False) -> DiscoveryResult:
    """Find up to `need` people with verified work emails at the target's own domain."""
    titles = target.titles or settings.apollo.recruiter_titles
    recruiters = rank(
        _search_all(apollo, target=target, settings=settings, titles=titles, similar=True),
        target=target, settings=settings, source="recruiter",
    )
    found, budget_hit = _enrich_until(apollo, recruiters, need=need, target=target, settings=settings, skip=skip)
    fallback_used = False
    fallback_titles = settings.apollo.fallback_titles.get(target.track, [])
    if not found and not budget_hit and settings.apollo.use_fallback_titles and fallback_titles:
        fallback_used = True
        hiring_side = rank(
            _search_all(apollo, target=target, settings=settings, titles=fallback_titles, similar=False),
            target=target, settings=settings, source="fallback",
        )
        found, budget_hit = _enrich_until(apollo, hiring_side, need=need, target=target, settings=settings,
                                          skip=skip)
    return DiscoveryResult(found=found, budget_hit=budget_hit, recruiters_seen=len(recruiters),
                           fallback_used=fallback_used)
