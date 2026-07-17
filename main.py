"""Pacioli — FastAPI backend with human-in-the-loop approval."""

import asyncio
import logging
import json
import re
import shutil
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import aiosqlite
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel, field_validator

import config
import db
import ai_client
import ledger_engine
import report_engine
from models import Proposal, OperationType

# ── Logging ───────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL, logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# ── Input sanitisation ────────────────────────────────────────────
_ROLE_TAGS = re.compile(r"\[(SYSTEM|ASSISTANT|INST|USER)\]", re.IGNORECASE)
_INJECTION = re.compile(
    r"\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\b",
    re.IGNORECASE,
)


def sanitize_input(text: str) -> str:
    text = _ROLE_TAGS.sub("", text)
    if _INJECTION.search(text):
        logger.warning("Possible prompt-injection attempt detected.")
    return text[: config.MAX_INPUT_LENGTH].strip()


def fiscal_warnings(actions) -> list[str]:
    """Flag insert_row transactions dated outside the configured fiscal year (item 1.3)."""
    seen: set[str] = set()
    warnings: list[str] = []
    for a in actions:
        if a.operation == OperationType.INSERT_ROW and a.values:
            date_val = a.values[0]
            if isinstance(date_val, str) and date_val[:4].isdigit():
                if int(date_val[:4]) != config.FISCAL_YEAR and date_val not in seen:
                    seen.add(date_val)
                    warnings.append(
                        f"Transaction dated {date_val} is outside fiscal year "
                        f"{config.FISCAL_YEAR}."
                    )
    return warnings


def _trim_for_context(history: list[dict], max_chars: int = 600) -> list[dict]:
    """Cap each chat turn before resending it to the model.

    Assistant turns can include whole rendered report tables; re-feeding those
    verbatim bloats the prompt for no benefit. Keep role + a bounded snippet.
    """
    trimmed = []
    for m in history:
        content = m["content"]
        if len(content) > max_chars:
            content = content[:max_chars] + " …[truncated]"
        trimmed.append({"role": m["role"], "content": content})
    return trimmed


def _render_ai_report(report: dict) -> str:
    """Fallback renderer when the report type can't be computed locally."""
    text = f"**{report.get('title', 'Report')}**\n\n"
    for section in report.get("sections", []):
        text += f"### {section.get('heading', '')}\n"
        for line in section.get("lines", []):
            acct = line.get("account", "")
            num = line.get("account_number", "")
            amt = line.get("amount", 0)
            text += f"  - {acct} ({num}): ${amt:,.2f}\n"
        text += "\n"
    text += "\n_Note: figures could not be recomputed from the ledger; shown as estimated by the AI._"
    return text


# ── Lifespan ──────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    Path("data").mkdir(exist_ok=True)
    await db.init_db()
    logger.info("Database initialised.")

    # Seed the live ledger from the committed template on first run. The live
    # file holds real financial data and is gitignored; the template is the
    # clean starting workbook shipped with the repo.
    ledger_p = Path(ledger_engine.LEDGER_PATH)
    template_p = Path(config.LEDGER_TEMPLATE_PATH)
    if not ledger_p.exists() and template_p.exists():
        ledger_p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(template_p, ledger_p)
        logger.info("Seeded ledger from template → %s", ledger_p)

    # Backup ledger on startup (keep last 10)
    if ledger_p.exists():
        backups = sorted(Path("data").glob("ledger_backup_*.xlsx"))
        for old in backups[:-9]:
            old.unlink(missing_ok=True)
        backup_name = f"data/ledger_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        shutil.copy2(ledger_engine.LEDGER_PATH, backup_name)
        logger.info("Ledger backed up → %s", backup_name)

    # Background task: expire stale proposals every 5 min
    cleanup_task = asyncio.create_task(db.cleanup_stale_proposals())

    yield

    cleanup_task.cancel()


