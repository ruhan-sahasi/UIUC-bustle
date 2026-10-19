"""Style checks for sequence copy. The writer is told these rules; this is what enforces them,
and it runs again on whatever you hand-edit in sequences/<target>.md before anything launches.

Every line of an email is checked except lines that exactly match the fixed sign-off and signature
from profile.md (those are checked once, on their own, by check_fixed_lines).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

APOSTROPHES = "'’‘ʼ"
FORBIDDEN = {"'": "apostrophe", "’": "curly apostrophe", "‘": "curly quote", "ʼ": "apostrophe",
             "—": "em dash", "–": "en dash", "~": "tilde"}
# Hard bans: the user's own list, each with the forms it takes. Nouns like "utilization" stay allowed.
BANNED_FORMS = {
    "spearheaded": r"spearhead(s|ed|ing)?", "leveraged": r"leverag(e|es|ed|ing)", "utilized": r"utiliz(e|es|ed|ing)",
    "robust": r"robust(ly|ness)?", "seamless": r"seamless(ly)?", "cutting-edge": r"cutting[- ]edge",
    "passionate": r"passionate(ly)?", "delve": r"delv(e|es|ed|ing)", "thrilled": r"thrill(ed|ing)",
    "synergy": r"synerg(y|ies|istic)", "game-changer": r"game[- ]chang(er|ers|ing)", "testament": r"testaments?",
    "tapestry": r"tapestr(y|ies)",
}
BANNED_WORDS = list(BANNED_FORMS)
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
# A number, but not the digits inside names like 10-K, S-1, a16z or 3D.
NUMBER = re.compile(r"(?<![\w.$-])\$?\d[\d,]*(?:\.\d+)?(?:%|\+|[kKmMbB]\b)?(?![\w-])")
URL = re.compile(r"https?://\S+|www\.\S+")
GREETING = re.compile(r"^\s*(hi|hello|hey|dear)\b", re.I)
SIGN_OFF = re.compile(r"^\s*(warm regards|best regards|best|thank you|thanks|sincerely|cheers),?\s*$", re.I)


# Rules --force can never skip: breaking them sends something false or broken, not just off-style.
SAFETY_RULES = {"resume", "review", "merge_field", "structure", "honesty", "greeting"}


@dataclass
class Violation:
    where: str
    rule: str
    detail: str

    @property
    def safety(self) -> bool:
        return self.rule in SAFETY_RULES

    def __str__(self) -> str:
        return f"{self.where}: {self.rule}: {self.detail}"


def expand_contractions(text: str) -> str:
    def repl(m: re.Match) -> str:
        word = m.group(0)
        out = CONTRACTIONS[re.sub(f"[{APOSTROPHES}]", "'", word.lower())]
        return out[0].upper() + out[1:] if word[0].isupper() else out

    return _CONTRACTION.sub(repl, text)


def count_numbers(text: str) -> int:
    return len(NUMBER.findall(SEASON_YEAR.sub(" ", URL.sub(" ", text))))


def words(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9][\w.&/-]*", URL.sub(" ", text)))


def _word_pattern(word: str) -> re.Pattern:
    """A banned word and its plain verb or adverb forms (not every word that shares its first letters)."""
    word = word.lower().strip()
    if word in BANNED_FORMS:
        body = BANNED_FORMS[word]
    else:
        stem = re.sub(r"(ing|ed|es|s|e)$", "", word) if len(word) > 5 else word
        body = re.escape(stem).replace(r"\-", "[- ]") + r"(e|es|ed|ing|s|ly|ely)?"
    return re.compile(rf"(?<![\w-]){body}(?![\w-])", re.I)


GRAD_CONTEXT = r"(graduat\w*|class of|expected|degree|finish\w*|complet\w*|bachelor\w*|diploma)"


def graduation_pattern(graduation: str) -> re.Pattern:
    """'class of', 'graduate...', and the user's graduation years when they read as a graduation date
    ('graduating in May 2028', 'class of 2029', "Penn '28"). A year on its own, as in a dated fact, is fine."""
    years = sorted(set(re.findall(r"20(\d\d)", graduation or "")))
    alternatives = [r"\bgraduat\w*", r"\bclass of\b"]
    for yy in years:
        alternatives += [rf"\b{GRAD_CONTEXT}\W+(\w+\W+){{0,4}}20{yy}\b", rf"[{APOSTROPHES}]{yy}\b"]
    return re.compile("|".join(alternatives), re.I)


def _mask(text: str, allowed: list[str]) -> str:
    for item in sorted({a for a in allowed if a}, key=len, reverse=True):
        text = re.sub(re.escape(item), " ", text, flags=re.I)
    return re.sub(r"\{(first|last|company)\}", " ", text)


def prose_lines(body: str, fixed_lines: list[str]) -> list[str]:
    """Every line except the greeting and lines that exactly match a fixed sign-off or signature line."""
    fixed = {f.strip() for f in fixed_lines if f.strip()}
    lines = body.splitlines()
    if lines and GREETING.match(lines[0]):
        lines = lines[1:]
    return [line for line in lines if line.strip() not in fixed and not SIGN_OFF.match(line)]


def _shared_checks(text: str, *, where: str, company: str, banned_topics: list[str], extra_banned_words: list[str],
                   graduation: re.Pattern, allowed_links: list[str], merge_text: str | None = None) -> list[Violation]:
    v: list[Violation] = []
    masked = _mask(text, [company, *allowed_links])
    for ch, label in FORBIDDEN.items():
        if ch in masked:
            i = masked.find(ch)
            v.append(Violation(where, "forbidden_char", f"{label} near ...{masked[max(0, i - 20):i + 20].strip()}..."))
    if any(re.search(r"\S\s+-{1,2}\s", line) for line in masked.splitlines()):
        v.append(Violation(where, "forbidden_char", "a hyphen used as a dash; rewrite the sentence"))
    if re.search(r"[()]", masked):
        v.append(Violation(where, "parentheses", "no parentheses or asides"))
    if "!" in masked:
        v.append(Violation(where, "exclamation", "no exclamation marks"))
    merge_text = text if merge_text is None else merge_text
    for name in sorted(set(re.findall(r"\{([^{}]*)\}", merge_text)) - MERGE_FIELDS):
        v.append(Violation(where, "merge_field", f"{{{name}}} is not a merge field; use {{first}} or {{company}}"))
    if "{{" in merge_text or "}}" in merge_text or re.search(r"\{[^}]*$|^[^{]*\}", merge_text, re.M):
        v.append(Violation(where, "merge_field", "write merge fields as {first}, with one brace on each side"))
    stray = [u for u in URL.findall(text) if u.rstrip(".,;:") not in {a for a in allowed_links if a}]
    if stray:
        v.append(Violation(where, "links", f"no links besides the resume link: {stray}"))
    lowered = text.lower()
    for word in BANNED_WORDS + list(extra_banned_words):
        if word.strip():
            hit = _word_pattern(word).search(masked)
            if hit:
                v.append(Violation(where, "banned_word", f'"{hit.group(0)}" (banned: {word})'))
    for phrase in BANNED_PHRASES:
        if phrase.lower() in lowered:
            v.append(Violation(where, "banned_phrase", f'"{phrase}"'))
    for topic in banned_topics:
        if topic and re.search(rf"(?<![\w]){re.escape(topic.lower())}(?![\w])", lowered):
            v.append(Violation(where, "banned_topic", f'never mention "{topic}"'))
    hit = graduation.search(masked)
    if hit:
        v.append(Violation(where, "graduation", f'remove "{hit.group(0)}": no graduation date or class year'))
    return v


def lint_subject(subject: str, *, company: str, banned_topics: list[str] = (), extra_banned_words: list[str] = (),
                 graduation: str = "") -> list[Violation]:
    v = []
    if not subject.strip():
        v.append(Violation("subject", "empty", "write a subject line"))
    if len(subject) > 70:
        v.append(Violation("subject", "length", f"{len(subject)} characters; keep it under 70"))
    if re.match(r"^\s*(re|fwd?)\s*:", subject, re.I):
        v.append(Violation("subject", "honesty", 'no fake "Re:" or "Fwd:"'))
    if count_numbers(_mask(subject, [company])) > 1:
        v.append(Violation("subject", "numbers", "at most 1 number in the subject"))
    v += _shared_checks(subject, where="subject", company=company, banned_topics=list(banned_topics),
                        extra_banned_words=list(extra_banned_words), graduation=graduation_pattern(graduation),
                        allowed_links=[])
    return v


def lint_email(body: str, *, where: str, first_touch: bool, company: str, opening: str = "",
               fixed_lines: list[str] | None = None, banned_topics: list[str] | None = None,
               extra_banned_words: list[str] | None = None, allowed_links: list[str] | None = None,
               graduation: str = "") -> list[Violation]:
    v: list[Violation] = []
    lines = body.splitlines()
    if not lines or not re.match(r"^\s*hi\s+\{first\},?\s*$", lines[0], re.I):
        v.append(Violation(where, "greeting", 'start with "Hi {first}," so Apollo fills in the name'))
    if sum(1 for line in lines if re.match(r"^\s*hi\s+\{first\}", line, re.I)) > 1:
        v.append(Violation(where, "structure", "two greetings in one email; check the ## Email headings"))
    prose = "\n".join(prose_lines(body, fixed_lines or [])).strip()
    links = allowed_links or []
    v += _shared_checks(prose, where=where, company=company, banned_topics=banned_topics or [],
                        extra_banned_words=extra_banned_words or [], graduation=graduation_pattern(graduation),
                        allowed_links=links, merge_text=body)
    masked = _mask(prose, [company, *links])
    n_words, n_numbers = words(prose), count_numbers(masked)
    if n_numbers > 3:
        v.append(Violation(where, "numbers", f"{n_numbers} numbers; use at most 3"))
    if first_touch:
        if opening and not " ".join(prose.split()).startswith(" ".join(opening.split())):
            v.append(Violation(where, "opening", f'start with exactly: "{opening}"'))
        if company and company.lower() not in prose.lower():
            v.append(Violation(where, "company", f"name {company} at least once"))
        if not 90 <= n_words <= 190:
            v.append(Violation(where, "length", f"{n_words} words; aim for 90 to 190"))
    elif not 20 <= n_words <= 90:
        v.append(Violation(where, "length", f"{n_words} words; a follow-up is 20 to 90"))
    return v


def check_fixed_lines(lines: list[str], *, banned_topics: list[str], graduation: str) -> list[Violation]:
    """The profile's closing, sign-off and signature go into every email, so check them once.
    Phone numbers and parentheses are fine in a signature."""
    v = []
    grad = graduation_pattern(graduation)
    for line in lines:
        masked = URL.sub(" ", line)
        for ch, label in FORBIDDEN.items():
            if ch in masked:
                v.append(Violation("profile.md", "forbidden_char", f"{label} in {line!r}"))
        for topic in banned_topics:
            if topic and re.search(rf"(?<![\w]){re.escape(topic.lower())}(?![\w])", line.lower()):
                v.append(Violation("profile.md", "banned_topic", f'"{topic}" in {line!r}'))
        if grad.search(masked):
            v.append(Violation("profile.md", "graduation", f"graduation date in {line!r}"))
    return v
