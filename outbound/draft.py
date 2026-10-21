"""draft: research a target with Claude and write its sequence copy to sequences/<target>.md.

1. Research. Claude Opus 5.5 searches the web and reads the job posting, then a second call turns
   its brief into JSON. A fact survives only if its URL was actually retrieved during research and
   it was published in the last year: an invented fact in a cold email is the worst failure.
2. Write. Claude writes the subject and two emails (the first touch and one in-thread follow-up)
   from profile.md and the verified research. The greeting, sign-off and signature are added by
   code. The style check runs on the result and failures go back to Claude, up to three rounds.
3. Save. The copy lands in sequences/<target>.md with the research notes underneath (never sent),
   for you to read and edit before `launch`.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from common import Target
from lint import Violation, check_fixed_lines, expand_contractions, lint_email, lint_subject, prose_lines
from profile_md import Profile
from sequences import Sequence

MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FOLLOWUP_DAY = 5


class LLMError(Exception):
    pass


class LLM:
    """Messages API with the server-side refusal fallback, prompt caching and structured output."""

    def __init__(self, client: Any = None, *, model: str = MODEL):
        if client is None:
            import anthropic

            client = anthropic.Anthropic()
        self.client = client
        self.model = model
        self.usage = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0,
                      "cache_read_input_tokens": 0, "web_search_requests": 0}

    def create(self, *, stream: bool = False, **kwargs: Any) -> Any:
        kwargs.setdefault("model", self.model)
        kwargs.setdefault("max_tokens", 16000)
        kwargs["betas"] = [*kwargs.get("betas", []), FALLBACK_BETA]
        kwargs["fallbacks"] = "default"
        if stream:  # long research turns: streaming avoids HTTP timeouts on a large max_tokens
            with self.client.beta.messages.stream(**kwargs) as s:
                response = s.get_final_message()
        else:
            response = self.client.beta.messages.create(**kwargs)
        usage = getattr(response, "usage", None)
        # With fallbacks, top-level usage covers only the attempt that answered; a declined attempt is
        # billed too and is listed in usage.iterations, so count every iteration when they are present.
        parts = [it for it in (getattr(usage, "iterations", None) or []) if hasattr(it, "input_tokens")] or [usage]
        for part in parts:
            for key in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
                self.usage[key] += int(getattr(part, key, 0) or 0)
        server = getattr(usage, "server_tool_use", None)
        self.usage["web_search_requests"] += int(getattr(server, "web_search_requests", 0) or 0)
        if response.stop_reason == "refusal":
            raise LLMError("Claude declined the request")
        return response

    def json(self, *, system: str, user: str, schema: dict, effort: str = "high") -> dict:
        # Cache only the stable system prompt; the user message changes on every call.
        response = self.create(system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                               messages=[{"role": "user", "content": user}],
                               output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}})
        if response.stop_reason == "max_tokens":
            raise LLMError("the reply hit max_tokens before the JSON was complete")
        text = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError(f"reply was not valid JSON: {text[:200]}") from exc

    def cost(self) -> float:
        """Claude Opus 5.5: $4 / MTok input, $5 cache writes, $0.20 cache reads, $20 output, $0.01 per search."""
        u = self.usage
        return (u["input_tokens"] * 4 + u["cache_creation_input_tokens"] * 5 + u["cache_read_input_tokens"] * 0.2
                + u["output_tokens"] * 20) / 1e6 + u["web_search_requests"] * 0.01


# --------------------------------------------------------------------------- research

RESEARCH_SYSTEM = """You research companies for a university student who writes short, honest emails to \
recruiters about internships. The facts you find will be quoted to a recruiter at that company, so accuracy \
matters far more than color.

Rules:
- Only report what you read in a source during this session. Never fill gaps from memory.
- Prefer primary sources: the company newsroom, engineering or research blog, product pages, earnings releases, \
and the job posting itself. Reputable press is fine. Skip rumors, opinion pieces, and anything you cannot date.
- Every fact needs the exact URL you read it on and its publication date.
- Explain things in plain words a smart friend outside the industry would understand."""

RESEARCH_PROMPT = """Today is {today}.

Company: {company} (website: {domain})
Role: {role}
Office location: {location}
Job posting: {posting}

Background on the student, only so you can judge fit. Do not research the student.
{experiences}

The student wants {term}. Expected graduation: {graduation}.

