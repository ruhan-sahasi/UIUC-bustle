"""Command line entry point: `outreach <command>` (or `python -m outreach <command>`)."""
from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

from .config import DEFAULT_CONFIG_DIR, ROOT, ConfigError, load_all
from .db import DB
from .lint import expand_contractions, lint_email, lint_plain
from .mailer import AuthFailed
from .pipeline import Pipeline
from .review import build_review_page
from .timeutil import in_send_window, next_window_start


def _pipeline(args, *, dry_run: bool = False) -> Pipeline:
    app = load_all(args.config_dir, args.data_dir)
    db = DB(app.data_dir / "outreach.db")
    return Pipeline(app, db, dry_run=dry_run)


def _review(p: Pipeline, open_browser: bool = False) -> Path:
    path = build_review_page(p.db, p.app.data_dir / "review.html")
    if open_browser:
        webbrowser.open(path.resolve().as_uri())
    return path


def _table(rows: list[dict], cols: list[str]) -> str:
    if not rows:
        return "(none)"
    widths = {c: max(len(c), *(len(str(r.get(c, ""))) for r in rows)) for c in cols}
    widths = {c: min(w, 48) for c, w in widths.items()}
    line = lambda r: "  ".join(str(r.get(c, ""))[: widths[c]].ljust(widths[c]) for c in cols)  # noqa: E731
    return "\n".join([line({c: c for c in cols}), line({c: "-" * widths[c] for c in cols}), *map(line, rows)])


# ---------------------------------------------------------------------------- commands


def cmd_init(args) -> int:
    config_dir = Path(args.config_dir or DEFAULT_CONFIG_DIR)
    for example in sorted(config_dir.glob("*.example.yaml")):
        real = example.with_name(example.name.replace(".example", ""))
        if real.exists():
            print(f"keep    {real}")
        else:
            shutil.copy(example, real)
            print(f"created {real}")
    env, env_example = config_dir.parent / ".env", ROOT / ".env.example"
    if not env.exists() and env_example.exists():
        shutil.copy(env_example, env)
        print(f"created {env}")
    print("Next: fill in config/profile.yaml, config/targets.yaml, config/settings.yaml and .env, then run `outreach check`.")
    return 0


def cmd_check(args) -> int:
    ok = True

    def report(passed: bool, label: str, detail: str = "") -> None:
        nonlocal ok
        ok = ok and passed
        print(f"[{'ok' if passed else 'FAIL'}] {label}{': ' + detail if detail else ''}")

    try:
        app = load_all(args.config_dir, args.data_dir)
    except (ConfigError, ValueError) as exc:
        report(False, "config", str(exc))
        return 1
    s, prof = app.settings, app.profile
    report(True, "config", f"{len(app.targets)} targets ({sum(t.enabled for t in app.targets)} enabled), mode={s.mode}, delivery={s.delivery}")
    for track in sorted({t.track for t in app.targets if t.enabled} | set(prof.resumes)):
        if track == "default" and "default" not in prof.resumes:
            continue
        try:
            path = prof.resume_for(track)
            good = path.exists() and path.read_bytes()[:4] == b"%PDF"
            report(good, f"resume[{track}]", str(path) if good else f"missing or not a PDF: {path}")
        except ConfigError as exc:
            report(False, f"resume[{track}]", str(exc))
    for t in app.targets:
        if t.enabled and t.resume:
            path = Path(t.resume).expanduser()
            report(path.exists(), f"resume override for {t.slug}", str(path))
        if t.enabled and not t.domain:
            report(False, f"target {t.slug}", "no domain (Apollo will try to resolve it, but setting it is safer)")
    problems = lint_plain(prof.followup_template, prof.style, allowed=[])
    report(not problems, "follow-up template style", "; ".join(p.detail for p in problems))
    report(bool(s.apollo.api_key), "APOLLO_API_KEY", "" if s.apollo.api_key else f"set {s.apollo.api_key_env} in .env")
    has_claude = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    report(has_claude, "ANTHROPIC_API_KEY", "" if has_claude else "set ANTHROPIC_API_KEY in .env")
    if s.delivery in ("smtp", "drafts"):
        report(bool(s.sender.password), s.sender.password_env,
               "" if s.sender.password else "mailbox app password missing")
    if not args.offline:
        p = Pipeline(app, DB(app.data_dir / "outreach.db"))
        if s.apollo.api_key:
            try:
                health = p.apollo.health()
                report(bool(health.get("is_logged_in", True)), "Apollo API", json.dumps(health)[:120])
            except Exception as exc:
                report(False, "Apollo API", str(exc))
        if has_claude:
            try:
                import anthropic

                model = anthropic.Anthropic().models.retrieve(s.llm.model)
                report(True, "Claude API", f"model {model.id} available")
            except Exception as exc:
                report(False, "Claude API", str(exc))
        if s.delivery != "file":
            try:
                p.transport.check()
                report(True, f"mailbox ({s.delivery})", f"logged in as {s.sender.username}")
            except Exception as exc:
                report(False, f"mailbox ({s.delivery})", str(exc))
    print("All checks passed." if ok else "Fix the FAIL lines above before running.")
    return 0 if ok else 1


