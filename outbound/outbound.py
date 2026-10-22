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
from common import (ConfigError, confirm, data_dir, load_env, load_targets, pick_targets, pin_slugs, read_csv,
                    set_env_value)
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


def remember(target, campaign_id: str, path: Path | None) -> None:
    remember_campaign(target.slug, campaign_id, campaign_name(target), copy_hash(path) if path else "")


def pending_batch(slug: str) -> list[dict]:
    rows = read_csv(data_dir() / f"batch-{slug}.csv")
    done = enrolled_emails()
    return [r for r in rows if r.get("email") and r["email"].lower() not in done]


def lint_target(target, profile):
    from draft import lint_sequence

    path = seq_path(target.slug)
    if not path.exists():
        raise ConfigError(f"no copy for {target.slug} yet; run: python3 outbound.py draft --target {target.slug}")
    seq = parse_md(path.read_text(), source=path.name)
    return seq, lint_sequence(seq, profile=profile, target=target)


class Blocked(Exception):
    """A preflight check failed; the message says what to do. Nothing was sent."""


def gate(problems, *, force: bool, name: str) -> None:
    """Print every problem. --force skips style rules only; safety rules (resume, review markers, merge
    fields, structure) always block, because breaking them sends something false or broken."""
    if not problems:
        return
    safety = [p for p in problems if p.safety]
    lines = [f"{name}:"] + [f"  - {p}" for p in problems]
    if safety:
        raise Blocked("\n".join(lines + ["These cannot be skipped with --force; fix them first. Nothing was sent."]))
    if not force:
        raise Blocked("\n".join(lines + ["Fix them, or pass --force to go ahead with these style issues."]))
    print("\n".join(lines + ["Going ahead anyway because of --force."]))


def preflight(a: Apollo, target, profile, args, *, need_campaign: bool):
    """Every check that must pass before anyone is enrolled, shared by launch and enroll."""
    path = seq_path(target.slug)
    seq, problems = lint_target(target, profile)
    gate(problems, force=getattr(args, "force", False), name=f"{path.name} has issues")
    rows = pending_batch(target.slug)
    if not rows:
        raise Blocked(f"No new recruiters to enroll for {target.slug}. Run: python3 outbound.py hunt --target "
                      f"{target.slug} && python3 outbound.py cut --target {target.slug}")
    mailbox_id = getattr(args, "mailbox", None) or os.environ.get("APOLLO_MAILBOX_ID", "")
    boxes = {b["id"]: b for b in mailboxes(a) if b["usable"]}
    if mailbox_id not in boxes:
        raise Blocked("Pick the mailbox Apollo should send from: python3 outbound.py mailboxes --save <id>")
    cid = campaign_for(target.slug)
    if need_campaign and not cid:
        raise Blocked(f"No Apollo sequence for {target.slug} yet. Use: python3 outbound.py launch --target {target.slug}")
    if cid:
        pushed = campaign_row(target.slug).get("copy_hash", "")
        if pushed and pushed != copy_hash(path):
            raise Blocked(f"{path.name} changed since it was pushed to Apollo. Push it with `python3 outbound.py "
                          f"create --target {target.slug}`" + ("" if profile.resume_is_link(target.track) else
                          ", re-check the resume attachment in Apollo,") + " then try again.")
    return seq, rows, boxes[mailbox_id], cid


def attach_guard(a: Apollo, cid: str, args) -> None:
    """Attach mode: the sequence must be on and email 1 must carry the resume. --yes never answers this."""
    detail = a.campaign(cid)
    if not (detail.get("emailer_campaign") or {}).get("active"):
        raise Blocked(f"The sequence is paused. In Apollo ({APOLLO_SEQUENCES_URL}), attach your resume to email 1 and "
                      "turn the sequence on, then run this again.")
    if (attachment_counts(a, cid) or [0])[0]:
        return
    print("WARNING: Apollo does not report an attachment on email 1, and email 1 says your resume is attached.")
    if getattr(args, "resume_attached", False):
        print("Continuing because you passed --resume-attached.")
        return
    if getattr(args, "yes", False):
        raise Blocked("Open the sequence in Apollo and check email 1 has your resume. If it does, re-run with "
                      "--resume-attached. Nothing was sent.")
    if not confirm("Did you attach your resume to email 1 in Apollo?"):
        raise Blocked("Attach it in Apollo first. Nothing was sent.")


def show_plan(target, seq, rows, box) -> None:
    print(f"\nLaunch {campaign_name(target)}")
    print(f"  From: {box['email']}   Subject: {seq.subject}")
    print("  Emails: " + ", ".join(f"#{i + 1} day {d}" for i, d in enumerate(seq.days)))
    print("  Recruiters:")
    for r in rows:
        print(f"    {r['name']}, {r['title']} <{r['email']}>")


