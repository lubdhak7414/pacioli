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
__all__ = ["call_gemma", "Proposal", "CellAction", "EquationCheck", "OperationType"]

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


def load_system_prompt() -> str:
    with open(SYSTEM_PROMPT_PATH, "r") as f:
        return f.read()


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

async def call_gemma(
    ledger_summary: str,
    chat_history: list[dict],
    user_message: str,
) -> dict:
    """
    Send the conversation + ledger context to Gemini and return a parsed dict.
    Raises RuntimeError on timeout or malformed JSON.
    """
    start = time.time()

    system_prompt = load_system_prompt().replace("{ledger_summary}", ledger_summary)

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
        max_output_tokens=4096,
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

    try:
        response = await asyncio.wait_for(
            asyncio.to_thread(_sync_call),
            timeout=config.AI_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise RuntimeError(
            f"AI request timed out after {config.AI_TIMEOUT}s. "
            "Please try again with a simpler request."
        )
    except Exception as e:
        if "503" in str(e) or "UNAVAILABLE" in str(e):
            logger.warning("503 UNAVAILABLE — retrying in 3s…")
            await asyncio.sleep(3)
            try:
                response = await asyncio.wait_for(
                    asyncio.to_thread(_sync_call),
                    timeout=config.AI_TIMEOUT,
                )
            except asyncio.TimeoutError:
                raise RuntimeError(f"AI request timed out on retry after {config.AI_TIMEOUT}s.")
        else:
            logger.error("Gemini call failed: %s: %s", type(e).__name__, e)
            raise

    ms = (time.time() - start) * 1000
    raw = response.text

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
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
