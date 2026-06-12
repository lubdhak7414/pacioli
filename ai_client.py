"""Gemini 2.5 Flash integration via Google GenAI SDK."""

import asyncio
import json
import logging
import os
import time

from google import genai
from google.genai import types

import config
from models import CellAction, EquationCheck, OperationType, Proposal

logger = logging.getLogger(__name__)

SYSTEM_PROMPT_PATH = "prompts/system_accountant.txt"

# Re-export models so callers that did `from ai_client import Proposal` still work.
__all__ = ["call_model", "Proposal", "CellAction", "EquationCheck", "OperationType"]

# ── Client ────────────────────────────────────────────────────────
_client = None


def get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GOOGLE_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "GOOGLE_API_KEY environment variable is not set."
            )
        _client = genai.Client(api_key=api_key)
    return _client


_SYSTEM_PROMPT: str | None = None

# Transient API failures worth a retry: rate limits and server-side outages.
_RETRYABLE_MARKERS = ("429", "500", "503", "UNAVAILABLE", "RESOURCE_EXHAUSTED", "INTERNAL")


def load_system_prompt() -> str:
    """Read the static system prompt once and cache it for the process lifetime."""
    global _SYSTEM_PROMPT
    if _SYSTEM_PROMPT is None:
        with open(SYSTEM_PROMPT_PATH, "r") as f:
            _SYSTEM_PROMPT = f.read()
    return _SYSTEM_PROMPT


async def _call_with_retry(sync_call, attempts: int = 2):
    """Run ``sync_call`` off the event loop, retrying transient API errors.

    Timeouts and 429/5xx responses are retried with linear backoff; anything else
    (auth, bad request, malformed call) fails fast on the first attempt.
    """
    for i in range(attempts):
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(sync_call), timeout=config.AI_TIMEOUT
            )
        except asyncio.TimeoutError:
            if i < attempts - 1:
                logger.warning("AI request timed out — retry %d/%d", i + 1, attempts - 1)
                await asyncio.sleep(2 * (i + 1))
                continue
            raise RuntimeError(
                f"AI request timed out after {config.AI_TIMEOUT}s. "
                "Please try again with a simpler request."
            )
        except Exception as e:
            transient = any(marker in str(e) for marker in _RETRYABLE_MARKERS)
            if transient and i < attempts - 1:
                logger.warning("Transient AI error (%s) — retry %d/%d in %ds",
                               type(e).__name__, i + 1, attempts - 1, 2 * (i + 1))
                await asyncio.sleep(2 * (i + 1))
                continue
            logger.error("Gemini call failed: %s: %s", type(e).__name__, e)
            raise


# ── Logging helpers ───────────────────────────────────────────────

def _log_sep(title: str):
    logger.info("=" * 60)
    logger.info("  %s", title)
    logger.info("=" * 60)


def _log_request(model: str, contents, config_dict: dict):
    _log_sep("AI REQUEST — Sending to Google Gemini")
    logger.info("Model: %s | Temp: %s | Timeout: %ss",
                model, config_dict.get("temperature"), config.AI_TIMEOUT)
    system = config_dict.get("system_instruction", "")
    logger.debug("System prompt (%d chars): %s...", len(system), system[:300])
    logger.info("Conversation messages: %d", len(contents))


def _log_response(raw: str, parsed: dict, ms: float):
    _log_sep("AI RESPONSE — Received from Google Gemini")
    logger.info("Round-trip: %.0fms | Raw length: %d chars", ms, len(raw))
    if "proposal" in parsed:
        p = parsed["proposal"]
        logger.info("Type=PROPOSAL  summary=%s  actions=%d",
                    p.get("summary", "?"), len(p.get("actions", [])))
    elif "report" in parsed:
        logger.info("Type=REPORT  title=%s", parsed["report"].get("title", "?"))
    else:
        logger.info("Unknown response keys: %s", list(parsed.keys()))
    _log_sep("END AI RESPONSE")


# ── Main call ─────────────────────────────────────────────────────

async def call_model(
    ledger_summary: str,
    chat_history: list[dict],
    user_message: str,
    chart_summary: str = "",
) -> dict:
    """
    Send the conversation + ledger context to Gemini and return a parsed dict.
    Raises RuntimeError on timeout or malformed JSON.
    """
    start = time.time()

    system_prompt = (
        load_system_prompt()
        .replace("{ledger_summary}", ledger_summary)
        .replace("{chart_of_accounts}", chart_summary)
    )

    contents = []
    for msg in chat_history:
        role = "user" if msg["role"] == "user" else "model"
        contents.append(types.Content(
            role=role,
            parts=[types.Part.from_text(text=msg["content"])],
        ))
    contents.append(types.Content(
        role="user",
        parts=[types.Part.from_text(text=user_message)],
    ))

    gen_config = types.GenerateContentConfig(
        system_instruction=system_prompt,
        temperature=config.AI_TEMPERATURE,
        max_output_tokens=8192,
        response_mime_type="application/json",
    )

    _log_request(config.AI_MODEL, contents, {
        "system_instruction": system_prompt,
        "temperature": config.AI_TEMPERATURE,
    })

    def _sync_call():
        return get_client().models.generate_content(
            model=config.AI_MODEL,
            contents=contents,
            config=gen_config,
        )

    response = await _call_with_retry(_sync_call)

    ms = (time.time() - start) * 1000

    # ``response.text`` can be None or raise when the candidate is empty —
    # e.g. a safety block or a MAX_TOKENS truncation with no usable content.
    try:
        raw = response.text
    except Exception:
        raw = None
    if not raw or not raw.strip():
        raise RuntimeError(
            "AI returned an empty response (it may have been blocked or truncated). "
            "Please try rephrasing your request."
        )

    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.error("JSON parse failed — raw length %d chars", len(raw))
        raise RuntimeError(
            f"AI response was not valid JSON (length={len(raw)}). "
            "Try simplifying your request."
        ) from exc

    # Guard: proposal must be a dict, not a string/list
    if "proposal" in parsed and not isinstance(parsed["proposal"], dict):
        raise RuntimeError(
            "AI returned an unexpected response shape. Please try rephrasing."
        )

    _log_response(raw, parsed, ms)

    if hasattr(response, "usage_metadata") and response.usage_metadata:
        u = response.usage_metadata
        logger.info(
            "Tokens — prompt: %s  candidates: %s  total: %s",
            u.prompt_token_count, u.candidates_token_count, u.total_token_count,
        )

    return parsed
