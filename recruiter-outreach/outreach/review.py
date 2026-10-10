"""Local HTML review page: every pending email with its research, sources, and style-check result."""
from __future__ import annotations

import html
import json
from pathlib import Path

from .db import DB

STYLE = """
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#78716c; --card:#fff; --line:#e7e5e4; --warn:#b45309; --bad:#b91c1c; --ok:#15803d; }
@media (prefers-color-scheme: dark) { :root { --bg:#1c1917; --fg:#f5f5f4; --muted:#a8a29e; --card:#292524; --line:#44403c; --warn:#f59e0b; --bad:#f87171; --ok:#4ade80; } }
body { background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system, system-ui, sans-serif; margin:0; padding:24px 16px; }
main { max-width:860px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; } .sub { color:var(--muted); margin-bottom:24px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:0 0 18px; }
.head { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:baseline; }
.id { font-weight:700; } .who { color:var(--muted); }
.pill { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); }
.pill.needs_attention, .pill.failed { color:var(--bad); border-color:var(--bad); }
.pill.draft { color:var(--warn); border-color:var(--warn); } .pill.approved { color:var(--ok); border-color:var(--ok); }
.subject { font-weight:600; margin:10px 0 6px; }
pre { white-space:pre-wrap; font:14px/1.55 ui-monospace, Menlo, monospace; background:var(--bg); border-radius:8px; padding:12px; margin:0; overflow-wrap:anywhere; }
details { margin-top:10px; } summary { cursor:pointer; color:var(--muted); }
ul { margin:6px 0; padding-left:20px; } li { margin:3px 0; } a { color:inherit; }
.bad { color:var(--bad); } .warn { color:var(--warn); }
code { font:13px ui-monospace, Menlo, monospace; }
"""


def _e(value) -> str:
    return html.escape(str(value or ""))


def build_review_page(db: DB, out_path: Path, *, statuses=("needs_attention", "draft", "approved")) -> Path:
    cards = []
    msgs = db.messages(status=list(statuses))
    for msg in msgs:
        contact = db.contact(msg["contact_id"])
        target = db.target(contact["target_id"])
        research = db.research(target["id"]) or {"data": {}, "dropped": []}
        meta = json.loads(msg["meta_json"])
        lint = json.loads(msg["lint_json"])
        used = set(meta.get("fact_urls_used", []))
        facts = "".join(
            f"<li>{'<b>' if f['source_url'] in used else ''}{_e(f['fact'])}{'</b>' if f['source_url'] in used else ''} "
            f"<span class='who'>({_e(f['published'])}, <a href='{_e(f['source_url'])}' target='_blank'>"
            f"{_e(f.get('source_title') or f['source_url'])}</a>)</span></li>"
            for f in research["data"].get("facts", [])
        ) or "<li>none</li>"
        dropped = "".join(f"<li>{_e(d.get('fact'))} <span class='who'>({_e(d.get('reason'))})</span></li>"
                          for d in research.get("dropped", []))
        flags = "".join(f"<li class='warn'>{_e(f)}</li>" for f in meta.get("eligibility_flags", []))
        lint_html = "".join(f"<li class='bad'>{_e(v['rule'])}: {_e(v['detail'])}</li>" for v in lint)
        hold = f"<div class='warn'>{_e(msg['error'])}</div>" if msg["error"] else ""
        cards.append(f"""
<section class="card">
  <div class="head">
    <span class="id">#{msg['id']}</span>
    <span>{_e(target['company'])}, {_e(target['role'])}</span>
    <span class="pill {msg['status']}">{_e(msg['status'])}</span>
    <span class="pill">{_e(msg['kind'])}</span>
  </div>
  <div class="who">To {_e(contact['first_name'])} {_e(contact['last_name'])}, {_e(contact['title'])} &lt;{_e(contact['email'])}&gt;
    &middot; email {_e(contact['email_status'])} &middot; {_e(contact['source'])}</div>
  {hold}
  {f"<ul>{lint_html}</ul>" if lint_html else ""}
  {f"<div class='warn'>Eligibility flags from research:</div><ul>{flags}</ul>" if flags else ""}
  <div class="subject">{_e(msg['subject'])}</div>
  <pre>{_e(msg['body'])}</pre>
  <div class="who">Attachment: <code>{_e(msg['attachment'])}</code></div>
  <details><summary>Research ({len(research['data'].get('facts', []))} verified facts)</summary>
    <p>{_e(research['data'].get('company_summary'))}</p>
    <p>{_e(research['data'].get('team_focus'))}</p>
    <ul>{facts}</ul>
    {f"<div class='who'>Dropped by verification:</div><ul>{dropped}</ul>" if dropped else ""}
  </details>
  <details><summary>Commands</summary>
    <pre>outreach approve {msg['id']}
outreach edit {msg['id']}
outreach reject {msg['id']} --reason "..."</pre>
  </details>
</section>""")
    body = "".join(cards) or "<p class='sub'>Nothing waiting for review.</p>"
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Outreach review</title><style>{STYLE}</style></head>
<body><main>
<h1>Outreach review</h1>
<div class="sub">{len(msgs)} email(s). Bold facts are the ones the email uses. Approve all clean drafts with
<code>outreach approve --all-clean</code>.</div>
{body}
</main></body></html>"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(page)
    return out_path