# --------------------------------------------------------------------------- commands


def cmd_check(args) -> int:
    ok = True

    def line(passed: bool, label: str, detail: str = "") -> None:
        nonlocal ok
        ok = ok and passed
        print(f"[{'ok' if passed else 'FAIL'}] {label}{': ' + detail if detail else ''}")

    enabled = []
    try:
        targets = load_targets(enabled_only=False)
        enabled = [t for t in targets if t.enabled]
        line(bool(enabled), "targets.csv", f"{len(enabled)} of {len(targets)} enabled: "
             + (", ".join(t.slug for t in enabled) or "set enabled to yes on the rows you want"))
        known = {t.slug for t in targets}
        used = {r.get("target") for name in ("contacts.csv", "campaigns.csv", "enrolled.csv")
                for r in read_csv(data_dir() / name)} - {"", None}
        for slug in sorted(used - known):
            line(False, "targets.csv", f"{slug!r} has contacts or a sequence but no row in targets.csv; restore its "
                                       "slug column so it is not treated as a new target")
    except ConfigError as exc:
        line(False, "targets.csv", str(exc))
    try:
        profile = load_profile()
        modes = {t.track: ("link" if profile.resume_is_link(t.track) else "attach in Apollo") for t in enabled}
        line(True, "profile.md", f"{profile.name}; resume: " + (", ".join(f"{k} {v}" for k, v in modes.items()) or "-"))
        from lint import check_fixed_lines

        for v in check_fixed_lines(profile.fixed_lines(), banned_topics=profile.banned_topics,
                                   graduation=profile.graduation_years, strict=profile.strict_punctuation):
            line(False, "profile.md", str(v))
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
            line(bool(schedules), "Apollo sequences API", f"{len(schedules)} send schedule(s)"
                 + ("" if any(s.get("default") for s in schedules) else "; mark one schedule default in Apollo"))
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
    import draft

    targets = pick_targets(load_targets(), args.target)
    profile = load_profile()
    llm = draft.LLM()
    (data_dir() / "sequences").mkdir(exist_ok=True)
    failed = []
    for target in targets:
        path = seq_path(target.slug)
        if path.exists() and not args.redo:
            print(f"[draft] {target.slug}: {path.name} exists (use --redo to rewrite it)")
            continue
        try:
            print(f"[draft] {target.slug}: researching {target.company}...")
            found = draft.research(llm, target, profile, today=date.today(),
                                   depth="deep" if getattr(args, "deep", False) else "light")
            print(f"[draft] {target.slug}: {len(found.data['facts'])} verified fact(s), {len(found.dropped)} dropped; "
                  "writing...")
            seq, problems = draft.write(llm, target, profile, found)
        except Exception as exc:  # one company failing (refusal, API error) must not stop the others
            failed.append(target.slug)
            print(f"[draft] {target.slug}: skipped: {str(exc)[:300]}")
            continue
        seq.notes = draft.research_notes(found)
        path.write_text(render_md(seq, title=f"Sequence: {target.company}, {target.role}",
                                  header_lines=draft.header_lines(target, found, problems)))
        flags = [line.split(":")[0] for line in draft.header_lines(target, found, problems)
                 if line.startswith(draft.BLOCKING_MARKERS)]
        print(f"[draft] {target.slug}: wrote {path}"
              + (f" with {len(problems)} style issue(s) to fix" if problems else "")
              + (f"; review needed: {', '.join(flags)}" if flags else ""))
    print(f"Claude usage this run: about ${llm.cost():.2f}")
    if failed:
        print(f"Not drafted: {', '.join(failed)}. Run draft again for them.")
    return 1 if failed else 0


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
    try:
        gate(problems, force=args.force, name=f"{seq_path(target.slug).name} has issues")
    except Blocked as exc:
        print(exc)
        return 1
    a = apollo()
    attach_mode = not profile.resume_is_link(target.track)
    existing = campaign_for(target.slug)
    before = (attachment_counts(a, existing) or [0])[0] if existing and attach_mode else 0
    if args.activate and attach_mode and not before and not args.resume_attached:
        print("Attach mode: email 1 must carry your resume before the sequence is turned on. Push the copy without "
              "--activate, attach the PDF in Apollo, then use `launch` (or pass --resume-attached).")
        return 1
    if existing and args.activate:
        detail = a.campaign(existing)
        camp = detail.get("emailer_campaign") or {}
        if not camp.get("active") and enrolled_count(target.slug):
            if not confirm(f"This sequence is paused in Apollo with {enrolled_count(target.slug)} people enrolled; "
                           "activating resumes their emails.", assume_yes=args.yes):
                print("Nothing changed.")
                return 1
    cid, active, steps = sync_sequence(a, seq, name=campaign_name(target), campaign_id=existing,
                                       activate=args.activate, max_per_day=args.max_per_day,
                                       on_created=lambda new_id: remember(target, new_id, None))
    remember(target, cid, seq_path(target.slug))
    print(f"Sequence {cid} {'active' if active else 'paused'}: {campaign_name(target)}")
    for s in steps:
        print(f"  email {s.position}: wait {s.wait}d, subject {s.subject!r}, {s.body_chars} chars, {s.attachments} attachment(s)")
    if attach_mode and steps and not steps[0].attachments:
        resume_file = profile.resume_file(target.track) or f"your {target.track} resume PDF"
        print(f"Attach {resume_file} to email 1 in Apollo ({APOLLO_SEQUENCES_URL}) before anyone is enrolled.")
    if before and steps and steps[0].attachments < before:
        print("WARNING: email 1 had an attachment before this update and Apollo no longer reports it. "
              "Re-attach your resume in Apollo before enrolling anyone.")
    return 0


