# AI Accountant Ledger — Full Implementation Blueprint

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER BROWSER (Dashboard)                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────────┐  │
│  │  Chat Panel  │    │  Proposal Preview │    │  Approve / Reject │  │
│  │  (send msg)  │    │  (diff + reason)  │    │  Buttons          │  │
│  └──────┬───────┘    └────────▲─────────┘    └───────┬───────────┘  │
│         │                     │                      │              │
└─────────┼─────────────────────┼──────────────────────┼──────────────┘
          │ POST /api/chat      │ GET /api/proposals   │ POST /api/approve
          ▼                     │                      ▼
┌───────────────────────────────┼──────────────────────────────────────┐
│                    FastAPI BACKEND  (main.py)                        │
│                                                                     │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────────────┐  │
│  │ /api/chat   │───▶│  Gemma 4 31B │───▶│  Parse JSON Proposal   │  │
│  │  handler    │    │  (GenAI SDK) │    │  Store in SQLite       │  │
│  └─────────────┘    └──────────────┘    └───────────┬────────────┘  │
│                                                     │               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────▼────────────┐  │
│  │ /api/approve │───▶│  Validate    │───▶│  Execute openpyxl     │  │
│  │  handler     │    │  proposal    │    │  write to .xlsx        │  │
│  └──────────────┘    └──────────────┘    └───────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  SQLite: proposals (id, status, json_payload, timestamps)    │   │
│  │  SQLite: chat_history (id, role, content, proposal_id)       │   │
│  │  Disk:   ledger.xlsx (single source of truth)                │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

</s>

**Request Lifecycle (step by step):**

```
1. User types: "Record a $5,000 purchase of office supplies on credit"

2. POST /api/chat →
   a. Appends message to chat_history in SQLite
   b. Loads recent chat history (last 20 messages)
   c. Loads a "ledger summary" (sheet names, row/col dimensions, key balances)
   d. Builds the full prompt: SYSTEM_PROMPT + ledger_summary + chat_history
   e. Calls Gemma 4 31B via google-genai SDK with JSON response schema
   f. Receives structured JSON proposal
   g. Validates JSON structure (pydantic model)
   h. Stores proposal in SQLite with status = "pending"
   i. Returns: chat acknowledgement + proposal_id to frontend

3. Frontend receives proposal_id →
   GET /api/proposals/{proposal_id} →
   a. Fetches proposal from SQLite
   b. Renders: old values (red strikethrough), new values (green), justification text
   c. Shows "Approve" and "Reject" buttons

4. User clicks "Approve" →
   POST /api/proposals/{proposal_id}/approve →
   a. Fetches proposal, verifies status == "pending"
   b. Executes each "action" in the proposal via openpyxl
   c. Saves ledger.xlsx
   d. Updates proposal status = "executed"
   e. Returns success + updated ledger summary

5. User clicks "Reject" →
   POST /api/proposals/{proposal_id}/reject →
   a. Updates proposal status = "rejected"
   b. Returns chat message: "The user has declined this proposal."
```

---

## 2. Human-in-the-Loop State Management (SQLite Schema)

```sql
-- schema.sql

CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content     TEXT NOT NULL,
    proposal_id INTEGER,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proposal_id) REFERENCES proposals(id)
);

CREATE TABLE IF NOT EXISTS proposals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'approved', 'rejected', 'executed', 'failed')),
    user_message    TEXT NOT NULL,
    ai_reasoning    TEXT,
    actions_json    TEXT NOT NULL,   -- The structured JSON array of edit operations
    validation_notes TEXT,           -- Pre-execution validation results
    executed_at     TIMESTAMP,
    rejected_at     TIMESTAMP,
    error_message   TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    snapshot    BLOB NOT NULL,       -- Full .xlsx bytes before the edit
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proposal_id) REFERENCES proposals(id)
);
```

</s>

**State Machine for a Proposal:**

```
         ┌──────────┐
         │  pending  │ ← Created when Gemma 4 returns valid JSON
         └────┬─────┘
              │
     ┌────────┴────────┐
     ▼                  ▼
┌──────────┐     ┌───────────┐
│ approved │     │  rejected │ ← User clicks "Reject"
└────┬─────┘     └───────────┘
     │
     ▼
┌──────────┐     ┌───────────┐
│ executed │     │   failed  │ ← openpyxl threw an exception
└──────────┘     └───────────┘
```

**Key Safety Rules:**

- A proposal can only transition forward (no rollback from `executed`).
- Before executing, the backend takes a **snapshot** of the current `ledger.xlsx` and stores it in `ledger_snapshots`. This is the undo mechanism.
- The `actions_json` is **never modified** after creation — it's the contract.
- A `pending` proposal expires after 15 minutes (a background task can clean these up).

---

## 3. Structured JSON Schema for Ledger Edits

This is the schema Gemma 4 must conform to. It supports four operation types covering the vast majority of accounting ledger manipulations:

```jsonc
{
  "proposal": {
    "summary": "Record $5,000 office supplies purchase on credit",
    "justification": "Under accrual accounting, the expense is recognized at purchase. Debit increases the Office Supplies Expense account; Credit increases Accounts Payable (liability). Debits ($5,000) = Credits ($5,000). This maintains the accounting equation: Assets = Liabilities + Equity.",
    "accounting_equation_check": {
      "assets_change": 0,
      "liabilities_change": 5000,
      "equity_change": -5000,
      "balance_confirmed": true,
    },
    "actions": [
      {
        "operation": "write_cell",
        "sheet": "GeneralLedger",
        "cell_ref": "F42",
        "old_value": null,
        "new_value": "2025-06-08",
        "context": "Transaction date",
      },
      {
        "operation": "write_cell",
        "sheet": "GeneralLedger",
        "cell_ref": "G42",
        "old_value": null,
        "new_value": "Office Supplies Purchase - Credit",
        "context": "Transaction description",
      },
      {
        "operation": "write_cell",
        "sheet": "GeneralLedger",
        "cell_ref": "H42",
        "old_value": null,
        "new_value": 5000.0,
        "context": "Debit: Office Supplies Expense (Account 6050)",
      },
      {
        "operation": "write_cell",
        "sheet": "GeneralLedger",
        "cell_ref": "I42",
        "old_value": null,
        "new_value": 0,
        "context": "Credit side for this line",
      },
      {
        "operation": "write_cell",
        "sheet": "GeneralLedger",
        "cell_ref": "H43",
        "old_value": null,
        "new_value": 0,
        "context": "Debit side for AP line",
      },
      {
        "operation": "write_cell",
        "sheet": "GeneralLedger",
        "cell_ref": "I43",
        "old_value": null,
        "new_value": 5000.0,
        "context": "Credit: Accounts Payable (Account 2100)",
      },
      {
        "operation": "write_formula",
        "sheet": "TrialBalance",
        "cell_ref": "C15",
        "formula": "=SUM(GeneralLedger!H:H)-SUM(GeneralLedger!I:I)",
        "context": "Recalculate trial balance difference",
      },
    ],
  },
}
```

