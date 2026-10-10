"""Stage orchestration: sync targets -> scan inbox -> discover -> research -> draft -> approve ->
queue follow-ups -> send.

Every stage reads its work from the ledger and only touches rows that are missing output, so any
stage can be re-run safely, and `run` is just the stages in order.
"""
from __future__ import annotations

import json
import random
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .apollo import ApolloClient, ApolloError
from .config import AppConfig, Target
from .contacts import discover as discover_contacts
from .db import DB
from .llm import LLM
from .mailer import AuthFailed, DeliveryError, OutgoingEmail, RecipientRejected, Transport, build_mime, make_transport
from .research import research_target
from .timeutil import business_days_between, in_send_window, local_date, next_window_start, parse_ts
from .writer import write_followup, write_initial

INACTIVE_CONTACT = {"replied", "bounced", "do_not_contact"}


@dataclass
class Report:
    discovered: int = 0
    researched: int = 0
    drafted: int = 0
    needs_attention: int = 0
    approved: int = 0
    followups_queued: int = 0
    sent: int = 0
    replies: int = 0
    bounces: int = 0
    notes: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        counts = (f"discovered {self.discovered} contacts, researched {self.researched} companies, "
                  f"drafted {self.drafted} emails ({self.needs_attention} need attention), "
                  f"approved {self.approved}, queued {self.followups_queued} follow-ups, sent {self.sent}, "
                  f"new replies {self.replies}, bounces {self.bounces}")
        return [counts, *[f"note: {n}" for n in self.notes], *[f"error: {e}" for e in self.errors]]


def real_eligibility_flags(flags: list[str]) -> list[str]:
    return [f for f in flags or [] if f.strip() and not re.match(r"^\s*(none|no red flags|n/?a)\b", f, re.I)]


