"""Valida payloads contra los JSON Schema compartidos en packages/contracts/schemas/.

Esos JSON Schema son la fuente de verdad del proyecto. Se cargan por ruta
relativa en vez de duplicarlos aqui, exactamente igual que
edge/src/SenseCare_edge/schemas.py, para que un cambio de contrato nunca se
desincronice de este simulador.
"""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

# simulators/evidence-device-sim/src/evidence_device_sim/schemas.py
#   parents[0] = .../evidence_device_sim
#   parents[1] = .../src
#   parents[2] = .../evidence-device-sim
#   parents[3] = .../simulators
#   parents[4] = raiz del repo
_CONTRACTS_DIR = Path(__file__).resolve().parents[4] / "packages" / "contracts" / "schemas"


def _load_validator(filename: str) -> Draft202012Validator:
    schema_path = _CONTRACTS_DIR / filename
    with open(schema_path, "r", encoding="utf-8") as handle:
        schema = json.load(handle)
    return Draft202012Validator(schema)


_upload_evidence_command_validator = _load_validator("uploadEvidenceCommand.schema.json")
_command_ack_validator = _load_validator("commandAck.schema.json")
_evidence_result_validator = _load_validator("evidenceResult.schema.json")


class SchemaValidationError(ValueError):
    def __init__(self, kind: str, errors: list[str]):
        super().__init__(f"{kind} invalido: {'; '.join(errors)}")
        self.kind = kind
        self.errors = errors


def validate_upload_evidence_command(payload: dict) -> None:
    errors = sorted(_upload_evidence_command_validator.iter_errors(payload), key=lambda e: e.path)
    if errors:
        raise SchemaValidationError("uploadEvidenceCommand", [e.message for e in errors])


def validate_command_ack(payload: dict) -> None:
    errors = sorted(_command_ack_validator.iter_errors(payload), key=lambda e: e.path)
    if errors:
        raise SchemaValidationError("commandAck", [e.message for e in errors])


def validate_evidence_result(payload: dict) -> None:
    errors = sorted(_evidence_result_validator.iter_errors(payload), key=lambda e: e.path)
    if errors:
        raise SchemaValidationError("evidenceResult", [e.message for e in errors])