</s>

**Four Supported Operations:**

| Operation       | Required Fields                                           | Description                    |
| --------------- | --------------------------------------------------------- | ------------------------------ |
| `write_cell`    | `sheet`, `cell_ref`, `new_value`, `old_value`             | Write a single value to a cell |
| `write_range`   | `sheet`, `start_cell`, `end_cell`, `values_2d` (2D array) | Write a block of values        |
| `write_formula` | `sheet`, `cell_ref`, `formula`                            | Set an Excel formula           |
| `insert_row`    | `sheet`, `row_index`, `values` (array)                    | Insert a new row at position   |

**Pydantic models (for validation on the backend):**

```python
from pydantic import BaseModel, Field, model_validator
from typing import Optional, Union
from enum import Enum

class OperationType(str, Enum):
    WRITE_CELL = "write_cell"
    WRITE_RANGE = "write_range"
    WRITE_FORMULA = "write_formula"
    INSERT_ROW = "insert_row"

class CellAction(BaseModel):
    operation: OperationType
    sheet: str
    cell_ref: Optional[str] = None
    start_cell: Optional[str] = None
    end_cell: Optional[str] = None
    old_value: Optional[Union[str, float, int]] = None
    new_value: Optional[Union[str, float, int]] = None
    formula: Optional[str] = None
    values_2d: Optional[list[list]] = None
    values: Optional[list] = None
    row_index: Optional[int] = None
    context: str = ""

    @model_validator(mode="after")
    def validate_operation_fields(self):
        if self.operation == OperationType.WRITE_CELL:
            if not self.cell_ref or self.new_value is None:
                raise ValueError("write_cell requires cell_ref and new_value")
        elif self.operation == OperationType.WRITE_FORMULA:
            if not self.cell_ref or not self.formula:
                raise ValueError("write_formula requires cell_ref and formula")
        elif self.operation == OperationType.WRITE_RANGE:
            if not self.start_cell or not self.end_cell or not self.values_2d:
                raise ValueError("write_range requires start_cell, end_cell, values_2d")
        elif self.operation == OperationType.INSERT_ROW:
            if self.row_index is None or self.values is None:
                raise ValueError("insert_row requires row_index and values")
        return self

class EquationCheck(BaseModel):
    assets_change: float = 0
    liabilities_change: float = 0
    equity_change: float = 0
    balance_confirmed: bool

class Proposal(BaseModel):
    summary: str
    justification: str
    accounting_equation_check: EquationCheck
    actions: list[CellAction]

    @model_validator(mode="after")
    def enforce_debit_equals_credit(self):
        total_debits = 0.0
        total_credits = 0.0
        for action in self.actions:
            ctx = action.context.lower()
            val = action.new_value if isinstance(action.new_value, (int, float)) else 0
            if "debit" in ctx:
                total_debits += val
            elif "credit" in ctx:
                total_credits += val
        if total_debits > 0 and total_credits > 0:
            if abs(total_debits - total_credits) > 0.01:
                raise ValueError(
                    f"Double-entry violation: debits={total_debits} != credits={total_credits}"
                )
        return self
```

---

## 4. Accounting Rules — System Prompt Design

This is the most critical piece. The system prompt must constrain Gemma 4 to behave as a disciplined accountant, not a freeform chatbot.

```
SYSTEM PROMPT (stored in prompts/system_accountant.txt):
─────────────────────────────────────────────────────────

You are a senior certified public accountant managing a company's primary
general ledger stored in a single Excel (.xlsx) workbook.

## Your Core Constraints

1. DOUBLE-ENTRY MANDATE: Every transaction you propose MUST have equal
   debits and credits. If a proposed edit affects monetary values, the
   sum of all debit entries must exactly equal the sum of all credit
   entries. You must include this verification in the
   accounting_equation_check of your response.

2. ACCOUNTING EQUATION: Assets = Liabilities + Equity. Every proposed
   change must be explainable in terms of this equation. Include the
   net effect on assets, liabilities, and equity in your response.

3. NO SILENT EDITS: You never "execute" changes. You PROPOSE changes
   as a structured JSON object. A human will review and approve every
   edit before it touches the ledger.

4. CONSERVATISM PRINCIPLE: When uncertain, prefer the option that
   understates assets/income rather than overstates them.

5. AUDIT TRAIL: Every action must include a clear "context" field
   explaining what that specific cell edit does and which account it
   affects (include the account number if known).

6. ASK WHEN UNSURE: If the user's instruction is ambiguous (e.g.,
   "record the expense" without specifying which account), ask for
   clarification before proposing an edit. Return a JSON response
   with "actions": [] and put your question in the "justification"
   field.

## Current Ledger Structure

{ledger_summary}

This includes sheet names, column headers, the last used row per sheet,
and the current trial balance totals so you can validate your proposals
against actual balances.

## Response Format

You MUST respond with valid JSON matching this exact schema. Do NOT
include any text outside the JSON object. Do NOT use markdown code fences.

{
  "proposal": {
    "summary": "<one-line description of what this edit does>",
    "justification": "<2-4 sentence explanation of the accounting
                       reasoning, referencing specific accounts and
                       the double-entry logic>",
    "accounting_equation_check": {
      "assets_change": <net change to total assets>,
      "liabilities_change": <net change to total liabilities>,
      "equity_change": <net change to total equity>,
      "balance_confirmed": <true if equation still balances>
    },
    "actions": [
      {
        "operation": "write_cell" | "write_range" | "write_formula" | "insert_row",
        "sheet": "<sheet name>",
        "cell_ref": "<e.g., F42>",
        "old_value": <current value or null if new>,
        "new_value": <proposed value>,
        "context": "<what this cell edit does>"
      }
    ]
  }
}

## Accounting Glossary Reference

Use standard chart of accounts numbering:
  1000-1999: Assets        (e.g., 1010 Cash, 1200 Accounts Receivable)
  2000-2999: Liabilities   (e.g., 2100 Accounts Payable, 2300 Accrued Expenses)
  3000-3999: Equity        (e.g., 3100 Retained Earnings)
  4000-4999: Revenue       (e.g., 4100 Service Revenue)
  5000-5999: COGS          (e.g., 5100 Cost of Goods Sold)
  6000-6999: Expenses      (e.g., 6050 Office Supplies, 6100 Rent)

## When the User Asks for a Report (not an edit)

If the user asks for a report (e.g., "generate a balance sheet"), respond
with a "report" object instead of "proposal":

{
  "report": {
    "title": "Balance Sheet as of 2025-06-08",
    "sections": [
      { "heading": "Assets", "lines": [
          { "account": "Cash", "account_number": 1010, "amount": 45000 },
          ...
      ]},
      ...
    ],
    "totals": { "total_assets": ..., "total_liabilities": ..., "total_equity": ... },
    "balanced": true
  }
}
```

