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

-- ── Personal bookkeeping tables ─────────────────────────────

CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    type        TEXT NOT NULL CHECK(type IN ('checking','savings','credit','cash','investment')),
    currency    TEXT DEFAULT 'USD',
    is_active   INTEGER DEFAULT 1,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    parent_id   INTEGER REFERENCES categories(id),
    icon        TEXT DEFAULT '',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, parent_id)
);

CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id     INTEGER,
    account_id      INTEGER REFERENCES accounts(id),
    category_id     INTEGER REFERENCES categories(id),
    date            TEXT NOT NULL,
    description     TEXT,
    amount          REAL NOT NULL,
    type            TEXT NOT NULL CHECK(type IN ('income','expense','transfer')),
    reference       TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categorization_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern         TEXT NOT NULL,
    category_id     INTEGER NOT NULL REFERENCES categories(id),
    account_id      INTEGER,
    priority        INTEGER DEFAULT 0,
    use_count       INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pattern, category_id)
);

CREATE TABLE IF NOT EXISTS recurring_transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL REFERENCES accounts(id),
    category_id     INTEGER REFERENCES categories(id),
    description     TEXT NOT NULL,
    amount          REAL NOT NULL,
    type            TEXT NOT NULL CHECK(type IN ('income','expense')),
    frequency       TEXT NOT NULL CHECK(frequency IN ('weekly','biweekly','monthly','quarterly','yearly')),
    next_date       TEXT NOT NULL,
    is_active       INTEGER DEFAULT 1,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS budgets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    amount      REAL NOT NULL,
    period      TEXT NOT NULL DEFAULT 'monthly',
    year        INTEGER NOT NULL,
    month       INTEGER NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category_id, year, month)
);

CREATE TABLE IF NOT EXISTS tax_tags (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id  INTEGER NOT NULL REFERENCES transactions(id),
    tag             TEXT NOT NULL CHECK(tag IN ('deductible','non-deductible','business','personal','capital_gains')),
    notes           TEXT DEFAULT '',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(transaction_id)
);

CREATE TABLE IF NOT EXISTS csv_profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    delimiter       TEXT DEFAULT ',',
    date_col        INTEGER NOT NULL,
    desc_col        INTEGER NOT NULL,
    amount_col      INTEGER NOT NULL,
    has_header      INTEGER DEFAULT 1,
    date_format     TEXT DEFAULT 'YYYY-MM-DD',
    amount_positive TEXT DEFAULT 'positive',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        # Migration: add transfer_pair_id if missing
        try:
            await db.execute("ALTER TABLE transactions ADD COLUMN transfer_pair_id INTEGER")
        except Exception:
            pass  # Column already exists
    await seed_personal_tables()


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


# ── Seed data for personal bookkeeping ───────────────────────

DEFAULT_CATEGORIES = [
    ("Food & Dining", "🍽️"), ("Transportation", "🚗"), ("Housing", "🏠"),
    ("Utilities", "💡"), ("Entertainment", "🎬"), ("Shopping", "🛍️"),
    ("Health", "💊"), ("Income", "💰"), ("Transfer", "🔄"),
    ("Education", "📚"), ("Personal Care", "💆"), ("Gifts", "🎁"),
]


async def seed_personal_tables():
    """Insert default accounts and categories if tables are empty."""
    async with _conn() as db:
        # Check if already seeded
        cursor = await db.execute("SELECT COUNT(*) FROM accounts")
        if (await cursor.fetchone())[0] > 0:
            return

        # Default accounts
        await db.execute(
            "INSERT INTO accounts (name, type) VALUES (?, ?)",
            ("Main Checking", "checking"),
        )
        await db.execute(
            "INSERT INTO accounts (name, type) VALUES (?, ?)",
            ("Cash", "cash"),
        )

        # Default categories
        for name, icon in DEFAULT_CATEGORIES:
            await db.execute(
                "INSERT INTO categories (name, icon) VALUES (?, ?)",
                (name, icon),
            )


# ── Account CRUD ─────────────────────────────────────────────

async def get_accounts() -> list[dict]:
    async with _conn() as db:
        cursor = await db.execute(
            "SELECT * FROM accounts WHERE is_active = 1 ORDER BY name"
        )
        return [dict(row) for row in await cursor.fetchall()]


async def create_account(name: str, acc_type: str, currency: str = "USD") -> int:
    async with _conn() as db:
        cursor = await db.execute(
            "INSERT INTO accounts (name, type, currency) VALUES (?, ?, ?)",
            (name, acc_type, currency),
        )
        return cursor.lastrowid


