# AI Accountant — Improvement Roadmap (v2)

> Based on a comprehensive code review of the working MVP.
> Prioritized for a university project: visible UX wins and correctness fixes first.

---

## 1. Frontend & UX

### P0 — Critical

**1.1. Proposal Diff Visualization**
- **What:** Show a clear side-by-side diff of old vs new values for each action in the proposal panel, with red/green color coding and cell references.
- **Why:** The current proposal preview shows raw JSON-like data. Users cannot quickly understand what will change, making approval feel risky.
- **Effort:** M (1–2 days)
- **Priority:** P0-critical
- **Implementation:** Replace the current action rendering in `static/index.html` (`loadProposal` function) with a table layout: column 1 = cell reference (e.g., `GeneralLedger!F3`), column 2 = old value (red strikethrough), column 3 = → arrow, column 4 = new value (green). Use the existing `old_value_display` and `new_value_display` fields from the `/api/proposals/{id}` response.

**1.2. Error Feedback in Chat**
- **What:** When AI validation fails or the API returns an error, show a styled error message in the chat (not just plain text), with a suggestion to simplify the request.
- **Why:** The current error message is a raw Pydantic validation error dump, which is incomprehensible to non-technical users.
- **Effort:** S (hours)
- **Priority:** P0-critical
- **Implementation:** In `static/index.html`, detect error messages (containing "validation" or "error") and wrap them in a styled `bg-red-500/10 border border-red-500/30 rounded-lg` container with a ⚠️ icon and a "Try rephrasing" hint. Modify `addMessage()` in the frontend JS.

**1.3. Loading / Thinking States**
- **What:** Show a visible loading indicator while the AI is processing (the `POST /api/chat` call can take 5–30 seconds), and disable the send button.
- **Why:** Users currently have no feedback that the system is working. The typing indicator only shows for a moment before the full response arrives.
- **Effort:** S (hours)
- **Priority:** P0-critical
- **Implementation:** In `static/index.html`, modify the `chatForm` submit handler: immediately show a persistent "Analyzing your request..." banner with a spinner, disable `chatInput` and `sendBtn`, and remove it only when the response arrives. Add a CSS `@keyframes spin` animation.

### P1 — High

**1.4. Keyboard Shortcuts**
- **What:** `Enter` to send, `Escape` to clear input, `Ctrl+Y` to approve the current pending proposal, `Ctrl+N` to focus the chat input.
- **Why:** Accountants and power users expect keyboard-driven workflows. Currently mouse-only.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** Add `keydown` listener on `document` in `static/index.html`. Check `event.key` and `event.ctrlKey`. Wire `Ctrl+Y` to call `approveProposal()` on the currently displayed proposal ID. Store the current proposal ID in a global variable `currentProposalId`.

**1.5. Proposal Status Badges**
- **What:** Show colored status badges (pending=yellow, approved=green, rejected=red, executed=blue, failed=red) next to proposal IDs in chat messages.
- **Why:** Currently there is no visual indication of which proposals have been acted on.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** In the chat message rendering, detect proposal links (e.g., `#12`) and wrap them in a badge `<span class="...">`. Add a small helper function `renderProposalBadge(status, id)` in the frontend JS. The backend already returns `proposal_id` in the chat response.

**1.6. Proposal History Panel**
- **What:** Add a collapsible "Past Proposals" section below the proposal panel showing the last 10 proposals with their status, summary, and a click-to-review action.
- **Why:** Users currently have no way to review what happened to past proposals without downloading the SQLite database.
- **Effort:** M (1–2 days)
- **Priority:** P1-high
- **Implementation:** Add a new endpoint `GET /api/proposals?limit=10` that returns a list of recent proposals with status and summary. In `static/index.html`, add a toggle section below `proposalContent` that fetches and renders this list on click. Use the same card styling as the existing UI.

**1.7. Inline Ledger Preview**
- **What:** Show a read-only table view of the GeneralLedger sheet in a third collapsible panel or tab, so users can see the current state of the ledger without downloading the Excel file.
- **Why:** Users currently cannot see the ledger state without opening Excel. This is the most requested feature for any accounting tool.
- **Effort:** M (1–2 days)
- **Priority:** P1-high
- **Implementation:** Add `GET /api/ledger/preview?sheet=GeneralLedger` endpoint in `main.py` that reads the workbook via `ledger_engine.get_workbook()` and returns the first 50 rows as JSON. In `index.html`, add a "Ledger" tab in the right panel that renders this as an HTML `<table>` with sticky headers. Add tab switching JS.

### P2 — Medium

