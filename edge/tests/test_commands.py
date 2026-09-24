from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from SenseCare_edge.commands import EvidenceCommandProcessor
from SenseCare_edge.frame_source import Frame
from SenseCare_edge.ring_buffer import FrameRingBuffer


class _FakeClockMs:
    def __init__(self, value: int = 0):
        self.value = value

    def __call__(self) -> int:
        return self.value


def _uuid() -> str:
    return str(uuid.uuid4())


def _build_command(
    case_id: str,
    command_id: str,
    *,
    s3_key: str | None = None,
    expires_at: str = "2999-01-01T00:00:00Z",
    capture_mode: str = "CURRENT",
    upload_url: str = "https://example-bucket.s3.amazonaws.com/upload?sig=abc",
    reason: str = "LOCAL_VISUAL_ANOMALY",
) -> dict:
    s3_key = s3_key or f"raw-images/recipient-1/{case_id}/{_uuid()}.jpg"
    return {
        "commandId": command_id,
        "caseId": case_id,
        "command": "UPLOAD_EVIDENCE",
        "reason": reason,
        "captureMode": capture_mode,
        "s3Key": s3_key,
        "uploadUrl": upload_url,
        "expiresAt": expires_at,
    }


class _Recorder:
    def __init__(self):
        self.messages: list[tuple[str, dict]] = []

    def __call__(self, topic: str, payload: dict) -> None:
        self.messages.append((topic, payload))

    def last_ack(self) -> dict:
        for topic, payload in reversed(self.messages):
            if topic == "command-acks":
                return payload
        raise AssertionError("no se publico ningun COMMAND_ACK")


def _processor(
    publish_fn=None,
    ring_buffer=None,
    put_fn=None,
    capture_current_fn=None,
    visual_evidence_ttl_ms=None,
    clock_ms=None,
):
    kwargs = dict(
        device_id="pi-test-01",
        ring_buffer=ring_buffer or FrameRingBuffer(),
        capture_current_fn=capture_current_fn or (lambda: b"\xff\xd8fake-current-frame"),
        publish_fn=publish_fn or _Recorder(),
        put_fn=put_fn or (lambda url, data: None),
    )
    if visual_evidence_ttl_ms is not None:
        kwargs["visual_evidence_ttl_ms"] = visual_evidence_ttl_ms
    if clock_ms is not None:
        kwargs["clock_ms"] = clock_ms
    return EvidenceCommandProcessor(**kwargs)


class ExpiredUrlTest(unittest.TestCase):
    def test_command_already_expired_is_rejected_without_upload(self):
        published = _Recorder()
        put_calls = []
        processor = _processor(publish_fn=published, put_fn=lambda url, data: put_calls.append(url))

        cmd = _build_command(_uuid(), _uuid(), expires_at="2000-01-01T00:00:00Z")
        outcome = processor.handle_command(cmd)

        self.assertEqual(outcome, "REJECTED")
        self.assertEqual(published.last_ack()["accepted"], False)
        self.assertEqual(published.last_ack()["reason"], "EXPIRED")
        self.assertEqual(put_calls, [])


class InvalidS3KeyTest(unittest.TestCase):
    def test_s3_key_case_id_mismatch_is_rejected(self):
        published = _Recorder()
        processor = _processor(publish_fn=published)

        case_id = _uuid()
        other_case_id = _uuid()
        cmd = _build_command(case_id, _uuid(), s3_key=f"raw-images/recipient-1/{other_case_id}/{_uuid()}.jpg")

        outcome = processor.handle_command(cmd)

        self.assertEqual(outcome, "REJECTED")
        self.assertEqual(published.last_ack()["reason"], "INVALID_S3_KEY")


