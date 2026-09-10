"""Alembic env guard: an empty DATABASE_URL must abort migrations, not skip them.

Pre-fix, alembic/env.py called sys.exit(0) when DATABASE_URL was empty, so
`alembic upgrade head` reported success without running any migrations — the
app would boot against an unmigrated database. The guard must exit nonzero.
"""

import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def test_empty_database_url_exits_nonzero():
    env = dict(os.environ)
    env["DATABASE_URL"] = ""
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode != 0, (
        "alembic upgrade head exited 0 with an empty DATABASE_URL — "
        "migrations were silently skipped"
    )
    assert "DATABASE_URL is not set" in (result.stderr + result.stdout)