**How the `ledger_summary` is dynamically generated:**

```python
def build_ledger_summary(path: str) -> str:
    """Read the current Excel workbook and produce a compact textual summary
    that fits inside the system prompt context window."""
    wb = load_workbook(path, data_only=True)
    lines = [f"Workbook: {path}", ""]

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        max_row = ws.max_row
        max_col = ws.max_column

        lines.append(f"--- Sheet: '{sheet_name}' ({max_row} rows x {max_col} cols) ---")

        # Header row
        headers = [str(ws.cell(1, c).value or "") for c in range(1, max_col + 1)]
        lines.append(f"  Headers: {' | '.join(headers)}")

        # Last 5 data rows (for context)
        start = max(2, max_row - 4)
        for r in range(start, max_row + 1):
            vals = [str(ws.cell(r, c).value or "") for c in range(1, max_col + 1)]
            lines.append(f"  Row {r}: {' | '.join(vals)}")

        lines.append("")

    # Trial balance summary if the sheet exists
    if "TrialBalance" in wb.sheetnames:
        ws_tb = wb["TrialBalance"]
        total_debits = ws_tb.cell(ws_tb.max_row - 1, 2).value or 0
        total_credits = ws_tb.cell(ws_tb.max_row, 2).value or 0
        lines.append(f"Trial Balance: Debits={total_debits}, Credits={total_credits}")
        lines.append(f"Balanced: {abs(float(total_debits) - float(total_credits)) < 0.01}")

    wb.close()
    return "\n".join(lines)
```

---

## 5. Complete Code Blueprint

### Project Structure

```
ai-accountant/
├── main.py                 # FastAPI app, all endpoints
├── db.py                   # SQLite initialization and helpers
├── ledger_engine.py        # openpyxl read/write/snapshot logic
├── ai_client.py            # Gemma 4 SDK wrapper
├── prompts/
│   └── system_accountant.txt   # The system prompt above
├── data/
│   └── ledger.xlsx         # The single source-of-truth ledger
├── requirements.txt
└── static/
    └── index.html          # Dashboard frontend
```

### `requirements.txt`

```
fastapi==0.115.6
uvicorn[standard]==0.34.0
google-genai==1.16.0
openpyxl==3.1.5
pandas==2.2.3
pydantic==2.10.4
python-multipart==0.0.20
jinja2==3.1.5
aiosqlite==0.20.0
```

### `db.py` — Database Layer

```python
"""SQLite database for proposal state management and chat history."""

import aiosqlite
import json
from datetime import datetime
from typing import Optional

DB_PATH = "data/accountant.db"

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
"""


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
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
            "SELECT role, content FROM chat_messages ORDER BY id DESC LIMIT ?", (limit,)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in reversed(rows)]


async def create_proposal(user_message: str, ai_reasoning: str,
                          actions: list[dict]) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """INSERT INTO proposals (status, user_message, ai_reasoning, actions_json)
               VALUES ('pending', ?, ?, ?)""",
            (user_message, ai_reasoning, json.dumps(actions)),
        )
        await db.commit()
        return cursor.lastrowid


async def get_proposal(proposal_id: int) -> Optional[dict]:
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


async def update_proposal_status(proposal_id: int, status: str,
                                  error_message: Optional[str] = None):
    async with aiosqlite.connect(DB_PATH) as db:
        timestamp_col = "executed_at" if status == "executed" else "rejected_at"
        await db.execute(
            f"""UPDATE proposals
                SET status = ?, {timestamp_col} = ?, error_message = ?
                WHERE id = ?""",
            (status, datetime.utcnow().isoformat(), error_message, proposal_id),
        )
        await db.commit()


async def save_snapshot(proposal_id: int, snapshot_bytes: bytes):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO ledger_snapshots (proposal_id, snapshot) VALUES (?, ?)",
            (proposal_id, snapshot_bytes),
        )
        await db.commit()
```

### `ai_client.py` — Gemma 4 SDK Wrapper