async def update_account(account_id: int, name: str = None, acc_type: str = None):
    async with _conn() as db:
        fields, vals = [], []
        if name is not None:
            fields.append("name = ?")
            vals.append(name)
        if acc_type is not None:
            fields.append("type = ?")
            vals.append(acc_type)
        if not fields:
            return
        vals.append(account_id)
        await db.execute(
            f"UPDATE accounts SET {', '.join(fields)} WHERE id = ?", vals
        )


async def delete_account(account_id: int):
    async with _conn() as db:
        await db.execute(
            "UPDATE accounts SET is_active = 0 WHERE id = ?", (account_id,)
        )


# ── Category CRUD ────────────────────────────────────────────

async def get_categories() -> list[dict]:
    async with _conn() as db:
        cursor = await db.execute(
            "SELECT * FROM categories ORDER BY name"
        )
        return [dict(row) for row in await cursor.fetchall()]


async def create_category(name: str, parent_id: int = None, icon: str = "") -> int:
    async with _conn() as db:
        cursor = await db.execute(
            "INSERT INTO categories (name, parent_id, icon) VALUES (?, ?, ?)",
            (name, parent_id, icon),
        )
        return cursor.lastrowid


async def update_category(category_id: int, name: str = None, icon: str = None):
    async with _conn() as db:
        fields, vals = [], []
        if name is not None:
            fields.append("name = ?")
            vals.append(name)
        if icon is not None:
            fields.append("icon = ?")
            vals.append(icon)
        if not fields:
            return
        vals.append(category_id)
        await db.execute(
            f"UPDATE categories SET {', '.join(fields)} WHERE id = ?", vals
        )


# ── Transaction CRUD ─────────────────────────────────────────

