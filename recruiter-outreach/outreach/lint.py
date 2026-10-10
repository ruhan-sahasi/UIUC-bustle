"""Deterministic style checks for generated emails.

The model is told the rules, but the linter is what enforces them: a draft with any violation is
sent back to the model with the exact list of problems, and a draft that still fails after the
last attempt is parked as `needs_attention` instead of being sent.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass

from .config import StyleRules

CONTRACTIONS = {
    "i'm": "I am", "i've": "I have", "i'd": "I would", "i'll": "I will",
    "you're": "you are", "you've": "you have", "you'll": "you will", "you'd": "you would",
    "we're": "we are", "we've": "we have", "we'll": "we will", "they're": "they are",
    "it's": "it is", "that's": "that is", "there's": "there is", "here's": "here is",
    "what's": "what is", "let's": "let us", "who's": "who is",
    "don't": "do not", "doesn't": "does not", "didn't": "did not", "can't": "cannot",
    "won't": "will not", "wouldn't": "would not", "couldn't": "could not", "shouldn't": "should not",
    "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
    "haven't": "have not", "hasn't": "has not", "hadn't": "had not",
}
APOSTROPHES = "'’‘ʼ"
_CONTRACTION_RE = re.compile(
    r"\b(" + "|".join(re.escape(k).replace("'", f"[{APOSTROPHES}]") for k in CONTRACTIONS) + r")\b",
    re.I,
)
SEASON_YEAR = re.compile(r"\b(summer|fall|autumn|spring|winter)\s+20\d\d\b", re.I)
NUMBER = re.compile(r"(?<![\w.])\$?\d[\d,]*(?:\.\d+)?(?:%|\+|[kKmMbB]\b)?")
GRADUATION = re.compile(r"\b(graduat\w*|class of)\b", re.I)
MONTH_YEAR = re.compile(r"\b(may|june|december|dec|jan(uary)?)\s+20[2-3]\d\b", re.I)
SPACED_DASH = re.compile(r"\s-{1,2}\s")
PLACEHOLDER = re.compile(r"[{}\[\]<>]|\bTODO\b|\bXX+\b")
GREETING = re.compile(r"^\s*(hi|hello|hey|dear)\b", re.I)
SIGNOFF = re.compile(r"\b(warm regards|best regards|sincerely|best,|thanks,|cheers)\b", re.I)


@dataclass
class Violation:
    rule: str
    detail: str

    def to_dict(self) -> dict:
        return asdict(self)


def expand_contractions(text: str) -> str:
    def repl(match: re.Match) -> str:
        word = match.group(0)
        key = re.sub(f"[{APOSTROPHES}]", "'", word.lower())
        out = CONTRACTIONS[key]
        if word[0].isupper() and out[0].islower():
            out = out[0].upper() + out[1:]
        return out

    return _CONTRACTION_RE.sub(repl, text)


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9][\w.&/-]*", text))


def count_numbers(text: str) -> int:
    stripped = SEASON_YEAR.sub(" ", text)
    return len(NUMBER.findall(stripped))


def _mask(text: str, allowed: list[str]) -> str:
    """Hide allowed strings (like a company name that has an apostrophe) from char checks."""
    for item in sorted({a for a in allowed if a}, key=len, reverse=True):
        text = re.sub(re.escape(item), " ", text, flags=re.I)
    return text


def lint_email(
    *,
    subject: str,
    paragraphs: list[str],
    style: StyleRules,
    company: str,
    required_opening: str | None = None,
    allowed_strings: list[str] | None = None,
) -> list[Violation]:
    v: list[Violation] = []
    allowed = [company, *(allowed_strings or [])]
    body = "\n\n".join(paragraphs)
    masked_body = _mask(body, allowed)
    masked_subject = _mask(subject, allowed)

    # Shape
    if not subject.strip():
        v.append(Violation("subject", "subject is empty"))
    if len(subject) > style.max_subject_chars:
        v.append(Violation("subject", f"subject is {len(subject)} characters; max is {style.max_subject_chars}"))
    if not 3 <= len(paragraphs) <= 5:
        v.append(Violation("structure", f"{len(paragraphs)} paragraphs; write 3 to 5"))
    if paragraphs and GREETING.search(paragraphs[0]):
        v.append(Violation("structure", "do not include a greeting; the code adds 'Hi <name>,'"))
    if SIGNOFF.search(body):
        v.append(Violation("structure", "do not include a sign-off; the code adds it"))
    if required_opening and paragraphs:
        want = " ".join(required_opening.split())
        got = " ".join(paragraphs[0].split())
        if not got.startswith(want):
            v.append(Violation("opening", f'the first paragraph must start with exactly: "{want}"'))
    if company and company.lower() not in body.lower():
        v.append(Violation("company", f"the email never names {company}"))

    # Characters
    for ch in style.forbidden_chars:
        where = [name for name, text in (("subject", masked_subject), ("body", masked_body)) if ch in text]
        if where:
            label = {"'": "apostrophe", "’": "curly apostrophe", "‘": "curly quote",
                     "ʼ": "apostrophe", "—": "em dash", "–": "en dash", "~": "tilde"}.get(ch, repr(ch))
            snippet = _snippet(masked_body if "body" in where else masked_subject, ch)
            v.append(Violation("forbidden_char", f"{label} in {' and '.join(where)}: ...{snippet}..."))
    if SPACED_DASH.search(masked_body) or SPACED_DASH.search(masked_subject):
        v.append(Violation("forbidden_char", "a hyphen used as a dash ( - ); rewrite the sentence instead"))
    if not style.allow_parentheses and re.search(r"[()]", masked_body + masked_subject):
        v.append(Violation("parentheses", "no parentheses or parenthetical asides"))
    if "!" in masked_body:
        v.append(Violation("exclamation", "no exclamation marks in the paragraphs"))
    if re.search(r"https?://|www\.", body):
        v.append(Violation("links", "no links in the paragraphs; the signature already has them"))
    if PLACEHOLDER.search(masked_body + masked_subject):
        v.append(Violation("placeholder", "remove placeholders, brackets, or template markers"))

    # Words, phrases, topics
    full = f"{subject}\n{body}"
    for word in style.banned_words:
        if re.search(rf"(?<![\w-]){re.escape(word)}(?![\w-])", full, re.I):
            v.append(Violation("banned_word", f'do not use "{word}"'))
    for phrase in style.banned_phrases:
        if phrase.lower() in full.lower():
            v.append(Violation("banned_phrase", f'do not use "{phrase}"'))
    for topic in style.banned_topics:
        if re.search(rf"(?<![\w]){re.escape(topic)}(?![\w])", full, re.I):
            v.append(Violation("banned_topic", f'never mention "{topic}"'))
    if not style.allow_graduation_mention and (GRADUATION.search(full) or MONTH_YEAR.search(full)):
        v.append(Violation("graduation", "do not mention a graduation date or class year"))

    # Size
    numbers = count_numbers(body)
    if numbers > style.max_numbers:
        v.append(Violation("numbers", f"{numbers} numbers in the body; use at most {style.max_numbers}"))
    words = word_count(body)
    if words < style.min_words or words > style.max_words:
        v.append(Violation("length", f"{words} words; aim for {style.min_words} to {style.max_words}"))
    return v


def lint_plain(text: str, style: StyleRules, allowed: list[str] | None = None) -> list[Violation]:
    """Character and vocabulary checks only, for fixed templates such as the follow-up."""
    masked = _mask(text, allowed or [])
    v = [Violation("forbidden_char", f"{ch!r} in template") for ch in style.forbidden_chars if ch in masked]
    for word in style.banned_words:
        if re.search(rf"(?<![\w-]){re.escape(word)}(?![\w-])", text, re.I):
            v.append(Violation("banned_word", f'"{word}" in template'))
    return v


def _snippet(text: str, ch: str, width: int = 25) -> str:
    i = text.find(ch)
    return text[max(0, i - width): i + width].replace("\n", " ")
