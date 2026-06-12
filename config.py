"""Central configuration — all hardcoded values live here, overridable via env vars."""

import os

LEDGER_PATH = os.getenv("LEDGER_PATH", "data/ledger.xlsx")
DB_PATH = os.getenv("DB_PATH", "data/accountant.db")
AI_MODEL = os.getenv("AI_MODEL", "gemini-2.5-flash")
AI_TEMPERATURE = float(os.getenv("AI_TEMPERATURE", "0.2"))
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "2"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
TAX_RATE = float(os.getenv("TAX_RATE", "0.0"))
FISCAL_YEAR = int(os.getenv("FISCAL_YEAR", "2026"))
APP_PASSWORD = os.getenv("APP_PASSWORD", "")
AI_TIMEOUT = int(os.getenv("AI_TIMEOUT", "45"))
MAX_INPUT_LENGTH = int(os.getenv("MAX_INPUT_LENGTH", "500"))