# ── App ───────────────────────────────────────────────────────────
app = FastAPI(
    title="Pacioli",
    version="2.0.0",
    lifespan=lifespan,
    description="Human-in-the-loop AI-powered ledger management.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:*", "http://127.0.0.1:*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from fastapi.staticfiles import StaticFiles
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    t0 = time.time()
    response = await call_next(request)
    ms = (time.time() - t0) * 1000
    logger.info("<%s %s> %d  %.0fms", request.method, request.url.path,
                response.status_code, ms)
    return response


# ── Request/Response models ───────────────────────────────────────
class ChatRequest(BaseModel):
    message: str

    @field_validator("message")
    @classmethod
    def not_empty(cls, v):
        if not v.strip():
            raise ValueError("Message cannot be empty")
        return v.strip()


class ChatResponse(BaseModel):
    assistant_message: str
    proposal_id: int | None = None
    proposal_summary: str | None = None


class ProposalDetail(BaseModel):
    id: int
    status: str
    justification: str
    actions: list[dict]
    user_message: str
    created_at: str
    validation_notes: list[str] = []


class ApprovalResponse(BaseModel):
    success: bool
    message: str
    change_log: list[str] | None = None


# ── API Endpoints ─────────────────────────────────────────────────

@app.get("/api/health", summary="System health check")
async def health_check():
    db_ok = False
    try:
        async with aiosqlite.connect(db.DB_PATH) as conn:
            await conn.execute("SELECT 1")
            db_ok = True
    except Exception:
        pass
    return {
        "status": "ok" if db_ok else "degraded",
        "database": "connected" if db_ok else "error",
        "ai_model": config.AI_MODEL,
        "ledger_exists": Path(ledger_engine.LEDGER_PATH).exists(),
    }


@app.post("/api/chat", response_model=ChatResponse,
          summary="Send a message to Pacioli")
async def chat(request: ChatRequest):
    """
    Full lifecycle:
    1. Sanitise & store user message
    2. Build ledger context + history
    3. Call Gemini with retry on validation errors
    4. Validate & store proposal
    5. Return acknowledgement + proposal_id
    """
    clean_msg = sanitize_input(request.message)

    await db.insert_chat_message("user", clean_msg)
    history = await db.get_chat_history(limit=20)
    ledger_summary = ledger_engine.get_ledger_summary()
    chart_summary = ledger_engine.get_chart_text()

    last_error: str | None = None

    for attempt in range(config.MAX_RETRIES + 1):
        user_msg = clean_msg
        if last_error and attempt > 0:
            user_msg = (
                f"{clean_msg}\n\n"
                f"[SYSTEM FEEDBACK — fix these validation errors and retry:]\n"
                f"{last_error}\n\n"
                "Remember: write_cell needs cell_ref+new_value; "
                "insert_row needs row_index+values; debits must equal credits."
            )

        try:
            ai_response = await ai_client.call_model(
                ledger_summary=ledger_summary,
                chart_summary=chart_summary,
                chat_history=_trim_for_context(history[:-1]) if attempt == 0 else [],
                user_message=user_msg,
            )
        except Exception as e:
            logger.error("AI call failed: %s", e)
            err_msg = (
                "I'm having trouble connecting to the AI right now. "
                "Please try again in a moment."
            )
            await db.insert_chat_message("assistant", err_msg)
            return ChatResponse(assistant_message=err_msg)

        # ── Report (read-only, numbers computed from the ledger) ───
        if "report" in ai_response:
            report = ai_response["report"]
            # Compute the report from real ledger data — never trust AI numbers (item 4.1).
            try:
                computed = report_engine.generate(report.get("title", ""), clean_msg)
            except Exception as e:
                logger.error("Report computation failed: %s", e)
                computed = None

            if computed:
                report_text = report_engine.render_markdown(computed)
            else:
                # Unknown report type — fall back to the AI's structure.
                report_text = _render_ai_report(report)

            await db.insert_chat_message("assistant", report_text)
            return ChatResponse(assistant_message=report_text)

        # ── Transaction proposal ──────────────────────────────────
        proposal_data = ai_response.get("proposal")
        if not isinstance(proposal_data, dict):
            if proposal_data is not None:
                msg = "The AI response was not in the expected format. Please try rephrasing."
            else:
                msg = "I could not form a clear proposal. Could you rephrase your request?"
            await db.insert_chat_message("assistant", msg)
            return ChatResponse(assistant_message=msg)

        try:
            validated = Proposal(**proposal_data)
            last_error = None
            break
        except Exception as e:
            last_error = str(e)
            if attempt == config.MAX_RETRIES:
                msg = (
                    "I'm having trouble generating a valid proposal. "
                    "Could you rephrase your request more simply?\n\n"
                    f"_(Technical detail: {e})_"
                )
                await db.insert_chat_message("assistant", msg)
                return ChatResponse(assistant_message=msg)
            continue

    # ── Equation check ────────────────────────────────────────────
    eq = validated.accounting_equation_check
    if not eq.balance_confirmed:
        msg = (
            "I could not confirm the accounting equation balances. "
            "I won't submit this proposal. Please verify your instruction."
        )
        await db.insert_chat_message("assistant", msg)
        return ChatResponse(assistant_message=msg)

    # ── Fiscal-period check (non-blocking warnings, item 1.3) ──────
    warnings = fiscal_warnings(validated.actions)

    # ── Store proposal ────────────────────────────────────────────
    proposal_id = await db.create_proposal(
        user_message=clean_msg,
        ai_reasoning=validated.justification,
        actions=[a.model_dump() for a in validated.actions],
        validation_notes=warnings,
    )

    warn_text = ("\n\n⚠️ " + " ".join(warnings)) if warnings else ""
    ack = (
        f"I've prepared a proposed edit for your review. (Proposal #{proposal_id})\n\n"
        f"**Summary:** {validated.summary}\n"
        f"**Reasoning:** {validated.justification}{warn_text}\n\n"
        "Please review the changes in the right panel and approve or reject."
    )
    await db.insert_chat_message("assistant", ack, proposal_id=proposal_id)

    return ChatResponse(
        assistant_message=ack,
        proposal_id=proposal_id,
        proposal_summary=validated.summary,
    )


def _parse_notes(raw) -> list[str]:
    if not raw:
        return []
    try:
        val = json.loads(raw)
        return val if isinstance(val, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


@app.get("/api/proposals", summary="List recent proposals")
async def list_proposals(limit: int = 10):
    proposals = await db.get_proposals(limit=min(limit, 50))
    return {"proposals": proposals}


@app.get("/api/proposals/{proposal_id}", response_model=ProposalDetail,
         summary="Fetch a proposal for preview")
async def get_proposal(proposal_id: int):
    proposal = await db.get_proposal(proposal_id)
    if not proposal:
        raise HTTPException(404, "Proposal not found")

    preview_actions = []
    for act in proposal["actions"]:
        old_val = None
        if act.get("cell_ref") and act["operation"] in ("write_cell", "write_formula"):
            try:
                wb = ledger_engine.get_workbook(data_only=True)
                if act["sheet"] in wb.sheetnames:
                    old_val = wb[act["sheet"]][act["cell_ref"]].value
                wb.close()
            except Exception:
                old_val = "N/A"
        preview_actions.append({
            **act,
            "old_value_display": act.get("old_value", old_val),
            "new_value_display": act.get("new_value", act.get("formula", "")),
        })

    return ProposalDetail(
        id=proposal["id"],
        status=proposal["status"],
        justification=proposal.get("ai_reasoning", ""),
        actions=preview_actions,
        user_message=proposal["user_message"],
        created_at=proposal["created_at"],
        validation_notes=_parse_notes(proposal.get("validation_notes")),
    )


@app.post("/api/proposals/{proposal_id}/approve", response_model=ApprovalResponse,
          summary="Approve and execute a proposal")
async def approve_proposal(proposal_id: int):
    proposal = await db.get_proposal(proposal_id)
    if not proposal:
        raise HTTPException(404, "Proposal not found")

    # Atomic status transition — prevents double-approval race condition
    approved = await db.approve_proposal_atomic(proposal_id)
    if not approved:
        raise HTTPException(
            409, f"Proposal is already '{proposal['status']}', not 'pending'."
        )

    try:
        # The snapshot is captured inside the lock by execute_actions, so it is a
        # consistent pre-execution state for undo.
        snapshot, change_log = ledger_engine.execute_actions(proposal["actions"])
    except ledger_engine.LockTimeout:
        # Nothing was written (the atomic save never ran); let the user retry.
        await db.reset_proposal_pending(proposal_id)
        raise HTTPException(
            409, "The ledger is busy right now. Please try again in a moment."
        )
    except Exception as e:
        logger.error("Execution failed for proposal %d: %s", proposal_id, e)
        await db.update_proposal_status(proposal_id, "failed", str(e))
        await db.insert_chat_message(
            "assistant",
            f"Proposal #{proposal_id} execution failed: {e}",
            proposal_id=proposal_id,
        )
        return ApprovalResponse(success=False, message=f"Execution failed: {e}")

    await db.save_snapshot(proposal_id, snapshot)
    # Persist an audit trail of what was executed (item 2.9)
    for idx, act in enumerate(proposal["actions"]):
        await db.insert_audit_log(
            proposal_id=proposal_id,
            action_index=idx,
            sheet=act.get("sheet", ""),
            cell_ref=act.get("cell_ref"),
            old_value=act.get("old_value"),
            new_value=act.get("new_value") or act.get("formula")
            or act.get("values"),
        )
    await db.insert_chat_message(
        "assistant",
        f"Proposal #{proposal_id} approved and executed. "
        f"Changes: {'; '.join(change_log)}",
        proposal_id=proposal_id,
    )
    return ApprovalResponse(
        success=True,
        message="Proposal executed successfully.",
        change_log=change_log,
    )


@app.post("/api/proposals/{proposal_id}/reject", response_model=ApprovalResponse,
          summary="Reject a proposal")
async def reject_proposal(proposal_id: int):
    proposal = await db.get_proposal(proposal_id)
    if not proposal:
        raise HTTPException(404, "Proposal not found")
    if proposal["status"] != "pending":
        raise HTTPException(409, f"Proposal is '{proposal['status']}', not 'pending'.")

    await db.update_proposal_status(proposal_id, "rejected")
    await db.insert_chat_message(
        "assistant",
        f"Proposal #{proposal_id} rejected. No edits were made to the ledger.",
        proposal_id=proposal_id,
    )
    return ApprovalResponse(success=True, message="Proposal rejected.")


@app.post("/api/proposals/{proposal_id}/restore", response_model=ApprovalResponse,
          summary="Restore the ledger to its state before this proposal (undo)")
async def restore_proposal(proposal_id: int):
    """Roll the ledger back to the snapshot taken before this proposal executed."""
    proposal = await db.get_proposal(proposal_id)
    if not proposal:
        raise HTTPException(404, "Proposal not found")

    snapshot = await db.get_snapshot(proposal_id)
    if snapshot is None:
        raise HTTPException(404, "No snapshot available for this proposal.")

    try:
        ledger_engine.restore_snapshot(snapshot)
    except Exception as e:
        logger.error("Restore failed for proposal %d: %s", proposal_id, e)
        raise HTTPException(500, f"Restore failed: {e}")

    await db.insert_audit_log(
        proposal_id=proposal_id, action_index=-1, sheet="*",
        cell_ref=None, old_value="executed", new_value="restored",
    )
    await db.insert_chat_message(
        "assistant",
        f"Ledger restored to the state before proposal #{proposal_id}.",
        proposal_id=proposal_id,
    )
    return ApprovalResponse(
        success=True,
        message=f"Ledger restored to before proposal #{proposal_id}.",
    )


@app.get("/api/ledger/preview", summary="Read-only preview of a ledger sheet")
async def ledger_preview(sheet: str = "GeneralLedger", limit: int = 50):
    """Return the header row + first N data rows of a sheet as JSON (item 1.7)."""
    try:
        wb = ledger_engine.get_workbook(data_only=True)
    except Exception as e:
        raise HTTPException(500, f"Could not open ledger: {e}")
    try:
        if sheet not in wb.sheetnames:
            raise HTTPException(404, f"Sheet '{sheet}' not found.")
        ws = wb[sheet]
        max_col = ws.max_column or 1
        headers = [str(ws.cell(1, c).value or "") for c in range(1, max_col + 1)]
        rows = []
        for r in range(2, min(ws.max_row, 1 + max(1, limit)) + 1):
            rows.append([
                ws.cell(r, c).value for c in range(1, max_col + 1)
            ])
        return {"sheet": sheet, "sheets": wb.sheetnames,
                "headers": headers, "rows": rows}
    finally:
        wb.close()


@app.get("/api/chat/history", summary="Return full chat history")
async def get_history():
    history = await db.get_chat_history(limit=100)
    return {"messages": history}


@app.get("/api/audit", summary="Return audit log entries")
async def get_audit(limit: int = 50):
    async with aiosqlite.connect(db.DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cursor = await conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (min(limit, 200),)
        )
        rows = await cursor.fetchall()
    return {"entries": [dict(r) for r in rows]}


@app.get("/api/ledger/download", summary="Download the current ledger file")
async def download_ledger():
    if not Path(ledger_engine.LEDGER_PATH).exists():
        raise HTTPException(404, "Ledger file not found.")
    return FileResponse(
        ledger_engine.LEDGER_PATH,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="ledger.xlsx",
    )


@app.get("/", response_class=HTMLResponse)
async def serve_dashboard():
    html_path = Path("static/index.html")
    if html_path.exists():
        return HTMLResponse(html_path.read_text())
    return HTMLResponse("<h1>Pacioli</h1><p>Place static/index.html</p>")