def enrolled_count(slug: str) -> int:
    return sum(1 for r in read_csv(data_dir() / "enrolled.csv") if r.get("target") == slug and r.get("status") == "enrolled")


def cmd_launch(args) -> int:
    target = pick_targets(load_targets(), args.target)[0]
    profile = load_profile()
    path = seq_path(target.slug)
    a = apollo()
    attach_mode = not profile.resume_is_link(target.track)
    try:
        seq, rows, box, cid = preflight(a, target, profile, args, need_campaign=False)
        if attach_mode:
            never_filled = cid is not None and not campaign_row(target.slug).get("copy_hash")
            if cid is None or never_filled:  # never_filled: an earlier push failed after the sequence was created
                cid, _active, _ = sync_sequence(a, seq, name=campaign_name(target), campaign_id=cid, activate=False,
                                                max_per_day=args.max_per_day,
                                                on_created=lambda new_id: remember(target, new_id, None))
                remember(target, cid, path)
                resume_file = profile.resume_file(target.track) or f"your {target.track} resume PDF"
                print(f"Created the sequence in Apollo, paused: {campaign_name(target)}\n"
                      f"Two clicks in Apollo, then run this command again:\n"
                      f"  1. {APOLLO_SEQUENCES_URL} > open it > email 1 > edit > attach {resume_file} > save\n"
                      f"  2. Turn the sequence on (Activate)\n"
                      f"Nothing is sent until you run launch again and type yes.")
                return 0
            attach_guard(a, cid, args)
        elif cid:
            camp = a.campaign(cid).get("emailer_campaign") or {}
            if not camp.get("active") and enrolled_count(target.slug):
                raise Blocked(f"The sequence is paused in Apollo with {enrolled_count(target.slug)} people already "
                              "enrolled. Unpause it in Apollo yourself if you want their emails to resume, then run "
                              "launch again.")
    except Blocked as exc:
        print(exc)
        return 1
    show_plan(target, seq, rows, box)
    question = (f"Apollo will start emailing these {len(rows)} people from {box['email']} on its send schedule, "
                "and stops for anyone who replies.")
    if not confirm(question, assume_yes=args.yes):
        print("Nothing was sent.")
        return 1
    if not attach_mode:
        cid, active, _ = sync_sequence(a, seq, name=campaign_name(target), campaign_id=cid, activate=True,
                                       max_per_day=args.max_per_day,
                                       on_created=lambda new_id: remember(target, new_id, None))
        remember(target, cid, path)
        if not active:
            print("Apollo did not turn the sequence on; check it in Apollo. Nothing was sent.")
            return 1
    result = enroll(a, slug=target.slug, campaign_id=cid, rows=rows, mailbox_id=box["id"])
    print(f"Enrolled {len(result.enrolled)}, skipped {len(result.skipped)}. Apollo sends on its schedule; "
          "check progress with: python3 outbound.py stats")
    return 0