async def insert_transaction(proposal_id: int, account_id: int, category_id: int,
                             date: str, description: str, amount: float,
                             tx_type: str, reference: str = None) -> int:
    async with _conn() as db:
        cursor = await db.execute(
            """INSERT INTO transactions
               (proposal_id, account_id, category_id, date, description, amount, type, reference)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (proposal_id, account_id, category_id, date, description, amount, tx_type, reference),
        )
        return cursor.lastrowid


async def get_transactions(limit: int = 50, offset: int = 0,
                           account_id: int = None, category_id: int = None) -> list[dict]:
    async with _conn() as db:
        query = """
            SELECT t.*, a.name as account_name, c.name as category_name, c.icon as category_icon
            FROM transactions t
            LEFT JOIN accounts a ON t.account_id = a.id
            LEFT JOIN categories c ON t.category_id = c.id
            WHERE 1=1
        """
        params: list = []
        if account_id is not None:
            query += " AND t.account_id = ?"
            params.append(account_id)
        if category_id is not None:
            query += " AND t.category_id = ?"
            params.append(category_id)
        query += " ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        cursor = await db.execute(query, params)
        return [dict(row) for row in await cursor.fetchall()]


async def update_transaction_category(transaction_id: int, category_id: int):
    async with _conn() as db:
        await db.execute(
            "UPDATE transactions SET category_id = ? WHERE id = ?",
            (category_id, transaction_id),
        )


async def get_account_balance(account_id: int) -> float:
    async with _conn() as db:
        cursor = await db.execute(
            "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account_id = ?",
            (account_id,),
        )
        return (await cursor.fetchone())[0]


async def get_monthly_summary(year: int, month: int) -> dict:
    """Return total income, expenses, and net for a given month."""
    async with _conn() as db:
        month_str = f"{year}-{month:02d}"
        cursor = await db.execute(
            """SELECT type, COALESCE(SUM(amount), 0)
               FROM transactions WHERE date LIKE ?
               GROUP BY type""",
            (f"{month_str}%",),
        )
        by_type = {row[0]: row[1] for row in await cursor.fetchall()}
        income = by_type.get("income", 0)
        expenses = abs(by_type.get("expense", 0))
        return {"income": income, "expenses": expenses, "net": income - expenses}


async def get_category_breakdown(year: int, month: int) -> list[dict]:
    """Return spending by category for a given month."""
    async with _conn() as db:
        month_str = f"{year}-{month:02d}"
        cursor = await db.execute(
            """SELECT c.name, c.icon, COALESCE(SUM(ABS(t.amount)), 0) as total
               FROM transactions t
               LEFT JOIN categories c ON t.category_id = c.id
               WHERE t.date LIKE ? AND t.type = 'expense'
               GROUP BY t.category_id
               ORDER BY total DESC""",
            (f"{month_str}%",),
        )
        return [dict(row) for row in await cursor.fetchall()]


# ── Categorization rules ─────────────────────────────────────

async def get_rules() -> list[dict]:
    async with _conn() as db:
        cursor = await db.execute(
            """SELECT r.*, c.name as category_name, c.icon as category_icon
               FROM categorization_rules r
               LEFT JOIN categories c ON r.category_id = c.id
               ORDER BY r.use_count DESC, r.priority DESC"""
        )
        return [dict(row) for row in await cursor.fetchall()]


async def create_rule(pattern: str, category_id: int, account_id: int = None) -> int:
    async with _conn() as db:
        cursor = await db.execute(
            """INSERT OR IGNORE INTO categorization_rules
               (pattern, category_id, account_id) VALUES (?, ?, ?)""",
            (pattern.lower(), category_id, account_id),
        )
        return cursor.lastrowid


async def delete_rule(rule_id: int):
    async with _conn() as db:
        await db.execute(
            "DELETE FROM categorization_rules WHERE id = ?", (rule_id,)
        )


async def match_rule(description: str) -> Optional[dict]:
    """Find a categorization rule matching the transaction description."""
    async with _conn() as db:
        desc_lower = description.lower()
        cursor = await db.execute(
            "SELECT * FROM categorization_rules ORDER BY priority DESC, use_count DESC"
        )
        for row in await cursor.fetchall():
            rule = dict(row)
            if rule["pattern"] in desc_lower:
                # Increment use count
                await db.execute(
                    "UPDATE categorization_rules SET use_count = use_count + 1 WHERE id = ?",
                    (rule["id"],),
                )
                return rule
        return None


async def learn_rule(description: str, category_id: int):
    """Create or increment a categorization rule from a user categorization."""
    # Extract a short pattern from the description (first few words)
    words = description.split()[:3]
    pattern = " ".join(words).lower()
    if len(pattern) < 3:
        return
    async with _conn() as db:
        # Check if rule exists
        cursor = await db.execute(
            "SELECT id, use_count FROM categorization_rules WHERE pattern = ? AND category_id = ?",
            (pattern, category_id),
        )
        row = await cursor.fetchone()
        if row:
            await db.execute(
                "UPDATE categorization_rules SET use_count = use_count + 1 WHERE id = ?",
                (row[0],),
            )
        else:
            await db.execute(
                "INSERT INTO categorization_rules (pattern, category_id, use_count) VALUES (?, ?, 1)",
                (pattern, category_id),
            )


# ── Recurring Transactions ───────────────────────────────────

async def get_recurring() -> list[dict]:
    async with _conn() as db:
        cursor = await db.execute(
            """SELECT r.*, a.name as account_name, c.name as category_name, c.icon as category_icon
               FROM recurring_transactions r
               LEFT JOIN accounts a ON r.account_id = a.id
               LEFT JOIN categories c ON r.category_id = c.id
               ORDER BY r.next_date"""
        )
        return [dict(row) for row in await cursor.fetchall()]


async def create_recurring(account_id: int, category_id: int, description: str,
                           amount: float, tx_type: str, frequency: str, next_date: str) -> int:
    async with _conn() as db:
        cursor = await db.execute(
            """INSERT INTO recurring_transactions
               (account_id, category_id, description, amount, type, frequency, next_date)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (account_id, category_id, description, amount, tx_type, frequency, next_date),
        )
        return cursor.lastrowid


async def update_recurring(recurring_id: int, **kwargs):
    async with _conn() as db:
        fields, vals = [], []
        for key in ("description", "amount", "frequency", "next_date", "is_active", "category_id", "account_id"):
            if key in kwargs and kwargs[key] is not None:
                fields.append(f"{key} = ?")
                vals.append(kwargs[key])
        if not fields:
            return
        vals.append(recurring_id)
        await db.execute(
            f"UPDATE recurring_transactions SET {', '.join(fields)} WHERE id = ?", vals
        )


async def delete_recurring(recurring_id: int):
    async with _conn() as db:
        await db.execute(
            "UPDATE recurring_transactions SET is_active = 0 WHERE id = ?", (recurring_id,)
        )


async def get_due_recurring() -> list[dict]:
    """Return recurring transactions where next_date <= today."""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    async with _conn() as db:
        cursor = await db.execute(
            """SELECT * FROM recurring_transactions
               WHERE is_active = 1 AND next_date <= ?""",
            (today,),
        )
        return [dict(row) for row in await cursor.fetchall()]


