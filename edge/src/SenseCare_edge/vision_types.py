"""Estructuras de datos compartidas entre los detectores y RiskFusionEngine.
Separadas en su propio modulo para que las pruebas puedan construir
resultados de detectores falsos sin importar vision_detectors.py (que
puede requerir mediapipe instalado para su adaptador real)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

Posture = str  # "standing" | "lying_or_fallen" | "unknown"


@dataclass(frozen=True)
class PoseObservation:
    timestamp_ms: int
    person_present: bool
    posture: Posture
    confidence: float = 1.0


@dataclass(frozen=True)
class PersonObservation:
    timestamp_ms: int
    person_present: bool
    zone: Optional[str]
    confidence: float = 1.0


@dataclass(frozen=True)
class SmokeFireObservation:
    timestamp_ms: int
    detected: bool
    confidence: float


@dataclass(frozen=True)
class CameraHealthObservation:
    timestamp_ms: int
    frame_received: bool
    occluded: bool
    extreme_change: bool
