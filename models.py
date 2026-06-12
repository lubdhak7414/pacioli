"""Shared Pydantic models used by both the AI layer and the API layer."""

import re
from enum import Enum
from typing import Optional, Union

from pydantic import BaseModel, field_validator, model_validator


class OperationType(str, Enum):
    WRITE_CELL = "write_cell"
    WRITE_RANGE = "write_range"
    WRITE_FORMULA = "write_formula"
    INSERT_ROW = "insert_row"


_DANGEROUS_FORMULA = re.compile(
    r"\b(SYSTEM|EXEC|SHELL|CALL|OPEN|IMPORT|LINK)\b", re.IGNORECASE
)


class CellAction(BaseModel):
    operation: OperationType
    sheet: str
    cell_ref: Optional[str] = None
    start_cell: Optional[str] = None
    end_cell: Optional[str] = None
    old_value: Optional[Union[str, float, int]] = None
    new_value: Optional[Union[str, float, int, list]] = None
    formula: Optional[str] = None
    values_2d: Optional[list[list]] = None
    values: Optional[list] = None
    row_index: Optional[int] = None
    context: str = ""

    @field_validator("new_value", mode="before")
    @classmethod
    def round_monetary(cls, v):
        if isinstance(v, float):
            return round(v, 2)
        return v

    @field_validator("formula", mode="before")
    @classmethod
    def validate_formula(cls, v):
        if v is None:
            return v
        if not v.startswith("="):
            raise ValueError("Formulas must start with =")
        if _DANGEROUS_FORMULA.search(v):
            raise ValueError("Formula contains a forbidden function name")
        return v

    @model_validator(mode="after")
    def validate_operation_fields(self):
        if self.operation == OperationType.WRITE_CELL:
            if not self.cell_ref or self.new_value is None:
                raise ValueError("write_cell requires cell_ref and new_value")
        elif self.operation == OperationType.WRITE_FORMULA:
            if not self.cell_ref or not self.formula:
                raise ValueError("write_formula requires cell_ref and formula")
        elif self.operation == OperationType.WRITE_RANGE:
            if not self.start_cell or not self.end_cell or not self.values_2d:
                raise ValueError("write_range requires start_cell, end_cell, values_2d")
        elif self.operation == OperationType.INSERT_ROW:
            if self.values is None and self.row_index is not None and isinstance(self.new_value, list):
                self.values = self.new_value
            if self.row_index is None or self.values is None:
                raise ValueError("insert_row requires row_index and values (or new_value as list)")
        return self


class EquationCheck(BaseModel):
    assets_change: float = 0
    liabilities_change: float = 0
    equity_change: float = 0
    balance_confirmed: bool


class Proposal(BaseModel):
    summary: str
    justification: str
    accounting_equation_check: EquationCheck
    actions: list[CellAction]

    @model_validator(mode="after")
    def enforce_debit_equals_credit(self):
        total_debits = 0.0
        total_credits = 0.0
        for action in self.actions:
            ctx = action.context.lower()
            val = action.new_value if isinstance(action.new_value, (int, float)) else 0
            if "debit" in ctx:
                total_debits += val
            elif "credit" in ctx:
                total_credits += val
        if total_debits > 0 and total_credits > 0:
            if abs(total_debits - total_credits) > 0.01:
                raise ValueError(
                    f"Double-entry violation: debits={total_debits} != credits={total_credits}"
                )
        return self