async def advance_recurring(recurring_id: int, frequency: str, current_date: str):
    """Advance next_date based on frequency."""
    from datetime import timedelta
    d = datetime.strptime(current_date, "%Y-%m-%d")
    if frequency == "weekly":
        d += timedelta(weeks=1)
    elif frequency == "biweekly":
        d += timedelta(weeks=2)
    elif frequency == "monthly":
        month = d.month + 1
        year = d.year
        if month > 12:
            month = 1
            year += 1
        d = d.replace(year=year, month=month)
    elif frequency == "quarterly":
        month = d.month + 3
        year = d.year
        while month > 12:
            month -= 12
            year += 1
        d = d.replace(year=year, month=month)
    elif frequency == "yearly":
        d = d.replace(year=d.year + 1)
    async with _conn() as db:
        await db.execute(
            "UPDATE recurring_transactions SET next_date = ? WHERE id = ?",
            (d.strftime("%Y-%m-%d"), recurring_id),
        )


# ── Budgets ──────────────────────────────────────────────────

async def get_budgets(year: int, month: int) -> list[dict]:
    async with _conn() as db:
        cursor = await db.execute(
            """SELECT b.*, c.name as category_name, c.icon as category_icon
               FROM budgets b
               LEFT JOIN categories c ON b.category_id = c.id
               WHERE b.year = ? AND b.month = ?
               ORDER BY c.name""",
            (year, month),
        )
        return [dict(row) for row in await cursor.fetchall()]


async def set_budget(category_id: int, amount: float, year: int, month: int) -> int:
    async with _conn() as db:
        cursor = await db.execute(
            """INSERT INTO budgets (category_id, amount, year, month)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(category_id, year, month) DO UPDATE SET amount = excluded.amount""",
            (category_id, amount, year, month),
        )
        return cursor.lastrowid


async def delete_budget(budget_id: int):
    async with _conn() as db:
        await db.execute("DELETE FROM budgets WHERE id = ?", (budget_id,))


async def get_budget_status(year: int, month: int) -> list[dict]:
    """Return budget vs actual spending per category for a month."""
    month_str = f"{year}-{month:02d}"
    async with _conn() as db:
        cursor = await db.execute(
            """SELECT b.id, b.category_id, b.amount as budget_amount,
                      c.name as category_name, c.icon as category_icon,
                      COALESCE(SUM(ABS(t.amount)), 0) as spent
               FROM budgets b
               LEFT JOIN categories c ON b.category_id = c.id
               LEFT JOIN transactions t ON t.category_id = b.category_id
                   AND t.date LIKE ? AND t.type = 'expense'
               WHERE b.year = ? AND b.month = ?
               GROUP BY b.id
               ORDER BY c.name""",
            (f"{month_str}%", year, month),
        )
        results = []
        for row in await cursor.fetchall():
            d = dict(row)
            d["pct"] = round((d["spent"] / d["budget_amount"]) * 100, 1) if d["budget_amount"] > 0 else 0
            results.append(d)
        return results


# ── Transfers ────────────────────────────────────────────────

async def create_transfer(from_account_id: int, to_account_id: int, amount: float,
                          description: str, date: str) -> int:
    """Create a paired transfer (expense on source, income on destination)."""
    async with _conn() as db:
        cursor = await db.execute(
            "SELECT COALESCE(MAX(transfer_pair_id), 0) + 1 FROM transactions"
        )
        pair_id = (await cursor.fetchone())[0]

        # Expense on source account (money leaves)
        await db.execute(
            """INSERT INTO transactions
               (account_id, date, description, amount, type, transfer_pair_id)
               VALUES (?, ?, ?, ?, 'expense', ?)""",
            (from_account_id, date, description, -abs(amount), pair_id),
        )
        # Income on destination account (money arrives)
        await db.execute(
            """INSERT INTO transactions
               (account_id, date, description, amount, type, transfer_pair_id)
               VALUES (?, ?, ?, ?, 'income', ?)""",
            (to_account_id, date, description, abs(amount), pair_id),
        )
        return pair_id


# ── Tax Tags ─────────────────────────────────────────────────

async def tag_transaction(transaction_id: int, tag: str, notes: str = "") -> int:
    async with _conn() as db:
        cursor = await db.execute(
            """INSERT INTO tax_tags (transaction_id, tag, notes)
               VALUES (?, ?, ?)
               ON CONFLICT(transaction_id) DO UPDATE SET tag=excluded.tag, notes=excluded.notes""",
            (transaction_id, tag, notes),
        )
        return cursor.lastrowid


