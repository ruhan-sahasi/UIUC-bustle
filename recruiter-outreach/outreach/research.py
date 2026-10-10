"""Company and role research with Claude plus server-side web search and web fetch.

Two calls per target:
  1. Research: Claude searches the web (and fetches the job posting if a URL is given) and writes
     a brief where every fact carries its source URL and publication date.
  2. Extraction: a tool-free call turns the brief into JSON under a strict schema.

Then code verifies the result: a fact survives only if its URL is one Claude actually retrieved in
step 1 and its date is within `max_fact_age_days`. This is the guard against invented facts, which
would be the most embarrassing failure for a cold email.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .config import Profile, Settings, Target
from .llm import LLM

RESEARCH_SYSTEM = """You research companies for a university student who writes short, honest cold \
emails to recruiters about internships. The facts you find will be quoted to a recruiter at that \
company, so accuracy matters far more than color.

Rules:
- Only report what you read in a source during this session. Never fill gaps from memory.
- Prefer primary sources: the company newsroom, engineering or research blog, product pages, earnings \
releases, and the job posting itself. Reputable press is fine. Skip rumors, opinion pieces, and \
anything you cannot date.
- Every fact needs the exact URL you read it on and its publication date.
- Explain things in plain words a smart friend outside the industry would understand."""

RESEARCH_PROMPT = """Today is {today}.

Company: {company} (website: {domain})
Role: {role}
Office location: {location}
Job posting: {posting}
Track: {track}

Background on the student, only so you can judge fit. Do not research the student.
{experiences}

The student is looking for {term}. Expected graduation: {graduation}. {citizenship}