Write a research brief with these sections:
1. What {company} does, in one or two plain sentences.
2. The team, product, or org this role most likely sits in, and what it works on. Use the posting if you can read it.
3. {fact_count} recent facts about {company} that someone applying to this role could mention to show real, specific \
interest, each published within the last 365 days. For each: the fact in one sentence, why it matters in plain words, \
the exact source URL, the source title, and the publication date as YYYY-MM-DD. Favor launches, product milestones, \
and engineering or research posts related to this role over funding news and mission statements.
4. Requirements or keywords from the posting that matter.
5. Eligibility red flags for this student, if any (graduate students only, the wrong term, a graduation window the \
student misses, location rules). Write "none found" if there are none."""

EXTRACT_SYSTEM = """You convert a research brief into JSON. Copy facts faithfully. Use only URLs that appear in the \
provided source list; drop any fact without one. Dates must be YYYY-MM-DD (first of the month if only the month is \
known); drop facts with no known date."""

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "company_summary": {"type": "string"},
        "team_focus": {"type": "string"},
        "facts": {"type": "array", "items": {
            "type": "object",
            "properties": {"fact": {"type": "string"}, "why_it_matters": {"type": "string"},
                           "source_url": {"type": "string"}, "source_title": {"type": "string"},
                           "published": {"type": "string"}},
            "required": ["fact", "why_it_matters", "source_url", "source_title", "published"],
            "additionalProperties": False}},
        "posting_keywords": {"type": "array", "items": {"type": "string"}},
        "eligibility_flags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["company_summary", "team_focus", "facts", "posting_keywords", "eligibility_flags"],
    "additionalProperties": False,
}

TRACKING = re.compile(r"^(utm_|gclid|fbclid|mc_|ref$|source$)", re.I)


def normalize_url(url: str) -> str:
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip().lower()
    host = (parts.hostname or "").lower().removeprefix("www.")
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if not TRACKING.match(k)])
    return urlunsplit(("https", host, parts.path.rstrip("/"), query, ""))


@dataclass
class Research:
    data: dict
    sources: list[dict]
    dropped: list[dict]
    incomplete: str = ""  # why the research turn did not finish cleanly, if it did not


def _collect(content: list, sources: dict[str, dict]) -> None:
    for block in content:
        kind = getattr(block, "type", None)
        if kind == "web_search_tool_result" and isinstance(getattr(block, "content", None), list):
            for r in block.content:
                if getattr(r, "url", None):
                    sources.setdefault(normalize_url(r.url), {"url": r.url, "title": getattr(r, "title", "") or "",
                                                             "page_age": getattr(r, "page_age", None)})
        elif kind == "web_fetch_tool_result":
            result = getattr(block, "content", None)
            if getattr(result, "url", None):
                sources[normalize_url(result.url)] = {"url": result.url, "title": "", "page_age": None}
        elif kind == "text":
            for c in getattr(block, "citations", None) or []:
                if getattr(c, "url", None):
                    sources.setdefault(normalize_url(c.url), {"url": c.url, "title": getattr(c, "title", "") or "",
                                                             "page_age": None})


def _parse_date(value: str) -> date | None:
    m = re.match(r"^(\d{4})-(\d{2})(?:-(\d{2}))?$", (value or "").strip())
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3) or 1))
    except ValueError:
        return None


def verify_facts(facts: list[dict], sources: dict, *, today: date, max_age_days: int = 365) -> tuple[list, list]:
    kept, dropped = [], []
    for fact in facts:
        published = _parse_date(fact.get("published", ""))
        if normalize_url(fact.get("source_url", "")) not in sources:
            dropped.append({**fact, "reason": "source URL was not retrieved during research"})
        elif published is None:
            dropped.append({**fact, "reason": "no usable publication date"})
        elif published > today + timedelta(days=2):
            dropped.append({**fact, "reason": "dated in the future"})
        elif (today - published).days > max_age_days:
            dropped.append({**fact, "reason": f"older than {max_age_days} days"})
        else:
            kept.append(fact)
    return kept, dropped


# Research depth. "light" is the default: about half the cost of "deep" (fewer searches and page reads,
# and medium effort), and still reads the posting plus enough news to find one verified fact.
DEPTH = {
    "light": {"searches": 3, "fetches": 2, "effort": "medium", "max_tokens": 32000},
    "deep": {"searches": 6, "fetches": 4, "effort": "high", "max_tokens": 64000},
}


def research(llm: LLM, target: Target, profile: Profile, *, today: date, max_rounds: int = 5,
             depth: str = "light") -> Research:
    prompt = RESEARCH_PROMPT.format(
        today=today.isoformat(), company=target.company, domain=target.domain, role=target.role,
        location=target.location or "not stated",
        posting=target.posting_url or "not provided; find it on the company careers site if you can",
        experiences=profile.experiences_for(target.track) or "(none listed)", term=profile.term,
        graduation=profile.graduation or "not stated",
        fact_count="One to three" if depth == "light" else "Two to four",
    )
    cfg = DEPTH[depth]
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": cfg["searches"]},
             {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": cfg["fetches"]}]
    messages: list[dict] = [{"role": "user", "content": prompt}]
    sources: dict[str, dict] = {}
    texts: list[str] = []
    assistant_blocks: list = []
    stop = ""
    for _ in range(max_rounds):
        response = llm.create(stream=True, max_tokens=cfg["max_tokens"], system=RESEARCH_SYSTEM, messages=messages,
                              tools=tools, output_config={"effort": cfg["effort"]})
        _collect(response.content, sources)
        texts += [b.text for b in response.content if getattr(b, "type", None) == "text"]
        stop = response.stop_reason
        if stop != "pause_turn":
            break
        # A paused server-tool turn resumes from the whole turn so far, not just the last chunk.
        assistant_blocks += list(response.content)
        messages = [messages[0], {"role": "assistant", "content": assistant_blocks}]
    incomplete = ""
    if stop == "max_tokens":
        incomplete = "the research reply was cut off (max_tokens)"
    elif stop == "pause_turn":
        incomplete = f"the research was still running after {max_rounds} rounds"
    brief = "".join(texts).strip()
    if not brief:
        raise LLMError(f"research for {target.slug} returned no text")
    source_list = "\n".join(f"- {s['url']} | {s['title']} | page date: {s['page_age'] or 'unknown'}"
                            for s in sources.values()) or "(no sources were retrieved)"
    data = llm.json(system=EXTRACT_SYSTEM, schema=EXTRACT_SCHEMA, effort="medium",
                    user=f"Today is {today.isoformat()}.\n\nSource list:\n{source_list}\n\nResearch brief:\n{brief}")
    kept, dropped = verify_facts(data.get("facts", []), sources, today=today)
    data["facts"] = kept
    data["eligibility_flags"] = [f for f in data.get("eligibility_flags", [])
                                 if f.strip() and not re.match(r"^\s*(none|n/?a|no red flags)\b", f, re.I)]
    return Research(data=data, sources=list(sources.values()), dropped=dropped, incomplete=incomplete)


# --------------------------------------------------------------------------- writing

WRITE_SCHEMA = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},
        "email1_paragraphs": {"type": "array", "items": {"type": "string"}},
        "email2_paragraphs": {"type": "array", "items": {"type": "string"}},
        "fact_url_used": {"type": "string"},
    },
    "required": ["subject", "email1_paragraphs", "email2_paragraphs", "fact_url_used"],
    "additionalProperties": False,
}

# Markers that block launch until the person has looked at the copy and deleted the line.
BLOCKING_MARKERS = ("NO VERIFIED FACT", "RESEARCH INCOMPLETE")


def system_prompt(profile: Profile, track: str, *, link_mode: bool, has_facts: bool) -> str:
    never = "\n".join(f"- {item}" for item in profile.never_mention) or "- (none)"
    resume_sentence = ("do not mention attaching anything, because code adds a line with the resume link"
                       if link_mode else 'say "I have attached my resume"')
    fact_rule = ("Mention ONE specific recent fact from research.facts the way a person mentions something they "
                 'read ("I saw that ...", "I read the ... post about ..."), in plain words. Never quote the URL, and '
                 "never say when the student read it." if has_facts else
                 "There are no verified facts for this company, so state no specific claims about it at all: no "
                 "launches, numbers, dates or news. Say in one plain sentence what the team works on that connects "
                 "to the experience in paragraph 3.")
    return f"""You write short emails from {profile.name}, a student, to recruiters about internships the student has \