**1.8. Responsive Layout**
- **What:** On screens < 768px, stack the chat and proposal panels vertically (chat on top, proposal below) with a toggle button to switch between them.
- **Why:** The fixed two-column layout breaks on tablets and phones. Demo presentations often happen on various screen sizes.
- **Effort:** M (1–2 days)
- **Priority:** P2-medium
- **Implementation:** Add Tailwind `md:flex` and `md:w-1/2` classes. Add a floating toggle button visible on mobile that shows/hides each panel. Use CSS `@media (max-width: 768px)` in a `<style>` block.

**1.9. Toast Notifications**
- **What:** Show toast notifications (success/error/info) for approve, reject, and error events, auto-dismissing after 3 seconds.
- **Why:** The current feedback is in-page text that requires scrolling. Toasts provide immediate, non-intrusive feedback.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** Add a `showToast(message, type)` function in `static/index.html` that creates a fixed-position div at bottom-right with `bg-green-500`/`bg-red-500`/`bg-blue-500` background. Append to body, auto-remove with `setTimeout`. Call it from `approveProposal()` and `rejectProposal()` success handlers.

**1.10. Empty State Guidance**
- **What:** Show 3 clickable example prompts in the chat empty state (e.g., "Record a $1,000 expense", "Show me the balance sheet", "What's my cash balance?") that auto-fill and send when clicked.
- **Why:** New users don't know what to type. The current greeting is static text with no actionable starting point.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** In `static/index.html`, after the greeting message, render 3 clickable `<button>` elements styled as cards. On click, set `chatInput.value` and trigger `chatForm.dispatchEvent(new Event('submit'))`.

**1.11. Chat History Search**
- **What:** Add a search input above the chat messages that filters messages by text content.
- **Why:** After many transactions, finding a specific past entry is impossible.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** Add an `<input>` above `chatMessages` in `index.html`. On `input` event, iterate all child divs of `chatMessages`, check `textContent.includes(query)`, and toggle `display: none` on non-matching messages. Pure frontend, no backend changes needed.

### P3 — Low

**1.12. Dark Mode Toggle**
- **What:** Add a sun/moon icon toggle that switches between the current dark theme and a light theme.
- **Why:** The app is already dark-themed; a light option improves accessibility for users in bright environments.
- **Effort:** S (hours)
- **Priority:** P3-low
- **Implementation:** Add a toggle button in the header. Use Tailwind's `dark:` prefix classes. Store preference in `localStorage`. The current color scheme already uses Tailwind utilities, so adding `dark:bg-white` etc. to key elements is straightforward.

**1.13. Onboarding Tour**
- **What:** On first visit, show a 3-step overlay tour: (1) "Type a request here", (2) "AI proposes changes here", (3) "Approve or reject here".
- **Why:** The two-panel layout is non-obvious. First-time users don't know where to look.
- **Effort:** S (hours)
- **Priority:** P3-low
- **Implementation:** Use a simple CSS overlay with positioned arrows. Check `localStorage.getItem('tour_seen')`. Show on first visit, hide on "Got it" click, set `localStorage`.

---

## 2. Backend Reliability & Error Handling

### P0 — Critical

**2.1. API Request Timeout**
- **What:** Add a timeout wrapper around the Gemini API call so that a stuck request doesn't block the FastAPI event loop forever.
- **Why:** The current code has no timeout. If Google's API hangs, the user's browser tab freezes indefinitely. The 30-second timeout observed in testing is the HTTP client default, not a controlled limit.
- **Effort:** S (hours)
- **Priority:** P0-critical
- **Implementation:** In `ai_client.py`, wrap the `generate_content` call with `asyncio.wait_for(response_coroutine, timeout=45)`. Catch `asyncio.TimeoutError` and raise a clear `RuntimeError("AI request timed out after 45s")`. The retry logic in `main.py` will then surface a user-friendly message.

**2.2. Malformed AI Response Handling**
- **What:** Handle edge cases where the AI returns valid JSON but in an unexpected shape (e.g., `{"proposal": "I can't do that"}` instead of a structured object).
- **Why:** The current code does `Proposal(**proposal_data)` which will throw a Pydantic error for non-dict input, but the error message is raw and unhelpful.
- **Effort:** S (hours)
- **Priority:** P0-critical
- **Implementation:** In `main.py`, after `proposal_data = ai_response.get("proposal")`, add: `if not isinstance(proposal_data, dict): return ChatResponse(assistant_message="The AI response was not in the expected format. Please try rephrasing.")`. This catches the case where `proposal` is a string, list, or null.

