# AGENTS.md

## Agent Roles

### build (default)
The primary agent. Full tool access — reads, writes, edits, runs shell commands, spawns subagents. Handles all user-facing tasks: bug fixes, feature implementation, refactoring, testing, and deployment.

### explore
Read-only codebase explorer. Fast searches across file patterns and content. Use for:
- Finding where a function/class is defined
- Tracing call chains across modules
- Understanding data flow (e.g. how a proposal moves from `/api/chat` to the ledger)
- Searching for patterns like error handling, validation, or retry logic

**Thoroughness levels:**
- `quick` — single-file or obvious lookups
- `medium` — cross-file searches (e.g. "where is `_check_double_entry` called?")
- `very thorough` — deep architectural questions (e.g. "how does the snapshot/restore lifecycle work?")

### general
Multi-step worker for delegated tasks. Has full tool access but runs non-interactively. Use for:
- Parallel research (e.g. "investigate all test failures")
- Long-running investigations that benefit from isolated context
- Implementing a well-scoped subtask with clear acceptance criteria

---

## Project Conventions

### Language & Runtime
- **Python 3.11+** (developed against 3.14 per CONTRIBUTING.md)
- **FastAPI** async backend, **SQLite** via aiosqlite (WAL mode), **openpyxl** for Excel I/O
- All code in the repo root (`/`); no `src/` directory

### Code Style
- **ruff** for linting: `ruff check .` — select rules `["F", "E9"]` (pyflakes + syntax errors only)
- **No docstrings on public functions** unless the WHY is non-obvious
- Line length: 100 characters (`pyproject.toml`)
- Prefer small, focused functions over large monoliths
- Money is always rounded to 2 decimals before touching the ledger

### Testing
- **pytest** — test files in `tests/`, fixtures in `tests/conftest.py`
- `conftest.py` builds a known in-memory ledger fixture (`ledger`) — tests never touch `data/ledger.xlsx`
- Run: `pytest` (from repo root; `pythonpath = ["."]` is set in pyproject.toml)
- CI: `ruff check .` → `py_compile *.py` → `pytest` (GitHub Actions, Python 3.11 + 3.12 matrix)

### Configuration
- All tunables in `config.py`, overridable via env vars
- See `.env.example` for the full list
- Never scatter hardcoded constants — always route through `config.py`

### Data & State
- `data/ledger.xlsx` — live ledger (gitignored, real financial data)
- `data/ledger.template.xlsx` — committed starter workbook, seeds the ledger on first run
- `data/accountant.db` — SQLite state store (gitignored)
- To reset: delete `data/ledger.xlsx` and restart

### Architecture Invariants (do not violate)
1. **The LLM never reports a number.** All financial figures come from `report_engine.py` computed from the GeneralLedger.
2. **The LLM never writes directly.** Proposals are schema-validated (`models.py`) and require human approval before execution.
3. **Double-entry balance is enforced** at three layers: Pydantic schema (`Proposal.enforce_debit_equals_credit`), pre-flight check (`ledger_engine._check_double_entry`), and the model's own `accounting_equation_check`.
4. **Every execution is reversible.** Snapshots are byte-exact, captured inside the same file lock as the write.
5. **Atomic state transitions.** Proposal approval uses a conditional SQL UPDATE that prevents double-approval race conditions.
6. **Column positions are detected from headers**, never hardcoded — the system survives schema reordering.

### Key Modules
| Module | Responsibility |
|--------|---------------|
| `main.py` | FastAPI app, endpoints, self-correction loop, input sanitisation, fiscal-year warnings |
| `ai_client.py` | Gemini transport via `google-genai` SDK: timeout + transient-error retry, JSON/shape guards, empty-response detection |
| `models.py` | Pydantic schema (`Proposal`, `CellAction`, `EquationCheck`, `OperationType`) + double-entry / formula-safety validators |
| `report_engine.py` | Deterministic Trial Balance / Income Statement / Balance Sheet; `generate()` dispatches from free text, `render_markdown()` for output |
| `ledger_engine.py` | openpyxl I/O, FileLock, atomic save, snapshot/restore, double-entry pre-flight, account-number validation, cell bounds checks, running balance recalculation |
| `db.py` | Async SQLite (WAL mode): proposals, chat, snapshot BLOBs, audit log, stale-proposal cleanup |
| `config.py` | Central, env-overridable configuration (see `.env.example`) |
| `prompts/system_accountant.txt` | System prompt with few-shot examples for the model |

### API Surface
| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/health` | DB / model / ledger health |
| `POST` | `/api/chat` | Submit message → proposal or computed report |
| `GET` | `/api/chat/history` | Full chat history |
| `GET` | `/api/proposals` | List recent proposals |
| `GET` | `/api/proposals/{id}` | Proposal detail with per-cell diff |
| `POST` | `/api/proposals/{id}/approve` | Atomically approve & execute |
| `POST` | `/api/proposals/{id}/reject` | Reject (no changes) |
| `POST` | `/api/proposals/{id}/restore` | Restore pre-execution snapshot |
| `GET` | `/api/audit` | Audit log of executed writes |
| `GET` | `/api/ledger/preview` | Read-only JSON preview of a sheet |
| `GET` | `/api/ledger/download` | Download the current `ledger.xlsx` |

### Input Sanitisation
- `sanitize_input()` (`main.py:42-46`) strips role tags (`[SYSTEM]`, `[ASSISTANT]`, etc.) and truncates to `MAX_INPUT_LENGTH`
- Prompt-injection patterns (`ignore previous`, `disregard above`) are logged as warnings
- `_trim_for_context()` (`main.py:64-76`) caps each chat turn at 600 chars before re-sending to the model

### Safety Guards at Execution Time
- **Account-number validation** (`ledger_engine.py:354-364`): `insert_row` actions are validated against the live ChartOfAccounts via `get_valid_accounts()` — unknown account numbers are rejected with the valid set echoed back
- **Cell bounds validation** (`ledger_engine.py:132-145`): `_validate_cell_bounds()` refuses writes to cells more than 10 rows beyond the sheet's max row
- **Fiscal-period warnings** (`main.py:49-61`): `insert_row` transactions dated outside `config.FISCAL_YEAR` generate non-blocking warnings in the proposal response (proposal is still created, operator sees the warning)

### Background Tasks
- **Stale proposal cleanup** (`db.py:208-225`): auto-rejects proposals pending >15 minutes, runs every 5 minutes
- **Ledger backup on startup** (`main.py:112-118`): creates a timestamped backup of `ledger.xlsx` each time the server starts, retains the last 10

### Report Dispatch
- `report_engine.generate(*texts)` (`report_engine.py:222`) infers report type from free text via `detect_report_type()` (regex matching for "trial balance", "balance sheet", "income statement" etc.)
- `report_engine.render_markdown(report)` formats the computed dict into a Markdown table
- If the requested report type is unknown, `main.py:79-91` (`_render_ai_report`) falls back to the AI's structure but labels it "estimated"

### Self-Correction Pattern
When the LLM returns invalid JSON or a schema-violating proposal, the exact validation error is appended as `SYSTEM FEEDBACK` and the model is asked to repair its output. This runs up to `MAX_RETRIES` (default 2) before surfacing a graceful failure. This pattern is in `main.py` lines 228-298.

### Frontend
- Single-page dashboard in `static/index.html` (Tailwind CSS, vanilla JS)
- Two-column layout: chat (left) + proposal review / ledger preview (right)
- Keyboard shortcuts: `Ctrl+Y` approve, `Ctrl+N` focus chat, `Esc` clear input
