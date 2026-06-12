"""SQLite database for proposal state management and chat history."""

import asyncio
import json
import logging
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


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.executescript(INIT_SQL)
        await db.commit()


async def insert_chat_message(role: str, content: str,
                              proposal_id: Optional[int] = None) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO chat_messages (role, content, proposal_id) VALUES (?, ?, ?)",
            (role, content, proposal_id),
        )
        await db.commit()
        return cursor.lastrowid


async def get_chat_history(limit: int = 20) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT role, content, proposal_id FROM chat_messages ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in reversed(rows)]


async def create_proposal(user_message: str, ai_reasoning: str,
                          actions: list[dict],
                          validation_notes: Optional[list[str]] = None) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """INSERT INTO proposals
               (status, user_message, ai_reasoning, actions_json, validation_notes)
               VALUES ('pending', ?, ?, ?, ?)""",
            (user_message, ai_reasoning, json.dumps(actions),
             json.dumps(validation_notes or [])),
        )
        await db.commit()
        return cursor.lastrowid


async def get_proposal(proposal_id: int) -> Optional[dict]:
    assert isinstance(proposal_id, int)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM proposals WHERE id = ?", (proposal_id,)
        )
        row = await cursor.fetchone()
        if row:
            d = dict(row)
            d["actions"] = json.loads(d["actions_json"])
            return d
        return None


async def get_proposals(limit: int = 10) -> list[dict]:
    """Return recent proposals for the history panel."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """SELECT id, status, user_message, ai_reasoning, created_at
               FROM proposals ORDER BY id DESC LIMIT ?""",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def approve_proposal_atomic(proposal_id: int) -> bool:
    """Atomically transition pending -> executed. Returns True if the update succeeded."""
    assert isinstance(proposal_id, int)
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """UPDATE proposals SET status = 'executed', executed_at = ?
               WHERE id = ? AND status = 'pending'""",
            (datetime.utcnow().isoformat(), proposal_id),
        )
        await db.commit()
        return cursor.rowcount > 0


async def update_proposal_status(proposal_id: int, status: str,
                                  error_message: Optional[str] = None):
    assert isinstance(proposal_id, int)
    async with aiosqlite.connect(DB_PATH) as db:
        timestamp_col = "executed_at" if status == "executed" else "rejected_at"
        await db.execute(
            f"""UPDATE proposals
                SET status = ?, {timestamp_col} = ?, error_message = ?
                WHERE id = ?""",
            (status, datetime.utcnow().isoformat(), error_message, proposal_id),
        )
        await db.commit()


async def get_snapshot(proposal_id: int) -> Optional[bytes]:
    """Return the most recent ledger snapshot stored for a proposal, if any."""
    assert isinstance(proposal_id, int)
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """SELECT snapshot FROM ledger_snapshots
               WHERE proposal_id = ? ORDER BY id DESC LIMIT 1""",
            (proposal_id,),
        )
        row = await cursor.fetchone()
        return row[0] if row else None


async def save_snapshot(proposal_id: int, snapshot_bytes: bytes):
    assert isinstance(proposal_id, int)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO ledger_snapshots (proposal_id, snapshot) VALUES (?, ?)",
            (proposal_id, snapshot_bytes),
        )
        await db.commit()


async def insert_audit_log(proposal_id: int, action_index: int, sheet: str,
                            cell_ref: Optional[str], old_value, new_value):
    async with aiosqlite.connect(DB_PATH) as db:
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
        await db.commit()


async def cleanup_stale_proposals():
    """Background task: auto-reject proposals pending for more than 15 minutes."""
    while True:
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                cursor = await db.execute(
                    """UPDATE proposals
                       SET status = 'rejected', rejected_at = ?,
                           error_message = 'Expired: pending for more than 15 minutes'
                       WHERE status = 'pending'
                         AND created_at < datetime('now', '-15 minutes')""",
                    (datetime.utcnow().isoformat(),),
                )
                if cursor.rowcount > 0:
                    logger.info("Cleaned up %d stale proposal(s).", cursor.rowcount)
                await db.commit()
        except Exception as e:
            logger.error("Stale-proposal cleanup error: %s", e)
        await asyncio.sleep(300)  # every 5 minutes