Write a research brief with these sections:
1. What {company} does, in one or two plain sentences.
2. The team, product, or org this role most likely sits in, and what that team works on. Use the posting if you can read it.
3. Two to four recent facts about {company} that someone applying to this role could mention to show real, specific interest. Each must have been published within the last {max_age} days. For each fact give: the fact in one sentence, why it matters in plain words, the exact source URL, the source title, and the publication date as YYYY-MM-DD. Favor launches, product milestones, engineering or research posts, and customer or partnership news that relate to this role over funding announcements and mission statements.
4. Requirements or keywords from the posting that matter: languages, tools, term, location, eligibility.
5. Eligibility red flags for this student, if any, such as graduate students only, the wrong term, a graduation window the student misses, or location requirements. Write "none found" if there are none.
6. Which of the student experience ids above best fit this role, with one line on why for each.
7. The office city for this role."""

EXTRACT_SYSTEM = """You convert a research brief into JSON. Copy facts faithfully. Use only URLs \
that appear in the provided source list; if a fact has no URL from that list, leave it out. \
Dates must be YYYY-MM-DD; if only a month is known use the first of the month; if no date is \
known, leave the fact out."""

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "company_summary": {"type": "string"},
        "team_focus": {"type": "string"},
        "facts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "fact": {"type": "string"},
                    "why_it_matters": {"type": "string"},
                    "source_url": {"type": "string"},
                    "source_title": {"type": "string"},
                    "published": {"type": "string"},
                },
                "required": ["fact", "why_it_matters", "source_url", "source_title", "published"],
                "additionalProperties": False,
            },
        },
        "posting_keywords": {"type": "array", "items": {"type": "string"}},
        "eligibility_flags": {"type": "array", "items": {"type": "string"}},
        "matching_experiences": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "reason": {"type": "string"}},
                "required": ["id", "reason"],
                "additionalProperties": False,
            },
        },
        "office_city": {"type": "string"},
    },
    "required": ["company_summary", "team_focus", "facts", "posting_keywords", "eligibility_flags",
                 "matching_experiences", "office_city"],
    "additionalProperties": False,
}

TRACKING_PARAMS = re.compile(r"^(utm_|gclid|fbclid|mc_|ref$|source$)", re.I)


def normalize_url(url: str) -> str:
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip().lower()
    host = (parts.hostname or "").lower().removeprefix("www.")
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if not TRACKING_PARAMS.match(k)])
    path = parts.path.rstrip("/") or ""
    return urlunsplit(("https", host, path, query, ""))


@dataclass
class ResearchResult:
    brief: str
    data: dict
    sources: list[dict]
    dropped: list[dict]

    @property
    def usable(self) -> bool:
        return bool(self.data.get("facts"))


def _collect_sources(content: list, sources: dict[str, dict]) -> None:
    for block in content:
        btype = getattr(block, "type", None)
        if btype == "web_search_tool_result":
            results = getattr(block, "content", None)
            if isinstance(results, list):
                for r in results:
                    url = getattr(r, "url", None)
                    if url:
                        sources.setdefault(normalize_url(url), {
                            "url": url, "title": getattr(r, "title", "") or "",
                            "page_age": getattr(r, "page_age", None), "via": "search"})
        elif btype == "web_fetch_tool_result":
            result = getattr(block, "content", None)
            url = getattr(result, "url", None)
            if url:
                doc = getattr(result, "content", None)
                title = getattr(doc, "title", None) or ""
                sources[normalize_url(url)] = {"url": url, "title": title, "page_age": None, "via": "fetch"}
        elif btype == "text":
            for c in getattr(block, "citations", None) or []:
                url = getattr(c, "url", None)
                if url:
                    sources.setdefault(normalize_url(url), {
                        "url": url, "title": getattr(c, "title", "") or "", "page_age": None, "via": "citation"})


def _parse_date(value: str) -> date | None:
    value = (value or "").strip()
    for pattern in (r"^(\d{4})-(\d{2})-(\d{2})$", r"^(\d{4})-(\d{2})$"):
        m = re.match(pattern, value)
        if m:
            parts = [int(x) for x in m.groups()] + [1] * (3 - len(m.groups()))
            try:
                return date(*parts)
            except ValueError:
                return None
    return None


def verify_facts(data: dict, sources: dict[str, dict], *, today: date, max_age_days: int) -> tuple[list, list]:
    kept, dropped = [], []
    for fact in data.get("facts", []):
        url_key = normalize_url(fact.get("source_url", ""))
        published = _parse_date(fact.get("published", ""))
        if url_key not in sources:
            dropped.append({**fact, "reason": "source URL was not retrieved during research"})
        elif published is None:
            dropped.append({**fact, "reason": "no usable publication date"})
        elif published > today + timedelta(days=2):
            dropped.append({**fact, "reason": "publication date is in the future"})
        elif (today - published).days > max_age_days:
            dropped.append({**fact, "reason": f"older than {max_age_days} days"})
        else:
            kept.append(fact)
    return kept, dropped


def _experience_lines(profile: Profile, track: str) -> str:
    lines = []
    for exp in profile.experiences:
        if track in exp.tracks:
            lines.append(f"- [{exp.id}] {exp.summary}")
    return "\n".join(lines)


def research_target(llm: LLM, target: Target, profile: Profile, settings: Settings, *, today: date,
                    max_continuations: int = 4) -> ResearchResult:
    cfg = settings.llm
    prompt = RESEARCH_PROMPT.format(
        today=today.isoformat(),
        company=target.company,
        domain=target.domain or "unknown",
        role=target.role,
        location=target.location or "not stated",
        posting=target.posting_url or "not provided; find the posting on the company careers site if you can",
        track=target.track,
        experiences=_experience_lines(profile, target.track),
        term=profile.target_term,
        graduation=target.graduation or profile.graduation or "not stated",
        citizenship=profile.citizenship_note,
        max_age=cfg.max_fact_age_days,
    )
    tools = [
        {"type": "web_search_20260209", "name": "web_search", "max_uses": cfg.max_web_searches},
        {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": cfg.max_web_fetches},
    ]
    messages: list[dict] = [{"role": "user", "content": prompt}]
    sources: dict[str, dict] = {}
    texts: list[str] = []
    for _ in range(max_continuations + 1):
        response = llm.create(
            label=f"research:{target.slug}",
            system=RESEARCH_SYSTEM,
            messages=messages,
            tools=tools,
            output_config={"effort": cfg.research_effort},
        )
        _collect_sources(response.content, sources)
        texts += [b.text for b in response.content if getattr(b, "type", None) == "text"]
        if response.stop_reason != "pause_turn":
            break
        # A long server-side tool loop pauses; send the turn back unchanged and it resumes.
        messages = [messages[0], {"role": "assistant", "content": response.content}]
    brief = "".join(texts).strip()
    if not brief:
        raise RuntimeError(f"research for {target.slug} returned no text")

    source_list = "\n".join(
        f"- {s['url']} | {s['title']} | page date: {s['page_age'] or 'unknown'}" for s in sources.values()
    ) or "(no sources were retrieved)"
    data = llm.json(
        label=f"extract:{target.slug}",
        system=EXTRACT_SYSTEM,
        user=f"Today is {today.isoformat()}.\n\nSource list:\n{source_list}\n\nResearch brief:\n{brief}",
        schema=EXTRACT_SCHEMA,
        effort="medium",
    )
    kept, dropped = verify_facts(data, sources, today=today, max_age_days=cfg.max_fact_age_days)
    data["facts"] = kept
    known_ids = {e.id for e in profile.experiences}
    data["matching_experiences"] = [m for m in data.get("matching_experiences", []) if m.get("id") in known_ids]
    return ResearchResult(brief=brief, data=data, sources=list(sources.values()), dropped=dropped)


def summarize_for_prompt(data: dict) -> str:
    """Compact JSON of the verified research, for the writer."""
    keep = {k: data.get(k) for k in ("company_summary", "team_focus", "facts", "posting_keywords",
                                       "matching_experiences", "office_city")}
    return json.dumps(keep, indent=2)
