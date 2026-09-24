"""Reglas locales de sensores: una lectura aislada nunca es una anomalia.
Cada regla exige que la condicion se sostenga por una ventana de tiempo y
respeta un cooldown para no reabrir la misma alerta en cada ciclo.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from .esp32_reader import SensorReading


@dataclass
class _RuleState:
    condition_since: Optional[float] = None
    last_fired_at: Optional[float] = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class SensorRulesEngine:
    def __init__(self, rules_config: dict):
        self._co2_cfg = rules_config.get("co2", {})
        self._temp_cfg = rules_config.get("temperature", {})
        self._co2_state = _RuleState()
        self._temp_state = _RuleState()

    def evaluate(self, reading: SensorReading) -> Optional[dict]:
        """Devuelve un payload SENSOR_ANOMALY (sin validar contra el schema
        todavia) o None. Solo una anomalia por llamada: la primera regla que
        dispare gana ese ciclo."""
        anomaly = self._evaluate_co2(reading)
        if anomaly is not None:
            return anomaly
        return self._evaluate_temperature(reading)

    def _evaluate_co2(self, reading: SensorReading) -> Optional[dict]:
        cfg = self._co2_cfg
        if not cfg or reading.co2Ppm is None:
            self._co2_state.condition_since = None
            return None
        return self._sustained_check(
            state=self._co2_state,
            active=reading.co2Ppm >= cfg["thresholdPpm"],
            window_seconds=cfg["windowSeconds"],
            cooldown_seconds=cfg.get("cooldownSeconds", 120),
            build_event=lambda: {
                "anomalyType": "POOR_AIR_QUALITY",
                "severity": "warning",
                "sensorRule": {
                    "ruleVersion": cfg.get("ruleVersion", "sensor-rules-v1"),
                    "windowSeconds": cfg["windowSeconds"],
                    "trigger": f"co2Ppm >= {cfg['thresholdPpm']} sostenido",
                },
                "sensors": {"co2Ppm": reading.co2Ppm, "temperatureC": reading.temperatureC},
            },
        )

    def _evaluate_temperature(self, reading: SensorReading) -> Optional[dict]:
        cfg = self._temp_cfg
        if not cfg or reading.temperatureC is None:
            self._temp_state.condition_since = None
            return None
        return self._sustained_check(
            state=self._temp_state,
            active=reading.temperatureC >= cfg["thresholdC"],
            window_seconds=cfg["windowSeconds"],
            cooldown_seconds=cfg.get("cooldownSeconds", 120),
            build_event=lambda: {
                "anomalyType": "TEMPERATURE_ALERT",
                "severity": "critical" if reading.temperatureC >= cfg["thresholdC"] + 10 else "warning",
                "sensorRule": {
                    "ruleVersion": cfg.get("ruleVersion", "sensor-rules-v1"),
                    "windowSeconds": cfg["windowSeconds"],
                    "trigger": f"temperatureC >= {cfg['thresholdC']} sostenido",
                },
                "sensors": {"temperatureC": reading.temperatureC},
            },
        )

    @staticmethod
    def _sustained_check(state: _RuleState, active: bool, window_seconds: float,
                          cooldown_seconds: float, build_event) -> Optional[dict]:
        now = time.monotonic()

        if not active:
            state.condition_since = None
            return None

        if state.condition_since is None:
            state.condition_since = now
            return None

        sustained_for = now - state.condition_since
        if sustained_for < window_seconds:
            return None

        if state.last_fired_at is not None and (now - state.last_fired_at) < cooldown_seconds:
            return None  # en cooldown: la condicion sigue pero no se reemite

        state.last_fired_at = now
        event = build_event()
        event.update({
            "eventId": str(uuid.uuid4()),
            "eventType": "SENSOR_ANOMALY",
            "occurredAt": _now_iso(),
        })
        return event
