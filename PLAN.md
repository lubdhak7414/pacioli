# AI Accountant — Roadmap & Status

> The original build blueprint and the v2 improvement roadmap have been
> implemented and retired. The items below were the remaining worthwhile work
> after a full code review — **all are now done.** A short "future ideas"
> section captures what's intentionally left for later.

---

## ✅ Done

### Correctness
- **Reports computed from real ledger data** — `report_engine.py` sums Trial
  Balance, Balance Sheet, and Income Statement from actual GeneralLedger rows
  with header-detected columns. The AI never supplies figures; unknown report
  types fall back to a clearly-labelled AI estimate.
- **Running balance column** — recomputed (cumulative debit − credit) on every
  execution in `ledger_engine.recalculate_running_balance`.
- **Fiscal-period check** — proposals dated outside `FISCAL_YEAR` raise a
  non-blocking warning shown in the proposal panel and acknowledgement.

### Trust & robustness
- **Test suite** — `tests/` (report math, ledger execution, model validation,
  input sanitisation, snapshot round-trip). 23 tests.
- **CI** — `.github/workflows/ci.yml` runs ruff + py_compile + pytest on
  Python 3.11 and 3.12 for every push/PR.
- **Snapshot restore (undo)** — `POST /api/proposals/{id}/restore` rolls the
  ledger back to its pre-execution snapshot, with an **Undo** button in the UI.
- **Audit log** — every executed action is recorded in the `audit_log` table.

### Polish & DX
- **Inline ledger preview** — a "Ledger" tab renders any sheet read-only via
  `GET /api/ledger/preview`.
- **Currency formatting** — monetary cells written with the `#,##0.00` format.
- **Dockerfile** + `.dockerignore` for one-command containerised runs.

---

## Future ideas (intentionally out of scope)

Revisit only if the app is deployed publicly or grows a real user base:

- **Auth / rate limiting** — only matters for a network-exposed deployment;
  this runs on localhost. An `APP_PASSWORD` gate is the planned first step.
- **Architecture refactors** — endpoint splitting, dependency injection, DB
  migrations. No user-facing change; current size doesn't warrant them.
- **Structured JSON logging, chat pagination** — premature at this scale.
- **Tax line items, dark mode, onboarding tour** — feature creep for an MVP.
- **Replace Tailwind CDN with a local build** — for production hardening.
