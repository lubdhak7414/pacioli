# 🧮 AI Accountant

> A human-in-the-loop AI accounting ledger. Chat in natural language, review proposed changes, approve with one click.

**Status:** Functional MVP · **Stack:** FastAPI + Gemini 2.5 Flash + SQLite + openpyxl + Tailwind CSS

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       Browser (Dashboard)                        │
│  ┌───────────────┐  ┌─────────────────┐  ┌───────────────────┐  │
│  │  Chat Panel   │  │ Proposal Preview │  │ Approve / Reject  │  │
│  │  (send msg)   │  │  (diff + reason) │  │    Buttons        │  │
│  └───────┬───────┘  └────────▲────────┘  └────────┬──────────┘  │
└──────────┼───────────────────┼────────────────────┼──────────────┘
           │  POST /api/chat   │  GET /api/proposals│  POST /approve
           ▼                   │                    ▼
┌──────────────────────────────┼──────────────────────────────────┐
│              FastAPI Backend  (main.py)                          │
│                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌─────────────────────────┐    │
│  │/api/chat │───▶│ Gemini   │───▶│ Pydantic Validation      │    │
│  │ handler  │    │ 2.5 Flash│    │ (double-entry check)     │    │
│  └──────────┘    └──────────┘    └────────────┬────────────┘    │
│                                               │                  │
│  ┌──────────────┐    ┌──────────┐    ┌────────▼────────────┐    │
│  │/api/approve  │───▶│ Snapshot │───▶│ openpyxl Execute     │    │
│  │ handler      │    │ (backup) │    │ (write to .xlsx)     │    │
│  └──────────────┘    └──────────┘    └─────────────────────┘    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ SQLite: proposals · chat_messages · ledger_snapshots     │    │
│  │ Disk:   data/ledger.xlsx (source of truth)               │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Features

**Chat & Propose**
- Natural language input: "Record a $3,500 payment from a client"
- AI generates a structured double-entry proposal with debit/credit breakdown
- Validation ensures debits equal credits before anything is saved

**Review & Approve**
- Side-by-side proposal preview with old vs new values
- Approve to execute, reject to cancel — the ledger never changes without your permission
- Every approval creates a snapshot for potential rollback

**Report & Verify**
- Ask for a Balance Sheet, Trial Balance, or P&L statement in chat
- Download the raw `ledger.xlsx` at any time to verify in Excel

**Safety Nets**
- Retry logic: AI self-corrects on validation errors (up to 2 retries)
- Proposal expiration: stale pending proposals auto-expire after 15 minutes
- Snapshot backup: every edit preserves a full copy of the ledger before changes

---

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Backend | FastAPI | ≥0.115 |
| Database | SQLite via aiosqlite | ≥0.20 |
| AI Model | Google Gemini 2.5 Flash | via google-genai ≥2.0 |
| Ledger Engine | openpyxl | ≥3.1 |
| Validation | Pydantic v2 | ≥2.10 |
| Frontend | Tailwind CSS (CDN) + vanilla JS | — |
| Runtime | Python | 3.10+ (tested on 3.14) |

---

## Quick Start

### Prerequisites

