"""Draft the email for one contact from the profile, the verified research, and the style rules.

The model writes only the middle paragraphs and the subject. The greeting, the fixed sign-off and
the signature are assembled by code so they can never drift. Each draft is linted; on failure the
exact violations go back to the model, up to `llm.max_draft_attempts` tries.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from .config import Profile, Settings, Target
from .contacts import is_recruiter_title
from .lint import Violation, expand_contractions, lint_email, lint_plain
from .llm import LLM
from .research import normalize_url, summarize_for_prompt

DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},
        "paragraphs": {"type": "array", "items": {"type": "string"}},
        "fact_urls_used": {"type": "array", "items": {"type": "string"}},
        "experience_ids_used": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["subject", "paragraphs", "fact_urls_used", "experience_ids_used"],
    "additionalProperties": False,
}


def build_system_prompt(profile: Profile) -> str:
    """Stable per profile, so it is cached across every draft in a run."""
    s = profile.style
    experiences = []
    for exp in profile.experiences:
        line = f"- [{exp.id}] (tracks: {', '.join(exp.tracks)}) {exp.summary}"
        for wording in exp.approved_wording:
            line += f'\n    Approved wording you may reuse: "{wording}"'
        experiences.append(line)
    never = "\n".join(f"- {item}" for item in profile.facts_never_to_use) or "- (none)"
    banned_words = ", ".join(s.banned_words)
    banned_phrases = "; ".join(f'"{p}"' for p in s.banned_phrases)
    topics = ", ".join(s.banned_topics) or "(none)"
    grad_rule = (
        "Do not mention a graduation date, class year, or the word graduate."
        if not s.allow_graduation_mention else "You may mention the graduation date if it helps."
    )
    extra = s.extra_rules()
    extra_block = f"\n# Additional rules from the candidate\n{extra.strip()}\n" if extra.strip() else ""
    return f"""You write short cold emails from {profile.name}, a student at {profile.school}, to recruiters \
and hiring managers about internships. Each email goes out under their name to a real person, so it must \
sound like them and be completely true.

# What you may say about {profile.first_name}
Only these facts. Never invent or embellish experiences, numbers, titles, tools, or outcomes. If a fact is \
not listed here, it does not exist.
{chr(10).join(experiences)}

Never mention or imply:
{never}

# Structure
Write 3 or 4 short paragraphs. Code adds the greeting before them and the sign-off and signature after \
them, so do not write any of those.
1. Intro. Start with exactly this sentence: "{profile.opening_sentence}" Then say why you are writing: the \
role and the company. If they have already applied, say so plainly.
2. Why this company. Start with "The reason I would love to join <company> is that". Give the plain big idea \
first, then one specific recent fact from the research, explained simply. Use only facts from the research \
JSON, and do not quote the URL or the date.
3. Fit. Start with "Specifically," and describe one or two experiences that fit this role best. Reuse \
approved wording where it fits, and connect it to what the team does.
4. The ask. One or two sentences: the resume is attached, and they would be grateful to be considered or to be \
pointed to the right person. If the recipient is not a recruiter, such as an engineer, a manager, or a \
founder, ask for a pointer or a short conversation instead of assuming they hire.
If the input says near_home is true, end paragraph 2 or 4 with the near_home_line given in the input.
notes_from_candidate is private context from the candidate. Use it only where it helps, and never quote it.

# Voice
{s.voice_notes.strip()}

