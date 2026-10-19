"""Style checks for sequence copy. The writer is told these rules; this is what enforces them,
and it runs again on whatever you hand-edit in sequences/<target>.md before anything launches."""
from __future__ import annotations

import re
from dataclasses import dataclass

APOSTROPHES = "'’‘ʼ"
FORBIDDEN = {"'": "apostrophe", "’": "curly apostrophe", "‘": "curly quote", "ʼ": "apostrophe",
             "—": "em dash", "–": "en dash", "~": "tilde"}
BANNED_WORDS = ["spearheaded", "spearhead", "leveraged", "leverage", "leveraging", "utilized", "utilize", "robust",
                "seamless", "seamlessly", "cutting-edge", "passionate", "delve", "thrilled", "synergy",
                "game-changer", "testament", "tapestry", "innovative", "dynamic"]
BANNED_PHRASES = ["I hope this email finds you well", "I hope you are doing well", "not just", "To whom it may concern",
                  "Dear Sir", "Dear Hiring", "just bumping", "circling back"]
MERGE_FIELDS = {"first", "last", "company"}
CONTRACTIONS = {
    "i'm": "I am", "i've": "I have", "i'd": "I would", "i'll": "I will", "you're": "you are", "you've": "you have",
    "you'll": "you will", "we're": "we are", "we've": "we have", "they're": "they are", "it's": "it is",
    "that's": "that is", "there's": "there is", "here's": "here is", "what's": "what is", "let's": "let us",
    "don't": "do not", "doesn't": "does not", "didn't": "did not", "can't": "cannot", "won't": "will not",
    "wouldn't": "would not", "couldn't": "could not", "shouldn't": "should not", "isn't": "is not",
    "aren't": "are not", "wasn't": "was not", "weren't": "were not", "haven't": "have not", "hasn't": "has not",
}
_CONTRACTION = re.compile(
    r"\b(" + "|".join(re.escape(k).replace("'", f"[{APOSTROPHES}]") for k in CONTRACTIONS) + r")\b", re.I)
SEASON_YEAR = re.compile(r"\b(summer|fall|autumn|spring|winter)\s+20\d\d\b", re.I)
NUMBER = re.compile(r"(?<![\w.])\$?\d[\d,]*(?:\.\d+)?(?:%|\+|[kKmMbB]\b)?")
GRADUATION = re.compile(r"\b(graduat\w*|class of)\b|\b(may|june|december|dec)\s+20[2-3]\d\b", re.I)


@dataclass
class Violation:
    where: str
    rule: str
    detail: str

    def __str__(self) -> str:
        return f"{self.where}: {self.rule}: {self.detail}"


def expand_contractions(text: str) -> str:
    def repl(m: re.Match) -> str:
        word = m.group(0)
        out = CONTRACTIONS[re.sub(f"[{APOSTROPHES}]", "'", word.lower())]
        return out[0].upper() + out[1:] if word[0].isupper() else out

    return _CONTRACTION.sub(repl, text)


def count_numbers(text: str) -> int:
    return len(NUMBER.findall(SEASON_YEAR.sub(" ", text)))


def words(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9][\w.&/-]*", text))


def _mask(text: str, allowed: list[str]) -> str:
    for item in sorted({a for a in allowed if a}, key=len, reverse=True):
        text = re.sub(re.escape(item), " ", text, flags=re.I)
    return re.sub(r"\{(first|last|company)\}", " ", text)


def split_body(body: str, fixed_lines: list[str]) -> tuple[str, str]:
    """Separate the written paragraphs from the greeting, the fixed sign-off and the signature."""
    lines = body.splitlines()
    if lines and re.match(r"^\s*(hi|hello|dear)\b", lines[0], re.I):
        lines = lines[1:]
    fixed = {f.strip() for f in fixed_lines if f.strip()}
    prose, tail, in_tail = [], [], False
    for line in lines:
        if line.strip() in fixed or re.match(r"^\s*(warm regards|best|thank you|thanks),?\s*$", line, re.I):
            in_tail = True
        (tail if in_tail else prose).append(line)
    return "\n".join(prose).strip(), "\n".join(tail).strip()