```python
"""Gemma 4 31B integration via Google GenAI SDK."""

import json
import os
import logging
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# Configure once at module level
client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])

SYSTEM_PROMPT_PATH = "prompts/system_accountant.txt"


def load_system_prompt() -> str:
    with open(SYSTEM_PROMPT_PATH, "r") as f:
        return f.read()


async def call_gemma(
    ledger_summary: str,
    chat_history: list[dict],
    user_message: str,
) -> dict:
    """
    Sends the full conversation + ledger context to Gemma 4 31B
    and expects a structured JSON proposal back.
    """
    system_prompt = load_system_prompt().replace(
        "{ledger_summary}", ledger_summary
    )

    # Build conversation messages for the SDK
    contents = []
    for msg in chat_history:
        role = "user" if msg["role"] == "user" else "model"
        contents.append(types.Content(
            role=role,
            parts=[types.Part.from_text(text=msg["content"])],
        ))

    # Append current user message
    contents.append(types.Content(
        role="user",
        parts=[types.Part.from_text(text=user_message)],
    ))

    response = client.models.generate_content(
        model="gemma-4-31b-it",  # Gemma 4 31B instruction-tuned
        contents=contents,
        config=types.GenerateContentConfig(
            system_instruction=system_prompt,
            temperature=0.2,          # Low temperature for accounting precision
            max_output_tokens=4096,
            response_mime_type="application/json",  # Force JSON output
            response_schema={          # Constrain output shape
                "type": "object",
                "properties": {
                    "proposal": {
                        "type": "object",
                        "properties": {
                            "summary": {"type": "string"},
                            "justification": {"type": "string"},
                            "accounting_equation_check": {
                                "type": "object",
                                "properties": {
                                    "assets_change": {"type": "number"},
                                    "liabilities_change": {"type": "number"},
                                    "equity_change": {"type": "number"},
                                    "balance_confirmed": {"type": "boolean"},
                                },
                            },
                            "actions": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "operation": {"type": "string"},
                                        "sheet": {"type": "string"},
                                        "cell_ref": {"type": "string"},
                                        "old_value": {},
                                        "new_value": {},
                                        "formula": {"type": "string"},
                                        "context": {"type": "string"},
                                    },
                                    "required": ["operation", "sheet", "context"],
                                },
                            },
                        },
                        "required": ["summary", "justification", "actions"],
                    },
                    "report": {"type": "object"},  # For read-only report requests
                },
            },
        ),
    )

    raw_text = response.text
    logger.debug("Gemma 4 raw response: %s", raw_text[:500])

    parsed = json.loads(raw_text)
    return parsed
```

### `ledger_engine.py` — openpyxl Read/Write Engine

```python
"""Safe read/write operations on the Excel ledger with snapshot support."""

import io
import os
import logging
from copy import copy
from openpyxl import load_workbook
from openpyxl.utils import column_index_from_string, get_column_letter

logger = logging.getLogger(__name__)

LEDGER_PATH = "data/ledger.xlsx"


def get_workbook(data_only: bool = False):
    return load_workbook(LEDGER_PATH, data_only=data_only)


def take_snapshot() -> bytes:
    """Return the raw bytes of the current ledger file for rollback."""
    with open(LEDGER_PATH, "rb") as f:
        return f.read()


def get_ledger_summary() -> str:
    """Build a compact text summary of the ledger for the AI prompt."""
    wb = get_workbook(data_only=True)
    lines = [f"Workbook: ledger.xlsx", ""]

    for name in wb.sheetnames:
        ws = wb[name]
        max_row = ws.max_row or 1
        max_col = ws.max_column or 1
        lines.append(f"--- Sheet: '{name}' ({max_row} rows x {max_col} cols) ---")

        headers = [str(ws.cell(1, c).value or "") for c in range(1, max_col + 1)]
        lines.append(f"  Columns: {' | '.join(headers)}")

        # Show last 8 data rows
        start = max(2, max_row - 7)
        for r in range(start, max_row + 1):
            vals = []
            for c in range(1, max_col + 1):
                v = ws.cell(r, c).value
                vals.append(str(v) if v is not None else "")
            lines.append(f"  Row {r}: {' | '.join(vals)}")
        lines.append("")

    wb.close()
    return "\n".join(lines)


def execute_actions(actions: list[dict]) -> list[str]:
    """
    Execute the approved proposal actions against the ledger.
    Returns a list of human-readable change descriptions.
    """
    wb = get_workbook()
    change_log = []

    try:
        for action in actions:
            op = action["operation"]
            sheet = action["sheet"]

            if sheet not in wb.sheetnames:
                raise ValueError(f"Sheet '{sheet}' does not exist in the workbook.")

            ws = wb[sheet]

            if op == "write_cell":
                cell_ref = action["cell_ref"]
                old_val = ws[cell_ref].value
                new_val = action["new_value"]
                ws[cell_ref] = new_val
                change_log.append(
                    f"[{sheet}!{cell_ref}] {old_val!r} → {new_val!r} "
                    f"({action.get('context', '')})"
                )

            elif op == "write_formula":
                cell_ref = action["cell_ref"]
                formula = action["formula"]
                ws[cell_ref] = formula
                change_log.append(
                    f"[{sheet}!{cell_ref}] Set formula: {formula}"
                )

            elif op == "write_range":
                start = action["start_cell"]
                end = action["end_cell"]
                values = action["values_2d"]
                # Use openpyxl's range iteration
                from openpyxl.utils import range_boundaries
                min_col, min_row, max_col, max_row = range_boundaries(
                    f"{start}:{end}"
                )
                for r_idx, row_data in enumerate(values):
                    for c_idx, val in enumerate(row_data):
                        ws.cell(
                            row=min_row + r_idx,
                            column=min_col + c_idx,
                            value=val,
                        )
                change_log.append(
                    f"[{sheet}!{start}:{end}] Wrote {len(values)}x"
                    f"{len(values[0]) if values else 0} block"
                )

            elif op == "insert_row":
                row_idx = action["row_index"]
                values = action["values"]
                ws.insert_rows(row_idx)
                for c_idx, val in enumerate(values, start=1):
                    ws.cell(row=row_idx, column=c_idx, value=val)
                change_log.append(
                    f"[{sheet}] Inserted row {row_idx} with {len(values)} values"
                )

            else:
                raise ValueError(f"Unknown operation: {op}")

        wb.save(LEDGER_PATH)
        logger.info("Ledger saved. %d actions executed.", len(actions))

    except Exception:
        wb.close()
        raise
    finally:
        wb.close()

    return change_log
```

