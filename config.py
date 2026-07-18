"""Central configuration — all hardcoded values live here, overridable via env vars."""

import os

LEDGER_PATH = os.getenv("LEDGER_PATH", "data/ledger.xlsx")
LEDGER_TEMPLATE_PATH = os.getenv("LEDGER_TEMPLATE_PATH", "data/ledger.template.xlsx")
DB_PATH = os.getenv("DB_PATH", "data/accountant.db")
AI_MODEL = os.getenv("AI_MODEL", "gemini-3.1-flash-lite")
AI_TEMPERATURE = float(os.getenv("AI_TEMPERATURE", "0.2"))
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "2"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
TAX_RATE = float(os.getenv("TAX_RATE", "0.0"))
FISCAL_YEAR = int(os.getenv("FISCAL_YEAR", "2026"))
APP_PASSWORD = os.getenv("APP_PASSWORD", "")
AI_TIMEOUT = int(os.getenv("AI_TIMEOUT", "45"))
MAX_INPUT_LENGTH = int(os.getenv("MAX_INPUT_LENGTH", "500"))
CHAT_RATE_LIMIT = os.getenv("CHAT_RATE_LIMIT", "10/minute")
PROPOSAL_TIMEOUT_MINUTES = int(os.getenv("PROPOSAL_TIMEOUT_MINUTES", "15"))
