"""Compute financial reports directly from the ledger.

The AI is never trusted to produce report *numbers* — it only supplies the
request. Every figure here is summed from the actual GeneralLedger rows so that
balances are always correct. Column positions are detected from header names
(never hardcoded) via ``ledger_engine.get_column_indices``.
"""

from __future__ import annotations

import logging
import re

import ledger_engine

logger = logging.getLogger(__name__)

# Account "normal balance" side, keyed by the ChartOfAccounts Type column.
# Debit-normal accounts increase with debits; credit-normal with credits.
_DEBIT_NORMAL = {"asset", "expense", "cogs"}
_CREDIT_NORMAL = {"liability", "equity", "revenue"}


# ── Data loading ──────────────────────────────────────────────────

def load_chart(wb) -> dict[str, dict]:
    """Return {account_number: {"name": str, "type": str}} from ChartOfAccounts."""
    chart: dict[str, dict] = {}
    if "ChartOfAccounts" not in wb.sheetnames:
        return chart
    cols = ledger_engine.get_column_indices("ChartOfAccounts", wb)
    c_acct = cols.get("Account", 1)
    c_name = cols.get("AccountName", 2)
    c_type = cols.get("Type", 3)
    ws = wb["ChartOfAccounts"]
    for r in range(2, ws.max_row + 1):
        num = ws.cell(r, c_acct).value
        if num is None:
            continue
        chart[str(num).strip()] = {
            "name": str(ws.cell(r, c_name).value or "").strip(),
            "type": str(ws.cell(r, c_type).value or "").strip().lower(),
        }
    return chart


def account_balances(wb) -> dict[str, dict]:
    """Sum debits/credits per account number from GeneralLedger.

    Returns {account_number: {"debit": float, "credit": float}}.
    """
    balances: dict[str, dict] = {}
    if "GeneralLedger" not in wb.sheetnames:
        return balances
    cols = ledger_engine.get_column_indices("GeneralLedger", wb)
    c_acct = cols.get("Account", 4)
    c_debit = cols.get("Debit", 6)
    c_credit = cols.get("Credit", 7)
    ws = wb["GeneralLedger"]
    for r in range(2, ws.max_row + 1):
        num = ws.cell(r, c_acct).value
        if num is None or str(num).strip() == "":
            continue  # skip opening-balance / blank rows
        key = str(num).strip()
        entry = balances.setdefault(key, {"debit": 0.0, "credit": 0.0})
        entry["debit"] += _num(ws.cell(r, c_debit).value)
        entry["credit"] += _num(ws.cell(r, c_credit).value)
    return balances


def _num(v) -> float:
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return 0.0


def _signed_balance(acct_type: str, debit: float, credit: float) -> float:
    """Net balance in the account's normal-balance direction (always >= 0 for
    a normally-behaving account)."""
    if acct_type in _DEBIT_NORMAL:
        return round(debit - credit, 2)
    return round(credit - debit, 2)


# ── Reports ───────────────────────────────────────────────────────

def trial_balance() -> dict:
    """Trial balance: each account's net debit or credit. Totals must match."""
    wb = ledger_engine.get_workbook(data_only=True)
    try:
        chart = load_chart(wb)
        balances = account_balances(wb)
    finally:
        wb.close()

    rows = []
    total_debit = 0.0
    total_credit = 0.0
    for num in sorted(set(balances) | set(chart)):
        d = balances.get(num, {}).get("debit", 0.0)
        c = balances.get(num, {}).get("credit", 0.0)
        net = round(d - c, 2)
        if net == 0 and num not in balances:
            continue  # skip never-used chart accounts
        debit_col = net if net > 0 else 0.0
        credit_col = -net if net < 0 else 0.0
        total_debit += debit_col
        total_credit += credit_col
        rows.append({
            "account": num,
            "name": chart.get(num, {}).get("name", ""),
            "debit": round(debit_col, 2),
            "credit": round(credit_col, 2),
        })

    return {
        "kind": "trial_balance",
        "title": "Trial Balance",
        "rows": rows,
        "total_debit": round(total_debit, 2),
        "total_credit": round(total_credit, 2),
        "balanced": abs(total_debit - total_credit) < 0.01,
    }


def _grouped_balances():
    wb = ledger_engine.get_workbook(data_only=True)
    try:
        chart = load_chart(wb)
        balances = account_balances(wb)
    finally:
        wb.close()

    groups: dict[str, list] = {
        "asset": [], "liability": [], "equity": [], "revenue": [], "expense": [],
    }
    for num, bal in balances.items():
        info = chart.get(num, {})
        acct_type = info.get("type", "")
        bucket = "expense" if acct_type in ("expense", "cogs") else acct_type
        if bucket not in groups:
            continue
        amount = _signed_balance(acct_type, bal["debit"], bal["credit"])
        if amount == 0:
            continue
        groups[bucket].append({
            "account": num,
            "name": info.get("name", ""),
            "amount": amount,
        })
    for g in groups.values():
        g.sort(key=lambda x: x["account"])
    return groups


def income_statement() -> dict:
    """Profit & Loss: revenue minus expenses = net income."""
    groups = _grouped_balances()
    total_revenue = round(sum(x["amount"] for x in groups["revenue"]), 2)
    total_expenses = round(sum(x["amount"] for x in groups["expense"]), 2)
    return {
        "kind": "income_statement",
        "title": "Income Statement",
        "revenue": groups["revenue"],
        "expenses": groups["expense"],
        "total_revenue": total_revenue,
        "total_expenses": total_expenses,
        "net_income": round(total_revenue - total_expenses, 2),
    }


