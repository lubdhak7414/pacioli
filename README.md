# Pacioli

**A deterministic double-entry ledger engine with a human-in-the-loop AI proposal layer.**

[![Python](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-async-009688.svg)](https://fastapi.tiangolo.com/)
[![SQLite](https://img.shields.io/badge/state-SQLite%20WAL-003B57.svg)](https://www.sqlite.org/)
[![Lint](https://img.shields.io/badge/lint-ruff-261230.svg)](https://docs.astral.sh/ruff/)
[![CI](https://img.shields.io/badge/CI-ruff%20%2B%20pytest-success.svg)](.github/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## Overview

Pacioli is a bookkeeping system that lets an operator drive a double-entry Excel ledger through natural language, **without ever delegating financial correctness to a language model.**

The design premise is narrow and deliberate: large language models are excellent at *parsing intent* and *structuring* an instruction into well-formed accounting actions, and unreliable at *arithmetic* and *state mutation*. Pacioli draws that line explicitly. The model is confined to producing a structured, schema-validated **proposal**. Every figure in a report, every balance check, and every byte written to disk is computed and gated by deterministic Python.

Nothing the model emits touches the ledger until a human approves it, and anything that *is* approved can be reverted in one call. The result is a system where the AI is a convenience at the edge, not a dependency in the critical path.

**What it is**
- A FastAPI service wrapping an `openpyxl`-backed Excel ledger.
- A proposal/approval state machine persisted in SQLite.
- A deterministic reporting engine (Trial Balance, Income Statement, Balance Sheet).
- A reversible execution layer with per-proposal snapshots and an audit trail.

**What it is not**
- It is not an "AI wrapper." The LLM produces *candidate* edits; it has no write authority and is not trusted for any numeric output.

---

## Architecture & System Design

Pacioli's reliability properties come from four design decisions, each enforced in code rather than convention.

### 1. Self-correcting LLM integration

The model boundary is treated as an unreliable network dependency and a source of malformed output — and handled on both axes.

**Transport resilience** (`ai_client.py`) — every call runs inside `asyncio.wait_for` with a hard timeout (`AI_TIMEOUT`, default 45s), executed off the event loop via `asyncio.to_thread`. A single `_call_with_retry` helper classifies failures: timeouts and transient API errors (`429`, `5xx`, `UNAVAILABLE`, `RESOURCE_EXHAUSTED`) are retried with linear backoff, while non-transient errors (auth, bad request) fail fast on the first attempt. The response is then guarded on three fronts — an empty/blocked candidate (`response.text` is `None` or raises), a `JSONDecodeError`/`TypeError` on parse, and a shape check that rejects any `proposal` that is not a JSON object. Every one of these fails closed with an actionable message rather than propagating a half-parsed structure downstream.

**Semantic self-correction** (`main.py` → `/api/chat`) — structured output is validated against the Pydantic `Proposal` schema, and validation is a feedback loop, not a dead end. When validation fails, the exact validator error is appended back into the next prompt as explicit `SYSTEM FEEDBACK`, and the model is asked to repair its own output. This runs up to `MAX_RETRIES` (default 2) times before surfacing a graceful failure to the operator:

```text
[SYSTEM FEEDBACK — fix these validation errors and retry:]
write_cell requires cell_ref and new_value
Remember: insert_row needs row_index+values; debits must equal credits.
```

This converts the LLM's most common failure mode — *almost*-valid JSON — from a hard error into a recoverable round-trip.

### 2. Deterministic math (the model never reports a number)

Financial figures are never read out of the model's response. `report_engine.py` recomputes every report directly from the `GeneralLedger` rows:

- Debits and credits are summed per account from the source-of-truth sheet.
- Normal-balance direction is resolved from the `ChartOfAccounts` account type (`asset/expense/cogs` are debit-normal; `liability/equity/revenue` are credit-normal).
- Column positions are **detected from header names**, never hardcoded, so the engine survives schema reordering.
- Each report carries its own self-consistency assertion — a Trial Balance reports `balanced` only when debits and credits agree to within a cent; the Balance Sheet only when `Assets == Liabilities + Equity`.

The LLM's role in reporting is reduced to a single token of intent ("show me the balance sheet"); the numbers are Python's. If a requested report type isn't one Pacioli can compute, it falls back to the model's structure but labels it **explicitly as estimated** — hallucinated figures are never silently presented as authoritative.

### 3. Data integrity & concurrency

The write path is defended in depth, and the ordering of those defenses matters.

- **Atomic state transition.** Approval is a single conditional SQL update — `UPDATE … SET status='executed' WHERE id=? AND status='pending'` (`db.approve_proposal_atomic`). The double-approval race is closed at the database, not in application logic: a losing concurrent request observes `rowcount == 0` and receives a `409 Conflict`.
- **Serialized, atomic file I/O.** Every Excel read-modify-write and every restore runs under a cross-process `FileLock` (`filelock`), so concurrent execution can never interleave writes to `ledger.xlsx`. The lock degrades gracefully to a no-op only if the dependency is absent. Within the lock, the workbook is written to a `.tmp` file and swapped in via `os.replace` — an atomic rename — so a crash mid-save leaves either the complete old file or the complete new one, never a torn `.xlsx`. If the lock can't be acquired in time, the approval route catches the `LockTimeout`, returns the proposal to `pending`, and responds `409` so the operator can simply retry.
- **Double-entry pre-flight.** Before any cell is touched, `_check_double_entry` sums the proposed debit and credit columns — located **by header name**, not fixed position, so it stays correct if the ledger columns are reordered — and **aborts the entire batch** if they diverge by more than a cent. The same invariant is enforced at the schema layer by `Proposal.enforce_debit_equals_credit`.
- **Referential integrity, prevented *and* enforced.** The valid Chart of Accounts is rendered from the live workbook (`get_chart_text`) and injected into the system prompt at request time, so the model sees the authoritative account list rather than a hardcoded copy that could drift. Should it propose an account anyway, inserted rows are still validated against the live `ChartOfAccounts` at write time (unknown numbers are rejected with the valid set echoed back), and `_validate_cell_bounds` refuses writes far outside the populated region to contain out-of-range coordinates.
- **Input and formula hardening.** Incoming messages are stripped of injected role tags and flagged for injection patterns (`sanitize_input`); proposed formulas must begin with `=` and are rejected if they contain dangerous tokens (`SYSTEM`, `EXEC`, `SHELL`, `IMPORT`, …). Monetary values are rounded to two decimal places at the schema boundary *and* at write time.

### 4. State reversibility (one-click undo)

Every execution captures a full, byte-exact snapshot of the ledger. Crucially, `execute_actions` takes that snapshot **inside the same file lock** that guards the write, immediately before mutating anything — so the captured bytes are always a consistent pre-execution state, never a copy caught mid-write by a concurrent operation. It returns the snapshot alongside the change log, and `db.save_snapshot()` persists it as a `BLOB` in the `ledger_snapshots` table, keyed to the proposal. Because the snapshot is the *entire file* rather than a computed diff, restoration is total and lossless:

```
POST /api/proposals/{id}/restore
   └─ fetch snapshot BLOB for proposal {id}
      └─ FileLock → write .tmp → os.replace(ledger.xlsx) → invalidate caches
         └─ write audit_log row:  executed → restored
```

`restore_snapshot()` writes the stored bytes back through the same atomic `.tmp` → `os.replace` swap under the file lock, invalidates the summary/column caches, and records the rollback in the audit log. Any executed change is therefore reversible from the UI in a single action. As a second line of defense, the service also rotates timestamped ledger backups on startup (last 10 retained).

---

## Tech Stack

| Layer | Choice | Role |
|---|---|---|
| API | **FastAPI** + Uvicorn | Async HTTP, lifespan-managed startup/shutdown, request logging |
| State | **SQLite** via `aiosqlite` (WAL mode) | Proposals, chat history, snapshot BLOBs, audit log |
| Ledger | **openpyxl** | Read/write of the source-of-truth `ledger.xlsx` |
| Concurrency | **filelock** | Cross-process serialization of ledger I/O |
| Validation | **Pydantic v2** | Schema enforcement and the self-correction feedback contract |
| LLM | **Google Gemini 2.5 Flash** (`google-genai`) | Intent parsing → structured proposals (JSON mode) |
| Frontend | Static HTML + Tailwind CSS | Proposal review & ledger preview dashboard |
| Quality | **ruff** + **pytest** (GitHub Actions CI) | Lint, compile check, test suite |

---

## Local Installation & Quick Start

**Prerequisites:** Python 3.11+ and a Google AI Studio API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)).

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Provide your API key (and any config overrides)
export GOOGLE_API_KEY="your-key-here"     # Linux/macOS
# $env:GOOGLE_API_KEY="your-key-here"     # PowerShell

# 3. Run the service (the live ledger is auto-seeded from the template on first run)
uvicorn main:app --port 8000 --reload

# 4. Open the dashboard
#    http://localhost:8000
```

On first start, Pacioli seeds the working ledger at `data/ledger.xlsx` by copying the committed **`data/ledger.template.xlsx`** — no manual step required. The SQLite state store is created the same way.

Configuration is centralized in `config.py` and fully overridable via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_API_KEY` | _(required)_ | Gemini API credential |
| `AI_MODEL` | `gemini-2.5-flash` | Model identifier |
| `AI_TEMPERATURE` | `0.2` | Low temperature for structural determinism |
| `AI_TIMEOUT` | `45` | Hard request timeout (seconds) |
| `MAX_RETRIES` | `2` | Validation self-correction attempts |
| `LEDGER_PATH` | `data/ledger.xlsx` | Live ledger (gitignored — holds real data) |
| `LEDGER_TEMPLATE_PATH` | `data/ledger.template.xlsx` | Committed starter workbook used to seed the ledger |
| `DB_PATH` | `data/accountant.db` | SQLite state store |
| `FISCAL_YEAR` | `2026` | Drives out-of-period transaction warnings |
| `MAX_INPUT_LENGTH` | `500` | Input cap (defense-in-depth) |

A container build is provided via the included `Dockerfile`. Run the test suite with `pytest`.

### Data & state

The repository ships a clean **`data/ledger.template.xlsx`** (chart of accounts + an empty general ledger). Your actual ledger lives at `data/ledger.xlsx`, which is **gitignored** — it carries real financial data and must never be committed. To reset to a clean slate, delete `data/ledger.xlsx` and restart; it will be re-seeded from the template. The SQLite store (`data/accountant.db`) and timestamped startup backups are gitignored too.

---

## The Human-in-the-Loop Workflow

No ledger mutation occurs without an explicit human approval. A proposal moves through a strict state machine — `pending → executed`, or one of the terminal exits — and the transition into execution is atomic.

```
            ┌─────────────┐
  user msg  │  /api/chat  │  parse intent → Pydantic-validated Proposal
 ─────────► │             │  (self-correcting retry on validation failure)
            └──────┬──────┘
                   │  store proposal
                   ▼
            ┌─────────────┐
            │   PENDING   │◄──── operator reviews diff via /api/proposals/{id}
            └──┬───────┬──┘      (old value → new value, per cell)
       approve │       │ reject / expire (>15 min, auto)
               ▼       ▼
   snapshot ledger   REJECTED ─── ledger untouched
   → BLOB in SQLite
               │
   atomic UPDATE pending→executed   (409 if already acted on)
               │
   execute_actions() under FileLock
   ├─ double-entry pre-flight
   ├─ account-number + bounds checks
   ├─ write cells, recalc running balance, save .xlsx
   └─ append audit_log rows
               ▼
            ┌─────────────┐
            │  EXECUTED   │──── reversible via /api/proposals/{id}/restore
            └─────────────┘
```

1. **Propose.** `/api/chat` sanitizes the message, builds ledger context, and obtains a schema-valid proposal from the model (self-correcting on failure). A read-only request returns a *computed* report instead and never creates a proposal.
2. **Review.** The operator inspects the proposal via `/api/proposals/{id}`, which renders a per-cell `old → new` diff plus any non-blocking warnings (e.g. a transaction dated outside the fiscal year).
3. **Decide.** Approve, reject, or let it expire. Stale proposals are auto-rejected after 15 minutes by a background task.
4. **Execute.** On approval, the ledger is snapshotted, the status is flipped atomically, and the actions run under the file lock with the full validation chain. Every cell write is recorded in the audit log.
5. **Revert (optional).** `/api/proposals/{id}/restore` rolls the ledger back to its exact pre-execution bytes.

---

## Supported Operations

The model may only emit actions from a closed vocabulary, each with enforced required fields (`models.py`):

| Operation | Description | Required fields |
|---|---|---|
| `insert_row` | Insert a new transaction row (preferred for journal entries) | `sheet`, `row_index`, `values` |
| `write_cell` | Write a single cell value | `sheet`, `cell_ref`, `new_value` |
| `write_formula` | Set a cell formula (must start with `=`, dangerous tokens rejected) | `sheet`, `cell_ref`, `formula` |
| `write_range` | Write a rectangular block of cells | `sheet`, `start_cell`, `end_cell`, `values_2d` |

**Computed reports** (numbers derived from the ledger, never from the model):

| Report | Self-consistency guarantee |
|---|---|
| Trial Balance | Total debits == total credits |
| Income Statement | Net income = revenue − expenses |
| Balance Sheet | Assets == Liabilities + Equity (incl. current-period net income) |

### HTTP API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | DB / model / ledger health |
| `POST` | `/api/chat` | Submit a message → proposal or computed report |
| `GET` | `/api/chat/history` | Full chat history |
| `GET` | `/api/proposals` | List recent proposals |
| `GET` | `/api/proposals/{id}` | Proposal detail with per-cell diff |
| `POST` | `/api/proposals/{id}/approve` | Atomically approve & execute |
| `POST` | `/api/proposals/{id}/reject` | Reject (no changes) |
| `POST` | `/api/proposals/{id}/restore` | Restore pre-execution snapshot (undo) |
| `GET` | `/api/audit` | Audit log of executed writes |
| `GET` | `/api/ledger/preview` | Read-only JSON preview of a sheet |
| `GET` | `/api/ledger/download` | Download the current `ledger.xlsx` |

---

## Project Layout

```
pacioli/
├── main.py            # FastAPI app: endpoints, approval state machine, self-correction loop
├── ai_client.py       # Gemini transport: timeout + transient-error retry, empty/JSON/shape guards
├── models.py          # Pydantic schema + double-entry / formula-safety validators
├── report_engine.py   # Deterministic Trial Balance / Income Statement / Balance Sheet
├── ledger_engine.py   # openpyxl I/O, FileLock, atomic save, snapshot/restore, double-entry pre-flight
├── db.py              # Async SQLite: proposals, chat, snapshot BLOBs, audit log
├── config.py          # Central, env-overridable configuration
├── prompts/           # System prompt for the model
├── static/            # Dashboard frontend
├── tests/             # pytest suite (CI: ruff + py_compile + pytest)
└── data/
    └── ledger.template.xlsx   # Committed starter ledger (live ledger.xlsx is seeded from this, gitignored)
```

---

## License

Released under the [MIT License](LICENSE).