class DuplicateWithRenewedUrlTest(unittest.TestCase):
    def test_same_command_id_only_url_changes_reuses_the_captured_frame(self):
        published = _Recorder()
        put_calls = []
        processor = _processor(publish_fn=published, put_fn=lambda url, data: put_calls.append(url))

        case_id, command_id = _uuid(), _uuid()
        first = _build_command(case_id, command_id, upload_url="https://example.com/v1")
        outcome1 = processor.handle_command(first)
        self.assertEqual(outcome1, "ACCEPTED")

        renewed = dict(first)
        renewed["uploadUrl"] = "https://example.com/v2"
        outcome2 = processor.handle_command(renewed)
        self.assertEqual(outcome2, "RENEWED")

        processor.attempt_upload(command_id)

        self.assertEqual(put_calls, ["https://example.com/v2"])
        self.assertEqual(published.messages[-1][0], "evidence")
        self.assertEqual(published.messages[-1][1]["eventType"], "EVIDENCE_UPLOADED")


class CommandConflictTest(unittest.TestCase):
    def test_immutable_field_change_is_rejected_as_conflict(self):
        published = _Recorder()
        processor = _processor(publish_fn=published)

        case_id, command_id = _uuid(), _uuid()
        first = _build_command(case_id, command_id, reason="LOCAL_VISUAL_ANOMALY")
        self.assertEqual(processor.handle_command(first), "ACCEPTED")

        conflicting = dict(first)
        conflicting["reason"] = "SENSOR_ANOMALY"
        outcome = processor.handle_command(conflicting)

        self.assertEqual(outcome, "CONFLICT")
        self.assertEqual(published.last_ack()["reason"], "COMMAND_CONFLICT")


class MissingBufferedFrameTest(unittest.TestCase):
    def test_buffered_order_without_a_pending_reservation_fails_without_recapturing(self):
        published = _Recorder()
        capture_calls = []
        processor = _processor(
            publish_fn=published,
            ring_buffer=FrameRingBuffer(),  # sin frame pineado, ninguna reserva de evidencia visual
            capture_current_fn=lambda: capture_calls.append(1) or b"\xff\xd8should-not-be-used",
        )

        cmd = _build_command(_uuid(), _uuid(), capture_mode="BUFFERED")
        outcome = processor.handle_command(cmd)

        self.assertEqual(outcome, "REJECTED")
        self.assertEqual(published.last_ack()["reason"], "FRAME_NOT_AVAILABLE")
        self.assertEqual(capture_calls, [])  # BUFFERED nunca dispara una captura nueva


class SecondAnomalyBeforeCommandIsSuppressedTest(unittest.TestCase):
    """Escenario "anomalia A, luego B antes de comando": la segunda reserva
    se rechaza mientras la primera siga vigente, y el comando BUFFERED solo
    puede reclamar el frame de la anomalia realmente reservada (A). El
    frame de B queda intacto (ver limitacion de demo en commands.py)."""

    def test_second_reservation_attempt_fails_and_command_only_claims_the_first_frame(self):
        published = _Recorder()
        ring_buffer = FrameRingBuffer()
        ring_buffer.add(Frame(jpeg_bytes=b"\xff\xd8frame-a", timestamp_ms=0, width=1, height=1))
        ring_buffer.pin_best_frame_for("evt-a", now_ms=0)
        ring_buffer.add(Frame(jpeg_bytes=b"\xff\xd8frame-b", timestamp_ms=100, width=1, height=1))
        ring_buffer.pin_best_frame_for("evt-b", now_ms=100)

        # clock_ms fijo en el mismo dominio de tiempo que los `now_ms`
        # explicitos usados abajo, para que la comprobacion de vencimiento
        # de _resolve_frame (que usa el reloj interno del procesador) no
        # confunda un reloj real de produccion con estos valores de prueba.
        processor = _processor(publish_fn=published, ring_buffer=ring_buffer, clock_ms=lambda: 100)

        self.assertTrue(processor.try_reserve_visual_evidence("evt-a", now_ms=0))
        self.assertFalse(processor.try_reserve_visual_evidence("evt-b", now_ms=100))

        cmd = _build_command(_uuid(), _uuid(), capture_mode="BUFFERED")
        outcome = processor.handle_command(cmd)

        self.assertEqual(outcome, "ACCEPTED")
        # Unico frame que pudo reclamar el comando: el de A. B nunca se toco.
        self.assertFalse(ring_buffer.has_pinned("evt-a"))
        self.assertTrue(ring_buffer.has_pinned("evt-b"))


