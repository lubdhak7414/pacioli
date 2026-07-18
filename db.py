"""SQLite database for proposal state management and chat history."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

import aiosqlite

from config import DB_PATH

logger = logging.getLogger(__name__)

INIT_SQL = """
CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content     TEXT NOT NULL,
    proposal_id INTEGER,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proposal_id) REFERENCES proposals(id)
);

CREATE TABLE IF NOT EXISTS proposals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','approved','rejected','executed','failed')),
    user_message     TEXT NOT NULL,
    ai_reasoning     TEXT,
    actions_json     TEXT NOT NULL,
    validation_notes TEXT,
    executed_at      TIMESTAMP,
    rejected_at      TIMESTAMP,
    error_message    TEXT,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    snapshot    BLOB NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proposal_id) REFERENCES proposals(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id  INTEGER NOT NULL,
    action_index INTEGER NOT NULL,
    sheet        TEXT NOT NULL,
    cell_ref     TEXT,
    old_value    TEXT,
    new_value    TEXT,
    executed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


@asynccontextmanager
async def _conn():
    """Open a connection with a Row factory, commit on clean exit, always close.

    Centralizes the open/row_factory/commit/close dance every query repeated.
    """
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    try:
        yield db
        await db.commit()
    finally:
        await db.close()


async def init_db():
    async with _conn() as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.executescript(INIT_SQL)


async def insert_chat_message(role: str, content: str,
                              proposal_id: Optional[int] = None) -> int:
    async with _conn() as db:
        cursor = await db.execute(
            "INSERT INTO chat_messages (role, content, proposal_id) VALUES (?, ?, ?)",
            (role, content, proposal_id),
        )
        return cursor.lastrowid


async def get_chat_history(limit: int = 20) -> list[dict]:
    async with _conn() as db:
        cursor = await db.execute(
            "SELECT role, content, proposal_id FROM chat_messages ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in reversed(rows)]


async def create_proposal(user_message: str, ai_reasoning: str,
                          actions: list[dict],
                          validation_notes: Optional[list[str]] = None) -> int:
    async with _conn() as db:
        cursor = await db.execute(
            """INSERT INTO proposals
               (status, user_message, ai_reasoning, actions_json, validation_notes)
               VALUES ('pending', ?, ?, ?, ?)""",
            (user_message, ai_reasoning, json.dumps(actions),
             json.dumps(validation_notes or [])),
        )
        return cursor.lastrowid


async def get_proposal(proposal_id: int) -> Optional[dict]:
    async with _conn() as db:
        cursor = await db.execute(
            "SELECT * FROM proposals WHERE id = ?", (proposal_id,)
        )
        row = await cursor.fetchone()
        if row:
            d = dict(row)
            d["actions"] = json.loads(d["actions_json"])
            return d
        return None


async def get_proposals(limit: int = 10, offset: int = 0) -> tuple[list[dict], int]:
    """Return recent proposals for the history panel with pagination.

    Returns (proposals, total_count).
    """
    async with _conn() as db:
        # Get total count
        cursor = await db.execute("SELECT COUNT(*) FROM proposals")
        total = (await cursor.fetchone())[0]
        # Get page
        cursor = await db.execute(
            """SELECT id, status, user_message, ai_reasoning, created_at
               FROM proposals ORDER BY id DESC LIMIT ? OFFSET ?""",
            (limit, offset),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows], total


async def approve_proposal_atomic(proposal_id: int) -> bool:
    """Atomically transition pending -> executed. Returns True if the update succeeded."""
    async with _conn() as db:
        cursor = await db.execute(
            """UPDATE proposals SET status = 'executed', executed_at = ?
               WHERE id = ? AND status = 'pending'""",
            (datetime.utcnow().isoformat(), proposal_id),
        )
        return cursor.rowcount > 0


async def update_proposal_status(proposal_id: int, status: str,
                                  error_message: Optional[str] = None):
    async with _conn() as db:
        timestamp_col = "executed_at" if status == "executed" else "rejected_at"
        await db.execute(
            f"""UPDATE proposals
                SET status = ?, {timestamp_col} = ?, error_message = ?
                WHERE id = ?""",
            (status, datetime.utcnow().isoformat(), error_message, proposal_id),
        )


async def reset_proposal_pending(proposal_id: int):
    """Return a proposal to 'pending' so it can be retried (e.g. after a lock timeout)."""
    async with _conn() as db:
        await db.execute(
            "UPDATE proposals SET status = 'pending', executed_at = NULL WHERE id = ?",
            (proposal_id,),
        )


async def get_snapshot(proposal_id: int) -> Optional[bytes]:
    """Return the most recent ledger snapshot stored for a proposal, if any."""
    async with _conn() as db:
        cursor = await db.execute(
            """SELECT snapshot FROM ledger_snapshots
               WHERE proposal_id = ? ORDER BY id DESC LIMIT 1""",
            (proposal_id,),
        )
        row = await cursor.fetchone()
        return row[0] if row else None


async def save_snapshot(proposal_id: int, snapshot_bytes: bytes):
    async with _conn() as db:
        await db.execute(
            "INSERT INTO ledger_snapshots (proposal_id, snapshot) VALUES (?, ?)",
            (proposal_id, snapshot_bytes),
        )


async def insert_audit_log(proposal_id: int, action_index: int, sheet: str,
                            cell_ref: Optional[str], old_value, new_value):
    async with _conn() as db:
        await db.execute(
            """INSERT INTO audit_log
               (proposal_id, action_index, sheet, cell_ref, old_value, new_value)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                proposal_id, action_index, sheet, cell_ref,
                str(old_value) if old_value is not None else None,
                str(new_value) if new_value is not None else None,
            ),
        )


async def _reject_stale_proposals() -> int:
    """Reject proposals pending for longer than the configured timeout. Returns count rejected."""
    from config import PROPOSAL_TIMEOUT_MINUTES
    async with _conn() as db:
        cursor = await db.execute(
            """UPDATE proposals
               SET status = 'rejected', rejected_at = ?,
                   error_message = ?
               WHERE status = 'pending'
                 AND replace(created_at, 'T', ' ') < datetime('now', ?)""",
            (
                datetime.utcnow().isoformat(),
                f"Expired: pending for more than {PROPOSAL_TIMEOUT_MINUTES} minutes",
                f"-{PROPOSAL_TIMEOUT_MINUTES} minutes",
            ),
        )
        return cursor.rowcount


async def cleanup_stale_proposals():
    """Background task: auto-reject proposals pending for longer than configured timeout."""
    while True:
        try:
            count = await _reject_stale_proposals()
            if count > 0:
                logger.info("Cleaned up %d stale proposal(s).", count)
        except Exception as e:
            logger.error("Stale-proposal cleanup error: %s", e)
        await asyncio.sleep(300)