# Hard rules. A checker rejects the email if any is broken.
- No apostrophes of any kind, straight or curly. Write "I am", "do not", "it is". Reword possessives: \
"the team at Stripe", never "Stripe's team".
- No em dashes, en dashes, tildes, or hyphens used as dashes. No parentheses. No exclamation marks.
- Never use these words: {banned_words}.
- Never use these phrases: {banned_phrases}.
- Never mention: {topics}.
- {grad_rule}
- At most {s.max_numbers} numbers in the whole email. A season and year like "{profile.target_term}" does not count.
- {s.min_words} to {s.max_words} words across all paragraphs.
- No links or URLs. The signature already has them.
- Subject: plain and specific, under {s.max_subject_chars} characters, no apostrophes, names the role or the \
company. For example: "{profile.subject_example}".
{extra_block}
# Output
JSON with: subject, paragraphs (array of strings, no greeting or sign-off), fact_urls_used (the source_url of \
each research fact you used), experience_ids_used."""


@dataclass
class Draft:
    subject: str
    paragraphs: list[str]
    body: str
    violations: list[Violation]
    attempts: int
    fact_urls_used: list[str] = field(default_factory=list)
    experience_ids_used: list[str] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.violations


def greeting_name(first_name: str | None) -> str:
    name = (first_name or "").strip()
    if name.islower() or name.isupper():
        name = "-".join(part.capitalize() for part in name.split("-"))
    return name if name else "there"


def assemble_body(profile: Profile, first_name: str | None, paragraphs: list[str]) -> str:
    parts = [f"Hi {greeting_name(first_name)},", *[p.strip() for p in paragraphs]]
    closing = "\n".join([*profile.closing_lines, profile.name])
    signature = "\n".join(profile.signature_lines)
    return "\n\n".join(parts) + "\n\n" + closing + ("\n" + signature if signature else "")


def near_home_city(profile: Profile, target: Target) -> str | None:
    if not target.location:
        return None
    loc = target.location.lower()
    for city in profile.home_cities:
        if city.lower() in loc:
            return city
    return None


def write_initial(llm: LLM, *, profile: Profile, settings: Settings, target: Target, research: dict,
                  contact: dict) -> Draft:
    system = build_system_prompt(profile)
    city = near_home_city(profile, target)
    payload = {
        "company": target.company,
        "role": target.role,
        "term": profile.target_term,
        "already_applied": target.applied,
        "notes_from_candidate": target.notes or "",
        "recipient": {
            "first_name": contact.get("first_name"),
            "title": contact.get("title"),
            "is_recruiter": is_recruiter_title(contact.get("title") or ""),
        },
        "near_home": bool(city),
        "near_home_line": profile.near_home_line.format(city=city) if city else "",
        "research": json.loads(summarize_for_prompt(research)),
    }
    user = "Write the email for this recipient.\n\n" + json.dumps(payload, indent=2)
    allowed_urls = {normalize_url(f["source_url"]) for f in research.get("facts", [])}
    known_ids = {e.id for e in profile.experiences}

    feedback = ""
    draft: Draft | None = None
    for attempt in range(1, settings.llm.max_draft_attempts + 1):
        out = llm.json(
            label=f"draft:{target.slug}",
            system=system,
            user=user + feedback,
            schema=DRAFT_SCHEMA,
            effort=settings.llm.writing_effort,
        )
        subject = expand_contractions(out["subject"].strip())
        paragraphs = [expand_contractions(p.strip()) for p in out["paragraphs"] if p.strip()]
        violations = lint_email(
            subject=subject,
            paragraphs=paragraphs,
            style=profile.style,
            company=target.company,
            required_opening=profile.opening_sentence,
        )
        used_urls = [u for u in out.get("fact_urls_used", []) if u]
        stray = [u for u in used_urls if normalize_url(u) not in allowed_urls]
        if stray:
            violations.append(Violation("facts", f"cited facts that are not in the research: {stray}"))
        if allowed_urls and not used_urls:
            violations.append(Violation("facts", "use one specific fact from the research in paragraph 2"))
        bad_ids = [i for i in out.get("experience_ids_used", []) if i not in known_ids]
        if bad_ids:
            violations.append(Violation("experiences", f"unknown experience ids {bad_ids}"))
        draft = Draft(
            subject=subject,
            paragraphs=paragraphs,
            body=assemble_body(profile, contact.get("first_name"), paragraphs),
            violations=violations,
            attempts=attempt,
            fact_urls_used=used_urls,
            experience_ids_used=out.get("experience_ids_used", []),
        )
        if draft.clean:
            return draft
        problems = "\n".join(f"- {v.rule}: {v.detail}" for v in violations)
        previous = json.dumps({"subject": subject, "paragraphs": paragraphs}, indent=2)
        feedback = (
            f"\n\nYour previous draft broke these rules:\n{problems}\n\nPrevious draft:\n{previous}\n\n"
            "Rewrite it so every rule passes. Keep what was good."
        )
    assert draft is not None
    return draft


def write_followup(profile: Profile, *, target: Target, contact: dict, original_subject: str,
                   original_body: str, original_sent_at: str, sender_name: str, sender_email: str) -> tuple[str, str]:
    """Fixed-template follow-up, quoted under the original so it threads like a normal reply."""
    from email.utils import format_datetime

    from .timeutil import parse_ts

    text = profile.followup_template.format(role=target.role, company=target.company)
    problems = lint_plain(text, profile.style, allowed=[target.company])
    if problems:
        raise ValueError(f"profile.followup_template breaks the style rules: {[p.detail for p in problems]}")
    first = greeting_name(contact.get("first_name"))
    closing = "\n".join([*profile.closing_lines, profile.name])
    when = format_datetime(parse_ts(original_sent_at))
    quoted = "\n".join(f"> {line}" if line else ">" for line in original_body.splitlines())
    body = f"Hi {first},\n\n{text}\n\n{closing}\n\nOn {when}, {sender_name} <{sender_email}> wrote:\n{quoted}\n"
    subject = original_subject if original_subject.lower().startswith("re:") else f"Re: {original_subject}"
    return subject, body