class CurrentModeIgnoresVisualReservationTest(unittest.TestCase):
    def test_current_mode_upload_leaves_pending_visual_reservation_untouched(self):
        published = _Recorder()
        ring_buffer = FrameRingBuffer()
        ring_buffer.add(Frame(jpeg_bytes=b"\xff\xd8frame-a", timestamp_ms=0, width=1, height=1))
        ring_buffer.pin_best_frame_for("evt-a", now_ms=0)
        processor = _processor(
            publish_fn=published,
            ring_buffer=ring_buffer,
            capture_current_fn=lambda: b"\xff\xd8fresh-current-frame",
        )

        self.assertTrue(processor.try_reserve_visual_evidence("evt-a", now_ms=0))

        cmd = _build_command(_uuid(), _uuid(), capture_mode="CURRENT")
        outcome = processor.handle_command(cmd)

        self.assertEqual(outcome, "ACCEPTED")
        # CURRENT es independiente: ni reclama ni libera la reserva visual
        # pendiente ni el frame que tiene pineado.
        self.assertTrue(processor.has_pending_visual_evidence(now_ms=0))
        self.assertTrue(ring_buffer.has_pinned("evt-a"))


class DuplicateCommandDoesNotReconsumeReservationTest(unittest.TestCase):
    def test_retrying_the_same_command_id_does_not_touch_the_reservation_again(self):
        published = _Recorder()
        ring_buffer = FrameRingBuffer()
        ring_buffer.add(Frame(jpeg_bytes=b"\xff\xd8frame-a", timestamp_ms=0, width=1, height=1))
        ring_buffer.pin_best_frame_for("evt-a", now_ms=0)
        processor = _processor(publish_fn=published, ring_buffer=ring_buffer, clock_ms=lambda: 0)

        self.assertTrue(processor.try_reserve_visual_evidence("evt-a", now_ms=0))

        cmd = _build_command(_uuid(), _uuid(), capture_mode="BUFFERED")
        self.assertEqual(processor.handle_command(cmd), "ACCEPTED")
        self.assertFalse(processor.has_pending_visual_evidence(now_ms=0))  # ya consumida

        # Reintento identico del mismo commandId (misma orden logica).
        outcome_retry = processor.handle_command(dict(cmd))

        self.assertEqual(outcome_retry, "RENEWED")
        self.assertFalse(processor.has_pending_visual_evidence(now_ms=0))  # sigue consumida


class VisualEvidenceExpirationTest(unittest.TestCase):
    def test_ttl_expiry_releases_the_reservation_and_the_pinned_frame(self):
        clock = _FakeClockMs(value=0)
        published = _Recorder()
        ring_buffer = FrameRingBuffer()
        ring_buffer.add(Frame(jpeg_bytes=b"\xff\xd8frame-a", timestamp_ms=0, width=1, height=1))
        ring_buffer.pin_best_frame_for("evt-a", now_ms=0)
        processor = _processor(
            publish_fn=published, ring_buffer=ring_buffer, visual_evidence_ttl_ms=1000, clock_ms=clock
        )

        self.assertTrue(processor.try_reserve_visual_evidence("evt-a", now_ms=0))

        clock.value = 500
        self.assertTrue(processor.has_pending_visual_evidence())  # todavia vigente

        clock.value = 1500
        self.assertFalse(processor.has_pending_visual_evidence())  # vencida
        self.assertFalse(ring_buffer.has_pinned("evt-a"))  # el frame tambien se libero

        # Un BUFFERED que llega despues del vencimiento nunca reclama la
        # reserva vieja: falla como si nunca hubiera existido.
        cmd = _build_command(_uuid(), _uuid(), capture_mode="BUFFERED")
        outcome = processor.handle_command(cmd)

        self.assertEqual(outcome, "REJECTED")
        self.assertEqual(published.last_ack()["reason"], "FRAME_NOT_AVAILABLE")


if __name__ == "__main__":
    unittest.main()
