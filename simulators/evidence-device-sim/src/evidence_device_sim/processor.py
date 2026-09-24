"""Logica de negocio de la orden UPLOAD_EVIDENCE (equivalente de prueba a
`commands.py`/`evidence.py`, descritos en docs/EDGE_IMPLEMENTATION_GUIDE.md
seccion 8 y su subseccion de reintentos).

Sin AWS SDK ni red directa: recibe callables `publish_fn`/`put_fn`
inyectados para poder probarse sin MQTT ni HTTP reales (ver
test/test_processor.py). No implementa camara/vision real: siempre lee el
mismo fixture JPEG local pasado en el constructor.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Literal, Optional
from uuid import uuid4

from .errors import PutIoError, PutTimeoutError
from .schemas import (
    SchemaValidationError,
    validate_command_ack,
    validate_evidence_result,
    validate_upload_evidence_command,
)
from .state import CommandFingerprint, CommandRecord

logger = logging.getLogger("evidence_device_sim.processor")

# raw-images/{recipientId}/{caseId}/{imageId}.jpg -- misma forma que
# packages/contracts/schemas/uploadEvidenceCommand.schema.json#s3Key, pero
# con grupos nombrados para poder extraer caseId/imageId y verificar que el
# caseId embebido en la ruta coincide con el caseId de nivel superior (ver
# EDGE_IMPLEMENTATION_GUIDE.md seccion 8, paso 2).
_S3_KEY_PATTERN = re.compile(
    r"^raw-images/(?P<recipient>[a-z0-9-]{1,64})/"
    r"(?P<case_id>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})/"
    r"(?P<image_id>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\.jpg$"
)
_UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# <1 MB, igual que el limite acordado con el backend (ver
# services/evidence/src/evidenceCallbackHandlerFn.ts EVIDENCE_MAX_BYTES).
MAX_IMAGE_BYTES = 1_048_576

HandleOutcome = Literal["ACCEPTED", "REJECTED", "CONFLICT", "RENEWED", "RESENT", "DROPPED"]

PublishFn = Callable[[str, dict], None]
PutFn = Callable[[str, bytes], None]


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _looks_like_uuid(value: object) -> bool:
    return isinstance(value, str) and bool(_UUID_PATTERN.match(value))


class EvidenceOrderProcessor:
    def __init__(
        self,
        device_id: str,
        image_path: Path,
        publish_fn: PublishFn,
        clock: Callable[[], str] = _utcnow_iso,
    ) -> None:
        self._device_id = device_id
        self._image_path = image_path
        self._publish = publish_fn
        self._clock = clock
        self._records: dict[str, CommandRecord] = {}

    # ---- API publica ----

    def handle_command(self, raw_command: dict) -> HandleOutcome:
        try:
            validate_upload_evidence_command(raw_command)
        except SchemaValidationError as exc:
            return self._reject_malformed(raw_command, exc)

        command_id = raw_command["commandId"]
        case_id = raw_command["caseId"]

        match = _S3_KEY_PATTERN.match(raw_command["s3Key"])
        if not match or match.group("case_id") != case_id:
            self._publish_ack(case_id, command_id, accepted=False, reason="INVALID_S3_KEY")
            return "REJECTED"
        image_id = match.group("image_id")
        fingerprint = CommandFingerprint.from_command(raw_command, image_id)

        existing = self._records.get(command_id)

        if existing is not None and existing.fingerprint != fingerprint:
            # Cambio de cualquier campo inmutable: rechazar la orden
            # completa, nunca adivinar cual version es la correcta.
            self._publish_ack(case_id, command_id, accepted=False, reason="COMMAND_CONFLICT")
            return "CONFLICT"

        if existing is not None and existing.status == "TERMINATED":
            # Orden ya resuelta: reenviar exactamente los mismos resultados,
            # sin volver a capturar ni subir nada.
            self._resend_final(existing)
            return "RESENT"

        if existing is not None:
            # Misma orden logica, todavia pendiente: solo se renueva la URL
            # en memoria ("sin recapturar el frame"). El intento de subida
            # real ocurre en attempt_upload(), disparado por el llamador.
            existing.upload_url = raw_command["uploadUrl"]
            logger.info("uploadUrl renovada en memoria (commandId=%s)", command_id)
            return "RENEWED"

        if self._is_expired(raw_command["expiresAt"]):
            # Nunca aceptar una orden que ya nacio vencida.
            ack = self._build_ack(case_id, command_id, accepted=False, reason="EXPIRED")
            self._records[command_id] = CommandRecord(
                command_id, fingerprint, raw_command["uploadUrl"], status="TERMINATED", ack_sent=ack
            )
            self._publish("command-acks", ack)
            return "REJECTED"

        if not self._frame_available():
            ack = self._build_ack(case_id, command_id, accepted=False, reason="FRAME_NOT_AVAILABLE")
            self._records[command_id] = CommandRecord(
                command_id, fingerprint, raw_command["uploadUrl"], status="TERMINATED", ack_sent=ack
            )
            self._publish("command-acks", ack)
            return "REJECTED"

        ack = self._build_ack(case_id, command_id, accepted=True)
        self._records[command_id] = CommandRecord(
            command_id, fingerprint, raw_command["uploadUrl"], status="PENDING", ack_sent=ack
        )
        self._publish("command-acks", ack)
        return "ACCEPTED"

    def attempt_upload(self, command_id: str, put_fn: PutFn) -> None:
        """Ejecuta el PUT real. Llamar solo tras un resultado ACCEPTED o
        RENEWED de handle_command; es un no-op seguro en cualquier otro
        caso (orden desconocida o ya terminada)."""
        record = self._records.get(command_id)
        if record is None or record.status == "TERMINATED":
            return

        case_id = record.fingerprint.case_id

        # Revalidado en cada intento: la orden pudo haber quedado pendiente
        # el tiempo suficiente para vencer entre el accept y este intento.
        # A diferencia de EXPIRED (paso 1, antes de aceptar), esto usa el
        # codigo de EVIDENCE_FAILED URL_EXPIRED (paso 7 de la guia).
        if self._is_expired(record.fingerprint.expires_at):
            self._finalize_failure(record, case_id, command_id, "URL_EXPIRED")
            return

        try:
            image_bytes = self._read_image()
        except (FileNotFoundError, ValueError) as exc:
            logger.warning("frame no disponible al momento de subir: %s", exc)
            self._finalize_failure(record, case_id, command_id, "FRAME_NOT_AVAILABLE")
            return

        try:
            put_fn(record.upload_url, image_bytes)
        except PutTimeoutError:
            self._finalize_failure(record, case_id, command_id, "UPLOAD_TIMEOUT")
            return
        except PutIoError:
            self._finalize_failure(record, case_id, command_id, "IO_ERROR")
            return
        except Exception:  # noqa: BLE001 - cualquier fallo no anticipado
            logger.exception("fallo interno subiendo evidencia (commandId=%s)", command_id)
            self._finalize_failure(record, case_id, command_id, "INTERNAL_ERROR")
            return

        result = {
            "eventId": str(uuid4()),
            "commandId": command_id,
            "caseId": case_id,
            "eventType": "EVIDENCE_UPLOADED",
            "occurredAt": self._clock(),
            "s3Key": record.fingerprint.s3_key,
            "imageId": record.fingerprint.image_id,
        }
        validate_evidence_result(result)
        record.status = "TERMINATED"
        record.final_result = result
        self._publish("evidence", result)

    # ---- helpers privados ----

    def _finalize_failure(self, record: CommandRecord, case_id: str, command_id: str, error_code: str) -> None:
        result = {
            "eventId": str(uuid4()),
            "commandId": command_id,
            "caseId": case_id,
            "eventType": "EVIDENCE_FAILED",
            "occurredAt": self._clock(),
            "errorCode": error_code,
        }
        validate_evidence_result(result)
        record.status = "TERMINATED"
        record.final_result = result
        self._publish("evidence", result)

    def _resend_final(self, record: CommandRecord) -> None:
        if record.ack_sent is not None:
            self._publish("command-acks", record.ack_sent)
        if record.final_result is not None:
            self._publish("evidence", record.final_result)

    def _build_ack(self, case_id: str, command_id: str, accepted: bool, reason: Optional[str] = None) -> dict:
        ack = {
            "eventId": str(uuid4()),
            "commandId": command_id,
            "caseId": case_id,
            "command": "UPLOAD_EVIDENCE",
            "occurredAt": self._clock(),
            "accepted": accepted,
        }
        if reason is not None:
            ack["reason"] = reason
        validate_command_ack(ack)
        return ack

    def _publish_ack(self, case_id: str, command_id: str, accepted: bool, reason: Optional[str] = None) -> None:
        ack = self._build_ack(case_id, command_id, accepted, reason)
        self._publish("command-acks", ack)

    def _reject_malformed(self, raw_command: dict, exc: SchemaValidationError) -> HandleOutcome:
        case_id = raw_command.get("caseId")
        command_id = raw_command.get("commandId")
        if not _looks_like_uuid(case_id) or not _looks_like_uuid(command_id):
            # Sin caseId/commandId confiables no hay con que correlacionar
            # un COMMAND_ACK valido contra el schema: se descarta y se
            # registra, nunca se inventa un ID.
            logger.warning("UPLOAD_EVIDENCE descartado, sin caseId/commandId validos: %s", exc)
            return "DROPPED"
        logger.warning(
            "UPLOAD_EVIDENCE invalido para caseId=%s commandId=%s: %s", case_id, command_id, exc
        )
        self._publish_ack(case_id, command_id, accepted=False, reason="INVALID_CASE")
        return "REJECTED"

    def _frame_available(self) -> bool:
        try:
            self._read_image()
            return True
        except (FileNotFoundError, ValueError):
            return False

    def _read_image(self) -> bytes:
        if not self._image_path.is_file():
            raise FileNotFoundError(f"fixture JPEG no encontrado: {self._image_path}")
        data = self._image_path.read_bytes()
        if len(data) == 0 or len(data) > MAX_IMAGE_BYTES:
            raise ValueError(f"fixture JPEG invalido (tamano={len(data)} bytes)")
        if data[:2] != b"\xff\xd8":  # firma JPEG (marcador SOI)
            raise ValueError("el archivo no parece un JPEG valido (falta firma SOI)")
        return data

    @staticmethod
    def _is_expired(expires_at: str) -> bool:
        naive = expires_at.rstrip("Z").split(".")[0]
        parsed = datetime.strptime(naive, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) >= parsed
