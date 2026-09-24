"""RiskFusionEngine: convierte flujos de observaciones de detectores en
candidatos de riesgo VISUAL_ANOMALY, validados contra
visualAnomaly.schema.json antes de retornarse.

No emite diagnosticos ni acusaciones (ver limites en
docs/EDGE_IMPLEMENTATION_GUIDE.md): solo candidatos con evidencia temporal
minima, sujetos a un umbral de confianza configurable y a un cooldown de
120 segundos por tipo, para no reabrir la misma alerta en cada ciclo.

Los timestamps son siempre los de cada Frame (ms, monotonicos), nunca el
reloj de pared: esto hace que la logica sea determinista y facil de probar
sin `time.sleep`, igual que sensor_rules.py usa `time.monotonic()` para su
propio proposito.
"""

from __future__ import annotations

import logging
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Deque, Dict, List, Optional, Tuple

from . import schemas
from .vision_types import CameraHealthObservation, PersonObservation, PoseObservation, SmokeFireObservation

logger = logging.getLogger("SenseCare_edge.risk_fusion")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


@dataclass
class RiskFusionConfig:
    device_id: str
    pose_model_version: str
    person_model_version: str
    smoke_fire_model_version: Optional[str] = None
    confidence_threshold: float = 0.80
    cooldown_seconds: float = 120.0
    fall_burst_window_ms: int = 1000
    fall_min_consistent_frames: int = 2
    prone_inactive_seconds: float = 12.0
    armed_zones: Tuple[str, ...] = ()
    armed: bool = True
    # Apagado por defecto: sin un modelo TFLite compatible, medido y
    # validado, POSSIBLE_SMOKE_OR_FIRE nunca se reporta (ver plan).
    smoke_fire_enabled: bool = False
    smoke_fire_min_consistent: int = 2
    camera_tamper_window_seconds: float = 5.0


@dataclass
class _CooldownState:
    last_fired_ms: Optional[int] = None