class Pipeline:
    def __init__(
        self,
        app: AppConfig,
        db: DB,
        *,
        apollo: ApolloClient | None = None,
        llm: LLM | None = None,
        transport: Transport | None = None,
        inbox: Any = None,
        clock: Callable[[], datetime] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        out: Callable[[str], None] = print,
        dry_run: bool = False,
    ):
        self.app = app
        self.settings = app.settings
        self.profile = app.profile
        self.db = db
        self._apollo = apollo
        self._llm = llm
        self._transport = transport
        self._inbox = inbox
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.sleep = sleep
        self.out = out
        self.dry_run = dry_run
        self.report = Report()

    # ------------------------------------------------------------------ lazy clients
    @property
    def apollo(self) -> ApolloClient:
        if self._apollo is None:
            cfg = self.settings.apollo
            self._apollo = ApolloClient(
                cfg.api_key or "",
                base_url=cfg.base_url,
                enrich_budget=self.settings.limits.apollo_enrich_per_run,
                on_usage=lambda op, units: self.db.record_usage("apollo", op, units),
            )
        return self._apollo

    @property
    def llm(self) -> LLM:
        if self._llm is None:
            self._llm = LLM(self.settings.llm, on_usage=lambda op, units: self.db.record_usage("anthropic", op, units))
        return self._llm

    @property
    def transport(self) -> Transport:
        if self._transport is None:
            self._transport = make_transport(self.settings, self.app.data_dir, self.app.config_dir,
                                             dry_run=self.dry_run)
        return self._transport

    @property
    def inbox(self):
        if self._inbox is None:
            if self.settings.delivery == "gmail_api":
                from .gmail_api import GmailApiInbox

                self._inbox = GmailApiInbox(self.app.config_dir)
            else:
                from .inbox import ImapInbox

                self._inbox = ImapInbox(self.settings.sender)
        return self._inbox

    def _target(self, row) -> Target:
        return Target.model_validate_json(row["config_json"])

    # ------------------------------------------------------------------ targets
    def sync_targets(self) -> None:
        yaml_slugs = set()
        for target in self.app.targets:
            yaml_slugs.add(target.slug)
            existing = self.db.targets(enabled_only=False, slug=target.slug)
            if existing and not target.domain and existing[0]["domain"]:
                target.domain = existing[0]["domain"]  # keep a domain resolved on an earlier run
            self.db.upsert_target(target)
        for row in self.db.targets(enabled_only=False):
            if row["slug"] not in yaml_slugs and row["enabled"]:
                self.db.update_target(row["id"], enabled=0)

    # ------------------------------------------------------------------ discover
    def _active_contacts(self, target_id: int) -> list:
        return [c for c in self.db.contacts(target_id=target_id) if c["status"] not in INACTIVE_CONTACT]

    def discover(self, *, slug: str | None = None, retry: bool = False) -> int:
        added_total = 0
        cap = self.settings.limits.contacts_per_company
        for row in self.db.targets(slug=slug):
            state = row["discovery_state"]
            if state != "pending" and not (retry and state in ("no_contacts", "failed", "done")):
                continue
            target = self._target(row)
            need = cap - len(self._active_contacts(row["id"]))
            if need <= 0:
                self.db.update_target(row["id"], discovery_state="done")
                continue
            try:
                if not target.domain:
                    domain = self.apollo.find_domain(target.company)
                    if not domain:
                        raise ApolloError(f"could not find a website domain for {target.company}; add `domain:`")
                    target.domain = domain
                    self.db.update_target(row["id"], domain=domain, config_json=target.model_dump_json())
                    self.report.notes.append(f"{target.slug}: resolved domain {domain} (add it to targets.yaml)")
                result = discover_contacts(
                    self.apollo, target, self.settings, need=need,
                    skip=lambda email: bool(self.db.contact_by_email(email)) or self.db.is_suppressed(email),
                )
            except ApolloError as exc:
                self.db.update_target(row["id"], discovery_state="failed", last_error=str(exc))
                self.report.errors.append(f"{target.slug}: {exc}")
                if "refused" in str(exc) or "API key" in str(exc):
                    break  # bad key or plan: every target would fail the same way
                continue
            added = 0
            for cand in result.found:
                if self.db.add_contact(row["id"], cand.person, score=cand.score, source=cand.source):
                    added += 1
            added_total += added
            has_any = bool(self._active_contacts(row["id"]))
            self.db.update_target(
                row["id"],
                discovery_state="done" if has_any else "no_contacts",
                last_error=None if has_any else
                f"no verified emails ({result.recruiters_seen} recruiter profiles seen"
                f"{', tried fallback titles' if result.fallback_used else ''})",
            )
            self.db.log("discovered", target.slug, {"added": added, "fallback": result.fallback_used})
            self.out(f"[discover] {target.slug}: +{added} contact(s)")
            if result.budget_hit:
                self.report.notes.append("Apollo enrichment budget reached for this run; the rest waits for tomorrow")
                break
        self.report.discovered += added_total
        return added_total

    # ------------------------------------------------------------------ research
    def research(self, *, slug: str | None = None, redo: bool = False) -> int:
        done = 0
        today = local_date(self.clock(), self.settings.limits.send_window.timezone)
        for row in self.db.targets(slug=slug):
            if row["discovery_state"] != "done":
                continue
            if row["research_state"] == "done" and not redo:
                continue
            if row["research_state"] == "no_facts" and not redo:
                continue  # "failed" (network, API) retries on the next run; "no_facts" needs --redo
            if not self._active_contacts(row["id"]):
                continue
            target = self._target(row)
            try:
                result = research_target(self.llm, target, self.profile, self.settings, today=today)
            except Exception as exc:  # one bad company should not stop the run
                self.db.update_target(row["id"], research_state="failed", last_error=f"research: {exc}")
                self.report.errors.append(f"{target.slug}: research failed: {exc}")
                continue
            self.db.save_research(row["id"], brief=result.brief, data=result.data, sources=result.sources,
                                  dropped=result.dropped, model=self.settings.llm.model)
            state = "done" if result.usable else "no_facts"
            self.db.update_target(row["id"], research_state=state,
                                  last_error=None if result.usable else "research found no verifiable recent facts")
            self.out(f"[research] {target.slug}: {len(result.data.get('facts', []))} verified fact(s), "
                     f"{len(result.dropped)} dropped")
            done += 1
        self.report.researched += done
        return done

    # ------------------------------------------------------------------ draft
    def draft(self, *, slug: str | None = None, redo: bool = False) -> int:
        made = 0
        for row in self.db.targets(slug=slug):
            if row["research_state"] != "done":
                continue
            target = self._target(row)
            research = self.db.research(row["id"])
            if not research:
                continue
            try:
                attachment = self.profile.resume_for(target.track, target.resume)
            except Exception as exc:
                self.report.errors.append(f"{target.slug}: {exc}")
                continue
            for contact in self.db.contacts(target_id=row["id"]):
                if contact["status"] in INACTIVE_CONTACT or not contact["email"]:
                    continue
                existing = self.db.message_for(contact["id"], "initial")
                if existing:
                    if not redo or existing["status"] in ("sent", "approved"):
                        continue
                    self.db.delete_message(existing["id"])
                try:
                    draft = write_initial(self.llm, profile=self.profile, settings=self.settings, target=target,
                                          research=research["data"], contact=dict(contact))
                except Exception as exc:
                    self.report.errors.append(f"{target.slug} / {contact['email']}: drafting failed: {exc}")
                    continue
                status = "draft" if draft.clean else "needs_attention"
                meta = {
                    "fact_urls_used": draft.fact_urls_used,
                    "experience_ids_used": draft.experience_ids_used,
                    "contact_source": contact["source"],
                    "eligibility_flags": real_eligibility_flags(research["data"].get("eligibility_flags", [])),
                }
                self.db.create_message(
                    contact_id=contact["id"], kind="initial", subject=draft.subject, body=draft.body,
                    attachment=str(attachment), lint=[v.to_dict() for v in draft.violations], meta=meta,
                    attempts=draft.attempts, status=status,
                )
                self.db.update_contact(contact["id"], status="drafted")
                made += 1
                if status == "needs_attention":
                    self.report.needs_attention += 1
                self.out(f"[draft] {target.slug} -> {contact['email']}: {status} after {draft.attempts} attempt(s)")
        self.report.drafted += made
        return made

    # ------------------------------------------------------------------ approve / reject
    def auto_approvable(self, msg) -> tuple[bool, str]:
        if msg["status"] != "draft":
            return False, f"status is {msg['status']}"
        contact = self.db.contact(msg["contact_id"])
        accept = {s.lower() for s in self.settings.apollo.accept_email_status}
        if msg["kind"] == "initial" and (contact["email_status"] or "").lower() not in accept:
            return False, "email is not verified"
        meta = json.loads(msg["meta_json"])
        if meta.get("eligibility_flags"):
            return False, "research raised eligibility flags: " + "; ".join(meta["eligibility_flags"])
        if json.loads(msg["lint_json"]):
            return False, "style check failed"
        if msg["attachment"] and not self._attachment_ok(msg["attachment"]):
            return False, f"resume missing at {msg['attachment']}"
        return True, "ok"

    def _attachment_ok(self, path: str) -> bool:
        from pathlib import Path

        p = Path(path).expanduser()
        return p.exists() and p.read_bytes()[:4] == b"%PDF"

    def auto_approve(self) -> int:
        n = 0
        for msg in self.db.messages(status="draft"):
            ok, why = self.auto_approvable(msg)
            if ok:
                self.db.update_message(msg["id"], status="approved")
                n += 1
            else:
                self.db.update_message(msg["id"], error=f"held for review: {why}")
        self.report.approved += n
        return n

    def approve(self, ids: list[int] | None = None, *, all_clean: bool = False) -> list[int]:
        approved = []
        if all_clean:
            candidates = [m for m in self.db.messages(status="draft") if not json.loads(m["lint_json"])]
        else:
            candidates = [m for m in (self.db.message(i) for i in ids or []) if m]
        for msg in candidates:
            if msg["status"] not in ("draft", "needs_attention", "failed"):
                continue
            self.db.update_message(msg["id"], status="approved", error=None)
            approved.append(msg["id"])
        self.report.approved += len(approved)
        return approved

    def reject(self, ids: list[int], reason: str = "") -> list[int]:
        done = []
        for i in ids:
            msg = self.db.message(i)
            if msg and msg["status"] not in ("sent",):
                self.db.update_message(i, status="rejected", error=reason or "rejected in review")
                done.append(i)
        return done

    # ------------------------------------------------------------------ inbox
    def sync_inbox(self) -> dict[str, str]:
        contacted = [c for c in self.db.contacts(status="contacted") if c["email"]]
        if not contacted:
            self.db.log("inbox_sync", detail={"checked": 0}, ts=self.clock().isoformat(timespec="seconds"))
            return {}
        pairs = []
        for c in contacted:
            initial = self.db.message_for(c["id"], "initial")
            since = parse_ts(initial["sent_at"]) if initial and initial["sent_at"] else self.clock() - timedelta(days=30)
            pairs.append((c["email"], since - timedelta(days=1)))
        results = self.inbox.scan(pairs)
        for email_addr, kind in results.items():
            contact = self.db.contact_by_email(email_addr)
            if not contact:
                continue
            if kind == "replied":
                self.db.update_contact(contact["id"], status="replied")
                self._cancel_pending(contact["id"], "they replied")
                self.report.replies += 1
                self.out(f"[inbox] reply from {email_addr}")
            elif kind == "bounced":
                self.db.update_contact(contact["id"], status="bounced")
                self.db.suppress(email_addr, "bounced")
                self._cancel_pending(contact["id"], "address bounced")
                self.db.update_target(contact["target_id"], discovery_state="pending")  # find a replacement
                self.report.bounces += 1
                self.out(f"[inbox] bounce for {email_addr}")
            self.db.log(f"inbox_{kind}", email_addr)
        self.db.log("inbox_sync", detail={"checked": len(pairs), "found": len(results)},
                    ts=self.clock().isoformat(timespec="seconds"))
        return results

    def _cancel_pending(self, contact_id: int, reason: str) -> None:
        for kind in ("initial", "followup"):
            msg = self.db.message_for(contact_id, kind)
            if msg and msg["status"] in ("draft", "needs_attention", "approved"):
                self.db.update_message(msg["id"], status="cancelled", error=reason)

    def _inbox_checked_recently(self) -> bool:
        ts = self.db.last_event_ts("inbox_sync")
        return bool(ts) and self.clock() - parse_ts(ts) < timedelta(hours=24)

    # ------------------------------------------------------------------ follow-ups
    def queue_followups(self) -> int:
        cfg = self.settings.followup
        if not cfg.enabled:
            return 0
        if not self._inbox_checked_recently():
            self.report.notes.append("follow-ups skipped: the inbox has not been checked for replies in 24h")
            return 0
        tz = self.settings.limits.send_window.timezone
        today = local_date(self.clock(), tz)
        queued = 0
        for parent in self.db.messages(status="sent", kind="initial"):
            contact = self.db.contact(parent["contact_id"])
            if contact["status"] != "contacted" or self.db.message_for(contact["id"], "followup"):
                continue
            if business_days_between(local_date(parse_ts(parent["sent_at"]), tz), today) < cfg.after_business_days:
                continue
            target = self._target(self.db.target(contact["target_id"]))
            subject, body = write_followup(
                self.profile, target=target, contact=dict(contact), original_subject=parent["subject"],
                original_body=parent["body"], original_sent_at=parent["sent_at"],
                sender_name=self.settings.sender.name, sender_email=self.settings.sender.email,
            )
            self.db.create_message(
                contact_id=contact["id"], kind="followup", parent_id=parent["id"], subject=subject, body=body,
                attachment=parent["attachment"], lint=[], meta={}, attempts=1,
                status="approved" if self.settings.mode == "auto" else "draft",
            )
            queued += 1
        self.report.followups_queued += queued
        return queued

    # ------------------------------------------------------------------ send
    def sent_today(self) -> list:
        tz = self.settings.limits.send_window.timezone
        today = local_date(self.clock(), tz)
        return [m for m in self.db.sent_messages() if local_date(parse_ts(m["sent_at"]), tz) == today]

    def send(self, *, force_window: bool = False, limit: int | None = None) -> int:
        limits = self.settings.limits
        now = self.clock()
        if not force_window and not in_send_window(now, limits.send_window):
            nxt = next_window_start(now, limits.send_window)
            self.report.notes.append(f"outside the send window; approved emails go out at {nxt:%a %b %d %H:%M %Z}")
            return 0
        sent_today = self.sent_today()
        remaining = limits.daily_send_cap - len(sent_today)
        if limit is not None:
            remaining = min(remaining, limit)
        if remaining <= 0:
            self.report.notes.append(f"daily cap of {limits.daily_send_cap} reached")
            return 0
        new_today: dict[int, int] = {}
        for m in sent_today:
            if m["kind"] == "initial":
                new_today[m["target_id"]] = new_today.get(m["target_id"], 0) + 1

        def order(msg) -> tuple:
            contact = self.db.contact(msg["contact_id"])
            target = self.db.target(contact["target_id"])
            return (0 if msg["kind"] == "followup" else 1, target["priority"], msg["id"])

        queue = sorted(self.db.messages(status="approved"), key=order)
        sent = 0
        for msg in queue:
            if sent >= remaining:
                break
            contact = self.db.contact(msg["contact_id"])
            if contact["status"] in INACTIVE_CONTACT or self.db.is_suppressed(contact["email"]):
                self.db.update_message(msg["id"], status="cancelled", error=f"contact is {contact['status']}")
                continue
            if msg["kind"] == "initial" and new_today.get(contact["target_id"], 0) >= limits.new_contacts_per_company_per_day:
                continue  # stays approved; goes out on a later day
            parent = self.db.message(msg["parent_id"]) if msg["parent_id"] else None
            if msg["kind"] == "followup" and (not parent or parent["status"] != "sent"):
                continue
            outgoing = OutgoingEmail(
                to_email=contact["email"],
                to_name=" ".join(x for x in (contact["first_name"], contact["last_name"]) if x),
                subject=msg["subject"],
                body=msg["body"],
                attachment_path=msg["attachment"],
                attachment_name=self.profile.resume_attachment_name,
                in_reply_to=parent["message_id"] if parent else None,
            )
            try:
                mime = build_mime(self.settings.sender, outgoing)
                thread_id = json.loads(parent["meta_json"]).get("thread_id") if parent else None
                info = self.transport.deliver(mime, thread_id=thread_id) or {}
            except AuthFailed:
                raise
            except RecipientRejected as exc:
                self.db.update_message(msg["id"], status="failed", error=f"recipient rejected: {exc}")
                self.db.update_contact(contact["id"], status="bounced")
                self.db.suppress(contact["email"], "rejected at send")
                self.report.bounces += 1
                continue
            except DeliveryError as exc:
                self.db.update_message(msg["id"], status="failed", error=str(exc))
                self.report.errors.append(f"send to {contact['email']} failed: {exc}")
                continue
            if msg["kind"] == "initial":
                new_today[contact["target_id"]] = new_today.get(contact["target_id"], 0) + 1
            if self.dry_run:
                self.out(f"[dry-run] wrote {info.get('eml')} for {contact['email']}")
            else:
                meta = {**json.loads(msg["meta_json"]), **info, "via": self.transport.name}
                self.db.update_message(msg["id"], status="sent", message_id=str(mime["Message-ID"]),
                                       sent_at=self.clock().isoformat(timespec="seconds"), error=None,
                                       meta_json=json.dumps(meta))
                if msg["kind"] == "initial":
                    self.db.update_contact(contact["id"], status="contacted")
                self.db.log("sent", contact["email"], {"message": msg["id"], "kind": msg["kind"]})
                self.out(f"[send] {msg['kind']} -> {contact['email']} ({self.transport.name})")
            sent += 1
            if sent < remaining and not self.dry_run:
                self.sleep(random.uniform(limits.min_gap_seconds, limits.max_gap_seconds))
        if self._transport is not None:
            self._transport.close()
        self.report.sent += sent
        return sent

    # ------------------------------------------------------------------ run
    def run(self, *, send: bool = True, force_window: bool = False) -> Report:
        self.sync_targets()
        try:
            self.sync_inbox()
        except Exception as exc:
            self.report.notes.append(f"inbox not checked ({exc}); follow-ups wait until it works")
        self.discover()
        self.research()
        self.draft()
        if self.settings.mode == "auto":
            self.auto_approve()
        self.queue_followups()
        if send:
            self.send(force_window=force_window)
        return self.report

    # ------------------------------------------------------------------ status
    def status_rows(self) -> list[dict]:
        rows = []
        for t in self.db.targets(enabled_only=False):
            contacts = self.db.contacts(target_id=t["id"])
            msgs = [m for c in contacts for m in (self.db.message_for(c["id"], k) for k in ("initial", "followup")) if m]
            count = lambda s: sum(1 for m in msgs if m["status"] == s)  # noqa: E731
            rows.append({
                "slug": t["slug"],
                "enabled": bool(t["enabled"]),
                "discovery": t["discovery_state"],
                "research": t["research_state"],
                "contacts": len(contacts),
                "draft": count("draft") + count("needs_attention"),
                "approved": count("approved"),
                "sent": count("sent"),
                "replied": sum(1 for c in contacts if c["status"] == "replied"),
                "error": t["last_error"] or "",
            })
        return rows