applied to or wants. Apollo sends the same copy to every recruiter at that company, so write to the company and the \
role, never to one specific recipient. Each email goes out under the student's name, so it must sound like them and \
be completely true.

# Facts you may use
Only these. Never invent or embellish experiences, numbers, titles, tools, or outcomes.
{profile.experiences_for(track)}

Never mention or imply:
{never}

# Email 1, the first touch
A quick note from a student to a recruiter, not a cover letter: 3 or 4 short paragraphs, 90 to 150 words. Code adds \
"Hi {{first}}," before them and the sign-off after them.
1. Start with exactly: "{profile.opening}" Then one sentence: if the input says already_applied is true, that you \
applied to the role at the company, otherwise that you are interested in it, that you are really excited about it, \
and that you wanted to reach out directly.
2. One or two sentences. {fact_rule} The research background fields are unverified context: never state them as \
facts.
3. One experience from the facts above, two at most, told plainly as what the student built and what happened, with \
at most one number each. Pick the one closest to paragraph 2, and name the connection in a few plain words only if \
it is real.
4. The ask, one sentence: {resume_sentence}, and you would be grateful to be considered or pointed to the right \
person.
Sound genuinely excited: say so plainly in paragraph 1, and in paragraph 2 tie it to something specific ("I would \
love to work on ..."). Never generic hype, superlatives like "my dream company", or interests the facts do not show. \
Do not open paragraphs with "The reason I would love to join", "Specifically," or "Put simply,": those are cover \
letter habits and read as a template in an email. Do not explain the company back to itself or add a takeaway line \
after the fact.