async def untag_transaction(transaction_id: int):
    async with _conn() as db:
        await db.execute(
            "DELETE FROM tax_tags WHERE transaction_id = ?", (transaction_id,)
        )


async def get_tax_summary(year: int) -> dict:
    """Return tax summary for a year: totals by tag."""
    async with _conn() as db:
        cursor = await db.execute(
            """SELECT tt.tag, COALESCE(SUM(ABS(t.amount)), 0) as total, COUNT(*) as count
               FROM tax_tags tt
               JOIN transactions t ON tt.transaction_id = t.id
               WHERE t.date LIKE ?
               GROUP BY tt.tag""",
            (f"{year}%",),
        )
        by_tag = {row[0]: {"total": row[1], "count": row[2]} for row in await cursor.fetchall()}

        # Total income
        cursor = await db.execute(
            "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date LIKE ? AND type = 'income'",
            (f"{year}%",),
        )
        total_income = (await cursor.fetchone())[0]

        # Total expenses
        cursor = await db.execute(
            "SELECT COALESCE(SUM(ABS(amount)), 0) FROM transactions WHERE date LIKE ? AND type = 'expense'",
            (f"{year}%",),
        )
        total_expenses = (await cursor.fetchone())[0]

        total_deductible = by_tag.get("deductible", {}).get("total", 0)
        total_business = by_tag.get("business", {}).get("total", 0)
        taxable_income = total_income - total_deductible - total_business

        return {
            "year": year,
            "total_income": total_income,
            "total_expenses": total_expenses,
            "total_deductible": total_deductible,
            "total_business": total_business,
            "taxable_income": max(0, taxable_income),
            "by_tag": by_tag,
        }


async def get_tagged_transactions(year: int, tag: str = None) -> list[dict]:
    async with _conn() as db:
        query = """
            SELECT t.*, tt.tag, tt.notes, c.name as category_name, c.icon as category_icon,
                   a.name as account_name
            FROM transactions t
            LEFT JOIN tax_tags tt ON t.id = tt.transaction_id
            LEFT JOIN categories c ON t.category_id = c.id
            LEFT JOIN accounts a ON t.account_id = a.id
            WHERE t.date LIKE ?
        """
        params: list = [f"{year}%"]
        if tag:
            query += " AND tt.tag = ?"
            params.append(tag)
        query += " ORDER BY t.date DESC"
        cursor = await db.execute(query, params)
        return [dict(row) for row in await cursor.fetchall()]


async def auto_tag_transactions(year: int, category_defaults: dict) -> int:
    """Auto-tag all untagged transactions in a year based on category defaults."""
    async with _conn() as db:
        cursor = await db.execute(
            """SELECT t.id, c.name FROM transactions t
               LEFT JOIN categories c ON t.category_id = c.id
               LEFT JOIN tax_tags tt ON t.id = tt.transaction_id
               WHERE t.date LIKE ? AND tt.id IS NULL""",
            (f"{year}%",),
        )
        tagged = 0
        for row in await cursor.fetchall():
            tx_id, cat_name = row[0], row[1]
            if cat_name and cat_name in category_defaults:
                await db.execute(
                    "INSERT INTO tax_tags (transaction_id, tag) VALUES (?, ?)",
                    (tx_id, category_defaults[cat_name]),
                )
                tagged += 1
        return tagged


# ── CSV Profiles ─────────────────────────────────────────────

async def get_csv_profiles() -> list[dict]:
    async with _conn() as db:
        cursor = await db.execute("SELECT * FROM csv_profiles ORDER BY name")
        return [dict(row) for row in await cursor.fetchall()]


async def create_csv_profile(name: str, delimiter: str, date_col: int, desc_col: int,
                              amount_col: int, has_header: int = 1,
                              date_format: str = "YYYY-MM-DD",
                              amount_positive: str = "positive") -> int:
    async with _conn() as db:
        cursor = await db.execute(
            """INSERT INTO csv_profiles
               (name, delimiter, date_col, desc_col, amount_col, has_header, date_format, amount_positive)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, delimiter, date_col, desc_col, amount_col, has_header, date_format, amount_positive),
        )
        return cursor.lastrowid


async def delete_csv_profile(profile_id: int):
    async with _conn() as db:
        await db.execute("DELETE FROM csv_profiles WHERE id = ?", (profile_id,))
