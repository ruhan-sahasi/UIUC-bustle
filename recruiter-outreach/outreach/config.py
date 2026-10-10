"""Typed configuration: settings.yaml, profile.yaml, targets.yaml, and .env.

All three YAML files live in one config directory (default: recruiter-outreach/config).
Only the *.example.yaml versions are tracked in git; the real ones hold personal data.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, field_validator

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_DIR = ROOT / "config"
DEFAULT_DATA_DIR = ROOT / "data"

Track = Literal["swe", "pm", "consulting"]


class ConfigError(Exception):
    pass


# --------------------------------------------------------------------------- settings

PROVIDER_PRESETS = {
    "gmail": {
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 465,
        "smtp_security": "ssl",
        "imap_host": "imap.gmail.com",
        "drafts_folder": "[Gmail]/Drafts",
        "inbox_folder": "[Gmail]/All Mail",
    },
    "outlook": {
        "smtp_host": "smtp.office365.com",
        "smtp_port": 587,
        "smtp_security": "starttls",
        "imap_host": "outlook.office365.com",
        "drafts_folder": "Drafts",
        "inbox_folder": "INBOX",
    },
}


class SenderConfig(BaseModel):
    name: str
    email: str
    provider: Literal["gmail", "outlook", "custom"] = "gmail"
    smtp_host: str | None = None
    smtp_port: int | None = None
    smtp_security: Literal["ssl", "starttls", "none"] | None = None
    imap_host: str | None = None
    imap_port: int = 993
    drafts_folder: str | None = None
    inbox_folder: str | None = None
    username_env: str = "OUTREACH_EMAIL_USER"
    password_env: str = "OUTREACH_EMAIL_PASSWORD"
    bcc_self: bool = False

    def model_post_init(self, __context) -> None:
        for key, value in PROVIDER_PRESETS.get(self.provider, {}).items():
            if getattr(self, key) is None:
                setattr(self, key, value)

    @property
    def username(self) -> str:
        return os.environ.get(self.username_env) or self.email

    @property
    def password(self) -> str | None:
        return os.environ.get(self.password_env)


class SendWindow(BaseModel):
    timezone: str = "America/New_York"
    days: list[str] = ["Mon", "Tue", "Wed", "Thu"]
    start: str = "08:30"
    end: str = "11:30"

    @field_validator("days")
    @classmethod
    def _days(cls, v: list[str]) -> list[str]:
        valid = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
        bad = [d for d in v if d not in valid]
        if bad:
            raise ValueError(f"unknown day names {bad}; use {sorted(valid)}")
        return v


class Limits(BaseModel):
    daily_send_cap: int = 15
    contacts_per_company: int = 2
    new_contacts_per_company_per_day: int = 1
    min_gap_seconds: int = 90
    max_gap_seconds: int = 240
    apollo_enrich_per_run: int = 20
    send_window: SendWindow = SendWindow()


class FollowupConfig(BaseModel):
    enabled: bool = True
    after_business_days: int = 5


DEFAULT_RECRUITER_TITLES = [
    "University Recruiter",
    "Campus Recruiter",
    "Early Career Recruiter",
    "Emerging Talent Recruiter",
    "University Programs",
    "Internship Program Manager",
    "Technical Recruiter",
    "Recruiter",
    "Talent Acquisition Partner",
    "Talent Acquisition",
    "Recruiting Manager",
    "Head of Talent",
]

DEFAULT_FALLBACK_TITLES = {
    "swe": ["Engineering Manager", "Head of Engineering", "VP Engineering", "CTO", "Co-Founder", "Founder"],
    "pm": ["Head of Product", "Product Manager", "VP Product", "Co-Founder", "Founder"],
    "consulting": ["Partner", "Principal", "Managing Director", "Director"],
}

DEFAULT_EXCLUDE_TITLES = [
    r"\bexecutive (search|recruit)",
    r"\b(clinical|nurs\w*|healthcare|retail|store|warehouse|driver|hourly|field)\b.*\brecruit",
    r"\b(recruiting|talent|hr|people)\s+intern\b",
    r"\bformer\b",
    r"\bassistant to\b",
]


class ApolloConfig(BaseModel):
    api_key_env: str = "APOLLO_API_KEY"
    base_url: str = "https://api.apollo.io/api/v1"
    accept_email_status: list[str] = ["verified"]
    person_locations: list[str] = ["United States"]
    per_page: int = 25
    max_pages: int = 2
    recruiter_titles: list[str] = DEFAULT_RECRUITER_TITLES
    use_fallback_titles: bool = True
    fallback_titles: dict[str, list[str]] = DEFAULT_FALLBACK_TITLES
    exclude_title_patterns: list[str] = DEFAULT_EXCLUDE_TITLES

    @property
    def api_key(self) -> str | None:
        return os.environ.get(self.api_key_env)


class LLMConfig(BaseModel):
    model: str = "claude-opus-5-5"
    research_effort: Literal["low", "medium", "high", "xhigh", "max"] = "high"
    writing_effort: Literal["low", "medium", "high", "xhigh", "max"] = "high"
    max_web_searches: int = 6
    max_web_fetches: int = 4
    fallbacks: bool = True
    max_draft_attempts: int = 3
    max_fact_age_days: int = 365
    # Used only for the cost estimate in `outreach status`.
    price_input_per_mtok: float = 4.0
    price_output_per_mtok: float = 20.0
    price_per_web_search: float = 0.01


class Settings(BaseModel):
    mode: Literal["review", "auto"] = "review"
    delivery: Literal["smtp", "drafts", "gmail_api", "file"] = "smtp"
    sender: SenderConfig
    limits: Limits = Limits()
    followup: FollowupConfig = FollowupConfig()
    apollo: ApolloConfig = ApolloConfig()
    llm: LLMConfig = LLMConfig()


# --------------------------------------------------------------------------- profile


class Experience(BaseModel):
    id: str
    summary: str
    approved_wording: list[str] = []
    tracks: list[Track] = ["swe", "pm", "consulting"]


class StyleRules(BaseModel):
    forbidden_chars: list[str] = ["'", "’", "‘", "ʼ", "—", "–", "~"]
    banned_words: list[str] = [
        "spearheaded", "spearhead", "leveraged", "leverage", "leveraging", "utilized", "utilize",
        "robust", "seamless", "seamlessly", "cutting-edge", "passionate", "delve", "thrilled",
        "synergy", "game-changer", "testament", "tapestry", "innovative", "dynamic",
    ]
    banned_phrases: list[str] = [
        "I hope this email finds you well",
        "I hope you are doing well",
        "not just",
        "To whom it may concern",
        "Dear Sir",
        "Dear Hiring",
    ]
    banned_topics: list[str] = []
    allow_parentheses: bool = False
    allow_graduation_mention: bool = False
    max_numbers: int = 3
    min_words: int = 110
    max_words: int = 190
    max_subject_chars: int = 70
    voice_notes: str = ""
    extra_rules_file: str | None = None

    def extra_rules(self) -> str:
        if not self.extra_rules_file:
            return ""
        path = Path(self.extra_rules_file).expanduser()
        return path.read_text() if path.exists() else ""


class Profile(BaseModel):
    name: str
    first_name: str
    school: str
    opening_sentence: str
    signature_lines: list[str]
    closing_lines: list[str] = [
        "Thank you for reading and I look forward to hearing back!",
        "",
        "Warm Regards,",
    ]
    graduation: str = ""
    target_term: str = "Summer 2027"
    citizenship_note: str = ""
    subject_example: str = "CS student interested in the Software Engineering Intern role"
    home_cities: list[str] = []
    near_home_line: str = "The {city} office would also put me close to home."
    resumes: dict[str, str]
    resume_attachment_name: str = "Resume.pdf"
    experiences: list[Experience]
    facts_never_to_use: list[str] = []
    style: StyleRules = StyleRules()
    followup_template: str = Field(
        default=(
            "I wanted to follow up on my note below about the {role} role at {company}. "
            "I have attached my resume again in case it is helpful, and if someone else "
            "on the team is the right person to talk to, I would be grateful for a pointer."
        )
    )

    def resume_for(self, track: str, override: str | None = None) -> Path:
        raw = override or self.resumes.get(track) or self.resumes.get("default")
        if not raw:
            raise ConfigError(f"profile.resumes has no entry for track '{track}' and no 'default'")
        return Path(raw).expanduser()


# --------------------------------------------------------------------------- targets


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60]


class Target(BaseModel):
    company: str
    role: str
    domain: str | None = None
    alt_domains: list[str] = []
    track: Track = "swe"
    posting_url: str | None = None
    location: str | None = None
    applied: bool = False
    resume: str | None = None
    graduation: str | None = None
    notes: str | None = None
    priority: int = 5
    enabled: bool = True
    titles: list[str] | None = None
    slug: str = ""

    def model_post_init(self, __context) -> None:
        if not self.slug:
            self.slug = slugify(f"{self.company} {self.role}")
        if self.domain:
            self.domain = self.domain.lower().removeprefix("https://").removeprefix("http://")
            self.domain = self.domain.removeprefix("www.").split("/")[0]

    @property
    def domains(self) -> list[str]:
        return [d for d in [self.domain, *self.alt_domains] if d]


# --------------------------------------------------------------------------- loading


def load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, does not override variables already set."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


def _read_yaml(path: Path):
    if not path.exists():
        example = path.with_name(path.stem + ".example.yaml")
        hint = f" Copy {example.name} to {path.name} (or run `outreach init`)." if example.exists() else ""
        raise ConfigError(f"Missing {path}.{hint}")
    with path.open() as f:
        return yaml.safe_load(f)


def load_settings(config_dir: Path) -> Settings:
    return Settings.model_validate(_read_yaml(config_dir / "settings.yaml"))


def load_profile(config_dir: Path) -> Profile:
    return Profile.model_validate(_read_yaml(config_dir / "profile.yaml"))


def load_targets(config_dir: Path) -> list[Target]:
    raw = _read_yaml(config_dir / "targets.yaml") or []
    if isinstance(raw, dict):
        raw = raw.get("targets", [])
    targets = [Target.model_validate(item) for item in raw]
    slugs = [t.slug for t in targets]
    dupes = sorted({s for s in slugs if slugs.count(s) > 1})
    if dupes:
        raise ConfigError(f"Duplicate target slugs in targets.yaml: {dupes}. Set an explicit `slug:` on one of them.")
    return targets


class AppConfig(BaseModel):
    settings: Settings
    profile: Profile
    targets: list[Target]
    config_dir: Path
    data_dir: Path


def load_all(config_dir: Path | None = None, data_dir: Path | None = None) -> AppConfig:
    config_dir = Path(config_dir or os.environ.get("OUTREACH_CONFIG_DIR") or DEFAULT_CONFIG_DIR)
    data_dir = Path(data_dir or os.environ.get("OUTREACH_DATA_DIR") or DEFAULT_DATA_DIR)
    for env_file in dict.fromkeys([ROOT / ".env", config_dir.parent / ".env", config_dir / ".env"]):
        load_dotenv(env_file)
    return AppConfig(
        settings=load_settings(config_dir),
        profile=load_profile(config_dir),
        targets=load_targets(config_dir),
        config_dir=config_dir,
        data_dir=data_dir,
    )