### `main.py` — FastAPI Application

```python
"""AI Accountant — FastAPI backend with human-in-the-loop approval."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

import db
import ai_client
import ledger_engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ── Lifespan: initialize DB on startup ────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    Path("data").mkdir(exist_ok=True)
    await db.init_db()
    logger.info("Database initialized.")
    yield


app = FastAPI(title="AI Accountant", version="1.0.0", lifespan=lifespan)


# ── Request/Response Models ────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str

    @field_validator("message")
    @classmethod
    def not_empty(cls, v):
        if not v.strip():
            raise ValueError("Message cannot be empty")
        return v.strip()


class ChatResponse(BaseModel):
    assistant_message: str
    proposal_id: int | None = None
    proposal_summary: str | None = None


class ProposalDetail(BaseModel):
    id: int
    status: str
    summary: str
    justification: str
    accounting_equation_check: dict
    actions: list[dict]
    user_message: str
    created_at: str


class ApprovalResponse(BaseModel):
    success: bool
    message: str
    change_log: list[str] | None = None


# ── API Endpoints ──────────────────────────────────────────────────

@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Full lifecycle:
    1. Store user message
    2. Build ledger context + history
    3. Call Gemma 4
    4. Validate & store proposal
    5. Return acknowledgement + proposal_id
    """
    # 1. Store user message
    await db.insert_chat_message("user", request.message)

    # 2. Build context
    history = await db.get_chat_history(limit=20)
    ledger_summary = ledger_engine.get_ledger_summary()

    # 3. Call Gemma 4
    try:
        ai_response = await ai_client.call_gemma(
            ledger_summary=ledger_summary,
            chat_history=history[:-1],  # Exclude the just-added message
            user_message=request.message,
        )
    except Exception as e:
        logger.error("Gemma 4 call failed: %s", e)
        error_msg = "I'm sorry, I encountered an error processing your request. Please try again."
        await db.insert_chat_message("assistant", error_msg)
        return ChatResponse(assistant_message=error_msg)

    # 4. Process the response
    if "report" in ai_response:
        # Read-only report — no proposal needed
        report = ai_response["report"]
        report_text = f"**{report.get('title', 'Report')}**\n\n"
        for section in report.get("sections", []):
            report_text += f"### {section['heading']}\n"
            for line in section.get("lines", []):
                acct = line.get("account", "")
                num = line.get("account_number", "")
                amt = line.get("amount", 0)
                report_text += f"  - {acct} ({num}): ${amt:,.2f}\n"
            report_text += "\n"

        totals = report.get("totals", {})
        report_text += (
            f"**Total Assets:** ${totals.get('total_assets', 0):,.2f}\n"
            f"**Total Liabilities:** ${totals.get('total_liabilities', 0):,.2f}\n"
            f"**Total Equity:** ${totals.get('total_equity', 0):,.2f}\n"
        )

        await db.insert_chat_message("assistant", report_text)
        return ChatResponse(assistant_message=report_text)

    # Transaction proposal
    proposal_data = ai_response.get("proposal")
    if not proposal_data:
        msg = "I could not form a clear proposal. Could you rephrase your request?"
        await db.insert_chat_message("assistant", msg)
        return ChatResponse(assistant_message=msg)

    # Validate with Pydantic (enforces double-entry)
    from ai_client import Proposal  # or import from a shared models.py
    try:
        validated = Proposal(**proposal_data)
    except Exception as e:
        logger.warning("Proposal validation failed: %s", e)
        msg = (
            f"I prepared a proposal but it failed validation: {e}\n"
            "I'll revise it. Could you rephrase your instruction?"
        )
        await db.insert_chat_message("assistant", msg)
        return ChatResponse(assistant_message=msg)

    # Check the accounting equation
    eq = validated.accounting_equation_check
    if not eq.balance_confirmed:
        msg = (
            "I could not confirm that this proposal balances the accounting "
            "equation. I won't submit it for review. Please verify your "
            "instruction."
        )
        await db.insert_chat_message("assistant", msg)
        return ChatResponse(assistant_message=msg)

    # 5. Store proposal
    proposal_id = await db.create_proposal(
        user_message=request.message,
        ai_reasoning=validated.justification,
        actions=[a.model_dump() for a in validated.actions],
    )

    # 6. Store assistant message linked to proposal
    ack = (
        f"I've prepared a proposed edit for your review.\n\n"
        f"**Summary:** {validated.summary}\n"
        f"**Reasoning:** {validated.justification}\n\n"
        f"Please review the changes below and approve or reject."
    )
    await db.insert_chat_message("assistant", ack, proposal_id=proposal_id)

    return ChatResponse(
        assistant_message=ack,
        proposal_id=proposal_id,
        proposal_summary=validated.summary,
    )


@app.get("/api/proposals/{proposal_id}", response_model=ProposalDetail)
async def get_proposal(proposal_id: int):
    """Fetch a proposal for the frontend to render as a preview."""
    proposal = await db.get_proposal(proposal_id)
    if not proposal:
        raise HTTPException(404, "Proposal not found")

    actions = proposal["actions"]

    # Build old_value vs new_value previews
    preview_actions = []
    for act in actions:
        # Fetch old value from the live workbook
        old_val = None
        if act.get("cell_ref") and act["operation"] in ("write_cell", "write_formula"):
            try:
                wb = ledger_engine.get_workbook(data_only=True)
                if act["sheet"] in wb.sheetnames:
                    old_val = wb[act["sheet"]][act["cell_ref"]].value
                wb.close()
            except Exception:
                old_val = "N/A"

        preview_actions.append({
            **act,
            "old_value_display": act.get("old_value", old_val),
            "new_value_display": act.get("new_value", act.get("formula", "")),
        })

    return ProposalDetail(
        id=proposal["id"],
        status=proposal["status"],
        summary=proposal.get("ai_reasoning", "")[:200],
        justification=proposal.get("ai_reasoning", ""),
        accounting_equation_check={
            "assets_change": 0,
            "liabilities_change": 0,
            "equity_change": 0,
            "balance_confirmed": True,
        },
        actions=preview_actions,
        user_message=proposal["user_message"],
        created_at=proposal["created_at"],
    )


@app.post("/api/proposals/{proposal_id}/approve", response_model=ApprovalResponse)
async def approve_proposal(proposal_id: int):
    """
    Human-in-the-loop approval:
    1. Verify proposal is pending
    2. Snapshot the ledger
    3. Execute the actions
    4. Update status
    """
    proposal = await db.get_proposal(proposal_id)
    if not proposal:
        raise HTTPException(404, "Proposal not found")
    if proposal["status"] != "pending":
        raise HTTPException(
            409, f"Proposal is '{proposal['status']}', not 'pending'."
        )

    # Snapshot before execution
    snapshot = ledger_engine.take_snapshot()
    await db.save_snapshot(proposal_id, snapshot)

    # Execute
    try:
        change_log = ledger_engine.execute_actions(proposal["actions"])
        await db.update_proposal_status(proposal_id, "executed")
        await db.insert_chat_message(
            "assistant",
            f"Approved and executed. Changes: {'; '.join(change_log)}",
            proposal_id=proposal_id,
        )
        return ApprovalResponse(
            success=True,
            message="Proposal executed successfully.",
            change_log=change_log,
        )
    except Exception as e:
        logger.error("Execution failed: %s", e)
        await db.update_proposal_status(proposal_id, "failed", str(e))
        await db.insert_chat_message(
            "assistant",
            f"Execution failed: {e}",
            proposal_id=proposal_id,
        )
        return ApprovalResponse(
            success=False,
            message=f"Execution failed: {e}",
        )


@app.post("/api/proposals/{proposal_id}/reject", response_model=ApprovalResponse)
async def reject_proposal(proposal_id: int):
    proposal = await db.get_proposal(proposal_id)
    if not proposal:
        raise HTTPException(404, "Proposal not found")
    if proposal["status"] != "pending":
        raise HTTPException(409, f"Proposal is '{proposal['status']}', not 'pending'.")

    await db.update_proposal_status(proposal_id, "rejected")
    await db.insert_chat_message(
        "assistant",
        "The proposed changes have been rejected. No edits were made to the ledger.",
        proposal_id=proposal_id,
    )
    return ApprovalResponse(success=True, message="Proposal rejected.")


@app.get("/api/chat/history")
async def get_history():
    """Return full chat history for dashboard rendering."""
    history = await db.get_chat_history(limit=100)
    return {"messages": history}


@app.get("/api/ledger/download")
async def download_ledger():
    """Download the current ledger file."""
    if not Path(LEDGER_PATH).exists():
        raise HTTPException(404, "Ledger file not found.")
    return FileResponse(
        LEDGER_PATH,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="ledger.xlsx",
    )


@app.get("/", response_class=HTMLResponse)
async def serve_dashboard():
    """Serve the single-page dashboard."""
    html_path = Path("static/index.html")
    if html_path.exists():
        return HTMLResponse(html_path.read_text())
    return HTMLResponse("<h1>AI Accountant</h1><p>Place static/index.html</p>")
```

