"""profile.md: who you are and the only facts the writer may use. Plain markdown on purpose.

Top lines are `Key: value` settings; `## Sections` hold the rest. See profile.example.md.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from common import ConfigError, data_dir

REQUIRED = ["Name", "First name", "Opening", "Resume"]


@dataclass
class Profile:
    settings: dict[str, str]
    sections: dict[str, str]
    raw: str = ""
    banned_topics: list[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return self.settings["Name"]

    @property
    def first_name(self) -> str:
        return self.settings["First name"]

    @property
    def opening(self) -> str:
        return self.settings["Opening"]

    @property
    def term(self) -> str:
        return self.settings.get("Term", "Summer 2027")

    @property
    def graduation(self) -> str:
        return self.settings.get("Graduation", "")

    @property
    def subject_example(self) -> str:
        return self.settings.get("Subject example", "CS student interested in the Software Engineering Intern role")

    def resume(self, track: str) -> str:
        """'attach' (attach the PDF to email 1 in Apollo) or a link to the resume."""
        return (self.settings.get(f"Resume {track}") or self.settings["Resume"]).strip()

    def resume_is_link(self, track: str) -> bool:
        return self.resume(track).lower().startswith(("http://", "https://"))

    def resume_file(self, track: str) -> str:
        return self.settings.get(f"Resume file {track}") or self.settings.get("Resume file", "")

    @property
    def closing_line(self) -> str:
        return self.settings.get("Closing", "Thank you for reading and I look forward to hearing back!")

    @property
    def sign_off(self) -> str:
        return self.settings.get("Sign-off", "Warm Regards,")

    @property
    def example_email(self) -> str:
        """The `## Example email` section: four paragraphs whose shape every first email should match."""
        return self.sections.get("Example email", "").strip()

    def _flag(self, name: str) -> bool:
        """A yes/no setting that defaults to yes."""
        return self.settings.get(name, "yes").strip().lower() not in ("no", "n", "false", "off", "0")

    @property
    def follow_up(self) -> bool:
        """`Follow-up: no` drafts only the first email, for following up by hand."""
        return self._flag("Follow-up")

    @property
    def strict_punctuation(self) -> bool:
        """`Strict punctuation: no` allows contractions, possessives, a spaced hyphen and parentheses."""
        return self._flag("Strict punctuation")

    @property
    def signature_lines(self) -> list[str]:
        lines = [line.rstrip() for line in self.sections.get("Signature", "").strip().splitlines() if line.strip()]
        return lines or [self.name]

    @property
    def experiences(self) -> str:
        return self.sections.get("Experiences", "").strip()

    def experiences_for(self, track: str) -> str:
        """Experience blocks whose `### Title (tags)` heading includes this track, plus untagged ones."""
        blocks = re.split(r"(?m)^(?=###\s)", self.experiences)
        keep = []
        for block in blocks:
            if not block.strip():
                continue
            heading = re.match(r"^###\s+.*?\(([^)]*)\)\s*$", block.splitlines()[0])
            tags = {t.strip().lower() for t in heading.group(1).split(",")} if heading else set()
            if not block.startswith("###") or not tags or track.lower() in tags:
                keep.append(block.strip())
        return "\n\n".join(keep)

    @property
    def graduation_years(self) -> str:
        """Every graduation year mentioned anywhere in the profile settings and notes (e.g. 2028 and 2029)."""
        top = self.raw.split("\n## ", 1)[0]
        return " ".join(sorted(set(re.findall(r"20\d\d", " ".join([self.graduation, *re.findall(r"(?i)graduat.*|eligib.*", top)])))))

    @property
    def voice(self) -> str:
        return self.sections.get("Voice", "").strip()

    @property
    def never_mention(self) -> list[str]:
        return _bullets(self.sections.get("Never mention", ""))

    @property
    def extra_banned_words(self) -> list[str]:
        return [w for item in _bullets(self.sections.get("Banned words", "")) for w in re.split(r",\s*", item) if w]

    def fixed_lines(self) -> list[str]:
        """Lines the code writes itself: they are exempt from the style check."""
        return [self.closing_line, self.sign_off, *self.signature_lines, "Thank you,", self.first_name]


def _bullets(text: str) -> list[str]:
    return [re.sub(r"^\s*[-*]\s+", "", line).strip() for line in text.splitlines() if re.match(r"^\s*[-*]\s+", line)]


def load_profile(path: Path | None = None) -> Profile:
    path = path or (data_dir() / "profile.md")
    if not path.exists():
        raise ConfigError(f"Missing {path}. Copy profile.example.md to profile.md and fill it in.")
    raw = path.read_text()
    settings: dict[str, str] = {}
    sections: dict[str, str] = {}
    current = None
    buffer: list[str] = []
    for line in raw.splitlines():
        heading = re.match(r"^##\s+(.+?)\s*$", line)
        if heading:
            if current:
                sections[current] = "\n".join(buffer)
            current, buffer = heading.group(1), []
            continue
        if current:
            buffer.append(line)
        else:
            kv = re.match(r"^([A-Za-z][A-Za-z -]*?):\s*(.+)$", line.strip())
            if kv:
                settings[kv.group(1).strip()] = kv.group(2).strip()
    if current:
        sections[current] = "\n".join(buffer)
    missing = [k for k in REQUIRED if not settings.get(k)]
    if missing:
        raise ConfigError(f"profile.md is missing: {', '.join(missing)} (top lines like `Name: Jordan Lee`)")
    profile = Profile(settings=settings, sections=sections, raw=raw)
    # Short "never mention" items double as hard lint topics (long ones are guidance for the writer).
    profile.banned_topics = [t for t in profile.never_mention if len(t.split()) <= 3]
    return profile
