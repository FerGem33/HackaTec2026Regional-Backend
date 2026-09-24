"""Detectores de vision.

Los Protocols definen el contrato que RiskFusionEngine consume; las pruebas
usan implementaciones falsas inyectables (ver tests/test_risk_fusion.py),
nunca los adaptadores reales de aqui. Los adaptadores de MediaPipe importan
`mediapipe`/`opencv`/`numpy` de forma perezosa (dentro de su __init__, no al
nivel de modulo), para que el resto del sistema -- y las pruebas -- no
dependan de tenerlos instalados mientras la decision de hardware (CSI/USB/
celular) siga pendiente.

Modo VIDEO de MediaPipe: exige timestamps_ms estrictamente crecientes por
instancia de detector; no asume que cada frame produzca una inferencia (el
modo live puede omitir frames bajo carga). Ver
https://ai.google.dev/edge/api/mediapipe/python/mp/tasks/vision/PoseLandmarker
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional, Protocol

from .vision_types import CameraHealthObservation, PersonObservation, PoseObservation, SmokeFireObservation

logger = logging.getLogger("SenseCare_edge.vision_detectors")


class PoseDetector(Protocol):
    def detect(self, jpeg_bytes: bytes, timestamp_ms: int) -> Optional[PoseObservation]: ...


class PersonDetector(Protocol):
    def detect(self, jpeg_bytes: bytes, timestamp_ms: int) -> Optional[PersonObservation]: ...


class SmokeFireDetector(Protocol):
    def detect(self, jpeg_bytes: bytes, timestamp_ms: int) -> Optional[SmokeFireObservation]: ...


class CameraHealthMonitor(Protocol):
    def observe(self, jpeg_bytes: Optional[bytes], timestamp_ms: int) -> CameraHealthObservation: ...


class ModelUnavailableError(RuntimeError):
    """Un modelo critico configurado no existe o no se pudo cargar; el
    servicio de vision debe pasar a DEGRADED, nunca inventar una anomalia."""


def _require_model_file(path: Optional[str], label: str) -> str:
    if not path:
        raise ModelUnavailableError(f"ruta de modelo no configurada: {label}")
    if not Path(path).is_file():
        raise ModelUnavailableError(f"modelo {label} no encontrado en {path}")
    return path


class NullSmokeFireDetector:
    """POSSIBLE_SMOKE_OR_FIRE esta apagado por defecto (ver plan): sin un
    modelo TFLite compatible, medido y validado, nunca se reporta este
    candidato. Este detector satisface el Protocol sin inventar detecciones."""

    def detect(self, jpeg_bytes: bytes, timestamp_ms: int) -> Optional[SmokeFireObservation]:
        return None


class ByteSizeCameraHealthMonitor:
    """Heuristica minima de salud de camara, sin modelo: compara el tamano
    en bytes de JPEGs consecutivos (un cambio extremo o repentino sugiere
    oclusion o manipulacion) y detecta perdida de frames por vencimiento de
    tiempo. Esto es un punto de partida razonable para el demo, NO un
    reemplazo de un detector de oclusion entrenado; el equipo debe medirlo
    con la camara real antes de confiar en el para produccion.
    """

    def __init__(self, max_frame_gap_ms: int, extreme_change_ratio: float = 0.85):
        self._max_frame_gap_ms = max_frame_gap_ms
        self._extreme_change_ratio = extreme_change_ratio
        self._last_frame_at_ms: Optional[int] = None
        self._last_size: Optional[int] = None

    def observe(self, jpeg_bytes: Optional[bytes], timestamp_ms: int) -> CameraHealthObservation:
        frame_received = jpeg_bytes is not None
        frame_loss = (
            self._last_frame_at_ms is not None
            and (timestamp_ms - self._last_frame_at_ms) > self._max_frame_gap_ms
        )

        extreme_change = False
        if frame_received:
            size = len(jpeg_bytes)  # type: ignore[arg-type]
            if self._last_size is not None and self._last_size > 0:
                ratio = abs(size - self._last_size) / self._last_size
                extreme_change = ratio >= self._extreme_change_ratio
            self._last_size = size
            self._last_frame_at_ms = timestamp_ms

        return CameraHealthObservation(
            timestamp_ms=timestamp_ms,
            frame_received=frame_received,
            occluded=frame_loss,
            extreme_change=extreme_change,
        )


class MediaPipePoseDetector:
    """Pose Landmarker de MediaPipe en modo VIDEO. La clasificacion de
    postura (`_classify_posture`) es una heuristica geometrica simple
    (dispersion vertical vs horizontal de hombros/caderas), no un
    clasificador entrenado: sirve como punto de partida razonable hasta que
    el equipo mida con datos reales de la Pi y ajuste umbrales."""

    def __init__(self, model_path: Optional[str]):
        model_path = _require_model_file(model_path, "pose")
        import mediapipe as mp  # noqa: PLC0415 -- import perezoso a proposito

        base_options = mp.tasks.BaseOptions(model_asset_path=model_path)
        options = mp.tasks.vision.PoseLandmarkerOptions(
            base_options=base_options,
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
        )
        self._landmarker = mp.tasks.vision.PoseLandmarker.create_from_options(options)
        self._mp_image_cls = mp.Image
        self._mp_format = mp.ImageFormat.SRGB
        self._last_timestamp_ms = -1

    def detect(self, jpeg_bytes: bytes, timestamp_ms: int) -> Optional[PoseObservation]:
        if timestamp_ms <= self._last_timestamp_ms:
            logger.warning("timestamp de pose fuera de orden, descartado: %s", timestamp_ms)
            return None
        self._last_timestamp_ms = timestamp_ms

        image = self._decode_image(jpeg_bytes)
        result = self._landmarker.detect_for_video(image, timestamp_ms)
        if not result.pose_landmarks:
            return PoseObservation(
                timestamp_ms=timestamp_ms, person_present=False, posture="unknown", confidence=0.0
            )

        landmarks = result.pose_landmarks[0]
        posture = self._classify_posture(landmarks)
        confidence = self._average_visibility(landmarks)
        return PoseObservation(
            timestamp_ms=timestamp_ms, person_present=True, posture=posture, confidence=confidence
        )

    @staticmethod
    def _average_visibility(landmarks) -> float:
        # MediaPipe expone `visibility` por landmark (0-1); un promedio
        # simple sirve como confianza agregada de la pose completa. No es
        # una probabilidad calibrada, solo una senal relativa util para el
        # umbral configurable.
        visibilities = [getattr(point, "visibility", 1.0) for point in landmarks]
        return sum(visibilities) / len(visibilities) if visibilities else 0.0

    def _decode_image(self, jpeg_bytes: bytes):
        import cv2
        import numpy as np

        array = np.frombuffer(jpeg_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(array, cv2.IMREAD_COLOR)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        return self._mp_image_cls(image_format=self._mp_format, data=rgb)

    @staticmethod
    def _classify_posture(landmarks) -> str:
        try:
            shoulder = landmarks[11]
            hip = landmarks[23]
        except IndexError:
            return "unknown"
        vertical_span = abs(shoulder.y - hip.y)
        horizontal_span = abs(shoulder.x - hip.x)
        return "lying_or_fallen" if vertical_span < horizontal_span else "standing"


class MediaPipePersonDetector:
    """Object Detector de MediaPipe (modo VIDEO) filtrado a la clase
    "person", cuantizado. `zones` mapea nombres de zona a un rectangulo
    normalizado (0-1) del encuadre; el detector reporta la primera zona
    cuyo rectangulo contiene el centro de la deteccion con score mas alto."""

    def __init__(self, model_path: Optional[str], zones: dict):
        model_path = _require_model_file(model_path, "person")
        import mediapipe as mp  # noqa: PLC0415

        base_options = mp.tasks.BaseOptions(model_asset_path=model_path)
        options = mp.tasks.vision.ObjectDetectorOptions(
            base_options=base_options,
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            category_allowlist=["person"],
        )
        self._detector = mp.tasks.vision.ObjectDetector.create_from_options(options)
        self._mp_image_cls = mp.Image
        self._mp_format = mp.ImageFormat.SRGB
        self._zones = zones
        self._last_timestamp_ms = -1

    def detect(self, jpeg_bytes: bytes, timestamp_ms: int) -> Optional[PersonObservation]:
        if timestamp_ms <= self._last_timestamp_ms:
            logger.warning("timestamp de persona fuera de orden, descartado: %s", timestamp_ms)
            return None
        self._last_timestamp_ms = timestamp_ms

        image = self._decode_image(jpeg_bytes)
        result = self._detector.detect_for_video(image, timestamp_ms)
        if not result.detections:
            return PersonObservation(
                timestamp_ms=timestamp_ms, person_present=False, zone=None, confidence=0.0
            )

        best = max(result.detections, key=lambda d: d.categories[0].score)
        box = best.bounding_box
        center_x = (box.origin_x + box.width / 2) / image.width
        center_y = (box.origin_y + box.height / 2) / image.height
        zone = self._zone_for(center_x, center_y)
        return PersonObservation(
            timestamp_ms=timestamp_ms,
            person_present=True,
            zone=zone,
            confidence=best.categories[0].score,
        )

    def _decode_image(self, jpeg_bytes: bytes):
        import cv2
        import numpy as np

        array = np.frombuffer(jpeg_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(array, cv2.IMREAD_COLOR)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        return self._mp_image_cls(image_format=self._mp_format, data=rgb)

    def _zone_for(self, x: float, y: float) -> Optional[str]:
        for name, rect in self._zones.items():
            if rect["x0"] <= x <= rect["x1"] and rect["y0"] <= y <= rect["y1"]:
                return name
        return None
