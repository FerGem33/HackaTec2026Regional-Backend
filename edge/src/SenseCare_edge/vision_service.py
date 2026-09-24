"""Orquestador de vision: captura -> detectores -> RiskFusionEngine ->
ring buffer -> MQTT, con cadencia adaptativa 2 FPS base / 6 FPS rafaga (ver
plan "deteccion visual local en Raspberry Pi 4B").

Nunca acumula frames pendientes: cada ciclo lee a lo sumo un frame nuevo de
`FrameSource.read()` (que ya retorna None si no hay nada listo, ver
frame_source.py) y lo procesa de inmediato o lo descarta; nunca encola
frames viejos para "ponerse al dia". Esto es lo que exige el plan para que
un bloqueo de red/publicacion nunca retrase la deteccion.

La decision de hardware de camara sigue pendiente: este modulo recibe un
`FrameSource` y detectores ya construidos (inyeccion de dependencias), nunca
decide el adaptador concreto. `create_vision_service()` es la unica fabrica
que conoce los adaptadores reales de MediaPipe, y deja pasar
`ModelUnavailableError` para que el llamador (main.py) decida degradar en
vez de abortar el proceso completo (a diferencia de `config.load_config()`,
que si debe fallar rapido: la vision es un subsistema opcional, la
telemetria de sensores no).
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, List, Optional

from .commands import EvidenceCommandProcessor
from .frame_source import Frame, FrameSource
from .ring_buffer import FrameRingBuffer
from .risk_fusion import RiskFusionConfig, RiskFusionEngine
from .vision_detectors import (
    ByteSizeCameraHealthMonitor,
    CameraHealthMonitor,
    MediaPipePersonDetector,
    MediaPipePoseDetector,
    NullSmokeFireDetector,
    PersonDetector,
    PoseDetector,
    SmokeFireDetector,
)
from .vision_types import CameraHealthObservation

logger = logging.getLogger("SenseCare_edge.vision_service")

PublishFn = Callable[[str, dict], None]


def _monotonic_ms() -> int:
    return int(time.monotonic() * 1000)


def _percentile(sorted_values: List[float], pct: float) -> float:
    if not sorted_values:
        return 0.0
    k = (len(sorted_values) - 1) * (pct / 100)
    lower = int(k)
    upper = min(lower + 1, len(sorted_values) - 1)
    if lower == upper:
        return round(sorted_values[lower], 1)
    return round(sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (k - lower), 1)


@dataclass
class VisionServiceConfig:
    base_fps: float = 2.0
    burst_fps: float = 6.0
    burst_duration_seconds: float = 3.0
    max_pinned_age_seconds: float = 90.0


@dataclass
class _VisionMetrics:
    frames_processed: int = 0
    frames_skipped: int = 0
    anomalies_published: int = 0
    # Anomalias visuales detectadas pero NO publicadas porque ya habia una
    # evidencia BUFFERED pendiente de otro eventId (ver limitacion de demo
    # documentada en commands.py: solo se admite una reserva por dispositivo).
    anomalies_suppressed_pending_evidence: int = 0
    _latencies_ms: List[float] = field(default_factory=list)

    def record_latency(self, latency_ms: float) -> None:
        self._latencies_ms.append(latency_ms)
        if len(self._latencies_ms) > 500:
            self._latencies_ms.pop(0)

    def latency_percentiles(self) -> tuple:
        sorted_latencies = sorted(self._latencies_ms)
        return _percentile(sorted_latencies, 50), _percentile(sorted_latencies, 95)


class VisionService:
    """Un ciclo de `run_once()` procesa a lo sumo un frame. `run_forever()`
    es el bucle real (para main.py); las pruebas llaman `run_once()`
    directamente con un `FixtureFrameSource` y un reloj inyectado, sin
    sleeps reales."""

    def __init__(
        self,
        config: VisionServiceConfig,
        frame_source: FrameSource,
        pose_detector: Optional[PoseDetector],
        person_detector: Optional[PersonDetector],
        smoke_fire_detector: SmokeFireDetector,
        camera_health_monitor: CameraHealthMonitor,
        risk_fusion: RiskFusionEngine,
        ring_buffer: FrameRingBuffer,
        publish_fn: PublishFn,
        topic_visual_anomaly: str,
        commands_processor: Optional[EvidenceCommandProcessor] = None,
        clock_ms: Callable[[], int] = _monotonic_ms,
        degraded: bool = False,
    ) -> None:
        self._config = config
        self._frame_source = frame_source
        self._pose_detector = pose_detector
        self._person_detector = person_detector
        self._smoke_fire_detector = smoke_fire_detector
        self._camera_health_monitor = camera_health_monitor
        self._risk_fusion = risk_fusion
        self._ring_buffer = ring_buffer
        self._publish = publish_fn
        self._topic_visual_anomaly = topic_visual_anomaly
        self._commands = commands_processor
        self._clock_ms = clock_ms
        self._degraded = degraded

        self._burst_until_ms: Optional[int] = None
        self._camera_healthy = True
        self._frame_timestamps_ms: Deque[int] = deque(maxlen=50)
        self._metrics = _VisionMetrics()

    @property
    def degraded(self) -> bool:
        return self._degraded

    def current_interval_seconds(self) -> float:
        now_ms = self._clock_ms()
        if self._burst_until_ms is not None and now_ms < self._burst_until_ms:
            return 1.0 / self._config.burst_fps
        return 1.0 / self._config.base_fps

    def run_once(self) -> None:
        """Un ciclo: lee a lo sumo un frame, corre los detectores que
        correspondan y publica como maximo un candidato por observacion
        (RiskFusionEngine ya aplica cooldown/umbral por tipo)."""
        now_ms = self._clock_ms()
        frame: Optional[Frame] = self._frame_source.read()

        if not self._frame_source.healthy:
            health_obs = CameraHealthObservation(
                timestamp_ms=now_ms, frame_received=False, occluded=False, extreme_change=False
            )
        else:
            health_obs = self._camera_health_monitor.observe(
                frame.jpeg_bytes if frame is not None else None, now_ms
            )
        self._camera_healthy = health_obs.frame_received and not health_obs.occluded and not health_obs.extreme_change
        self._publish_if_anomaly(self._risk_fusion.observe_camera_health(health_obs), frame, now_ms)

        self._ring_buffer.evict_stale_pinned(now_ms, int(self._config.max_pinned_age_seconds * 1000))

        if frame is None:
            self._metrics.frames_skipped += 1
            return

        self._ring_buffer.add(frame)
        self._frame_timestamps_ms.append(now_ms)

        detect_started_ms = time.monotonic()

        person_obs = None
        if self._person_detector is not None:
            person_obs = self._person_detector.detect(frame.jpeg_bytes, frame.timestamp_ms)
        zone = person_obs.zone if person_obs is not None else None

        if person_obs is not None and person_obs.person_present:
            self._burst_until_ms = now_ms + int(self._config.burst_duration_seconds * 1000)

        if self._pose_detector is not None:
            pose_obs = self._pose_detector.detect(frame.jpeg_bytes, frame.timestamp_ms)
            if pose_obs is not None:
                self._publish_if_anomaly(self._risk_fusion.observe_pose(pose_obs, zone=zone), frame, now_ms)

        if person_obs is not None:
            self._publish_if_anomaly(self._risk_fusion.observe_person(person_obs), frame, now_ms)

        smoke_obs = self._smoke_fire_detector.detect(frame.jpeg_bytes, frame.timestamp_ms)
        if smoke_obs is not None:
            self._publish_if_anomaly(self._risk_fusion.observe_smoke_fire(smoke_obs, zone=zone), frame, now_ms)

        latency_ms = (time.monotonic() - detect_started_ms) * 1000
        self._metrics.record_latency(latency_ms)
        self._metrics.frames_processed += 1

    def run_forever(self, stop_event: threading.Event) -> None:
        while not stop_event.is_set():
            try:
                self.run_once()
            except Exception:  # noqa: BLE001 - un ciclo fallido no debe matar el hilo de vision
                logger.exception("fallo no controlado en el ciclo de vision")
            stop_event.wait(self.current_interval_seconds())

    def status_snapshot(self) -> dict:
        """Metricas seguras para el heartbeat `status`: nunca IP, imagenes,
        audio, coordenadas de pose ni secretos (guia, seccion 7)."""
        latency_p50, latency_p95 = self._metrics.latency_percentiles()
        effective_fps = 0.0
        if len(self._frame_timestamps_ms) >= 2:
            elapsed_seconds = (self._frame_timestamps_ms[-1] - self._frame_timestamps_ms[0]) / 1000.0
            if elapsed_seconds > 0:
                effective_fps = (len(self._frame_timestamps_ms) - 1) / elapsed_seconds

        if self._degraded:
            vision_state = "DEGRADED"
        elif not self._camera_healthy:
            vision_state = "CAMERA_ISSUE"
        else:
            vision_state = "OK"

        return {
            "visionState": vision_state,
            "effectiveFps": round(effective_fps, 2),
            "latencyMsP50": latency_p50,
            "latencyMsP95": latency_p95,
            "framesProcessed": self._metrics.frames_processed,
            "framesSkipped": self._metrics.frames_skipped,
            "anomaliesPublished": self._metrics.anomalies_published,
            "anomaliesSuppressedPendingEvidence": self._metrics.anomalies_suppressed_pending_evidence,
            "cameraHealthy": self._camera_healthy,
        }

    def _publish_if_anomaly(self, anomaly: Optional[dict], frame: Optional[Frame], now_ms: int) -> None:
        if anomaly is None:
            return

        if self._commands is not None:
            # Limitacion de demo (ver commands.py): solo se admite una
            # anomalia visual con evidencia BUFFERED pendiente por
            # dispositivo, porque UPLOAD_EVIDENCE no lleva el eventId
            # original. Si ya hay una reserva vigente, esta anomalia se
            # SUPRIME por completo (no se publica, no se pinea su frame) en
            # vez de arriesgar que un comando cloud reciba la imagen
            # equivocada.
            reserved = self._commands.try_reserve_visual_evidence(anomaly["eventId"], now_ms)
            if not reserved:
                self._metrics.anomalies_suppressed_pending_evidence += 1
                logger.warning(
                    "VISUAL_ANOMALY suprimida (ya hay evidencia BUFFERED pendiente): %s",
                    anomaly["anomalyType"],
                )
                return

        self._publish(self._topic_visual_anomaly, anomaly)
        self._ring_buffer.pin_best_frame_for(anomaly["eventId"], now_ms, frame=frame)
        self._metrics.anomalies_published += 1
        logger.warning("VISUAL_ANOMALY publicada: %s", anomaly["anomalyType"])


def create_vision_service(
    device_id: str,
    vision_config: dict,
    camera_config: dict,
    risk_fusion_config: dict,
    frame_source: FrameSource,
    ring_buffer: FrameRingBuffer,
    publish_fn: PublishFn,
    topic_visual_anomaly: str,
    commands_processor: Optional[EvidenceCommandProcessor] = None,
) -> VisionService:
    """Construye el pipeline real con adaptadores MediaPipe. Puede lanzar
    `ModelUnavailableError` (ver vision_detectors.py) si falta un modelo
    critico; el llamador debe tratarlo como DEGRADED, no como fallo fatal
    del proceso (a diferencia de `config.load_config`)."""
    pose_detector = MediaPipePoseDetector(vision_config.get("poseModelPath"))
    person_detector = MediaPipePersonDetector(
        vision_config.get("personModelPath"), zones=vision_config.get("zones", {})
    )
    # Humo/fuego permanece apagado hasta que exista un adaptador TFLite real
    # y validado (ver NullSmokeFireDetector): activar smokeFireEnabled sin
    # un detector real nunca inventa detecciones.
    smoke_fire_detector = NullSmokeFireDetector()

    camera_health_monitor = ByteSizeCameraHealthMonitor(
        max_frame_gap_ms=int(camera_config.get("maxFrameGapMs", 5000)),
        extreme_change_ratio=float(camera_config.get("extremeChangeRatio", 0.85)),
    )

    risk_fusion = RiskFusionEngine(
        RiskFusionConfig(
            device_id=device_id,
            pose_model_version=vision_config.get("poseModelVersion", "pose-v1"),
            person_model_version=vision_config.get("personModelVersion", "person-v1"),
            smoke_fire_model_version=vision_config.get("smokeFireModelVersion"),
            confidence_threshold=float(vision_config.get("anomalyThreshold", 0.80)),
            cooldown_seconds=float(vision_config.get("cooldownSeconds", 120.0)),
            prone_inactive_seconds=float(risk_fusion_config.get("proneInactiveSeconds", 12.0)),
            fall_min_consistent_frames=int(risk_fusion_config.get("minConsistentFrames", 2)),
            armed_zones=tuple(risk_fusion_config.get("armedZones", [])),
            armed=bool(risk_fusion_config.get("armed", True)),
            smoke_fire_enabled=False,
        )
    )

    service_config = VisionServiceConfig(
        base_fps=float(vision_config.get("baseFps", 2.0)),
        burst_fps=float(vision_config.get("burstFps", 6.0)),
        burst_duration_seconds=float(vision_config.get("burstDurationSeconds", 3.0)),
    )

    return VisionService(
        config=service_config,
        frame_source=frame_source,
        pose_detector=pose_detector,
        person_detector=person_detector,
        smoke_fire_detector=smoke_fire_detector,
        camera_health_monitor=camera_health_monitor,
        risk_fusion=risk_fusion,
        ring_buffer=ring_buffer,
        publish_fn=publish_fn,
        topic_visual_anomaly=topic_visual_anomaly,
        commands_processor=commands_processor,
    )