def balance_sheet() -> dict:
    """Balance sheet: assets vs. liabilities + equity (incl. current net income)."""
    groups = _grouped_balances()
    total_assets = round(sum(x["amount"] for x in groups["asset"]), 2)
    total_liabilities = round(sum(x["amount"] for x in groups["liability"]), 2)
    booked_equity = round(sum(x["amount"] for x in groups["equity"]), 2)
    net_income = round(
        sum(x["amount"] for x in groups["revenue"])
        - sum(x["amount"] for x in groups["expense"]),
        2,
    )
    total_equity = round(booked_equity + net_income, 2)
    return {
        "kind": "balance_sheet",
        "title": "Balance Sheet",
        "assets": groups["asset"],
        "liabilities": groups["liability"],
        "equity": groups["equity"],
        "net_income": net_income,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "booked_equity": booked_equity,
        "total_equity": total_equity,
        "balanced": abs(total_assets - (total_liabilities + total_equity)) < 0.01,
    }


# ── Dispatch ──────────────────────────────────────────────────────

def detect_report_type(text: str) -> str | None:
    """Infer which report the user/AI is asking for from free text."""
    t = (text or "").lower()
    if re.search(r"trial\s*balance", t):
        return "trial_balance"
    if re.search(r"balance\s*sheet|statement of financial position", t):
        return "balance_sheet"
    if re.search(r"income statement|profit (and|&) loss|p\s*&\s*l|p\s*and\s*l|"
                 r"\bp&l\b|\bpnl\b|earnings", t):
        return "income_statement"
    return None


_DISPATCH = {
    "trial_balance": trial_balance,
    "balance_sheet": balance_sheet,
    "income_statement": income_statement,
}


def generate(*texts: str) -> dict | None:
    """Compute the report implied by any of the given text hints, or None."""
    for text in texts:
        kind = detect_report_type(text)
        if kind:
            return _DISPATCH[kind]()
    return None


# ── Rendering ─────────────────────────────────────────────────────

def render_markdown(report: dict) -> str:
    kind = report.get("kind")
    if kind == "trial_balance":
        return _render_trial_balance(report)
    if kind == "balance_sheet":
        return _render_balance_sheet(report)
    if kind == "income_statement":
        return _render_income_statement(report)
    return f"**{report.get('title', 'Report')}** (no data)"


def _money(v) -> str:
    return f"${v:,.2f}"


def _render_trial_balance(r: dict) -> str:
    lines = [f"**{r['title']}**", ""]
    lines.append("| Account | Name | Debit | Credit |")
    lines.append("|---|---|--:|--:|")
    for row in r["rows"]:
        lines.append(
            f"| {row['account']} | {row['name']} | "
            f"{_money(row['debit']) if row['debit'] else ''} | "
            f"{_money(row['credit']) if row['credit'] else ''} |"
        )
    lines.append(f"| | **Total** | **{_money(r['total_debit'])}** | "
                 f"**{_money(r['total_credit'])}** |")
    lines.append("")
    lines.append("✅ In balance." if r["balanced"]
                 else "⚠️ Out of balance — debits ≠ credits.")
    return "\n".join(lines)


def _render_balance_sheet(r: dict) -> str:
    lines = [f"**{r['title']}**", "", "### Assets"]
    for a in r["assets"]:
        lines.append(f"  - {a['name']} ({a['account']}): {_money(a['amount'])}")
    lines.append(f"  **Total Assets: {_money(r['total_assets'])}**")
    lines.append("")
    lines.append("### Liabilities")
    for a in r["liabilities"]:
        lines.append(f"  - {a['name']} ({a['account']}): {_money(a['amount'])}")
    lines.append(f"  **Total Liabilities: {_money(r['total_liabilities'])}**")
    lines.append("")
    lines.append("### Equity")
    for a in r["equity"]:
        lines.append(f"  - {a['name']} ({a['account']}): {_money(a['amount'])}")
    lines.append(f"  - Current Period Net Income: {_money(r['net_income'])}")
    lines.append(f"  **Total Equity: {_money(r['total_equity'])}**")
    lines.append("")
    lines.append(
        f"**Total Liabilities + Equity: "
        f"{_money(r['total_liabilities'] + r['total_equity'])}**"
    )
    lines.append("")
    lines.append("✅ Balanced (Assets = Liabilities + Equity)." if r["balanced"]
                 else "⚠️ Not balanced — please review the ledger.")
    return "\n".join(lines)


def _render_income_statement(r: dict) -> str:
    lines = [f"**{r['title']}**", "", "### Revenue"]
    for a in r["revenue"]:
        lines.append(f"  - {a['name']} ({a['account']}): {_money(a['amount'])}")
    lines.append(f"  **Total Revenue: {_money(r['total_revenue'])}**")
    lines.append("")
    lines.append("### Expenses")
    for a in r["expenses"]:
        lines.append(f"  - {a['name']} ({a['account']}): {_money(a['amount'])}")
    lines.append(f"  **Total Expenses: {_money(r['total_expenses'])}**")
    lines.append("")
    sign = "Net Income" if r["net_income"] >= 0 else "Net Loss"
    lines.append(f"**{sign}: {_money(abs(r['net_income']))}**")
    return "\n".join(lines)