class RiskFusionEngine:
    def __init__(self, config: RiskFusionConfig):
        self._config = config
        self._cooldowns: Dict[str, _CooldownState] = {
            "POSSIBLE_FALL": _CooldownState(),
            "PERSON_PRONE_INACTIVE": _CooldownState(),
            "UNEXPECTED_PERSON": _CooldownState(),
            "POSSIBLE_SMOKE_OR_FIRE": _CooldownState(),
            "CAMERA_TAMPERED": _CooldownState(),
        }

        # POSSIBLE_FALL: rafaga corta de posturas "lying_or_fallen" que
        # confirma una transicion sostenida desde "standing".
        self._recent_lying: Deque[PoseObservation] = deque()
        self._last_posture: Optional[str] = None
        self._last_pose_ms: Optional[int] = None

        # PERSON_PRONE_INACTIVE: desde cuando la postura es continuamente
        # "lying_or_fallen" sin una observacion "standing" intermedia.
        # "unknown" (sin deteccion en ese frame) no reinicia el conteo: el
        # modo VIDEO no garantiza una inferencia por frame.
        self._prone_since_ms: Optional[int] = None

        self._last_person_ms: Optional[int] = None

        # POSSIBLE_SMOKE_OR_FIRE: rafaga corta de detecciones coherentes.
        self._recent_smoke: Deque[SmokeFireObservation] = deque()
        self._last_smoke_ms: Optional[int] = None

        # CAMERA_TAMPERED: desde cuando la senal de salud es continuamente
        # mala (ocluida, cambio extremo o sin frames).
        self._unhealthy_since_ms: Optional[int] = None
        self._last_health_ms: Optional[int] = None

    def set_armed(self, armed: bool) -> None:
        self._config.armed = armed

    # ---- API publica: una llamada por observacion, un candidato o None ----

    def observe_pose(self, obs: PoseObservation, zone: Optional[str] = None) -> Optional[dict]:
        if not self._is_monotonic(obs.timestamp_ms, "_last_pose_ms"):
            return None
        fall = self._evaluate_fall(obs, zone)
        if fall is not None:
            return fall
        return self._evaluate_prone_inactive(obs, zone)

    def observe_person(self, obs: PersonObservation) -> Optional[dict]:
        if not self._is_monotonic(obs.timestamp_ms, "_last_person_ms"):
            return None
        return self._evaluate_unexpected_person(obs)

    def observe_smoke_fire(self, obs: SmokeFireObservation, zone: Optional[str] = None) -> Optional[dict]:
        if not self._is_monotonic(obs.timestamp_ms, "_last_smoke_ms"):
            return None
        return self._evaluate_smoke_fire(obs, zone)

    def observe_camera_health(self, obs: CameraHealthObservation) -> Optional[dict]:
        if not self._is_monotonic(obs.timestamp_ms, "_last_health_ms"):
            return None
        return self._evaluate_camera_tampered(obs)

    # ---- POSSIBLE_FALL ----

    def _evaluate_fall(self, obs: PoseObservation, zone: Optional[str]) -> Optional[dict]:
        if obs.posture != "lying_or_fallen":
            if obs.posture == "standing":
                self._last_posture = "standing"
            self._recent_lying.clear()
            return None

        # Se confirma transicion solo si la ultima postura conocida era
        # "standing", o si ya estamos a mitad de una rafaga que arranco
        # justo despues de una. Sin ese antecedente, una racha de "acostado"
        # no es una CAIDA confirmable (podria llevar acostada desde antes de
        # que arrancara el servicio); PERSON_PRONE_INACTIVE cubre ese caso.
        transition_confirmed = self._last_posture == "standing" or len(self._recent_lying) > 0
        self._last_posture = "lying_or_fallen"
        if not transition_confirmed:
            return None

        self._recent_lying.append(obs)
        while (
            self._recent_lying
            and obs.timestamp_ms - self._recent_lying[0].timestamp_ms > self._config.fall_burst_window_ms
        ):
            self._recent_lying.popleft()

        if len(self._recent_lying) < self._config.fall_min_consistent_frames:
            return None  # rafaga insuficiente: la Pi no la sostuvo a tiempo
        if obs.confidence < self._config.confidence_threshold:
            return None
        if not self._try_fire("POSSIBLE_FALL", obs.timestamp_ms):
            return None

        return self._build_event(
            anomaly_type="POSSIBLE_FALL",
            confidence=obs.confidence,
            evidence={"personCount": 1, "zone": zone or "unknown", "posture": obs.posture},
        )

    # ---- PERSON_PRONE_INACTIVE ----

    def _evaluate_prone_inactive(self, obs: PoseObservation, zone: Optional[str]) -> Optional[dict]:
        if obs.posture == "standing":
            self._prone_since_ms = None
            return None
        if obs.posture == "unknown":
            return None

        if self._prone_since_ms is None:
            self._prone_since_ms = obs.timestamp_ms
            return None

        elapsed_seconds = (obs.timestamp_ms - self._prone_since_ms) / 1000.0
        if elapsed_seconds < self._config.prone_inactive_seconds:
            return None
        if obs.confidence < self._config.confidence_threshold:
            return None
        if not self._try_fire("PERSON_PRONE_INACTIVE", obs.timestamp_ms):
            return None

        return self._build_event(
            anomaly_type="PERSON_PRONE_INACTIVE",
            confidence=obs.confidence,
            evidence={
                "personCount": 1,
                "zone": zone or "unknown",
                "posture": obs.posture,
                "horizontalSeconds": elapsed_seconds,
            },
        )

    # ---- UNEXPECTED_PERSON ----

    def _evaluate_unexpected_person(self, obs: PersonObservation) -> Optional[dict]:
        if not self._config.armed:
            return None
        if not obs.person_present or obs.zone is None:
            return None
        if obs.zone not in self._config.armed_zones:
            return None
        if obs.confidence < self._config.confidence_threshold:
            return None
        if not self._try_fire("UNEXPECTED_PERSON", obs.timestamp_ms):
            return None

        return self._build_event(
            anomaly_type="UNEXPECTED_PERSON",
            confidence=obs.confidence,
            evidence={"personCount": 1, "zone": obs.zone},
        )

    # ---- POSSIBLE_SMOKE_OR_FIRE ----

    def _evaluate_smoke_fire(self, obs: SmokeFireObservation, zone: Optional[str]) -> Optional[dict]:
        if not self._config.smoke_fire_enabled:
            return None
        if not obs.detected:
            self._recent_smoke.clear()
            return None

        self._recent_smoke.append(obs)
        while (
            self._recent_smoke
            and obs.timestamp_ms - self._recent_smoke[0].timestamp_ms > self._config.fall_burst_window_ms
        ):
            self._recent_smoke.popleft()

        if len(self._recent_smoke) < self._config.smoke_fire_min_consistent:
            return None
        if obs.confidence < self._config.confidence_threshold:
            return None
        if not self._try_fire("POSSIBLE_SMOKE_OR_FIRE", obs.timestamp_ms):
            return None

        return self._build_event(
            anomaly_type="POSSIBLE_SMOKE_OR_FIRE",
            confidence=obs.confidence,
            evidence={"personCount": 0, "zone": zone or "unknown"},
        )

    # ---- CAMERA_TAMPERED ----

    def _evaluate_camera_tampered(self, obs: CameraHealthObservation) -> Optional[dict]:
        unhealthy = obs.occluded or obs.extreme_change or not obs.frame_received
        if not unhealthy:
            self._unhealthy_since_ms = None
            return None

        if self._unhealthy_since_ms is None:
            self._unhealthy_since_ms = obs.timestamp_ms
            return None

        elapsed_seconds = (obs.timestamp_ms - self._unhealthy_since_ms) / 1000.0
        if elapsed_seconds < self._config.camera_tamper_window_seconds:
            return None
        if not self._try_fire("CAMERA_TAMPERED", obs.timestamp_ms):
            return None

        # Fallo tecnico, no una emergencia medica: confianza fija (esta
        # senal es una heuristica determinista, no una prediccion de ML).
        return self._build_event(
            anomaly_type="CAMERA_TAMPERED",
            confidence=1.0,
            evidence={"personCount": 0, "zone": "camera"},
        )

    # ---- helpers compartidos ----

    def _is_monotonic(self, timestamp_ms: int, attr_name: str) -> bool:
        last = getattr(self, attr_name)
        if last is not None and timestamp_ms <= last:
            logger.warning("observacion con timestamp fuera de orden descartada: %s", timestamp_ms)
            return False
        setattr(self, attr_name, timestamp_ms)
        return True

    def _try_fire(self, anomaly_type: str, now_ms: int) -> bool:
        state = self._cooldowns[anomaly_type]
        if state.last_fired_ms is not None:
            elapsed_seconds = (now_ms - state.last_fired_ms) / 1000.0
            if elapsed_seconds < self._config.cooldown_seconds:
                return False
        state.last_fired_ms = now_ms
        return True

    def _build_event(self, anomaly_type: str, confidence: float, evidence: dict) -> dict:
        model_versions = {
            "pose": self._config.pose_model_version,
            "person": self._config.person_model_version,
        }
        if self._config.smoke_fire_model_version:
            model_versions["smokeFire"] = self._config.smoke_fire_model_version

        event = {
            "eventId": str(uuid.uuid4()),
            "eventType": "VISUAL_ANOMALY",
            "deviceId": self._config.device_id,
            "occurredAt": _now_iso(),
            "anomalyType": anomaly_type,
            "confidence": round(min(max(confidence, 0.0), 1.0), 4),
            "candidates": [anomaly_type],
            "evidence": evidence,
            "modelVersions": model_versions,
        }
        schemas.validate_visual_anomaly(event)
        return event
