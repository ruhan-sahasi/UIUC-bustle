#!/usr/bin/env python3
"""Recruiter outbound: Apollo finds the recruiters, Claude writes the copy, Apollo sends it.

    python3 outbound.py check                      # keys, mailbox, sequences access, targets, profile
    python3 outbound.py run                        # hunt -> cut -> draft for every enabled target
    python3 outbound.py launch --target <slug>     # the one confirm before anything leaves
    python3 outbound.py stats                      # what Apollo has sent, opened, replied

Step by step: hunt, cut, draft, lint, create, enroll, mailboxes, search, match, org. See README.md.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
from datetime import date
from pathlib import Path

from apollo_api import Apollo, ApolloError
from common import ConfigError, confirm, data_dir, load_env, load_targets, pick_targets, read_csv, set_env_value
from hunt import cut, enrolled_emails, hunt
from profile_md import load_profile
from sequences import (attachment_counts, campaign_for, campaign_row, enroll, mailboxes, parse_md, remember_campaign,
                       render_md, stats, sync_sequence)

APOLLO_SEQUENCES_URL = "https://app.apollo.io/#/sequences"


def apollo() -> Apollo:
    return Apollo(os.environ.get("APOLLO_API_KEY", ""))


def seq_path(slug: str) -> Path:
    return data_dir() / "sequences" / f"{slug}.md"


def copy_hash(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:12]


def campaign_name(target) -> str:
    return f"Job outreach - {target.company} - {target.role}"[:120]


def stored_hash(slug: str) -> str:
    return campaign_row(slug).get("copy_hash", "")


def remember(target, campaign_id: str, path: Path) -> None:
    remember_campaign(target.slug, campaign_id, campaign_name(target), copy_hash(path))


def pending_batch(slug: str) -> list[dict]:
    rows = read_csv(data_dir() / f"batch-{slug}.csv")
    done = enrolled_emails()
    return [r for r in rows if r.get("email") and r["email"].lower() not in done]


# --------------------------------------------------------------------------- commands


def cmd_check(args) -> int:
    ok = True

    def line(passed: bool, label: str, detail: str = "") -> None:
        nonlocal ok
        ok = ok and passed
        print(f"[{'ok' if passed else 'FAIL'}] {label}{': ' + detail if detail else ''}")

    try:
        targets = load_targets(enabled_only=False)
        enabled = [t for t in targets if t.enabled]
        line(bool(enabled), "targets.csv", f"{len(enabled)} of {len(targets)} enabled: "
             + (", ".join(t.slug for t in enabled) or "set enabled to yes on the rows you want"))
    except ConfigError as exc:
        line(False, "targets.csv", str(exc))
        enabled = []
    try:
        profile = load_profile()
        modes = {t.track: ("link" if profile.resume_is_link(t.track) else "attach in Apollo") for t in enabled}
        line(True, "profile.md", f"{profile.name}; resume: " + (", ".join(f"{k} {v}" for k, v in modes.items()) or "-"))
    except ConfigError as exc:
        line(False, "profile.md", str(exc))
    line(bool(os.environ.get("APOLLO_API_KEY")), "APOLLO_API_KEY")
    has_claude = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    line(has_claude, "ANTHROPIC_API_KEY")
    if os.environ.get("APOLLO_API_KEY"):
        a = apollo()
        try:
            line(bool(a.health().get("is_logged_in", True)), "Apollo key")
        except ApolloError as exc:
            line(False, "Apollo key", str(exc))
        try:
            boxes = mailboxes(a)
            usable = [b for b in boxes if b["usable"]]
            chosen = os.environ.get("APOLLO_MAILBOX_ID", "")
            if not boxes:
                line(False, "Apollo mailbox", "none connected. Apollo: Settings > Mailboxes > Link mailbox")
            elif chosen and not any(b["id"] == chosen for b in usable):
                line(False, "Apollo mailbox", f"APOLLO_MAILBOX_ID={chosen} is not an active mailbox; run `mailboxes`")
            elif not chosen:
                line(False, "Apollo mailbox", f"{len(usable)} active; pick one: python3 outbound.py mailboxes --save <id>")
            else:
                email = next(b["email"] for b in usable if b["id"] == chosen)
                line(True, "Apollo mailbox", f"{email} will send")
        except ApolloError as exc:
            line(False, "Apollo mailbox", str(exc))
        try:
            schedules = a.schedules()
            line(True, "Apollo sequences API", f"{len(schedules)} send schedule(s)")
        except ApolloError as exc:
            line(False, "Apollo sequences API", f"{exc} (your Apollo plan may not include sequences via API)")
    if has_claude and not args.offline:
        try:
            import anthropic

            anthropic.Anthropic().models.retrieve("claude-opus-5-5")
            line(True, "Claude API", "claude-opus-5-5 available")
        except Exception as exc:
            line(False, "Claude API", str(exc)[:200])
    print("All checks passed." if ok else "Fix the FAIL lines above first.")
    return 0 if ok else 1


def cmd_mailboxes(args) -> int:
    boxes = mailboxes(apollo())
    for b in boxes:
        print(f"{b['id']}  {b['email']}  [{b['type']}]  {b['state']}")
    if not boxes:
        print("No mailboxes. Connect yours in Apollo: Settings > Mailboxes > Link mailbox, then run this again.")
    if args.save:
        if not any(b["id"] == args.save and b["usable"] for b in boxes):
            print(f"{args.save} is not an active mailbox above.")
            return 1
        set_env_value("APOLLO_MAILBOX_ID", args.save)
        print(f"Saved APOLLO_MAILBOX_ID={args.save} to .env")
    return 0


def cmd_hunt(args) -> int:
    targets = pick_targets(load_targets(), args.target)
    report = hunt(apollo(), targets, per_company=args.per_company, max_reveals=args.max)
    print(f"Revealed {report.revealed} (cap {args.max}). Usable recruiters per target: "
          + ", ".join(f"{k} {v}" for k, v in report.found.items()))
    for note in report.notes:
        print(f"note: {note}")
    return 0


def cmd_cut(args) -> int:
    targets = pick_targets(load_targets(), args.target)
    for slug, n in cut(targets, per_company=args.per_company).items():
        print(f"batch-{slug}.csv: {n} enroll-ready")
    return 0


def cmd_draft(args) -> int:
    from draft import LLM, research, research_notes, write

    targets = pick_targets(load_targets(), args.target)
    profile = load_profile()
    llm = LLM()
    (data_dir() / "sequences").mkdir(exist_ok=True)
    for target in targets:
        path = seq_path(target.slug)
        if path.exists() and not args.redo:
            print(f"[draft] {target.slug}: {path.name} exists (use --redo to rewrite it)")
            continue
        print(f"[draft] {target.slug}: researching {target.company}...")
        found = research(llm, target, profile, today=date.today())
        print(f"[draft] {target.slug}: {len(found.data['facts'])} verified fact(s), {len(found.dropped)} dropped; writing...")
        seq, problems = write(llm, target, profile, found)
        seq.notes = research_notes(found)
        header = [f"Target: {target.company}, {target.role} ({target.slug})",
                  "Edit anything below. `lint` checks it; `launch` pushes it to Apollo. Only the subject and emails are sent."]
        if problems:
            header.append("STYLE ISSUES LEFT (fix before launch): " + "; ".join(str(p) for p in problems))
        path.write_text(render_md(seq, title=f"Sequence: {target.company}, {target.role}", header_lines=header))
        print(f"[draft] {target.slug}: wrote {path}" + (f" with {len(problems)} issue(s) to fix" if problems else ""))
    print(f"Claude usage this run: about ${llm.cost():.2f}")
    return 0


def lint_target(target, profile) -> tuple[object, list]:
    from draft import lint_sequence

    path = seq_path(target.slug)
    if not path.exists():
        raise ConfigError(f"no copy for {target.slug} yet; run: python3 outbound.py draft --target {target.slug}")
    seq = parse_md(path.read_text(), source=path.name)
    return seq, lint_sequence(seq, profile=profile, target=target)


def cmd_lint(args) -> int:
    profile = load_profile()
    bad = 0
    for target in pick_targets(load_targets(), args.target):
        try:
            _seq, problems = lint_target(target, profile)
        except (ConfigError, ValueError) as exc:
            print(f"{target.slug}: {exc}")
            bad += 1
            continue
        print(f"{target.slug}: " + ("clean" if not problems else f"{len(problems)} issue(s)"))
        for p in problems:
            print(f"  - {p}")
        bad += bool(problems)
    return 1 if bad else 0


def cmd_create(args) -> int:
    target = pick_targets(load_targets(), args.target)[0]
    profile = load_profile()
    seq, problems = lint_target(target, profile)
    if problems and not args.force:
        print("Fix these first (or pass --force):\n" + "\n".join(f"  - {p}" for p in problems))
        return 1
    a = apollo()
    existing = campaign_for(target.slug)
    before = None
    if existing and not profile.resume_is_link(target.track):
        before = (attachment_counts(a, existing) or [0])[0]
    cid, active, steps = sync_sequence(a, seq, name=campaign_name(target), campaign_id=existing,
                                       activate=args.activate, max_per_day=args.max_per_day)
    remember(target, cid, seq_path(target.slug))
    print(f"Sequence {cid} {'active' if active else 'paused'}: {campaign_name(target)}")
    for s in steps:
        print(f"  email {s.position}: wait {s.wait}d, subject {s.subject!r}, {s.body_chars} chars, {s.attachments} attachment(s)")
    if before and steps and steps[0].attachments < before:
        print("WARNING: email 1 had an attachment before this update and Apollo no longer reports it. "
              "Re-attach your resume in Apollo before launching.")
    return 0


def cmd_launch(args) -> int:
    target = pick_targets(load_targets(), args.target)[0]
    profile = load_profile()
    path = seq_path(target.slug)
    seq, problems = lint_target(target, profile)
    if problems and not args.force:
        print(f"{path.name} has style issues; fix them (or pass --force):\n" + "\n".join(f"  - {p}" for p in problems))
        return 1
    rows = pending_batch(target.slug)
    if not rows:
        print(f"No new recruiters to enroll for {target.slug}. Run: python3 outbound.py hunt --target {target.slug}"
              f" && python3 outbound.py cut --target {target.slug}")
        return 1
    a = apollo()
    mailbox_id = args.mailbox or os.environ.get("APOLLO_MAILBOX_ID", "")
    boxes = {b["id"]: b for b in mailboxes(a) if b["usable"]}
    if mailbox_id not in boxes:
        print("Pick the mailbox Apollo should send from: python3 outbound.py mailboxes --save <id>")
        return 1
    attach_mode = not profile.resume_is_link(target.track)
    cid = campaign_for(target.slug)

    if attach_mode:
        if cid is None:
            cid, _active, _steps_ = sync_sequence(a, seq, name=campaign_name(target), activate=False,
                                                  max_per_day=args.max_per_day)
            remember(target, cid, path)
            resume_file = profile.resume_file(target.track) or f"your {target.track} resume PDF"
            print(f"Created the sequence in Apollo, paused: {campaign_name(target)}\n"
                  f"Two clicks in Apollo, then run this command again:\n"
                  f"  1. {APOLLO_SEQUENCES_URL} > open it > email 1 > edit > attach {resume_file} > save\n"
                  f"  2. Turn the sequence on (Activate)\n"
                  f"Nothing is sent until you run launch again and type yes.")
            return 0
        if stored_hash(target.slug) and stored_hash(target.slug) != copy_hash(path):
            print(f"{path.name} changed since it was pushed to Apollo. Push it with "
                  f"`python3 outbound.py create --target {target.slug}`, re-check the resume attachment, then launch.")
            return 1
        detail = a.campaign(cid)
        if not (detail.get("emailer_campaign") or {}).get("active"):
            print(f"The sequence is still paused. In Apollo ({APOLLO_SEQUENCES_URL}), attach your resume to email 1 "
                  "and turn the sequence on, then run launch again.")
            return 1
        attached = (attachment_counts(a, cid) or [0])[0]
        if not attached and not confirm("Apollo does not report an attachment on email 1. Is your resume attached?",
                                        assume_yes=args.yes):
            print("Attach it in Apollo first. Nothing was sent.")
            return 1
    print(f"\nLaunch {campaign_name(target)}")
    print(f"  From: {boxes[mailbox_id]['email']}   Subject: {seq.subject}")
    print("  Emails: " + ", ".join(f"#{i + 1} day {d}" for i, d in enumerate(seq.days)))
    print("  Recruiters:")
    for r in rows:
        print(f"    {r['name']}, {r['title']} <{r['email']}>")
    question = (f"Apollo will start emailing these {len(rows)} people from {boxes[mailbox_id]['email']} "
                "on its send schedule, and stops for anyone who replies.")
    if not confirm(question, assume_yes=args.yes):
        print("Nothing was sent.")
        return 1
    if not attach_mode:
        cid, active, _ = sync_sequence(a, seq, name=campaign_name(target), campaign_id=cid, activate=True,
                                       max_per_day=args.max_per_day)
        remember(target, cid, path)
        if not active:
            print("Apollo did not turn the sequence on; check it in Apollo before enrolling. Nothing was sent.")
            return 1
    result = enroll(a, slug=target.slug, campaign_id=cid, rows=rows, mailbox_id=mailbox_id)
    print(f"Enrolled {len(result.enrolled)}, skipped {len(result.skipped)}. Apollo sends on its schedule; "
          "check progress with: python3 outbound.py stats")
    return 0


def cmd_enroll(args) -> int:
    target = pick_targets(load_targets(), args.target)[0]
    cid = campaign_for(target.slug)
    if not cid:
        print(f"No Apollo sequence for {target.slug} yet. Use launch (or create first).")
        return 1
    rows = pending_batch(target.slug)[: args.max]
    mailbox_id = args.mailbox or os.environ.get("APOLLO_MAILBOX_ID", "")
    if not mailbox_id:
        print("Pick a mailbox first: python3 outbound.py mailboxes --save <id>")
        return 1
    if args.dry_run:
        for r in rows:
            print(f"[dry-run] would enroll {r['name']} <{r['email']}>")
        return 0
    if not confirm(f"Enroll {len(rows)} recruiter(s) into sequence {cid}?", assume_yes=args.yes):
        print("Nothing was enrolled.")
        return 1
    result = enroll(apollo(), slug=target.slug, campaign_id=cid, rows=rows, mailbox_id=mailbox_id)
    print(f"Enrolled {len(result.enrolled)}, skipped {len(result.skipped)}.")
    return 0


def cmd_stats(args) -> int:
    rows = read_csv(data_dir() / "campaigns.csv")
    if not rows:
        print("No sequences yet.")
        return 0
    a = apollo()
    enrolled = read_csv(data_dir() / "enrolled.csv")
    for r in rows:
        s = stats(a, r["campaign_id"])
        n = sum(1 for e in enrolled if e.get("target") == r["target"] and e.get("status") == "enrolled")
        extra = ", ".join(f"{k} {v}" for k, v in s.items() if k not in ("name", "active"))
        print(f"{r['target']}: {'active' if s.get('active') else 'paused'}, {n} enrolled" + (f", {extra}" if extra else ""))
    return 0


def cmd_run(args) -> int:
    targets = pick_targets(load_targets(), args.target)
    if not targets:
        print("No enabled targets in targets.csv.")
        return 1
    cmd_hunt(args)
    cmd_cut(args)
    args.redo = False
    cmd_draft(args)
    profile = load_profile()
    print("\nNext:")
    for t in targets:
        try:
            _seq, problems = lint_target(t, profile)
        except (ConfigError, ValueError) as exc:
            print(f"  {t.slug}: {exc}")
            continue
        n = len(pending_batch(t.slug))
        state = "copy clean" if not problems else f"{len(problems)} style issue(s), run lint"
        print(f"  {t.slug}: {n} recruiter(s) ready, {state}. Read sequences/{t.slug}.md, then: "
              f"python3 outbound.py launch --target {t.slug}")
    return 0


def cmd_search(args) -> int:
    from hunt import RECRUITER_TITLES

    titles = [x.strip() for x in args.titles.split(",")] if args.titles else RECRUITER_TITLES
    for p in apollo().search_people(domains=[args.domain], titles=titles, per_page=25):
        print(f"{p.get('id')}  {p.get('first_name')} {p.get('last_name_obfuscated', '')}  | {p.get('title')}  "
              f"| has_email={p.get('has_email')}")
    return 0


def cmd_match(args) -> int:
    print(apollo().match(id=args.id, first=args.first, last=args.last, domain=args.domain))
    return 0


def cmd_org(args) -> int:
    o = apollo().org(args.domain)
    print({k: o.get(k) for k in ("name", "industry", "estimated_num_employees", "city", "state", "linkedin_url")})
    return 0


# --------------------------------------------------------------------------- parser


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="outbound.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    def add(name, func, help_text, *, target=False, target_required=False):
        sp = sub.add_parser(name, help=help_text)
        if target:
            sp.add_argument("--target", required=target_required, help="target slug (see `check`)")
        sp.set_defaults(func=func)
        return sp

    c = add("check", cmd_check, "check keys, mailbox, sequences access, targets, profile")
    c.add_argument("--offline", action="store_true", help="skip the Claude model check")
    m = add("mailboxes", cmd_mailboxes, "list Apollo mailboxes; --save <id> picks the sender")
    m.add_argument("--save")
    for name, func, text in (("hunt", cmd_hunt, "find and reveal recruiters (costs Apollo credits)"),
                             ("cut", cmd_cut, "write enroll-ready batch-<target>.csv files"),
                             ("run", cmd_run, "hunt, cut and draft for every enabled target")):
        sp = add(name, func, text, target=True)
        sp.add_argument("--per-company", type=int, default=2, help="recruiters per target (default 2)")
        if name != "cut":
            sp.add_argument("--max", type=int, default=10, help="max reveals this run, 1 credit each (default 10)")
    d = add("draft", cmd_draft, "research with Claude and write sequences/<target>.md", target=True)
    d.add_argument("--redo", action="store_true")
    add("lint", cmd_lint, "style-check sequences/<target>.md", target=True)
    cr = add("create", cmd_create, "push the copy to an Apollo sequence (paused unless --activate)", target=True,
             target_required=True)
    cr.add_argument("--activate", action="store_true")
    cr.add_argument("--force", action="store_true", help="push even with style issues")
    cr.add_argument("--max-per-day", type=int, default=10)
    la = add("launch", cmd_launch, "the one confirm: push, activate and enroll a target", target=True,
             target_required=True)
    la.add_argument("--mailbox")
    la.add_argument("--yes", action="store_true", help="skip the typed confirmation")
    la.add_argument("--force", action="store_true", help="launch even with style issues")
    la.add_argument("--max-per-day", type=int, default=10)
    en = add("enroll", cmd_enroll, "enroll new batch contacts into an existing sequence", target=True,
             target_required=True)
    en.add_argument("--mailbox")
    en.add_argument("--max", type=int, default=25)
    en.add_argument("--dry-run", action="store_true")
    en.add_argument("--yes", action="store_true")
    add("stats", cmd_stats, "Apollo progress per sequence")
    s = add("search", cmd_search, "free Apollo people search at a domain (debugging)")
    s.add_argument("--domain", required=True)
    s.add_argument("--titles")
    mt = add("match", cmd_match, "reveal one person (1 credit)")
    for flag in ("--id", "--first", "--last", "--domain"):
        mt.add_argument(flag)
    o = add("org", cmd_org, "company lookup by domain")
    o.add_argument("--domain", required=True)
    return p


def main(argv: list[str] | None = None) -> int:
    load_env()
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ConfigError, ApolloError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
