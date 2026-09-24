"""Prueba de integracion sin hardware: FixtureFrameSource -> detectores
falsos inyectables -> RiskFusionEngine -> FrameRingBuffer -> "MQTT" (un
callback en memoria). Confirma exactamente lo que exige el plan: se publica
un unico evento VISUAL_ANOMALY sin ninguna imagen, y el frame que lo motivo
permanece unicamente en RAM (pineado, no reclamado).
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from SenseCare_edge.frame_source import Frame, FixtureFrameSource
from SenseCare_edge.ring_buffer import FrameRingBuffer
from SenseCare_edge.risk_fusion import RiskFusionConfig, RiskFusionEngine
from SenseCare_edge.vision_detectors import ByteSizeCameraHealthMonitor, NullSmokeFireDetector
from SenseCare_edge.vision_service import VisionService, VisionServiceConfig
from SenseCare_edge.vision_types import PersonObservation, PoseObservation

_JPEG = b"\xff\xd8fake-integration-frame"
TOPIC_VISUAL_ANOMALY = "SenseCare/v1/devices/pi-test-01/visual/anomaly"


class _FakePoseDetector:
    """Reproduce una secuencia fija de posturas, una por frame, para no
    depender de mediapipe en esta prueba de integracion sin hardware."""

    def __init__(self, postures):
        self._postures = list(postures)
        self._index = 0

    def detect(self, jpeg_bytes: bytes, timestamp_ms: int) -> Optional[PoseObservation]:
        posture = self._postures[self._index]
        self._index += 1
        return PoseObservation(timestamp_ms=timestamp_ms, person_present=True, posture=posture, confidence=0.95)


class _FakePersonDetector:
    def detect(self, jpeg_bytes: bytes, timestamp_ms: int) -> Optional[PersonObservation]:
        return PersonObservation(timestamp_ms=timestamp_ms, person_present=True, zone="living_room", confidence=0.9)


class _FakeClock:
    def __init__(self):
        self.value_ms = 0

    def __call__(self) -> int:
        return self.value_ms


class FixtureIntegrationTest(unittest.TestCase):
    def test_exactly_one_visual_anomaly_published_without_image_frame_stays_in_ram(self):
        frames = [
            Frame(jpeg_bytes=_JPEG, timestamp_ms=0, width=640, height=480),
            Frame(jpeg_bytes=_JPEG, timestamp_ms=300, width=640, height=480),
            Frame(jpeg_bytes=_JPEG, timestamp_ms=600, width=640, height=480),
        ]
        frame_source = FixtureFrameSource(frames)
        ring_buffer = FrameRingBuffer(window_seconds=10.0)
        published: list[tuple[str, dict]] = []
        clock = _FakeClock()

        service = VisionService(
            config=VisionServiceConfig(base_fps=2.0, burst_fps=6.0),
            frame_source=frame_source,
            pose_detector=_FakePoseDetector(["standing", "lying_or_fallen", "lying_or_fallen"]),
            person_detector=_FakePersonDetector(),
            smoke_fire_detector=NullSmokeFireDetector(),
            camera_health_monitor=ByteSizeCameraHealthMonitor(max_frame_gap_ms=5000),
            risk_fusion=RiskFusionEngine(
                RiskFusionConfig(
                    device_id="pi-test-01",
                    pose_model_version="pose-v1",
                    person_model_version="person-v1",
                    confidence_threshold=0.80,
                    fall_burst_window_ms=1000,
                    fall_min_consistent_frames=2,
                )
            ),
            ring_buffer=ring_buffer,
            publish_fn=lambda topic, payload: published.append((topic, payload)),
            topic_visual_anomaly=TOPIC_VISUAL_ANOMALY,
            clock_ms=clock,
        )

        for timestamp_ms in (0, 300, 600):
            clock.value_ms = timestamp_ms
            service.run_once()

        anomaly_messages = [payload for topic, payload in published if topic == TOPIC_VISUAL_ANOMALY]
        self.assertEqual(len(anomaly_messages), 1)

        event = anomaly_messages[0]
        self.assertEqual(event["anomalyType"], "POSSIBLE_FALL")
        self.assertTrue(all(not isinstance(value, (bytes, bytearray)) for value in event.values()))
        self.assertNotIn("image", event)
        self.assertNotIn("frame", event)

        # El frame que motivo la anomalia sigue solo en RAM: pineado y sin reclamar.
        self.assertTrue(ring_buffer.has_pinned(event["eventId"]))


if __name__ == "__main__":
    unittest.main()