def cmd_enroll(args) -> int:
    target = pick_targets(load_targets(), args.target)[0]
    profile = load_profile()
    a = apollo()
    try:
        seq, rows, box, cid = preflight(a, target, profile, args, need_campaign=True)
        rows = rows[: args.max]
        camp = a.campaign(cid).get("emailer_campaign") or {}
        if not profile.resume_is_link(target.track):
            attach_guard(a, cid, args)
        elif not camp.get("active"):
            print("Note: the sequence is paused in Apollo; these people get emails once you turn it on.")
    except Blocked as exc:
        print(exc)
        return 1
    if args.dry_run:
        for r in rows:
            print(f"[dry-run] would enroll {r['name']} <{r['email']}>")
        return 0
    show_plan(target, seq, rows, box)
    if not confirm(f"Enroll these {len(rows)} people into the Apollo sequence?", assume_yes=args.yes):
        print("Nothing was enrolled.")
        return 1
    result = enroll(a, slug=target.slug, campaign_id=cid, rows=rows, mailbox_id=box["id"])
    print(f"Enrolled {len(result.enrolled)}, skipped {len(result.skipped)}.")
    return 0


def cmd_stats(args) -> int:
    rows = read_csv(data_dir() / "campaigns.csv")
    if not rows:
        print("No sequences yet.")
        return 0
    a = apollo()
    for r in rows:
        s = stats(a, r["campaign_id"])
        extra = ", ".join(f"{k} {v}" for k, v in s.items() if k not in ("name", "active"))
        print(f"{r['target']}: {'active' if s.get('active') else 'paused'}, {enrolled_count(r['target'])} enrolled"
              + (f", {extra}" if extra else ""))
    unknown = [r for r in read_csv(data_dir() / "enrolled.csv") if r.get("status") == "enroll_unknown"]
    if unknown:
        print(f"{len(unknown)} enrollment(s) have an unknown outcome (Apollo failed mid-request); check them in Apollo: "
              + ", ".join(r["email"] for r in unknown))
    return 0


def cmd_run(args) -> int:
    targets = pick_targets(load_targets(), args.target)
    if not targets:
        print("No enabled targets in targets.csv.")
        return 1
    cmd_hunt(args)
    cmd_cut(args)
    args.redo = False
    draft_status = cmd_draft(args)
    profile = load_profile()
    print("\nNext:")
    for t in targets:
        try:
            _seq, problems = lint_target(t, profile)
        except (ConfigError, ValueError) as exc:
            print(f"  {t.slug}: {exc}")
            continue
        n = len(pending_batch(t.slug))
        state = "copy clean" if not problems else f"{len(problems)} issue(s), run lint"
        print(f"  {t.slug}: {n} recruiter(s) ready, {state}. Read sequences/{t.slug}.md, then: "
              f"python3 outbound.py launch --target {t.slug}")
    return draft_status


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

MUTATING = {"hunt", "cut", "run", "draft", "create", "launch", "enroll"}


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
        if name == "run":
            sp.add_argument("--deep", action="store_true", help="twice the research (and about twice the cost)")
        if name != "cut":
            sp.add_argument("--max", type=int, default=10, help="max reveals this run, 1 credit each (default 10)")
    d = add("draft", cmd_draft, "research with Claude and write sequences/<target>.md", target=True)
    d.add_argument("--redo", action="store_true")
    d.add_argument("--deep", action="store_true", help="twice the research (and about twice the cost)")
    add("lint", cmd_lint, "style-check sequences/<target>.md", target=True)
    cr = add("create", cmd_create, "push the copy to an Apollo sequence (paused unless --activate)", target=True,
             target_required=True)
    cr.add_argument("--activate", action="store_true")
    cr.add_argument("--force", action="store_true", help="push despite style issues (never resume or review checks)")
    cr.add_argument("--yes", action="store_true")
    cr.add_argument("--resume-attached", action="store_true", help="you checked email 1 has your resume in Apollo")
    cr.add_argument("--max-per-day", type=int, default=10)
    for name, func, text in (("launch", cmd_launch, "the one confirm: push, activate and enroll a target"),
                             ("enroll", cmd_enroll, "enroll new batch contacts into an existing sequence")):
        sp = add(name, func, text, target=True, target_required=True)
        sp.add_argument("--mailbox")
        sp.add_argument("--yes", action="store_true", help="skip the final typed confirmation (never the resume check)")
        sp.add_argument("--resume-attached", action="store_true", help="you checked email 1 has your resume in Apollo")
        sp.add_argument("--force", action="store_true", help="go ahead despite style issues (never resume or review checks)")
        if name == "launch":
            sp.add_argument("--max-per-day", type=int, default=10)
        else:
            sp.add_argument("--max", type=int, default=25)
            sp.add_argument("--dry-run", action="store_true")
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
        if args.command in MUTATING:
            for slug in pin_slugs():
                print(f"(pinned slug {slug} in targets.csv so later edits to the role text keep this target)")
        return args.func(args)
    except (ConfigError, ApolloError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