def lint_subject(subject: str, company: str) -> list[Violation]:
    v = []
    masked = _mask(subject, [company])
    if not subject.strip():
        v.append(Violation("subject", "empty", "write a subject line"))
    if len(subject) > 70:
        v.append(Violation("subject", "length", f"{len(subject)} characters; keep it under 70"))
    if re.match(r"^\s*(re|fwd?):", subject, re.I):
        v.append(Violation("subject", "honesty", 'no fake "Re:" or "Fwd:"'))
    for ch, label in FORBIDDEN.items():
        if ch in masked:
            v.append(Violation("subject", "forbidden_char", label))
    return v


def lint_email(body: str, *, where: str, first_touch: bool, company: str, opening: str = "",
               fixed_lines: list[str] | None = None, banned_topics: list[str] | None = None,
               extra_banned_words: list[str] | None = None, allowed_links: list[str] | None = None) -> list[Violation]:
    v: list[Violation] = []
    prose, _tail = split_body(body, fixed_lines or [])
    masked = _mask(prose, [company])
    if not re.match(r"^\s*hi\s+\{first\},?\s*$", body.splitlines()[0] if body.strip() else "", re.I):
        v.append(Violation(where, "greeting", 'start with "Hi {first}," so Apollo fills in the name'))
    for field_name in set(re.findall(r"\{([^{}]*)\}", body)) - MERGE_FIELDS:
        v.append(Violation(where, "merge_field", f"{{{field_name}}} is not a merge field; use {{first}} or {{company}}"))
    if "{{" in body:
        v.append(Violation(where, "merge_field", "write merge fields as {first}, not {{first_name}}"))
    for ch, label in FORBIDDEN.items():
        if ch in masked:
            i = masked.find(ch)
            v.append(Violation(where, "forbidden_char", f"{label} near ...{masked[max(0, i - 20):i + 20]}..."))
    if re.search(r"\s-{1,2}\s", masked):
        v.append(Violation(where, "forbidden_char", "a hyphen used as a dash; rewrite the sentence"))
    if re.search(r"[()]", masked):
        v.append(Violation(where, "parentheses", "no parentheses or asides"))
    if "!" in masked:
        v.append(Violation(where, "exclamation", "no exclamation marks in the paragraphs"))
    links = re.findall(r"https?://\S+|www\.\S+", prose)
    stray = [link for link in links if not any(link.startswith(a) for a in (allowed_links or []) if a)]
    if stray:
        v.append(Violation(where, "links", f"no links besides the resume link: {stray}"))
    text = prose.lower()
    for word in BANNED_WORDS + (extra_banned_words or []):
        if re.search(rf"(?<![\w-]){re.escape(word.lower())}(?![\w-])", text):
            v.append(Violation(where, "banned_word", f'"{word}"'))
    for phrase in BANNED_PHRASES:
        if phrase.lower() in text:
            v.append(Violation(where, "banned_phrase", f'"{phrase}"'))
    for topic in banned_topics or []:
        if topic and re.search(rf"(?<![\w]){re.escape(topic.lower())}(?![\w])", text):
            v.append(Violation(where, "banned_topic", f'never mention "{topic}"'))
    if GRADUATION.search(prose):
        v.append(Violation(where, "graduation", "no graduation date or class year"))
    n_words = words(prose)
    if first_touch:
        if opening and not " ".join(prose.split()).startswith(" ".join(opening.split())):
            v.append(Violation(where, "opening", f'start with exactly: "{opening}"'))
        if company and company.lower() not in prose.lower():
            v.append(Violation(where, "company", f"name {company} at least once"))
        if count_numbers(masked) > 3:
            v.append(Violation(where, "numbers", f"{count_numbers(masked)} numbers; use at most 3"))
        if not 90 <= n_words <= 190:
            v.append(Violation(where, "length", f"{n_words} words; aim for 90 to 190"))
    else:
        if count_numbers(masked) > 1:
            v.append(Violation(where, "numbers", "a follow-up needs at most 1 number"))
        if not 20 <= n_words <= 90:
            v.append(Violation(where, "length", f"{n_words} words; a follow-up is 20 to 90"))
    return v
