# Pacioli

**AI-powered personal bookkeeping.** Talk to your finances in plain English — Pacioli handles the double-entry accounting.

[![Python](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-async-009688.svg)](https://fastapi.tiangolo.com/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## What it does

Record expenses, track income, manage budgets, and generate tax reports — all through natural language. Say "I paid $1,200 for office supplies" and Pacioli proposes a double-entry transaction for your approval.

**Key features:**
- **Natural language input** — "Record $5,000 client payment" → AI proposes the transaction
- **Multi-account** — Checking, savings, credit cards, cash, investments
- **Auto-categorization** — Learns your merchants and assigns categories automatically
- **Budget tracking** — Set monthly limits, see progress bars on the dashboard
- **Recurring transactions** — Rent, salary, subscriptions — set once, execute monthly
- **Tax-ready reports** — Tag deductions, export annual summaries for your accountant
- **Bank CSV import** — Paste CSV, map columns, import with auto-categorization
- **Dashboard** — Balance cards, income vs expenses, spending charts, upcoming bills
- **Dark mode** — Toggle in header, saved to localStorage
- **PWA** — Installable app with offline support

**The AI never touches your numbers.** All math is computed by Python. The LLM only proposes transactions; you approve or reject them. Every change is reversible.

---

## Quick start

```bash
# Install
pip install -r requirements.txt

# Set your API key
export GOOGLE_API_KEY="your-key-here"

# Run
uvicorn main:app --port 8000

# Open http://localhost:8000
```

**Docker:**
```bash
docker build -t pacioli .
docker run -p 8000:8000 -e GOOGLE_API_KEY=your-key pacioli
```

---

## How it works

```
You: "Record $1,200 office supplies"
  → AI proposes: Debit Office Supplies $1,200 / Credit Cash $1,200
  → You review the diff in the proposal panel
  → Approve → ledger updated, or Reject → nothing changes
  → Undo anytime with one click
```

The AI generates a **proposal** (structured JSON). Python validates it against double-entry rules, executes it under file lock, and records everything in an audit trail. If the AI produces invalid output, it self-corrects by feeding the error back and retrying.

---

## Features

| Tab | What it does |
|-----|-------------|
| **Dashboard** | Account balances, income vs expenses, spending charts, budget progress, upcoming bills |
| **Proposals** | Review, approve, or reject AI-generated transactions |
| **Recurring** | Set up rent, salary, subscriptions with auto-advance |
| **Budgets** | Set monthly spending limits per category |
| **Transactions** | Search, filter by date/account/category/amount |
| **Tax** | Tag deductions, auto-tag by category, export CSV for accountant |
| **Accounts** | Manage checking, savings, credit, cash, investment accounts |
| **Categories** | 12 default categories + custom ones + auto-categorization rules |
| **Ledger** | Read-only Excel preview with cell diff highlighting |
| **Audit** | Full history of every executed change |

---

## Configuration

All config in `config.py`, overridable via env vars:

| Variable | Default | Purpose |
|----------|---------|---------|
| `GOOGLE_API_KEY` | _(required)_ | Gemini API key |
| `AI_MODEL` | `gemini-3.1-flash-lite` | LLM model |
| `APP_PASSWORD` | _(empty)_ | API auth (empty = disabled) |
| `DEFAULT_CURRENCY` | `USD` | Base currency for reports |
| `FISCAL_YEAR` | `2026` | Out-of-period warnings |
| `BACKUP_INTERVAL_HOURS` | `24` | Ledger backup frequency |

See `.env.example` for the full list.

---

## Project structure

```
pacioli/
├── main.py            # FastAPI endpoints + approval state machine
├── ai_client.py       # Gemini integration with retry + timeout
├── models.py          # Pydantic schemas + double-entry validators
├── ledger_engine.py   # Excel I/O, FileLock, atomic save, snapshots
├── report_engine.py   # Deterministic Trial Balance / Income / Balance Sheet
├── db.py              # SQLite: proposals, accounts, categories, transactions, budgets, rules, tax, reminders
├── config.py          # Centralized config (env-overridable)
├── prompts/           # System prompt for the AI
├── static/            # Frontend (HTML + CSS + JS)
├── tests/             # pytest suite
├── Dockerfile         # Container build
└── data/
    └── ledger.template.xlsx  # Starter ledger (auto-seeded on first run)
```

---

## License

MIT
