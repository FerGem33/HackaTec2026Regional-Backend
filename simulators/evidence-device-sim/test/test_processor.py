import dataclasses
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from evidence_device_sim.errors import PutIoError, PutTimeoutError  # noqa: E402
from evidence_device_sim.processor import EvidenceOrderProcessor  # noqa: E402

CASE_ID = "55555555-5555-4555-8555-555555555555"
COMMAND_ID = "44444444-4444-4444-b444-444444444444"
IMAGE_ID = "66666666-6666-4666-9666-666666666666"
RECIPIENT_SLUG = "recipient-demo-01"
S3_KEY = f"raw-images/{RECIPIENT_SLUG}/{CASE_ID}/{IMAGE_ID}.jpg"
DEVICE_ID = "pi-demo-01"


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _future(seconds: int = 300) -> str:
    return _iso(datetime.now(timezone.utc) + timedelta(seconds=seconds))


def _past(seconds: int = 60) -> str:
    return _iso(datetime.now(timezone.utc) - timedelta(seconds=seconds))


def _command(**overrides) -> dict:
    base = {
        "commandId": COMMAND_ID,
        "caseId": CASE_ID,
        "command": "UPLOAD_EVIDENCE",
        "reason": "LOCAL_VISUAL_ANOMALY",
        "captureMode": "BUFFERED",
        "s3Key": S3_KEY,
        "uploadUrl": "https://example-bucket.s3.amazonaws.com/signed-a",
        "expiresAt": _future(),
    }
    base.update(overrides)
    return base


class FakePublisher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, kind: str, payload: dict) -> None:
        self.calls.append((kind, payload))

    def acks(self) -> list[dict]:
        return [p for k, p in self.calls if k == "command-acks"]

    def evidence(self) -> list[dict]:
        return [p for k, p in self.calls if k == "evidence"]


def _put_ok(_url: str, _data: bytes) -> None:
    return None


def _put_timeout(_url: str, _data: bytes) -> None:
    raise PutTimeoutError("simulated timeout")


def _put_io_error(_url: str, _data: bytes) -> None:
    raise PutIoError("simulated 500")


class EvidenceOrderProcessorTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.image_path = Path(self._tmpdir.name) / "fixture.jpg"
        self.image_path.write_bytes(b"\xff\xd8" + b"\x00" * 100)
        self.publisher = FakePublisher()
        self.processor = EvidenceOrderProcessor(
            device_id=DEVICE_ID, image_path=self.image_path, publish_fn=self.publisher
        )

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    # ---- 1. payload valido ----

    def test_valid_command_is_accepted_with_ack_true(self) -> None:
        outcome = self.processor.handle_command(_command())

        self.assertEqual(outcome, "ACCEPTED")
        acks = self.publisher.acks()
        self.assertEqual(len(acks), 1)
        self.assertEqual(acks[0]["accepted"], True)
        self.assertEqual(acks[0]["caseId"], CASE_ID)
        self.assertEqual(acks[0]["commandId"], COMMAND_ID)
        self.assertNotIn("reason", acks[0])
        self.assertEqual(self.publisher.evidence(), [])

    # ---- 2. deduplicacion ----

    def test_exact_duplicate_while_pending_does_not_re_ack(self) -> None:
        first = self.processor.handle_command(_command())
        second = self.processor.handle_command(_command())  # mismo payload exacto

        self.assertEqual(first, "ACCEPTED")
        self.assertEqual(second, "RENEWED")
        self.assertEqual(len(self.publisher.acks()), 1)  # no se reenvia el ACK

    def test_exact_duplicate_after_terminal_success_resends_same_final_result(self) -> None:
        self.processor.handle_command(_command())
        self.processor.attempt_upload(COMMAND_ID, _put_ok)
        self.assertEqual(len(self.publisher.evidence()), 1)
        first_result = self.publisher.evidence()[0]

        outcome = self.processor.handle_command(_command())

        self.assertEqual(outcome, "RESENT")
        evidence_messages = self.publisher.evidence()
        self.assertEqual(len(evidence_messages), 2)
        self.assertEqual(evidence_messages[1], first_result)  # exactamente el mismo resultado

    # ---- 3. COMMAND_CONFLICT ----

    def test_same_command_id_different_immutable_field_is_rejected_as_conflict(self) -> None:
        self.processor.handle_command(_command())

        conflicting = _command(reason="SENSOR_ANOMALY", captureMode="CURRENT")
        outcome = self.processor.handle_command(conflicting)

        self.assertEqual(outcome, "CONFLICT")
        acks = self.publisher.acks()
        self.assertEqual(len(acks), 2)
        self.assertEqual(acks[1]["accepted"], False)
        self.assertEqual(acks[1]["reason"], "COMMAND_CONFLICT")

    def test_different_s3_key_for_same_command_id_is_a_conflict(self) -> None:
        self.processor.handle_command(_command())
        other_image_id = "77777777-7777-4777-9777-777777777777"
        conflicting = _command(s3Key=f"raw-images/{RECIPIENT_SLUG}/{CASE_ID}/{other_image_id}.jpg")

        outcome = self.processor.handle_command(conflicting)

        self.assertEqual(outcome, "CONFLICT")

    # ---- 4. URL renovada mientras esta pendiente ----

    def test_retry_with_only_upload_url_changed_while_pending_updates_url_without_reacking(self) -> None:
        self.processor.handle_command(_command(uploadUrl="https://example-bucket.s3.amazonaws.com/signed-a"))
        outcome = self.processor.handle_command(
            _command(uploadUrl="https://example-bucket.s3.amazonaws.com/signed-b")
        )

        self.assertEqual(outcome, "RENEWED")
        self.assertEqual(len(self.publisher.acks()), 1)  # sin segundo ACK

        put_calls: list[str] = []

        def _capturing_put(url: str, _data: bytes) -> None:
            put_calls.append(url)

        self.processor.attempt_upload(COMMAND_ID, _capturing_put)

        self.assertEqual(put_calls, ["https://example-bucket.s3.amazonaws.com/signed-b"])
        self.assertEqual(len(self.publisher.evidence()), 1)
        self.assertEqual(self.publisher.evidence()[0]["eventType"], "EVIDENCE_UPLOADED")

    # ---- 5. ACK + upload exitoso ----

    def test_full_happy_path_publishes_ack_true_then_evidence_uploaded(self) -> None:
        self.processor.handle_command(_command())
        self.processor.attempt_upload(COMMAND_ID, _put_ok)

        acks = self.publisher.acks()
        evidence = self.publisher.evidence()
        self.assertEqual(len(acks), 1)
        self.assertTrue(acks[0]["accepted"])
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["eventType"], "EVIDENCE_UPLOADED")
        self.assertEqual(evidence[0]["s3Key"], S3_KEY)
        self.assertEqual(evidence[0]["imageId"], IMAGE_ID)
        self.assertEqual(evidence[0]["caseId"], CASE_ID)
        self.assertEqual(evidence[0]["commandId"], COMMAND_ID)

    # ---- 6. expiracion / fallo de PUT ----

    def test_command_that_already_expired_on_arrival_is_rejected_without_ever_accepting(self) -> None:
        outcome = self.processor.handle_command(_command(expiresAt=_past()))

        self.assertEqual(outcome, "REJECTED")
        acks = self.publisher.acks()
        self.assertEqual(len(acks), 1)
        self.assertFalse(acks[0]["accepted"])
        self.assertEqual(acks[0]["reason"], "EXPIRED")
        self.assertEqual(self.publisher.evidence(), [])

    def test_put_timeout_publishes_evidence_failed_upload_timeout(self) -> None:
        self.processor.handle_command(_command())
        self.processor.attempt_upload(COMMAND_ID, _put_timeout)

        evidence = self.publisher.evidence()
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["eventType"], "EVIDENCE_FAILED")
        self.assertEqual(evidence[0]["errorCode"], "UPLOAD_TIMEOUT")

    def test_put_http_error_publishes_evidence_failed_io_error(self) -> None:
        self.processor.handle_command(_command())
        self.processor.attempt_upload(COMMAND_ID, _put_io_error)

        evidence = self.publisher.evidence()
        self.assertEqual(evidence[0]["eventType"], "EVIDENCE_FAILED")
        self.assertEqual(evidence[0]["errorCode"], "IO_ERROR")

    def test_upload_url_expiring_between_accept_and_attempt_fails_as_url_expired(self) -> None:
        # Simula el paso del tiempo entre el accept y el intento real de
        # subida: la orden se acepto a tiempo (expiresAt aun no vencia),
        # pero para cuando llega el momento de subir ya vencio. A
        # diferencia de EXPIRED (rechazo antes de aceptar), esto usa el
        # codigo de EVIDENCE_FAILED URL_EXPIRED.
        self.processor.handle_command(_command(expiresAt=_future(seconds=1)))
        record = self.processor._records[COMMAND_ID]  # type: ignore[attr-defined]
        record.fingerprint = dataclasses.replace(record.fingerprint, expires_at=_past())

        self.processor.attempt_upload(COMMAND_ID, _put_ok)

        evidence = self.publisher.evidence()
        self.assertEqual(evidence[0]["eventType"], "EVIDENCE_FAILED")
        self.assertEqual(evidence[0]["errorCode"], "URL_EXPIRED")

    # ---- 7. ausencia o JPEG invalido ----

    def test_missing_fixture_file_is_rejected_as_frame_not_available(self) -> None:
        self.image_path.unlink()

        outcome = self.processor.handle_command(_command())

        self.assertEqual(outcome, "REJECTED")
        acks = self.publisher.acks()
        self.assertFalse(acks[0]["accepted"])
        self.assertEqual(acks[0]["reason"], "FRAME_NOT_AVAILABLE")
        self.assertEqual(self.publisher.evidence(), [])

    def test_fixture_without_jpeg_signature_is_rejected_as_frame_not_available(self) -> None:
        self.image_path.write_bytes(b"not-a-real-jpeg")

        outcome = self.processor.handle_command(_command())

        self.assertEqual(outcome, "REJECTED")
        self.assertEqual(self.publisher.acks()[0]["reason"], "FRAME_NOT_AVAILABLE")

    def test_oversized_fixture_is_rejected_as_frame_not_available(self) -> None:
        self.image_path.write_bytes(b"\xff\xd8" + b"\x00" * (1_048_576 + 1))

        outcome = self.processor.handle_command(_command())

        self.assertEqual(outcome, "REJECTED")
        self.assertEqual(self.publisher.acks()[0]["reason"], "FRAME_NOT_AVAILABLE")

    # ---- robustez adicional: s3Key/caseId inconsistente y payload invalido ----

    def test_s3_key_case_id_mismatch_is_rejected_as_invalid_s3_key(self) -> None:
        other_case_id = "99999999-9999-4999-8999-999999999999"
        bad_command = _command(s3Key=f"raw-images/{RECIPIENT_SLUG}/{other_case_id}/{IMAGE_ID}.jpg")

        outcome = self.processor.handle_command(bad_command)

        self.assertEqual(outcome, "REJECTED")
        self.assertEqual(self.publisher.acks()[0]["reason"], "INVALID_S3_KEY")

    def test_schema_invalid_payload_with_recognizable_ids_is_rejected_as_invalid_case(self) -> None:
        bad_command = _command(captureMode="NOT_A_REAL_MODE")

        outcome = self.processor.handle_command(bad_command)

        self.assertEqual(outcome, "REJECTED")
        self.assertEqual(self.publisher.acks()[0]["reason"], "INVALID_CASE")

    def test_schema_invalid_payload_without_usable_ids_is_dropped_silently(self) -> None:
        outcome = self.processor.handle_command({"command": "UPLOAD_EVIDENCE"})

        self.assertEqual(outcome, "DROPPED")
        self.assertEqual(self.publisher.calls, [])


if __name__ == "__main__":
    unittest.main()