def _print_report(p: Pipeline) -> None:
    for line in p.report.lines():
        print(line)


def cmd_run(args) -> int:
    p = _pipeline(args, dry_run=args.dry_run)
    try:
        p.run(send=not args.no_send, force_window=args.now)
    except AuthFailed as exc:
        print(f"Stopped: {exc}", file=sys.stderr)
        return 2
    path = _review(p)
    _print_report(p)
    waiting = len(p.db.messages(status=["draft", "needs_attention"]))
    if waiting:
        print(f"{waiting} email(s) waiting for review: {path}  (outreach review --open)")
    return 0


def cmd_discover(args) -> int:
    p = _pipeline(args)
    p.sync_targets()
    p.discover(slug=args.target, retry=args.retry)
    _print_report(p)
    return 0


def cmd_research(args) -> int:
    p = _pipeline(args)
    p.sync_targets()
    p.research(slug=args.target, redo=args.redo)
    _print_report(p)
    return 0


def cmd_draft(args) -> int:
    p = _pipeline(args)
    p.sync_targets()
    p.draft(slug=args.target, redo=args.redo)
    _review(p)
    _print_report(p)
    return 0


def cmd_review(args) -> int:
    p = _pipeline(args)
    path = _review(p, open_browser=args.open)
    print(path)
    return 0


def cmd_show(args) -> int:
    p = _pipeline(args)
    msg = p.db.message(args.id)
    if not msg:
        print(f"no message #{args.id}")
        return 1
    c = p.db.contact(msg["contact_id"])
    print(f"#{msg['id']} [{msg['status']}] {msg['kind']} to {c['first_name']} {c['last_name']} <{c['email']}> ({c['title']})")
    print(f"Subject: {msg['subject']}\nAttachment: {msg['attachment']}\n")
    print(msg["body"])
    for v in json.loads(msg["lint_json"]):
        print(f"! {v['rule']}: {v['detail']}")
    if msg["error"]:
        print(f"! {msg['error']}")
    return 0


def cmd_approve(args) -> int:
    p = _pipeline(args)
    ids = p.approve(args.ids, all_clean=args.all_clean)
    print(f"approved {ids}" if ids else "nothing approved (only draft, needs_attention or failed emails can be approved)")
    return 0


def cmd_reject(args) -> int:
    p = _pipeline(args)
    print(f"rejected {p.reject(args.ids, args.reason)}")
    return 0


def cmd_edit(args) -> int:
    p = _pipeline(args)
    msg = p.db.message(args.id)
    if not msg or msg["status"] in ("sent", "cancelled"):
        print(f"message #{args.id} cannot be edited")
        return 1
    with tempfile.NamedTemporaryFile("w+", suffix=".txt", delete=False) as f:
        f.write(f"Subject: {msg['subject']}\n\n{msg['body']}")
        tmp = f.name
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR") or "nano"
    subprocess.call([editor, tmp])
    text = Path(tmp).read_text()
    os.unlink(tmp)
    first, _, body = text.partition("\n")
    subject = expand_contractions(first.removeprefix("Subject:").strip())
    body = body.lstrip("\n").rstrip() + "\n"
    if msg["kind"] == "initial":
        contact = p.db.contact(msg["contact_id"])
        target = p.db.target(contact["target_id"])
        paragraphs = _middle_paragraphs(body, p.profile.closing_lines)
        violations = lint_email(subject=subject, paragraphs=paragraphs, style=p.profile.style,
                                company=target["company"], required_opening=None)
        violations = [v for v in violations if v.rule != "facts"]
    else:
        violations = []
    status = "draft" if not violations else "needs_attention"
    p.db.update_message(args.id, subject=subject, body=body, lint_json=json.dumps([v.to_dict() for v in violations]),
                        status=status if msg["status"] != "approved" or violations else "approved")
    print(f"saved #{args.id}" + (f" with {len(violations)} style issue(s):" if violations else ""))
    for v in violations:
        print(f"! {v.rule}: {v.detail}")
    return 0