### `static/index.html` — Dashboard Frontend

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Accountant</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link
      href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <script>
      tailwind.config = {
        theme: {
          extend: {
            fontFamily: {
              sans: ["Inter", "sans-serif"],
              mono: ["JetBrains Mono", "monospace"],
            },
            colors: {
              ledger: {
                bg: "#0f1117",
                surface: "#1a1d27",
                border: "#2a2d3a",
                accent: "#3b82f6",
                success: "#22c55e",
                danger: "#ef4444",
                warn: "#f59e0b",
              },
            },
          },
        },
      };
    </script>
    <style>
      body {
        font-family: "Inter", sans-serif;
      }
      .font-mono {
        font-family: "JetBrains Mono", monospace;
      }
      .chat-scroll::-webkit-scrollbar {
        width: 6px;
      }
      .chat-scroll::-webkit-scrollbar-thumb {
        background: #2a2d3a;
        border-radius: 3px;
      }
      @keyframes fadeUp {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .fade-up {
        animation: fadeUp 0.3s ease forwards;
      }
      .typing-dot {
        animation: blink 1.4s infinite both;
      }
      .typing-dot:nth-child(2) {
        animation-delay: 0.2s;
      }
      .typing-dot:nth-child(3) {
        animation-delay: 0.4s;
      }
      @keyframes blink {
        0%,
        80%,
        100% {
          opacity: 0.2;
        }
        40% {
          opacity: 1;
        }
      }
    </style>
  </head>
  <body class="bg-ledger-bg text-gray-200 h-screen flex flex-col">
    <!-- Header -->
    <header
      class="border-b border-ledger-border px-6 py-4 flex items-center justify-between shrink-0"
    >
      <div class="flex items-center gap-3">
        <div
          class="w-8 h-8 rounded-lg bg-ledger-accent flex items-center justify-center text-white font-bold text-sm"
        >
          AI
        </div>
        <div>
          <h1 class="text-lg font-semibold text-white">AI Accountant</h1>
          <p class="text-xs text-gray-500">
            Human-in-the-Loop Ledger Management
          </p>
        </div>
      </div>
      <a
        href="/api/ledger/download"
        class="text-sm text-ledger-accent hover:underline"
        >Download ledger.xlsx</a
      >
    </header>

    <!-- Main: Two-column layout -->
    <div class="flex flex-1 overflow-hidden">
      <!-- Left: Chat Panel -->
      <div class="w-1/2 flex flex-col border-r border-ledger-border">
        <div
          id="chatMessages"
          class="flex-1 overflow-y-auto chat-scroll p-6 space-y-4"
        >
          <div class="fade-up flex gap-3">
            <div
              class="w-7 h-7 rounded-full bg-ledger-accent/20 flex items-center justify-center text-xs text-ledger-accent shrink-0 mt-0.5"
            >
              AI
            </div>
            <div
              class="bg-ledger-surface border border-ledger-border rounded-xl px-4 py-3 max-w-[85%]"
            >
              <p class="text-sm">
                Hello! I'm your AI accountant. I can help you record
                transactions, generate reports, reconcile accounts, and manage
                your general ledger. What would you like to do?
              </p>
            </div>
          </div>
        </div>

        <!-- Input -->
        <div class="p-4 border-t border-ledger-border shrink-0">
          <form id="chatForm" class="flex gap-2">
            <input
              type="text"
              id="chatInput"
              placeholder="e.g. Record a $5,000 office supplies purchase on credit..."
              class="flex-1 bg-ledger-surface border border-ledger-border rounded-lg px-4 py-3 text-sm
                               focus:outline-none focus:border-ledger-accent transition placeholder-gray-600"
            />
            <button
              type="submit"
              id="sendBtn"
              class="bg-ledger-accent hover:bg-blue-600 text-white px-5 py-3 rounded-lg text-sm font-medium
                               transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </form>
        </div>
      </div>

      <!-- Right: Proposal Preview Panel -->
      <div id="proposalPanel" class="w-1/2 flex flex-col">
        <div class="flex-1 overflow-y-auto chat-scroll p-6">
          <div
            id="proposalEmpty"
            class="h-full flex items-center justify-center text-gray-600 text-sm"
          >
            <div class="text-center">
              <div class="text-4xl mb-3 opacity-30">&#9878;</div>
              <p>No pending proposals</p>
              <p class="text-xs mt-1 text-gray-700">
                Proposed edits will appear here for your review
              </p>
            </div>
          </div>
          <div id="proposalContent" class="hidden">
            <!-- Filled dynamically -->
          </div>
        </div>
      </div>
    </div>

    <script>
      const chatMessages = document.getElementById("chatMessages");
      const chatForm = document.getElementById("chatForm");
      const chatInput = document.getElementById("chatInput");
      const sendBtn = document.getElementById("sendBtn");
      const proposalEmpty = document.getElementById("proposalEmpty");
      const proposalContent = document.getElementById("proposalContent");

      function addMessage(role, text, proposalId) {
        const isUser = role === "user";
        const wrapper = document.createElement("div");
        wrapper.className = `fade-up flex gap-3 ${isUser ? "justify-end" : ""}`;
        wrapper.innerHTML = isUser
          ? `<div class="bg-ledger-accent text-white rounded-xl px-4 py-3 max-w-[85%] text-sm">${escHtml(text)}</div>`
          : `<div class="w-7 h-7 rounded-full bg-ledger-accent/20 flex items-center justify-center text-xs text-ledger-accent shrink-0 mt-0.5">AI</div>
                   <div class="bg-ledger-surface border border-ledger-border rounded-xl px-4 py-3 max-w-[85%] text-sm whitespace-pre-wrap">${escHtml(text)}</div>`;
        chatMessages.appendChild(wrapper);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      function showTyping() {
        const el = document.createElement("div");
        el.id = "typingIndicator";
        el.className = "fade-up flex gap-3";
        el.innerHTML = `
                <div class="w-7 h-7 rounded-full bg-ledger-accent/20 flex items-center justify-center text-xs text-ledger-accent shrink-0">AI</div>
                <div class="bg-ledger-surface border border-ledger-border rounded-xl px-4 py-3">
                    <span class="typing-dot inline-block w-2 h-2 bg-gray-500 rounded-full mr-1"></span>
                    <span class="typing-dot inline-block w-2 h-2 bg-gray-500 rounded-full mr-1"></span>
                    <span class="typing-dot inline-block w-2 h-2 bg-gray-500 rounded-full"></span>
                </div>`;
        chatMessages.appendChild(el);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      function hideTyping() {
        document.getElementById("typingIndicator")?.remove();
      }

      function escHtml(s) {
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
      }

      // ── Chat submit ──────────────────────────────────
      chatForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const msg = chatInput.value.trim();
        if (!msg) return;

        chatInput.value = "";
        sendBtn.disabled = true;
        addMessage("user", msg);
        showTyping();

        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: msg }),
          });
          const data = await res.json();
          hideTyping();
          addMessage("assistant", data.assistant_message, data.proposal_id);

          if (data.proposal_id) {
            loadProposal(data.proposal_id);
          }
        } catch (err) {
          hideTyping();
          addMessage("assistant", "Error: Could not reach the server.");
        }
        sendBtn.disabled = false;
      });

      // ── Load and render proposal ─────────────────────
      async function loadProposal(id) {
        try {
          const res = await fetch(`/api/proposals/${id}`);
          const p = await res.json();
          proposalEmpty.classList.add("hidden");
          proposalContent.classList.remove("hidden");

          let actionsHtml = p.actions
            .map(
              (a, i) => `
                    <div class="bg-ledger-bg border border-ledger-border rounded-lg p-3">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="text-xs font-mono px-2 py-0.5 rounded bg-ledger-accent/10 text-ledger-accent">${escHtml(a.operation)}</span>
                            <span class="text-xs text-gray-500">${escHtml(a.sheet)}!${escHtml(a.cell_ref || a.start_cell || "Row " + a.row_index)}</span>
                        </div>
                        ${
                          a.old_value_display !== null &&
                          a.old_value_display !== undefined
                            ? `
                        <div class="flex items-center gap-2 text-sm">
                            <span class="text-ledger-danger line-through">${escHtml(String(a.old_value_display))}</span>
                            <span class="text-gray-600">&rarr;</span>
                            <span class="text-ledger-success font-medium">${escHtml(String(a.new_value_display))}</span>
                        </div>`
                            : `
                        <div class="text-sm">
                            <span class="text-gray-600">Set to:</span>
                            <span class="text-ledger-success font-medium ml-1">${escHtml(String(a.new_value_display))}</span>
                        </div>`
                        }
                        <p class="text-xs text-gray-500 mt-1">${escHtml(a.context || "")}</p>
                    </div>
                `,
            )
            .join("");

          proposalContent.innerHTML = `
                    <div class="fade-up">
                        <div class="flex items-center gap-2 mb-4">
                            <span class="inline-block w-3 h-3 rounded-full bg-ledger-warn animate-pulse"></span>
                            <span class="text-sm font-medium text-ledger-warn">Pending Approval</span>
                            <span class="text-xs text-gray-600 ml-auto">#${p.id}</span>
                        </div>
                        <div class="mb-4">
                            <p class="text-xs text-gray-500 mb-1">Your request</p>
                            <p class="text-sm bg-ledger-bg border border-ledger-border rounded-lg px-3 py-2">${escHtml(p.user_message)}</p>
                        </div>
                        <div class="mb-4">
                            <p class="text-xs text-gray-500 mb-1">AI Reasoning</p>
                            <p class="text-sm text-gray-400">${escHtml(p.justification)}</p>
                        </div>
                        <div class="mb-6">
                            <p class="text-xs text-gray-500 mb-2">Proposed Changes (${p.actions.length})</p>
                            <div class="space-y-2">${actionsHtml}</div>
                        </div>
                        <div id="approvalButtons" class="flex gap-3">
                            <button onclick="approveProposal(${p.id})"
                                class="flex-1 bg-ledger-success hover:bg-green-600 text-white py-3 rounded-lg text-sm font-medium transition">
                                Approve &amp; Execute
                            </button>
                            <button onclick="rejectProposal(${p.id})"
                                class="flex-1 bg-ledger-danger hover:bg-red-600 text-white py-3 rounded-lg text-sm font-medium transition">
                                Reject
                            </button>
                        </div>
                        <div id="approvalResult" class="mt-3 hidden"></div>
                    </div>`;
        } catch (err) {
          proposalContent.innerHTML = `<p class="text-sm text-ledger-danger">Failed to load proposal #${id}</p>`;
          proposalEmpty.classList.add("hidden");
          proposalContent.classList.remove("hidden");
        }
      }

      // ── Approve / Reject actions ─────────────────────
      async function approveProposal(id) {
        const btns = document.getElementById("approvalButtons");
        btns.innerHTML =
          '<p class="text-sm text-gray-500 animate-pulse">Executing...</p>';

        const res = await fetch(`/api/proposals/${id}/approve`, {
          method: "POST",
        });
        const data = await res.json();
        const result = document.getElementById("approvalResult");
        result.classList.remove("hidden");

        if (data.success) {
          btns.innerHTML =
            '<p class="text-sm text-ledger-success font-medium">&#10003; Changes applied to ledger</p>';
          result.innerHTML = `<div class="text-xs text-ledger-success bg-ledger-success/10 border border-ledger-success/20 rounded-lg p-3">
                    ${data.change_log ? data.change_log.map((c) => `<p>${escHtml(c)}</p>`).join("") : "Done."}
                </div>`;
          addMessage(
            "assistant",
            `Proposal #${id} approved and executed. ${data.change_log?.length || 0} cell(s) updated.`,
          );
        } else {
          btns.innerHTML = `<p class="text-sm text-ledger-danger">Execution failed</p>`;
          result.innerHTML = `<p class="text-xs text-ledger-danger">${escHtml(data.message)}</p>`;
          addMessage(
            "assistant",
            `Proposal #${id} execution failed: ${data.message}`,
          );
        }
      }

      async function rejectProposal(id) {
        const btns = document.getElementById("approvalButtons");
        btns.innerHTML =
          '<p class="text-sm text-gray-500 animate-pulse">Rejecting...</p>';

        const res = await fetch(`/api/proposals/${id}/reject`, {
          method: "POST",
        });
        const data = await res.json();
        const result = document.getElementById("approvalResult");
        result.classList.remove("hidden");

        if (data.success) {
          btns.innerHTML =
            '<p class="text-sm text-gray-500">Proposal rejected. No changes made.</p>';
          addMessage(
            "assistant",
            `Proposal #${id} was rejected. No edits were made.`,
          );
        }
      }

      // Load history on page load
      (async () => {
        try {
          const res = await fetch("/api/chat/history");
          const data = await res.json();
          if (data.messages?.length > 0) {
            chatMessages.innerHTML = ""; // Clear the default greeting
            data.messages.forEach((m) =>
              addMessage(m.role, m.content, m.proposal_id),
            );
          }
        } catch {}
      })();
    </script>
  </body>
