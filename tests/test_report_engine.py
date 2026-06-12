"""Reports must be computed from real ledger data, not guessed."""

import report_engine


def test_trial_balance_is_balanced(ledger):
    r = report_engine.trial_balance()
    assert r["balanced"] is True
    assert r["total_debit"] == 3500.0
    assert r["total_credit"] == 3500.0


def test_trial_balance_account_nets(ledger):
    r = report_engine.trial_balance()
    by_acct = {row["account"]: row for row in r["rows"]}
    assert by_acct["1010"]["debit"] == 300.0       # 3500 - 3200
    assert by_acct["1010"]["credit"] == 0.0
    assert by_acct["4100"]["credit"] == 3500.0
    assert by_acct["6050"]["debit"] == 1200.0
    assert by_acct["6100"]["debit"] == 2000.0


def test_income_statement(ledger):
    r = report_engine.income_statement()
    assert r["total_revenue"] == 3500.0
    assert r["total_expenses"] == 3200.0
    assert r["net_income"] == 300.0


def test_balance_sheet_balances(ledger):
    r = report_engine.balance_sheet()
    assert r["total_assets"] == 300.0          # Cash only
    assert r["total_liabilities"] == 0.0
    assert r["net_income"] == 300.0
    assert r["total_equity"] == 300.0          # 0 booked + 300 net income
    assert r["balanced"] is True


def test_detect_report_type():
    assert report_engine.detect_report_type("show me the trial balance") == "trial_balance"
    assert report_engine.detect_report_type("Balance Sheet please") == "balance_sheet"
    assert report_engine.detect_report_type("generate a P&L") == "income_statement"
    assert report_engine.detect_report_type("record a payment") is None


def test_generate_dispatch(ledger):
    r = report_engine.generate("income statement")
    assert r is not None and r["kind"] == "income_statement"
    assert report_engine.generate("nonsense") is None


def test_render_markdown_runs(ledger):
    for kind in ("trial_balance", "balance_sheet", "income_statement"):
        out = report_engine.render_markdown(getattr(report_engine, kind)())
        assert isinstance(out, str) and len(out) > 0