def _middle_paragraphs(body: str, closing_lines: list[str]) -> list[str]:
    blocks = [b.strip() for b in body.split("\n\n") if b.strip()]
    if blocks and blocks[0].lower().startswith(("hi ", "hello ", "dear ")):
        blocks = blocks[1:]
    marker = next((line for line in closing_lines if line.strip()), None)
    if marker:
        for i, b in enumerate(blocks):
            if b.startswith(marker):
                return blocks[:i]
    return blocks


def cmd_send(args) -> int:
    p = _pipeline(args, dry_run=args.dry_run)
    try:
        n = p.send(force_window=args.now, limit=args.limit)
    except AuthFailed as exc:
        print(f"Stopped: {exc}", file=sys.stderr)
        return 2
    _print_report(p)
    return 0 if n or not p.report.errors else 1


def cmd_followups(args) -> int:
    p = _pipeline(args)
    p.queue_followups()
    _review(p)
    _print_report(p)
    return 0


def cmd_sync(args) -> int:
    p = _pipeline(args)
    found = p.sync_inbox()
    print(json.dumps(found, indent=2) if found else "no new replies or bounces")
    return 0


def cmd_status(args) -> int:
    p = _pipeline(args)
    p.sync_targets()
    print(_table(p.status_rows(), ["slug", "discovery", "research", "contacts", "draft", "approved", "sent", "replied", "error"]))
    s = p.settings
    now = datetime.now(timezone.utc)
    sent_today = len(p.sent_today())
    window = "open now" if in_send_window(now, s.limits.send_window) else \
        f"next opens {next_window_start(now, s.limits.send_window):%a %b %d %H:%M %Z}"
    print(f"\nmode={s.mode} delivery={s.delivery} | sent today {sent_today}/{s.limits.daily_send_cap} | send window {window}")
    usage = p.db.usage_totals()
    claude = usage.get("anthropic", {})
    if claude:
        cost = ((claude.get("input_tokens", 0) + 1.25 * claude.get("cache_creation_input_tokens", 0)
                 + 0.1 * claude.get("cache_read_input_tokens", 0)) * s.llm.price_input_per_mtok
                + claude.get("output_tokens", 0) * s.llm.price_output_per_mtok) / 1e6 \
            + claude.get("web_search_requests", 0) * s.llm.price_per_web_search
        print(f"Claude: {int(claude.get('input_tokens', 0)):,} in / {int(claude.get('output_tokens', 0)):,} out tokens, "
              f"{int(claude.get('web_search_requests', 0))} searches, about ${cost:.2f} total")
    apollo = usage.get("apollo", {})
    if apollo:
        print(f"Apollo: {int(apollo.get('people', 0))} people enriched, {int(apollo.get('emails', 0))} emails revealed, "
              f"{int(apollo.get('credits_consumed', 0))} credits reported")
    return 0


def cmd_suppress(args) -> int:
    p = _pipeline(args)
    p.db.suppress(args.value, args.reason or "manual")
    contact = p.db.contact_by_email(args.value) if "@" in args.value else None
    if contact:
        p.db.update_contact(contact["id"], status="do_not_contact")
        p._cancel_pending(contact["id"], "suppressed")
    print(f"suppressed {args.value}")
    return 0


def cmd_mark(args) -> int:
    p = _pipeline(args)
    contact = p.db.contact_by_email(args.email)
    if not contact:
        print(f"no contact {args.email}")
        return 1
    p.db.update_contact(contact["id"], status=args.state)
    if args.state in ("replied", "do_not_contact", "bounced"):
        p._cancel_pending(contact["id"], f"marked {args.state}")
    print(f"{args.email} -> {args.state}")
    return 0


