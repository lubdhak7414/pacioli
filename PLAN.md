# AI Accountant — Remaining Work

> The original build blueprint and the v2 improvement roadmap are done and have
> been retired. This file tracks only what is **still worth building**, curated
> after a full review of the current code. Effort: S = hours, M = 1–2 days,
> L = 3–5 days.

---

## Priority 1 — Correctness (do these first)

### 1.1 Reports computed from real ledger data  ·  L
**Problem:** When a user asks for a Balance Sheet / Trial Balance / P&L, the
numbers come from the AI, which can hallucinate them. An accounting tool that
reports wrong balances is worse than none.

**Plan:**
- New `report_engine.py` with `trial_balance()`, `balance_sheet()`,
  `income_statement()`. Each reads `ledger.xlsx`, groups GeneralLedger rows by
  account number, and sums debits/credits using `get_column_indices()` (already
  in `ledger_engine.py`) — never hardcoded column numbers.
- In `main.py`, when the AI returns `{"report": ...}`, keep its section/heading
  *structure* but overwrite every figure with the computed value.
- Update `prompts/system_accountant.txt`: "For reports, return headings and
  structure only — the backend fills in the numbers."
- Add `tests/test_report_engine.py` with a fixture ledger of known transactions.

### 1.2 Running balance column  ·  M
**Problem:** The Balance column is always 0, so the raw ledger isn't usable
without external formulas.

**Plan:** In `ledger_engine.execute_actions()`, after writing rows, recompute
the Balance column top-to-bottom (`balance += debit - credit`) using the header
indices. Shares logic with 1.1, so build them together.

### 1.3 Fiscal-period check  ·  S
**Problem:** `config.FISCAL_YEAR` exists but is unused; transactions can be dated
in the wrong year.

**Plan:** In the proposal validator, flag any `insert_row` whose date doesn't
fall in `FISCAL_YEAR` and surface it as a non-blocking warning in the preview so
the user sees it before approving.

---

## Priority 2 — Trust & robustness

### 2.1 Test suite + CI  ·  M
**Problem:** There are no automated tests. For a public repo this is the biggest
credibility gap.

**Plan:**
- `pytest` covering: double-entry enforcement, formula-injection rejection,
  Chart-of-Accounts validation, input sanitization, atomic approval (409 on
  double-approve), and (after 1.1) report math.
- `.github/workflows/ci.yml`: run `ruff check .`, `python -m py_compile`, and
  `pytest` on push / PR. Add the build badge to `README.md`.

### 2.2 Restore from snapshot ("undo")  ·  S
**Problem:** A ledger snapshot is saved before every edit but can never be
restored — the data is dead weight today.

**Plan:** `POST /api/proposals/{id}/restore` rewrites `ledger.xlsx` from the
stored snapshot blob (under the same `FileLock`, invalidating caches and writing
an audit row). Add a small "Undo this change" button in the proposal history
panel.

---

## Priority 3 — Polish & DX

### 3.1 Inline ledger preview  ·  M
`GET /api/ledger/preview?sheet=GeneralLedger` returns the first ~50 rows as JSON;
add a "Ledger" tab in the right panel rendering it as a sticky-header table, so
users can see the ledger without opening Excel.

### 3.2 Currency formatting in Excel  ·  S
Set `cell.number_format = '#,##0.00'` on monetary columns (Debit/Credit/Balance)
when writing, using the header indices.

### 3.3 Dockerfile  ·  S
A slim `python:3.12-slim` image + `.dockerignore` for one-command runs:
`docker run -e GOOGLE_API_KEY=... -p 8000:8000 ai-accountant`.

---

## Explicitly out of scope (for this MVP)

Deferred from the v2 roadmap — revisit only if the app gets deployed publicly or
grows a real user base:

- **Auth / rate limiting** (matters only for a network-exposed deployment; this
  runs on localhost).
- **Architecture refactors** — endpoint splitting, dependency injection, DB
  migrations (no user-facing change; current size doesn't warrant it).
- **Structured JSON logging, chat pagination** (premature at this scale).
- **Dark mode, onboarding tour, tax line items** (cosmetic / feature creep).