**2.3. Proposal Expiration Cleanup**
- **What:** Auto-reject proposals that have been pending for more than 15 minutes, and clean up their snapshots.
- **Why:** Stale pending proposals accumulate in the database and confuse users. The HANDOFF.md mentions this but it's not implemented.
- **Effort:** S (hours)
- **Priority:** P0-critical
- **Implementation:** Add a startup background task in `main.py` using `@asynccontextmanager` lifespan: `asyncio.create_task(cleanup_stale_proposals())`. The task runs every 5 minutes, queries `SELECT id FROM proposals WHERE status='pending' AND created_at < datetime('now', '-15 minutes')`, and updates them to `rejected` with error_message="Expired". Add `cleanup_stale_proposals` async function to `db.py`.

### P1 — High

**2.4. Structured Logging**
- **What:** Switch from unstructured `logger.info()` calls to structured JSON logging for server logs.
- **Why:** The current verbose DEBUG-level logging is hard to filter and parse. Structured logs make it easy to grep for errors, filter by endpoint, and measure latency.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** Add `python-json-logger` to `requirements.txt`. In `main.py`, replace `logging.basicConfig()` with: `logging.handlers.RotatingFileHandler` + `pythonjsonlogger.json.JsonFormatter`. Keep the current console handler for development but switch it to INFO level.

**2.5. Health Check Endpoint**
- **What:** Add `GET /api/health` that returns `{"status": "ok", "database": "connected", "ai_model": "gemini-2.5-flash", "ledger_exists": true}`.
- **Why:** Makes it easy to verify the system is running correctly. Useful for demos and basic monitoring.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** Add a new endpoint in `main.py` that: (1) pings SQLite with `SELECT 1`, (2) checks `Path(ledger_engine.LEDGER_PATH).exists()`, (3) returns the JSON. No external dependencies needed.

**2.6. Excel File Locking**
- **What:** Use a file lock (e.g., `fcntl.flock` on Linux, `msvcrt.locking` on Windows, or a cross-platform `filelock` library) when executing actions to prevent concurrent writes.
- **Why:** If two users approve proposals simultaneously, one write could corrupt the other. Even in single-user mode, this protects against race conditions between the approve endpoint and the download endpoint.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** Add `filelock` to `requirements.txt`. In `ledger_engine.py`, wrap `execute_actions` with: `lock = filelock.FileLock(LEDGER_PATH + '.lock'); with lock: wb = get_workbook(); ... wb.save(LEDGER_PATH)`. Also wrap `get_workbook()` calls in `take_snapshot()` and `get_ledger_summary()`.

**2.7. AI Call Timeout Handling in Frontend**
- **What:** Show a "Request is taking longer than usual..." message in the chat if the AI hasn't responded within 10 seconds, and an error message after 60 seconds.
- **Why:** The current frontend has no timeout. If the server hangs, the user sees nothing. The typing indicator eventually disappears with no explanation.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** In `static/index.html`, after starting the `fetch()` call, start a `setTimeout(10000)` that shows "The AI is thinking... this may take a moment." Start a second `setTimeout(60000)` that shows "Request timed out. Please try again." Clear both timers when the response arrives.

### P2 — Medium

**2.8. Configuration via Environment Variables**
- **What:** Move all hardcoded values (DB path, ledger path, model name, temperature, max_retries, log level) to environment variables with sensible defaults.
- **Why:** Currently, changing the model or tuning parameters requires editing source code. Environment variables make the app configurable without code changes.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** Create a `config.py` file with: `MODEL_NAME = os.getenv("AI_MODEL", "gemini-2.5-flash")`, `TEMPERATURE = float(os.getenv("AI_TEMPERATURE", "0.2"))`, `MAX_RETRIES = int(os.getenv("MAX_RETRIES", "2"))`, etc. Import in `ai_client.py` and `main.py`. Add to `requirements.txt` if using `python-dotenv` for `.env` file support.

**2.9. Audit Logging Table**
- **What:** Add an `audit_log` SQLite table that records every action: who approved, what changed, when, and the before/after cell values.
- **Why:** The current change_log is ephemeral (returned in the API response and lost). An audit table provides permanent, queryable history of all ledger modifications.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** Add table to `db.py` INIT_SQL: `CREATE TABLE audit_log (id, proposal_id, action_index, sheet, cell_ref, old_value, new_value, executed_at)`. In `ledger_engine.py execute_actions`, after each successful write, insert a row. Queryable via a new `GET /api/audit` endpoint.

**2.10. Rate Limiting**
- **What:** Add basic rate limiting (e.g., max 10 chat requests per minute per IP) to prevent abuse of the Gemini API.
- **Why:** Without limits, a user (or bot) could run up a large Google API bill by spamming requests.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** Add `slowapi` to `requirements.txt`. In `main.py`: `from slowapi import Limiter; limiter = Limiter(key_func=get_remote_address)`. Apply `@limiter.limit("10/minute")` to the `/api/chat` endpoint. Return 429 with a "Too many requests" message.

