"""Prueba enfocada en la supresion de anomalias visuales mientras hay una
evidencia BUFFERED pendiente (ver limitacion de demo documentada en
commands.py y edge/README.md). Usa un stub minimo de
`EvidenceCommandProcessor` -- `VisionService._publish_if_anomaly` solo
depende de `try_reserve_visual_evidence`, asi que no hace falta el
`commands.py` real ni MQTT para probar esta invariante.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from SenseCare_edge.frame_source import Frame, FixtureFrameSource
from SenseCare_edge.ring_buffer import FrameRingBuffer
from SenseCare_edge.risk_fusion import RiskFusionConfig, RiskFusionEngine
from SenseCare_edge.vision_detectors import ByteSizeCameraHealthMonitor, NullSmokeFireDetector
from SenseCare_edge.vision_service import VisionService, VisionServiceConfig

_JPEG = b"\xff\xd8fake"


class _FakeCommandsProcessor:
    """Solo lo que necesita `_publish_if_anomaly`: acepta la primera
    reserva y rechaza cualquier otra mientras no se libere explicitamente."""

    def __init__(self, allow_first_n: int = 1):
        self._remaining = allow_first_n
        self.reserved_event_ids: list[str] = []

    def try_reserve_visual_evidence(self, event_id: str, now_ms: int) -> bool:
        if self._remaining <= 0:
            return False
        self._remaining -= 1
        self.reserved_event_ids.append(event_id)
        return True


def _build_service(commands_processor, ring_buffer, publish_fn) -> VisionService:
    return VisionService(
        config=VisionServiceConfig(),
        frame_source=FixtureFrameSource([]),
        pose_detector=None,
        person_detector=None,
        smoke_fire_detector=NullSmokeFireDetector(),
        camera_health_monitor=ByteSizeCameraHealthMonitor(max_frame_gap_ms=5000),
        risk_fusion=RiskFusionEngine(
            RiskFusionConfig(device_id="pi-test-01", pose_model_version="pose-v1", person_model_version="person-v1")
        ),
        ring_buffer=ring_buffer,
        publish_fn=publish_fn,
        topic_visual_anomaly="SenseCare/v1/devices/pi-test-01/visual/anomaly",
        commands_processor=commands_processor,
        clock_ms=lambda: 0,
    )


class SuppressionWhilePendingEvidenceTest(unittest.TestCase):
    def test_second_anomaly_before_a_command_is_suppressed_and_counted(self):
        published: list[tuple[str, dict]] = []
        ring_buffer = FrameRingBuffer()
        commands = _FakeCommandsProcessor(allow_first_n=1)
        service = _build_service(commands, ring_buffer, lambda topic, payload: published.append((topic, payload)))

        frame_a = Frame(jpeg_bytes=_JPEG, timestamp_ms=0, width=1, height=1)
        frame_b = Frame(jpeg_bytes=_JPEG, timestamp_ms=100, width=1, height=1)
        anomaly_a = {"eventId": "evt-a", "anomalyType": "POSSIBLE_FALL"}
        anomaly_b = {"eventId": "evt-b", "anomalyType": "CAMERA_TAMPERED"}

        service._publish_if_anomaly(anomaly_a, frame_a, now_ms=0)
        service._publish_if_anomaly(anomaly_b, frame_b, now_ms=100)

        self.assertEqual(len(published), 1)
        self.assertEqual(published[0][1]["eventId"], "evt-a")
        self.assertEqual(commands.reserved_event_ids, ["evt-a"])

        # Solo A se pineo; B nunca llego a tocar el ring buffer.
        self.assertTrue(ring_buffer.has_pinned("evt-a"))
        self.assertFalse(ring_buffer.has_pinned("evt-b"))

        snapshot = service.status_snapshot()
        self.assertEqual(snapshot["anomaliesPublished"], 1)
        self.assertEqual(snapshot["anomaliesSuppressedPendingEvidence"], 1)

    def test_without_a_commands_processor_every_anomaly_publishes_normally(self):
        published: list[tuple[str, dict]] = []
        ring_buffer = FrameRingBuffer()
        service = _build_service(None, ring_buffer, lambda topic, payload: published.append((topic, payload)))

        frame_a = Frame(jpeg_bytes=_JPEG, timestamp_ms=0, width=1, height=1)
        frame_b = Frame(jpeg_bytes=_JPEG, timestamp_ms=100, width=1, height=1)

        service._publish_if_anomaly({"eventId": "evt-a", "anomalyType": "POSSIBLE_FALL"}, frame_a, now_ms=0)
        service._publish_if_anomaly({"eventId": "evt-b", "anomalyType": "CAMERA_TAMPERED"}, frame_b, now_ms=100)

        self.assertEqual(len(published), 2)
        self.assertEqual(service.status_snapshot()["anomaliesSuppressedPendingEvidence"], 0)


if __name__ == "__main__":
    unittest.main()