def cmd_export(args) -> int:
    p = _pipeline(args)
    rows = []
    for msg in p.db.messages():
        c = p.db.contact(msg["contact_id"])
        t = p.db.target(c["target_id"])
        rows.append({
            "message_id": msg["id"], "kind": msg["kind"], "status": msg["status"], "sent_at": msg["sent_at"] or "",
            "company": t["company"], "role": t["role"], "name": f"{c['first_name'] or ''} {c['last_name'] or ''}".strip(),
            "title": c["title"], "email": c["email"], "contact_status": c["status"], "subject": msg["subject"],
        })
    out = Path(args.csv) if args.csv else p.app.data_dir / "outreach_export.csv"
    with out.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else ["message_id"])
        writer.writeheader()
        writer.writerows(rows)
    print(out)
    return 0


def cmd_log(args) -> int:
    p = _pipeline(args)
    for e in reversed(p.db.events(args.n)):
        print(f"{e['ts']}  {e['kind']:<16} {e['ref'] or '':<40} {e['detail'] or ''}")
    return 0


# ---------------------------------------------------------------------------- parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="outreach", description="Recruiter outreach pipeline")
    parser.add_argument("--config-dir", type=Path, default=None, help="default: recruiter-outreach/config")
    parser.add_argument("--data-dir", type=Path, default=None, help="default: recruiter-outreach/data")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="copy example configs into place").set_defaults(func=cmd_init)
    c = sub.add_parser("check", help="validate config, keys, resumes and mailbox login")
    c.add_argument("--offline", action="store_true", help="skip network checks")
    c.set_defaults(func=cmd_check)

    r = sub.add_parser("run", help="the daily job: sync, discover, research, draft, follow-ups, send")
    r.add_argument("--no-send", action="store_true", help="stop before sending")
    r.add_argument("--now", action="store_true", help="ignore the send window")
    r.add_argument("--dry-run", action="store_true", help="write .eml files to data/outbox instead of sending")
    r.set_defaults(func=cmd_run)

    for name, func, flag, help_text in (
        ("discover", cmd_discover, "--retry", "find recruiter emails with Apollo"),
        ("research", cmd_research, "--redo", "research each company with Claude"),
        ("draft", cmd_draft, "--redo", "write emails for contacts that have none"),
    ):
        sp = sub.add_parser(name, help=help_text)
        sp.add_argument("--target", help="only this target slug")
        sp.add_argument(flag, action="store_true")
        sp.set_defaults(func=func)

    rv = sub.add_parser("review", help="build the HTML review page")
    rv.add_argument("--open", action="store_true")
    rv.set_defaults(func=cmd_review)

    sh = sub.add_parser("show", help="print one email")
    sh.add_argument("id", type=int)
    sh.set_defaults(func=cmd_show)

    ap = sub.add_parser("approve", help="approve emails for sending")
    ap.add_argument("ids", type=int, nargs="*")
    ap.add_argument("--all-clean", action="store_true", help="approve every draft that passed the style check")
    ap.set_defaults(func=cmd_approve)

    rj = sub.add_parser("reject", help="never send these emails")
    rj.add_argument("ids", type=int, nargs="+")
    rj.add_argument("--reason", default="")
    rj.set_defaults(func=cmd_reject)

    ed = sub.add_parser("edit", help="edit an email in $EDITOR and re-check it")
    ed.add_argument("id", type=int)
    ed.set_defaults(func=cmd_edit)

    se = sub.add_parser("send", help="send approved emails within caps and the send window")
    se.add_argument("--now", action="store_true", help="ignore the send window")
    se.add_argument("--dry-run", action="store_true")
    se.add_argument("--limit", type=int)
    se.set_defaults(func=cmd_send)

    sub.add_parser("followups", help="queue follow-ups that are due").set_defaults(func=cmd_followups)
    sub.add_parser("sync", help="scan the inbox for replies and bounces").set_defaults(func=cmd_sync)
    sub.add_parser("status", help="per-company progress, caps and spend").set_defaults(func=cmd_status)

    su = sub.add_parser("suppress", help="never email this address or domain")
    su.add_argument("value")
    su.add_argument("--reason", default="")
    su.set_defaults(func=cmd_suppress)

    mk = sub.add_parser("mark", help="set a contact state by hand")
    mk.add_argument("email")
    mk.add_argument("state", choices=["replied", "do_not_contact", "contacted", "bounced"])
    mk.set_defaults(func=cmd_mark)

    ex = sub.add_parser("export", help="write a CSV ledger of every email")
    ex.add_argument("--csv")
    ex.set_defaults(func=cmd_export)

    lg = sub.add_parser("log", help="recent pipeline events")
    lg.add_argument("-n", type=int, default=40)
    lg.set_defaults(func=cmd_log)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
