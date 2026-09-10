"""Add edit_token to shared_trips (separate edit capability from the public read token)

The public token in the share URL must only grant read access; updating the
trip (or ending it via phase="arrived") requires this second secret, returned
once to the creator and never rendered on the share page. NULL edit_token
(legacy rows) means the trip can no longer be patched.

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-08
"""
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE shared_trips ADD COLUMN edit_token TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE shared_trips DROP COLUMN IF EXISTS edit_token")