- Python 3.10 or higher
- A Google API key ([get one free](https://aistudio.google.com/apikey))

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd ai_accountant

# Install dependencies
pip install -r requirements.txt
```

### Configuration

Set your Google API key as an environment variable:

```bash
# Linux / macOS
export GOOGLE_API_KEY="your-key-here"

# Windows PowerShell
$env:GOOGLE_API_KEY="your-key-here"

# Windows CMD
set GOOGLE_API_KEY=your-key-here
```

### Launch

```bash
uvicorn main:app --port 8000 --reload
```

Open **http://localhost:8000** in your browser.

> The SQLite database (`data/accountant.db`) and Excel ledger (`data/ledger.xlsx`) are created automatically on first run.

---

## Usage Walkthrough

### 1. Send a message

Type in the chat:

```
Record a $3,500 payment received from a client for software development services
```

### 2. Review the proposal

The AI generates a proposal with two journal entries:

| Cell | Action | Value |
|------|--------|-------|
| GeneralLedger row 3 | **Debit** Cash (1010) | $3,500 |
| GeneralLedger row 4 | **Credit** Service Revenue (4100) | $3,500 |

The proposal panel shows the summary, reasoning, and a preview of every cell change.

### 3. Approve or reject

- Click **Approve & Execute** — the changes are written to `data/ledger.xlsx`
- Click **Reject** — nothing changes, the proposal is marked as rejected

### 4. Verify

- Download `ledger.xlsx` via the link in the header
- Or ask the AI: "Show me the Cash balance" or "Generate a Trial Balance"

---

## Project Structure

```
ai_accountant/
├── main.py                     # FastAPI app, API endpoints
├── ai_client.py                # Gemini SDK wrapper, Pydantic models
├── db.py                       # SQLite async database layer
├── ledger_engine.py            # openpyxl read/write/snapshot engine
├── prompts/
│   └── system_accountant.txt   # System prompt for the AI model
├── data/
│   ├── ledger.xlsx             # The source-of-truth Excel ledger
│   └── accountant.db           # SQLite: proposals, chat, snapshots
├── static/
│   └── index.html              # Dashboard frontend (Tailwind CSS)
├── requirements.txt            # Python dependencies
├── PLAN.md                     # Original design blueprint
├── PLAN2.md                    # Improvement roadmap
├── HANDOFF.md                  # Project handoff document
└── README.md                   # This file
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_API_KEY` | *(required)* | Google API key for Gemini model access |
| `APP_PASSWORD` | *(none)* | Shared password for app access (if set) |
| `AI_MODEL` | `gemini-2.5-flash` | Gemini model to use |
| `AI_TEMPERATURE` | `0.2` | Model temperature (lower = more deterministic) |
| `MAX_RETRIES` | `2` | Retries when AI returns invalid JSON |
| `LOG_LEVEL` | `INFO` | Python logging level |
| `TAX_RATE` | `0.0` | Default tax rate for transactions |
| `FISCAL_YEAR` | `2025` | Current fiscal year for date validation |

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Serve the dashboard |
| `POST` | `/api/chat` | Send a message → get AI response + proposal |
| `GET` | `/api/chat/history` | Get chat message history |
| `GET` | `/api/proposals/{id}` | Get proposal details for preview |
| `POST` | `/api/proposals/{id}/approve` | Approve & execute a proposal |
| `POST` | `/api/proposals/{id}/reject` | Reject a proposal (no changes) |
| `GET` | `/api/ledger/download` | Download the current ledger as .xlsx |
| `GET` | `/api/health` | System health check |

### Example: Send a chat message

```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Record a $500 office supplies purchase"}'
```

Response:
```json
{
  "assistant_message": "I've prepared a proposed edit for your review...",
  "proposal_id": 1,
  "proposal_summary": "Record $500 office supplies purchase"
}
```

### Example: Approve a proposal

```bash
curl -X POST http://localhost:8000/api/proposals/1/approve
```

Response:
```json
{
  "success": true,
  "message": "Proposal executed successfully.",
  "change_log": [
    "[GeneralLedger] Inserted row 3 with 8 values",
    "[GeneralLedger] Inserted row 4 with 8 values"
  ]
}
```

---

## Human-in-the-Loop Workflow

```
         ┌──────────┐
         │  pending  │  ← AI generates proposal
         └────┬─────┘
              │
     ┌────────┴────────┐
     ▼                  ▼
┌──────────┐     ┌───────────┐
│ executed │     │  rejected │  ← You decide
└──────────┘     └───────────┘

  On approve:
    1. Snapshot current ledger (backup)
    2. Execute all actions via openpyxl
    3. Save ledger.xlsx
    4. Mark proposal as "executed"

  On reject:
    1. Mark proposal as "rejected"
    2. Ledger is untouched
```

---

## Example Prompts

```
# Record transactions
Record a $3,500 payment received from a client for software development services
Record a $500 office supplies purchase paid in cash
We paid $2,400 for 3 months of rent
Paid employee salary of $4,500 for June

# Generate reports
Generate a Balance Sheet
Show me the Trial Balance
What's the current Cash balance?

# Ask questions
How much revenue have we recorded?
What are our total expenses?
```

---

## Known Limitations

| Limitation | Impact | Workaround |
|-----------|--------|------------|
| No authentication | Anyone on the network can access | Set `APP_PASSWORD` env var (planned) |
| No undo button in UI | Can't revert a mistake from the browser | Download ledger from before the change and replace manually |
| AI-generated reports may be inaccurate | Numbers come from the AI, not computed from data | Always verify reports against `ledger.xlsx` directly |
| Single-user only | No concurrent editing support | Only one person should use the app at a time |
| No fiscal period enforcement | AI may suggest dates outside current year | Check proposal dates before approving |
| Tailwind via CDN | Not suitable for production deployment | Use a local Tailwind build for production |
| Python 3.14 compatibility | Some dependency build issues on bleeding-edge Python | Use Python 3.10–3.12 for best compatibility |

---

## Development

```bash
# Run with hot reload
uvicorn main:app --port 8000 --reload

# Run with verbose logging
LOG_LEVEL=DEBUG uvicorn main:app --port 8000 --reload

# Reset the database (start fresh)
rm data/accountant.db
```

---

## License

MIT
