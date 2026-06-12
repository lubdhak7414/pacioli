# Contributing to AI Accountant

## Prerequisites
- Python 3.11+ (the project is developed against 3.14)
- A Google API key with access to Gemini (`GOOGLE_API_KEY`)

## Setup
```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # then fill in GOOGLE_API_KEY
```

## Running
```bash
export $(grep -v '^#' .env | xargs)   # load env vars (or use a dotenv loader)
uvicorn main:app --reload --port 8000
```
Then open http://localhost:8000.

## Configuration
All tunables live in `config.py` and are overridable via environment
variables — see `.env.example` for the full list (model, temperature,
timeout, log level, fiscal year, paths, etc.).

## Project layout
| File | Responsibility |
|------|----------------|
| `main.py` | FastAPI app, endpoints, request lifecycle, input sanitisation |
| `ai_client.py` | Gemini call with timeout + retry |
| `models.py` | Shared Pydantic models (`Proposal`, `CellAction`, …) |
| `ledger_engine.py` | Excel read/write, validation, double-entry & account checks |
| `db.py` | SQLite (proposals, chat, snapshots, audit log) |
| `config.py` | Central configuration |
| `prompts/system_accountant.txt` | System prompt + few-shot examples |
| `static/index.html` | Single-page dashboard |

## Making changes
1. Branch from the current working tree.
2. Keep new config in `config.py`, not scattered constants.
3. Run `python -m py_compile <file>` (or `ruff check .`) before committing.
4. Manually test the chat → propose → approve flow against a scratch ledger.

## Code style
- Follow the surrounding style; prefer small, focused functions.
- Money is always rounded to 2 decimals before it touches the ledger.
- Every ledger write must preserve double-entry balance.
