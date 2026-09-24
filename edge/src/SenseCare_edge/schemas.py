"""Valida payloads contra el contrato compartido en packages/contracts/schemas/.

Esos JSON Schema son la fuente de verdad del proyecto (ver
docs/SIMULATOR_INTEGRATION_GUIDE.md). Se cargan por ruta relativa en vez de
duplicarlos aqui para que un cambio de contrato no se desincronice del edge.
"""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

_CONTRACTS_DIR = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "schemas"


def _load_validator(filename: str) -> Draft202012Validator:
    schema_path = _CONTRACTS_DIR / filename
    with open(schema_path, "r", encoding="utf-8") as handle:
        schema = json.load(handle)
    return Draft202012Validator(schema)


_telemetry_validator = _load_validator("telemetry.schema.json")
_sensor_anomaly_validator = _load_validator("sensorAnomaly.schema.json")


class SchemaValidationError(ValueError):
    def __init__(self, kind: str, errors: list[str]):
        super().__init__(f"{kind} invalido: {'; '.join(errors)}")
        self.kind = kind
        self.errors = errors


def validate_telemetry(payload: dict) -> None:
    errors = sorted(_telemetry_validator.iter_errors(payload), key=lambda e: e.path)
    if errors:
        raise SchemaValidationError("telemetry", [e.message for e in errors])


def validate_sensor_anomaly(payload: dict) -> None:
    errors = sorted(_sensor_anomaly_validator.iter_errors(payload), key=lambda e: e.path)
    if errors:
        raise SchemaValidationError("sensorAnomaly", [e.message for e in errors])
