# AI Accountant — Project Handoff

> **Created:** 2025-06-08 | **Status:** Functional MVP | **Last Verified:** Full end-to-end flow working

---

## What This Is

A **human-in-the-loop AI accounting ledger** that lets you chat in natural language to record transactions, generate reports, and manage a double-entry bookkeeping system. The AI proposes changes → you approve/reject → the ledger updates.

**Stack:** FastAPI + Google Gemini 2.5 Flash + SQLite + openpyxl + Tailwind CSS

---

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Set your Google API key (get one from https://aistudio.google.com/apikey)
# Windows PowerShell:
$env:GOOGLE_API_KEY="your-key-here"
# Windows CMD:
set GOOGLE_API_KEY=your-key-here
# Linux/Mac:
export GOOGLE_API_KEY="your-key-here"

# 3. Run the server
uvicorn main:app --port 8000 --reload

# 4. Open http://localhost:8000
```

---

## Project Structure

```
ai_accountant/
├── main.py                     # FastAPI app, all API endpoints
├── ai_client.py                # Gemini SDK wrapper (timeout + retry)
├── models.py                   # Shared Pydantic models & validation
├── report_engine.py            # Reports computed from real ledger data
├── db.py                       # SQLite async layer (proposals/chat/snapshots/audit)
├── ledger_engine.py            # openpyxl read/write/snapshot/restore
├── config.py                   # Central env-overridable configuration
├── prompts/
│   └── system_accountant.txt   # System prompt for Gemini
├── data/
│   ├── ledger.xlsx             # The source-of-truth Excel ledger
│   └── accountant.db           # SQLite: proposals, chat, snapshots, audit
├── static/
│   └── index.html              # Dashboard frontend (Proposal + Ledger tabs)
├── tests/                      # pytest suite
├── .github/workflows/ci.yml    # ruff + py_compile + pytest
├── Dockerfile
├── requirements.txt
├── requirements-dev.txt
├── PLAN.md                     # Remaining work / roadmap
└── HANDOFF.md                  # This file
```

---

## Architecture

```
Browser (Tailwind CSS Dashboard)
    │
    ├── POST /api/chat ──────────► FastAPI
    │                                  │
    │                                  ├── sanitize_input() (strip role tags, flag injection, cap length)
    │                                  ├── Store message in SQLite
    │                                  ├── Load ledger summary (30s cache) + chat history
    │                                  │
    │                                  ▼   ┌──── retry loop (MAX_RETRIES) ────┐
    │                                  ├── │ Call Gemini (asyncio timeout 45s)│
    │                                  │   │   └─ 503? retry once after 3s     │
    │                                  │   │ Parse JSON (truncation guard)     │
    │                                  │   │ proposal must be a dict           │
    │                                  │   │ Validate with Pydantic ───────────┤
    │                                  │   │   ├─ per-action field rules        │
    │                                  │   │   ├─ formula safety (=, no EXEC…)  │
    │                                  │   │   ├─ round money to 2dp            │
    │                                  │   │   └─ debits == credits             │
    │                                  │   │ fail? feed error back, retry ─────┘
    │                                  │
    │                                  ├── accounting_equation_check.balance_confirmed?
    │                                  ├── Store proposal (status=pending)
    │                                  └── Return proposal_id
    │
    ├── GET /api/proposals/{id} ──► Fetch proposal + old/new diff for preview
    │
    ├── POST /api/proposals/{id}/approve
    │        │
    │        ├── atomic UPDATE pending→executed (idempotency; 409 if already acted)
    │        ├── Snapshot ledger bytes → SQLite
    │        └── execute_actions() under FileLock
    │              ├── pre-flight double-entry check (sum debit col == credit col)
    │              ├── account number ∈ ChartOfAccounts?  (else reject)
    │              ├── cell bounds check (no far out-of-range writes)
    │              ├── round money, write cells, save xlsx
    │              └── invalidate summary cache
    │
    └── POST /api/proposals/{id}/reject ──► Mark rejected, no changes

Background: cleanup_stale_proposals() every 5 min auto-rejects
proposals pending > 15 min. Ledger is backed up on startup (last 10 kept).
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Serve dashboard HTML |
| `GET` | `/api/health` | System health (db, model, ledger presence) |
| `POST` | `/api/chat` | Send message → get AI response + optional proposal |
| `GET` | `/api/chat/history` | Get chat message history |
| `GET` | `/api/proposals` | List recent proposals (`?limit=10`) |
| `GET` | `/api/proposals/{id}` | Get proposal details for preview |
| `POST` | `/api/proposals/{id}/approve` | Approve & execute proposal (atomic) |
| `POST` | `/api/proposals/{id}/reject` | Reject proposal (no changes) |
| `POST` | `/api/proposals/{id}/restore` | Undo: restore ledger from the pre-execution snapshot |
| `GET` | `/api/audit` | Audit log of executed cell writes |
| `GET` | `/api/ledger/preview` | Read-only JSON preview of a sheet (`?sheet=&limit=`) |
| `GET` | `/api/ledger/download` | Download current ledger.xlsx |

---

## Database Schema (SQLite)

**`chat_messages`** — Chat history
- `id`, `role` (user/assistant/system), `content`, `proposal_id` (FK), `created_at`

**`proposals`** — Edit proposals awaiting approval
- `id`, `status` (pending/approved/rejected/executed/failed), `user_message`, `ai_reasoning`, `actions_json`, `created_at`

**`ledger_snapshots`** — Backup before each edit
- `id`, `proposal_id` (FK), `snapshot` (blob), `created_at`

---

## Key Design Decisions

### 1. Model: Gemini 2.5 Flash (not Gemma 4)
The original plan specified Gemma 4 31B, but it's not available via the `google-genai` SDK. Gemini 2.5 Flash works well and is faster.

### 2. JSON Mode Without Schema Constraint
Using `response_mime_type="application/json"` alone (no `response_schema`). Adding a JSON schema caused Gemini to go into infinite loops generating 50K+ char responses. JSON mode + Pydantic validation + retry logic is more reliable.

### 3. Retry Logic
The `/api/chat` endpoint retries up to 2 times if Pydantic validation fails, feeding the error back to the AI so it can self-correct.

### 4. 503 Retry
The `ai_client.py` retries once on Google 503 UNAVAILABLE errors with a 3-second delay.

### 5. Pydantic `CellAction` is lenient
`new_value` accepts `str | float | int | list` because Gemini sometimes puts row data in `new_value` instead of `values` for `insert_row` operations. The validator auto-normalizes this.

### 6. Reports are computed, not generated
`report_engine.py` sums Trial Balance / Balance Sheet / Income Statement directly from the GeneralLedger rows (column positions auto-detected from headers). The AI only triggers the request; it never supplies the figures. Unknown report types fall back to the AI's structure, clearly labelled as estimated.

### 7. Snapshot restore (undo)
A snapshot of `ledger.xlsx` is saved to SQLite before every execution. `POST /api/proposals/{id}/restore` writes that blob back under the file lock, so any executed change is reversible from the UI.

---

## AI Response Format

The AI returns one of two JSON shapes:

**Transaction proposal:**
```json
{
  "proposal": {
    "summary": "Record $3,500 client payment",
    "justification": "Cash increases (debit) and revenue increases (credit)...",
    "accounting_equation_check": {
      "assets_change": 3500, "liabilities_change": 0,
      "equity_change": 3500, "balance_confirmed": true
    },
    "actions": [
      {"operation": "insert_row", "sheet": "GeneralLedger", "row_index": 3,
       "values": ["2025-06-08", "TXN-001", "Client payment", "1010", "Cash", 3500, 0, 3500],
       "context": "Debit: Cash received"},
      {"operation": "insert_row", "sheet": "GeneralLedger", "row_index": 4,
       "values": ["2025-06-08", "TXN-001", "Client payment", "4100", "Service Revenue", 0, 3500, 3500],
       "context": "Credit: Revenue earned"}
    ]
  }
}
```

**Report:**
```json
{
  "report": {
    "title": "Balance Sheet",
    "sections": [{"heading": "Assets", "lines": [...]}],
    "totals": {"total_assets": 100000, ...},
    "balanced": true
  }
}
```

---

## Supported Operations

| Operation | Description | Required Fields |
|-----------|-------------|-----------------|
| `insert_row` | Insert a new row (preferred for new transactions) | `sheet`, `row_index`, `values` |
| `write_cell` | Write a single cell value | `sheet`, `cell_ref`, `new_value` |
| `write_formula` | Set a cell formula | `sheet`, `cell_ref`, `formula` |
| `write_range` | Write a block of cells | `sheet`, `start_cell`, `end_cell`, `values_2d` |

---

## Chart of Accounts

| Range | Type | Examples |
|-------|------|----------|
| 1000-1999 | Assets | 1010 Cash, 1200 Accounts Receivable |
| 2000-2999 | Liabilities | 2100 Accounts Payable |
| 3000-3999 | Equity | 3100 Retained Earnings |
| 4000-4999 | Revenue | 4100 Service Revenue |
| 5000-5999 | COGS | 5100 Cost of Goods Sold |
| 6000-6999 | Expenses | 6050 Office Supplies, 6100 Rent |

---

## Known Issues & Limitations

1. **No real authentication** — Anyone with network access can approve/reject
3. **CDN Tailwind** — Not production-ready; should be replaced with a local build
4. **Single-user** — No concurrent user support or locking
5. **AI sometimes uses `new_value` for lists** — The Pydantic validator normalizes this, but it's a quirk of Gemini's JSON generation
6. **Occasional 503s** — Google API can be overloaded; handled with single retry + 3s delay
7. **Python 3.14** — Built on 3.14.3; some dependencies had build issues (resolved with `>=` version pins)

---

## Example Prompts to Test

```
Record a $3,500 payment received from a client for software development services
Record a $500 office supplies purchase paid in cash
We paid $2,400 for 3 months of rent
Paid employee salary of $4,500 for June
Generate a Balance Sheet
Show me the Trial Balance
What's the current Cash balance?
```

---

## How to Modify

### Add a new operation type
1. Add enum value to `OperationType` in `ai_client.py`
2. Add validation rules in `CellAction.validate_operation_fields()`
3. Add execution logic in `ledger_engine.py execute_actions()`
4. Update `prompts/system_accountant.txt` with examples

### Change the AI model
Update the model name in `ai_client.py` line ~278:
```python
response = get_client().models.generate_content(
    model="gemini-2.5-flash",  # Change this
    ...
)
```

### Add new sheets to the ledger
1. Edit `data/ledger.xlsx` directly in Excel
2. The AI auto-discovers sheets via `ledger_engine.get_ledger_summary()`
3. No code changes needed

### Tune AI behavior
Edit `prompts/system_accountant.txt`:
- Add examples for specific transaction types
- Adjust length limits ("context: max 10 words")
- Add domain-specific rules

---

## File Dependencies

```
main.py
  ├── db.py (SQLite)
  ├── ai_client.py (Gemini + Pydantic models)
  │     └── prompts/system_accountant.txt
  └── ledger_engine.py (openpyxl)

static/index.html
  └── (standalone, calls API endpoints)
```