# Email 2, a follow-up five days later in the same thread
One or two sentences, 20 to 50 words. Code adds "Hi {{first}}," before it and "Thank you," and the first name after \
it. Say you are following up on your note about the role because you are still very excited about it, and ask them \
to point you to the right person if they are not. No guilt, no "just bumping", no "circling back".

# Voice
{profile.voice}

# Hard rules. A checker rejects the copy if any is broken, in the subject too.
- No apostrophes, straight or curly: write "I am", "do not", and reword possessives ("the team at X").
- No em dashes, en dashes, tildes, hyphens used as dashes, parentheses, or exclamation marks.
- No links. Never write a greeting, sign-off, or signature yourself.
- No graduation date, graduation year, or class year.
- At most 3 numbers per email ("{profile.term}" does not count). Email 1 is 90 to 150 words and names the company.
- Subject: plain and specific, under 70 characters, at most one number, no "Re:". For example: "{profile.subject_example}".
- Never use: leveraged, utilized, robust, seamless, cutting-edge, passionate, spearheaded, delve, thrilled, synergy, \
testament, tapestry, game-changer, or any form of them; and never "not just" or "I hope this email finds you well".

# Output
JSON: subject, email1_paragraphs, email2_paragraphs, fact_url_used (the source_url of the research fact you used, \
or an empty string if there were none)."""


def assemble(profile: Profile, track: str, email1: list[str], email2: list[str]) -> tuple[str, str]:
    p1 = [p.strip() for p in email1 if p.strip()]
    if profile.resume_is_link(track):
        p1.append(f"My resume: {profile.resume(track)}")
    body1 = "\n\n".join(["Hi {first},", *p1, profile.closing_line,
                         profile.sign_off + "\n" + "\n".join(profile.signature_lines)])
    body2 = "\n\n".join(["Hi {first},", *[p.strip() for p in email2 if p.strip()], "Thank you,\n" + profile.first_name])
    return body1, body2


ATTACH_WORDING = re.compile(r"\battach(ed|ing|ment)?\b", re.I)


def lint_sequence(seq: Sequence, *, profile: Profile, target: Target) -> list[Violation]:
    """Style rules plus the resume rules for the CURRENT profile, so copy drafted for one resume mode
    can never launch under the other."""
    fixed = profile.fixed_lines()
    link_mode = profile.resume_is_link(target.track)
    resume = profile.resume(target.track)
    links = [resume] if link_mode else []
    common = dict(banned_topics=profile.banned_topics, extra_banned_words=profile.extra_banned_words,
                  graduation=profile.graduation_years)
    v = lint_subject(seq.subject, company=target.company, **common)
    for i, body in enumerate(seq.emails, start=1):
        v += lint_email(body, where=f"email {i}", first_touch=(i == 1), company=target.company,
                        opening=profile.opening if i == 1 else "", fixed_lines=fixed, allowed_links=links, **common)
    first = seq.emails[0] if seq.emails else ""
    if link_mode:
        if f"My resume: {resume}" not in [line.strip() for line in first.splitlines()]:
            v.append(Violation("email 1", "resume", f'profile.md uses a resume link: email 1 needs the line '
                                                    f'"My resume: {resume}" (run draft --redo, or add it)'))
        if ATTACH_WORDING.search(first):
            v.append(Violation("email 1", "resume", "says the resume is attached, but profile.md uses a link"))
    elif "my resume:" in first.lower() or re.search(r"https?://", "\n".join(prose_lines(first, fixed))):
        v.append(Violation("email 1", "resume", "has a resume link, but profile.md is in attach mode"))
    v += check_fixed_lines(fixed, banned_topics=profile.banned_topics,
                           graduation=profile.graduation_years)
    for marker in BLOCKING_MARKERS:
        if marker in seq.preamble:
            v.append(Violation("header", "review", f'remove the "{marker}" line once you have checked the copy'))
    return v


def write(llm: LLM, target: Target, profile: Profile, found: Research, *, max_rounds: int = 3,
          log: Callable[[str], None] = print) -> tuple[Sequence, list[Violation]]:
    link_mode = profile.resume_is_link(target.track)
    facts = found.data.get("facts", [])
    system = system_prompt(profile, target.track, link_mode=link_mode, has_facts=bool(facts))
    payload = {
        "company": target.company, "role": target.role, "track": target.track, "term": profile.term,
        "already_applied": target.applied, "location": target.location, "notes_from_student": target.notes,
        "research": {
            "facts": facts,
            "background_unverified": {k: found.data.get(k) for k in ("company_summary", "team_focus", "posting_keywords")},
        },
    }
    user = "Write the copy for this role.\n\n" + json.dumps(payload, indent=2)
    allowed = {normalize_url(f["source_url"]) for f in facts}
    feedback, seq, problems = "", None, []
    for attempt in range(1, max_rounds + 1):
        out = llm.json(system=system, user=user + feedback, schema=WRITE_SCHEMA, effort="high")
        subject = expand_contractions(out["subject"].strip())
        e1 = [expand_contractions(p) for p in out["email1_paragraphs"]]
        e2 = [expand_contractions(p) for p in out["email2_paragraphs"]]
        body1, body2 = assemble(profile, target.track, e1, e2)
        seq = Sequence(subject=subject, emails=[body1, body2], days=[0, FOLLOWUP_DAY])
        problems = lint_sequence(seq, profile=profile, target=target)
        if allowed and normalize_url(out.get("fact_url_used", "")) not in allowed:
            problems.append(Violation("email 1", "facts", "use one fact from research.facts, by its source_url"))
        if not problems:
            break
        log(f"[draft] {target.slug}: round {attempt} had {len(problems)} style issue(s), rewriting")
        listing = "\n".join(f"- {p}" for p in problems)
        feedback = (f"\n\nYour last draft broke these rules:\n{listing}\n\nLast draft:\n"
                    f"{json.dumps({'subject': subject, 'email1_paragraphs': e1, 'email2_paragraphs': e2}, indent=2)}"
                    "\n\nRewrite it so every rule passes. Keep what was good.")
    assert seq is not None
    return seq, problems


def header_lines(target: Target, found: Research, problems: list[Violation]) -> list[str]:
    lines = [f"Target: {target.company}, {target.role} ({target.slug})",
             "Edit anything below. `lint` checks it; `launch` pushes it to Apollo. Only the subject and emails are sent."]
    if not found.data.get("facts"):
        lines.append("NO VERIFIED FACT: research found nothing it could verify, so paragraph 2 has no specifics. "
                     "Read it, add a fact you checked yourself if you like, then delete this line.")
    if found.incomplete:
        lines.append(f"RESEARCH INCOMPLETE: {found.incomplete}, so eligibility was not fully checked. Check the "
                     "posting yourself, then delete this line.")
    if problems:
        lines.append("STYLE ISSUES LEFT (lint shows them): " + "; ".join(str(p) for p in problems))
    return lines


def research_notes(found: Research) -> str:
    lines = ["Research notes (never sent)", "", found.data.get("company_summary", ""), "",
             found.data.get("team_focus", ""), "", "Verified facts:"]
    for f in found.data.get("facts", []):
        lines.append(f"- {f['fact']} ({f['published']}, [{f.get('source_title') or 'source'}]({f['source_url']}))")
    if not found.data.get("facts"):
        lines.append("- none survived verification")
    if found.dropped:
        lines += ["", "Dropped by verification:"]
        lines += [f"- {d.get('fact')} ({d.get('reason')})" for d in found.dropped]
    if found.data.get("eligibility_flags"):
        lines += ["", "Eligibility flags, check before launching:"]
        lines += [f"- {flag}" for flag in found.data["eligibility_flags"]]
    if found.data.get("posting_keywords"):
        lines += ["", "Posting keywords: " + ", ".join(found.data["posting_keywords"])]
    return "\n".join(lines)