### P3 — Low

**2.11. CORS Configuration**
- **What:** Add explicit CORS middleware for development (allow `localhost:*`) and restrict it in production.
- **Why:** Currently no CORS config. If the frontend is ever served from a different port or domain, requests will fail silently.
- **Effort:** S (hours)
- **Priority:** P3-low
- **Implementation:** Add `fastapi.middleware.cors.CORSMiddleware` in `main.py` with `allow_origins=["http://localhost:*", "http://127.0.0.1:*"]` for development. Make configurable via env var for production.

---

## 3. Security & Data Integrity

### P0 — Critical

**3.1. Input Sanitization**
- **What:** Sanitize user chat input to strip potential prompt injection attempts (e.g., "Ignore all previous instructions", role-play injection, system prompt extraction).
- **Why:** A malicious or accidental user input could trick the AI into generating harmful proposals (e.g., writing arbitrary values to cells, ignoring double-entry rules).
- **Effort:** S (hours)
- **Priority:** P0-critical
- **Implementation:** In `main.py`, add a `sanitize_input(text: str) -> str` function that: (1) strips `[SYSTEM]`, `[ASSISTANT]`, `[INST]` tags, (2) detects common injection patterns (regex: `r"(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)"`) and appends a warning to the system prompt, (3) truncates to 500 chars. Apply before storing in DB and before sending to AI.

**3.2. Simple Authentication**
- **What:** Add a single shared password (configured via env var `APP_PASSWORD`) that must be entered before accessing the app. Store a session cookie.
- **Why:** Anyone on the network can currently approve/reject proposals and modify the ledger. Even a simple password gate prevents accidental access by non-project members.
- **Effort:** M (1–2 days)
- **Priority:** P0-critical
- **Implementation:** Add a `GET /login` page with a password form. On submit, compare with `os.getenv("APP_PASSWORD")`. If correct, set a signed cookie (`itsdangerous`). Add a middleware that checks for the cookie on all `/api/*` and `/` routes. Redirect to `/login` if missing. This is a simple session-based approach, not enterprise auth.

**3.3. Formula Injection Prevention**
- **What:** Validate that formulas written by the AI start with `=` and contain only safe characters (no `SYSTEM`, `EXEC`, `SHELL`, `CALL`, etc.).
- **Why:** openpyxl writes formulas as strings. A malicious formula could potentially exploit Excel features when the file is opened. More importantly, the AI could generate dangerous formulas.
- **Effort:** S (hours)
- **Priority:** P0-critical
- **Implementation:** In `ai_client.py`, add a validator to `CellAction` for `write_formula` operations: `if not self.formula.startswith("="): raise ValueError("Formulas must start with =")`. Add a regex check: `re.match(r'^=[A-Z0-9+\-*/().,&\s:]+$', self.formula.upper())`. Reject any formula containing `SYSTEM`, `EXEC`, `CALL`, `OPEN`, `IMPORT`, `LINK`.

### P1 — High

**3.4. Proposal Idempotency**
- **What:** Prevent the same proposal from being approved twice. The current code checks `status == "pending"` but there's a race window between the check and the update.
- **Why:** In concurrent scenarios (two browser tabs, or a click-and-double-click), the same proposal could execute twice, inserting duplicate rows.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** In `db.py`, use an atomic UPDATE: `UPDATE proposals SET status = 'executed' WHERE id = ? AND status = 'pending'`. Check `cursor.rowcount`. If 0, the proposal was already acted on. Return 409 with "Proposal already executed".