</html>
```

### Running the Application

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Set your Google AI Studio API key
export GOOGLE_API_KEY="your-gemma-api-key-here"

# 3. Seed the initial ledger (optional — create a starter workbook)
python -c "
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = 'GeneralLedger'
ws.append(['Date','Ref','Description','Account','AccountName','Debit','Credit','Balance'])
ws.append(['','','','','Opening Balance','','','0'])
ws2 = wb.create_sheet('TrialBalance')
ws2.append(['Account','AccountName','Debit','Credit'])
ws2.append(['','','',''])
wb.save('data/ledger.xlsx')
print('Seeded data/ledger.xlsx')
"

# 4. Launch
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

---

## Architecture Summary Table

| Layer             | Technology                         | Responsibility                                                                        |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| **AI Brain**      | Gemma 4 31B via `google-genai` SDK | Natural language understanding, accounting logic, structured JSON proposal generation |
| **Validation**    | Pydantic v2 models                 | Enforces double-entry compliance, schema correctness, required fields                 |
| **API Server**    | FastAPI (async)                    | Routes, state management, orchestration between AI and ledger engine                  |
| **State Store**   | SQLite via `aiosqlite`             | Pending proposals, chat history, ledger snapshots for rollback                        |
| **Ledger Engine** | `openpyxl`                         | Safe cell/range/formula/row writes with pre-execution snapshotting                    |
| **Frontend**      | Vanilla HTML + Tailwind CSS        | Chat interface, proposal diff preview, approve/reject buttons                         |
| **Safety**        | Human-in-the-Loop                  | No write occurs without explicit user approval; full audit trail in SQLite            |

The key design principle throughout: **the AI proposes, the human disposes.** Gemma 4 never has direct write access to the filesystem. Every write is mediated by the approval endpoint, which validates state, snapshots the current file, executes, and logs.
