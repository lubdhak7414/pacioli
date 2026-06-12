"""Validation rules in the shared Pydantic models."""

import pytest
from pydantic import ValidationError

from models import CellAction, Proposal


def _balanced_proposal():
    return {
        "summary": "Record client payment",
        "justification": "Cash up, revenue up.",
        "accounting_equation_check": {
            "assets_change": 3500, "liabilities_change": 0,
            "equity_change": 3500, "balance_confirmed": True,
        },
        "actions": [
            {"operation": "insert_row", "sheet": "GeneralLedger", "row_index": 3,
             "values": ["2026-01-01", "TXN", "Pay", "1010", "Cash", 3500, 0, 0],
             "new_value": 3500, "context": "Debit: cash"},
            {"operation": "insert_row", "sheet": "GeneralLedger", "row_index": 4,
             "values": ["2026-01-01", "TXN", "Pay", "4100", "Service Revenue", 0, 3500, 0],
             "new_value": 3500, "context": "Credit: revenue"},
        ],
    }


def test_balanced_proposal_ok():
    p = Proposal(**_balanced_proposal())
    assert len(p.actions) == 2


def test_unbalanced_proposal_rejected():
    bad = _balanced_proposal()
    bad["actions"][1]["new_value"] = 9999  # credit no longer equals debit
    with pytest.raises(ValidationError):
        Proposal(**bad)


def test_formula_must_start_with_equals():
    with pytest.raises(ValidationError):
        CellAction(operation="write_formula", sheet="S", cell_ref="A1",
                   formula="SUM(A1:A2)")


def test_formula_blocks_dangerous_functions():
    with pytest.raises(ValidationError):
        CellAction(operation="write_formula", sheet="S", cell_ref="A1",
                   formula="=EXEC(1)")


def test_monetary_value_rounded():
    a = CellAction(operation="write_cell", sheet="S", cell_ref="A1",
                   new_value=3499.9999999)
    assert a.new_value == 3500.0


def test_insert_row_accepts_list_in_new_value():
    a = CellAction(operation="insert_row", sheet="S", row_index=3,
                   new_value=["2026", "x", 1, 2])
    assert a.values == ["2026", "x", 1, 2]