**3.5. Cell Reference Validation**
- **What:** Validate that cell references in proposals match the actual workbook dimensions (e.g., don't write to cell `Z999` if the sheet only has 50 rows).
- **Why:** Writing to out-of-bounds cells creates empty rows/columns in the Excel file, bloating it and confusing users.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** In `ledger_engine.py execute_actions`, before writing to a cell, check: `from openpyxl.utils import coordinate_from_string, column_index_from_string; col, row = coordinate_from_string(cell_ref); if row > ws.max_row + 10: raise ValueError(f"Row {row} is too far from existing data (max row: {ws.max_row})")`. Allow a small buffer (10 rows) for new insertions.

**3.6. Decimal Precision Enforcement**
- **What:** Round all monetary values to 2 decimal places before writing to the ledger.
- **Why:** Floating-point arithmetic can produce values like `3499.9999999999995` instead of `3500.00`. This is confusing in accounting and can cause the double-entry check to fail.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** In `ai_client.py`, add a `@field_validator` on `CellAction.new_value` that rounds floats: `if isinstance(v, float): return round(v, 2)`. In `ledger_engine.py execute_actions`, apply `round(float(val), 2)` before writing monetary values. Add a helper `is_monetary_column(sheet, col)` that checks if the column header contains "Debit", "Credit", "Amount", or "Balance".

### P2 — Medium

**3.7. Ledger Backup on Startup**
- **What:** Automatically create a timestamped backup of `ledger.xlsx` on server startup (e.g., `data/ledger_backup_20250608_143000.xlsx`).
- **Why:** If the ledger gets corrupted by a bad AI proposal, there's no easy way to recover without the snapshot blob in SQLite (which is harder to access).
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** In `main.py` lifespan, add: `shutil.copy2(LEDGER_PATH, f"data/ledger_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx")`. Limit backups to the last 10 by deleting oldest files.

**3.8. SQL Injection Prevention (Defense in Depth)**
- **What:** Even though aiosqlite uses parameterized queries, add explicit validation that proposal_id and other integer parameters are actually integers before they reach the DB layer.
- **Why:** Defense in depth. If a future developer accidentally uses string formatting in a query, this catches it.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** In `main.py`, add Pydantic validators on endpoint parameters: `proposal_id: int` is already enforced by FastAPI's type system, but add explicit checks in `db.py` functions: `assert isinstance(proposal_id, int)` at the top of each function.

---

## 4. Accounting Logic & AI Prompting

### P0 — Critical

**4.1. Report Generation from Actual Ledger Data**
- **What:** When the user asks for a report (Balance Sheet, Trial Balance, P&L), compute it from the actual ledger data in `ledger.xlsx` instead of relying on the AI to guess the numbers.
- **Why:** The current implementation asks the AI to generate report numbers, which can be wrong. An accounting tool that shows incorrect balances is worse than no tool at all.
- **Effort:** L (3–5 days)
- **Priority:** P0-critical
- **Implementation:** Create a `report_engine.py` module with functions: `generate_trial_balance()`, `generate_balance_sheet()`, `generate_income_statement()`. Each reads `ledger.xlsx`, groups by account number, sums debits/credits, and returns a structured dict. In `main.py`, detect report requests (AI returns `{"report": ...}`) and replace the AI's numbers with computed numbers. Update the system prompt to tell the AI: "For reports, return the section structure and headings, but the backend will fill in the actual numbers."

**4.2. Double-Entry Enforcement at Execution Time**
- **What:** Before executing any proposal, re-validate that the sum of debits equals the sum of credits across all actions.
- **Why:** The Pydantic validator checks the AI's `context` field for "debit"/"credit" strings, which is fragile. The AI might omit these keywords or misspell them. A hard check on the actual monetary values is more reliable.
- **Effort:** M (1–2 days)
- **Priority:** P0-critical
- **Implementation:** In `ledger_engine.py execute_actions`, before writing anything: compute `total_debits` and `total_credits` from the `values` arrays (column indices 5 and 6 in GeneralLedger = Debit and Credit). If `abs(total_debits - total_credits) > 0.01`, raise `ValueError("Double-entry violation: debits=X != credits=Y")`. This is a safety net independent of the AI's context annotations.

**4.3. Chart of Accounts Validation**
- **What:** Validate that account numbers used in proposals exist in the ChartOfAccounts sheet.
- **Why:** The AI can invent account numbers that don't exist in the ledger, creating orphan entries that never appear in reports.
- **Effort:** S (hours)
- **Priority:** P0-critical
- **Implementation:** In `ledger_engine.py`, add `validate_account_number(account_num: str) -> bool` that reads the ChartOfAccounts sheet and checks if the number exists. Call it in `execute_actions` before writing any row that includes an account number (column D in GeneralLedger). Reject proposals with unknown accounts.

### P1 — High

**4.4. Fiscal Period Enforcement**
- **What:** Restrict transactions to the current fiscal period (configurable, default: current calendar year). Warn if the AI proposes a transaction date outside this range.
- **Why:** Transactions dated in the wrong year are a common accounting error that's hard to catch in a flat Excel ledger.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** In `ai_client.py`, add a validator: `if action.operation == "insert_row" and action.values and len(action.values) > 0: date_val = action.values[0]; if isinstance(date_val, str) and not date_val.startswith(str(datetime.now().year)): warnings.append(f"Date {date_val} is outside current fiscal year")`. Return warnings as part of the proposal preview so the user can see them before approving.

**4.5. Improved System Prompt with Few-Shot Examples**
- **What:** Expand the system prompt with 3-5 diverse examples (expense on credit, revenue receipt, payroll, asset purchase, transfer) to reduce validation errors.
- **Why:** The current prompt has only 1 example. More examples dramatically reduce the AI's tendency to generate invalid JSON structures.
- **Effort:** M (1–2 days)
- **Priority:** P1-high
- **Implementation:** Expand `prompts/system_accountant.txt` to include examples for: (1) cash expense, (2) credit purchase, (3) payroll, (4) revenue receipt, (5) inter-account transfer. Each example should be a complete valid JSON response. Keep the context field to ≤10 words per the existing rule.

**4.6. Debit/Credit Column Detection**
- **What:** Auto-detect which columns in GeneralLedger are Debit and Credit by reading the header row, rather than hardcoding column indices.
- **Why:** If the user adds or rearranges columns, the current hardcoded column indices (5, 6, 7) will be wrong, causing silent data corruption.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** In `ledger_engine.py`, add `get_column_indices(sheet_name) -> dict` that reads row 1 and maps "Debit" → column index, "Credit" → column index, etc. Cache the result. Use these indices in `execute_actions` and in the report engine instead of hardcoded values.

### P2 — Medium

**4.7. Tax Rate Support**
- **What:** Add a configurable tax rate (via env var `TAX_RATE`, default 0%) and the ability to generate tax line items when recording revenue or expenses.
- **Why:** Most real transactions involve sales tax or VAT. Without it, the AI can't accurately record tax liability.
- **Effort:** M (1–2 days)
- **Priority:** P2-medium
- **Implementation:** Add `TAX_RATE` to `config.py`. Update the system prompt to instruct the AI to split transactions into gross, tax, and net when the user mentions "with tax" or "plus tax". Add a "Tax Payable" account (2200) to the Chart of Accounts.

**4.8. Running Balance Calculation**
- **What:** After each approved transaction, recalculate the Balance column in GeneralLedger using a formula or direct calculation.
- **Why:** The Balance column currently shows 0 for all rows. A running balance makes the ledger immediately useful without external formulas.
- **Effort:** M (1–2 days)
- **Priority:** P2-medium
- **Implementation:** In `ledger_engine.py execute_actions`, after writing all rows, read the Balance column index from headers, then iterate rows from bottom to top: `balance = previous_balance + debit - credit`. Write the calculated balance to each row.

### P3 — Low

**4.9. Currency Formatting**
- **What:** Apply Excel number formatting (`#,##0.00`) to all monetary cells when writing values.
- **Why:** Raw numbers like `3500` are harder to read than `$3,500.00` in Excel.
- **Effort:** S (hours)
- **Priority:** P3-low
- **Implementation:** In `ledger_engine.py`, after writing a value to a cell in a monetary column, set: `cell.number_format = '#,##0.00'`. Use the column detection from item 4.6.

---

## 5. Architecture & Code Quality

### P1 — High

**5.1. Extract Config Module**
- **What:** Move all hardcoded constants (paths, model name, temperature, retries, log level) into a single `config.py` module using environment variables with defaults.
- **Why:** Currently, configuration is scattered across `main.py`, `ai_client.py`, `db.py`, and `ledger_engine.py`. Changing a value requires editing multiple files.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** Create `config.py` with dataclass or simple module-level constants: `LEDGER_PATH = os.getenv("LEDGER_PATH", "data/ledger.xlsx")`, `DB_PATH = os.getenv("DB_PATH", "data/accountant.db")`, `AI_MODEL = os.getenv("AI_MODEL", "gemini-2.5-flash")`, etc. Update all imports.

**5.2. Move Pydantic Models to Shared Module**
- **What:** Extract `CellAction`, `Proposal`, `EquationCheck`, and `OperationType` from `ai_client.py` into a new `models.py` file.
- **Why:** `main.py` does `from ai_client import Proposal` inside a function body, which is a code smell. These models are used by both the AI layer and the API layer.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** Create `models.py`, move the Pydantic classes there. Update imports in `ai_client.py` and `main.py`.

**5.3. Separate Report and Chat Endpoints**
- **What:** Split the monolithic `/api/chat` endpoint into smaller, focused functions: `_handle_transaction_request()` and `_handle_report_request()`.
- **Why:** The current `chat()` function is 120+ lines with nested retry loops. This makes it hard to debug and modify.
- **Effort:** M (1–2 days)
- **Priority:** P1-high
- **Implementation:** Extract the retry loop into `async def _process_ai_response(ai_response, request_msg, history, ledger_summary)`. Extract report handling into `async def _format_report(report_data)`. Keep the `chat()` endpoint as a thin orchestrator.

### P2 — Medium

**5.4. Dependency Injection for Engine**
- **What:** Pass `ledger_engine` and `db` as dependencies to FastAPI endpoints using `Depends()`, making testing easier.
- **Why:** Currently, modules are imported directly. This makes unit testing impossible without mocking module-level globals.
- **Effort:** M (1–2 days)
- **Priority:** P2-medium
- **Implementation:** In `main.py`, create `def get_db(): return db` and `def get_ledger(): return ledger_engine`. Use `Depends(get_db)` in endpoints. This is a standard FastAPI pattern.

**5.5. Database Migration Support**
- **What:** Add a simple version tracking to the SQLite schema so that schema changes can be applied incrementally.
- **Why:** Currently, `CREATE TABLE IF NOT EXISTS` means schema changes (like adding the `audit_log` table) require manual SQL or code changes. A version tracker makes it automatic.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** Add a `schema_version` table: `CREATE TABLE schema_version (version INTEGER)`. On startup, check current version and run migration SQL for each version step. Store migrations in a `migrations/` directory as numbered SQL files.

**5.6. Remove DEBUG Logging in Production**
- **What:** Switch the default log level from `DEBUG` to `INFO` and make it configurable via `LOG_LEVEL` env var.
- **Why:** The current DEBUG logging fills the console with noise (every SQL query, every HTTP header). This makes it hard to find actual errors.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** In `main.py`, change `logging.basicConfig(level=logging.DEBUG)` to `logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))`. Keep the detailed AI request/response logging at INFO level.

### P3 — Low

**5.7. Type Hints Throughout**
- **What:** Add complete type hints to all functions in `db.py`, `ledger_engine.py`, and `ai_client.py`.
- **Why:** The current code has partial type hints. Complete hints improve IDE support and catch bugs at write time.
- **Effort:** S (hours)
- **Priority:** P3-low
- **Implementation:** Go through each `.py` file and add return types and parameter types. Use `mypy` or `pyright` to verify.

**5.8. Docstrings on All Public Functions**
- **What:** Add docstrings to every public function in every module.
- **Why:** The current docstrings are sparse. Good docstrings make the code self-documenting.
- **Effort:** S (hours)
- **Priority:** P3-low
- **Implementation:** Add Google-style docstrings to all functions. Include parameter descriptions and return value descriptions.

---

## 6. Performance

### P2 — Medium

**6.1. Ledger Summary Caching**
- **What:** Cache the ledger summary in memory (with a 30-second TTL) so that repeated chat requests don't re-read the Excel file each time.
- **Why:** `get_ledger_summary()` reads the entire workbook on every chat request. With many sheets or rows, this adds latency.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** Add a module-level cache in `ledger_engine.py`: `_summary_cache = {"data": None, "timestamp": 0}`. In `get_ledger_summary()`, check `time.time() - _summary_cache["timestamp"] < 30`. If fresh, return cached. Otherwise regenerate. Invalidate the cache when `execute_actions()` runs.

**6.2. Chat History Pagination**
- **What:** Support cursor-based pagination for chat history instead of loading all messages at once.
- **Why:** After many conversations, the `/api/chat/history` response grows large and slow.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** Change `GET /api/chat/history` to accept `?before_id=50&limit=20`. Update the SQL query: `WHERE id < ? ORDER BY id DESC LIMIT ?`. In the frontend, add a "Load more" button at the top of the chat that fetches older messages.

**6.3. SQLite WAL Mode**
- **What:** Enable WAL (Write-Ahead Logging) mode for SQLite to improve concurrent read performance.
- **Why:** The default journal mode locks the entire database during writes, blocking concurrent reads. WAL allows concurrent reads during writes.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** In `db.py init_db()`, add: `await db.execute("PRAGMA journal_mode=WAL")`. This is a one-line change with significant performance benefits.

---

## 7. Documentation

### P1 — High

**7.1. API Documentation**
- **What:** Add OpenAPI descriptions and example request/response bodies to all endpoints using FastAPI's built-in docstring support.
- **Why:** The current Swagger UI (at `/docs`) shows minimal descriptions. Adding examples makes the API self-documenting.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** Add `response_model_example` and `request_body_example` parameters to FastAPI decorators. Add `summary` and `description` to each `@app.post/get` decorator. Example: `@app.post("/api/chat", summary="Send a message to the AI accountant", description="...")`.

**7.2. Architecture Diagram**
- **What:** Update `HANDOFF.md` with a more detailed architecture diagram showing the data flow, including the retry loop, validation pipeline, and snapshot mechanism.
- **Why:** The current diagram is good but doesn't show the retry logic, validation steps, or error handling paths.
- **Effort:** S (hours)
- **Priority:** P1-high
- **Implementation:** Add an ASCII diagram in `HANDOFF.md` showing the full flow: User → Chat Input → Store Message → Build Context → AI Call → (retry on 503) → Parse JSON → (retry on validation fail) → Check Equation → Store Proposal → Return to User → Preview → Approve → Snapshot → Execute → Save.

### P2 — Medium

**7.3. Environment Variable Reference**
- **What:** Create a `.env.example` file listing all supported environment variables with descriptions and default values.
- **Why:** New developers don't know what configuration options are available without reading source code.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** Create `.env.example` with: `GOOGLE_API_KEY=your-key-here`, `APP_PASSWORD=changeme`, `AI_MODEL=gemini-2.5-flash`, `AI_TEMPERATURE=0.2`, `MAX_RETRIES=2`, `LOG_LEVEL=INFO`, `TAX_RATE=0.0`, `FISCAL_YEAR=2025`.

**7.4. Contributing Guide**
- **What:** Add a brief `CONTRIBUTING.md` explaining how to set up the dev environment, run the app, and submit changes.
- **Why:** If other students need to contribute to the project, they need a clear onboarding path.
- **Effort:** S (hours)
- **Priority:** P2-medium
- **Implementation:** Create `CONTRIBUTING.md` with sections: Prerequisites, Setup, Running, Making Changes, Code Style.

---

## Quick Wins

These are items that are **S effort** (hours) and **P0 or P1** priority. They provide the highest value for the least effort — perfect for an afternoon of work.

| # | Item | Priority | What It Fixes |
|---|------|----------|---------------|
| 1 | **1.2** Error Feedback in Chat | P0 | Users see raw Pydantic errors |
| 2 | **1.3** Loading States | P0 | No feedback during 5-30s AI calls |
| 3 | **1.4** Keyboard Shortcuts | P1 | Mouse-only workflow |
| 4 | **1.5** Proposal Status Badges | P1 | No visual status in chat |
| 5 | **2.1** API Request Timeout | P0 | Hung requests freeze the app |
| 6 | **2.2** Malformed AI Response Handling | P0 | Crash on weird AI output |
| 7 | **2.3** Proposal Expiration | P0 | Stale proposals accumulate |
| 8 | **2.5** Health Check Endpoint | P1 | No way to verify system status |
| 9 | **3.1** Input Sanitization | P0 | Prompt injection possible |
| 10 | **3.3** Formula Injection Prevention | P0 | Unsafe formulas can be written |
| 11 | **3.4** Proposal Idempotency | P1 | Double-approve race condition |
| 12 | **3.5** Cell Reference Validation | P1 | Out-of-bounds writes bloat Excel |
| 13 | **3.6** Decimal Precision | P1 | Float rounding errors in ledger |
| 14 | **4.3** Chart of Accounts Validation | P0 | AI invents fake account numbers |
| 15 | **5.1** Extract Config Module | P1 | Config scattered across files |
| 16 | **5.2** Move Pydantic Models | P1 | Models imported in wrong places |
| 17 | **6.1** Ledger Summary Caching | P2 | Excel re-read on every request |
| 18 | **6.3** SQLite WAL Mode | P2 | Read/write contention |
| 19 | **7.1** API Documentation | P1 | Swagger UI is sparse |
| 20 | **1.9** Toast Notifications | P2 | No non-intrusive feedback |
| 21 | **1.10** Empty State Guidance | P2 | New users don't know what to type |

---

## Implementation Order (Suggested)

**Week 1: Safety & Reliability** (P0 items)
- 2.1 API timeout, 2.2 malformed response handling, 2.3 proposal expiration
- 3.1 input sanitization, 3.3 formula injection, 3.4 idempotency, 3.5 cell validation, 3.6 decimal precision
- 4.1 report generation from real data, 4.2 double-entry enforcement at execution, 4.3 chart of accounts validation

**Week 2: UX Polish** (P0 + P1 frontend)
- 1.1 proposal diff visualization, 1.2 error feedback, 1.3 loading states
- 1.4 keyboard shortcuts, 1.5 status badges, 1.6 proposal history, 1.7 ledger preview
- 2.5 health check, 4.5 improved system prompt

**Week 3: Architecture & Quality** (P1 backend)
- 3.2 simple auth, 5.1 config module, 5.2 models module, 5.3 separate endpoints
- 4.4 fiscal period, 4.6 column detection, 7.1 API docs

**Week 4: Polish** (P2 + P3)
- 1.8 responsive layout, 1.9 toasts, 1.10 empty states, 1.11 search
- 2.8 config via env vars, 2.9 audit log, 2.10 rate limiting
- Everything else from P2/P3
