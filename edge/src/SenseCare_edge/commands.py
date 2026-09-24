"""Maneja el ciclo de vida de UPLOAD_EVIDENCE segun el contrato ya
desplegado (docs/EDGE_IMPLEMENTATION_GUIDE.md, seccion 8 y su subseccion de
reintentos). Mismo diseno de deduplicacion/fingerprint ya probado en
simulators/evidence-device-sim/src/evidence_device_sim/processor.py, pero
integrado con la camara real: BUFFERED reclama un frame ya pineado del
FrameRingBuffer; CURRENT dispara una captura fresca inyectada.

Correlacion caseId -> frame BUFFERED (LIMITACION DE DEMO, deliberada): el
contrato de UPLOAD_EVIDENCE viaja por MQTT con `caseId`, nunca con el
`eventId` de la VISUAL_ANOMALY que lo origino (ese campo no existe en
uploadEvidenceCommand.schema.json y no se puede agregar unilateralmente sin
aprobacion del coordinador). Sin ese campo, no hay forma de correlacionar
por el cable cual anomalia especifica motivo una orden BUFFERED si hubiera
mas de una pendiente a la vez.

Por eso este modulo admite **como maximo una** anomalia visual con
evidencia BUFFERED pendiente por dispositivo, modelada como una unica
reserva (`_PendingVisualEvidence`: eventId + vencimiento). Mientras esa
reserva este vigente, `vision_service.py` **suprime** (no publica) cualquier
otra anomalia visual que pudiera necesitar evidencia BUFFERED -- ver
`VisionService._publish_if_anomaly` y su contador
`anomaliesSuppressedPendingEvidence` -- en vez de arriesgar una correlacion
incorrecta con una cola FIFO. Un `UPLOAD_EVIDENCE BUFFERED` sin reserva
vigente responde `FRAME_NOT_AVAILABLE`; nunca elige "el siguiente frame" ni
una foto arbitraria. La reserva (y el frame pineado asociado en el ring
buffer) se libera sola tras `visual_evidence_ttl_ms` si nadie la reclama,
para no retener imagenes en RAM indefinidamente.

Si el demo necesita en el futuro varias anomalias visuales simultaneas por
dispositivo, el contrato tendria que ganar un campo de correlacion
explicito (por ejemplo `eventId` en UPLOAD_EVIDENCE) -- fuera de alcance de
este cambio y sujeto a aprobacion del coordinador antes de tocar el schema.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Dict, Literal, Optional
from uuid import uuid4

from .evidence import PutIoError, PutTimeoutError, http_put_jpeg
from .evidence_state import CommandFingerprint, CommandRecord
from .ring_buffer import FrameRingBuffer
from .schemas import (
    SchemaValidationError,
    validate_command_ack,
    validate_evidence_result,
    validate_upload_evidence_command,
)

logger = logging.getLogger("SenseCare_edge.commands")

# raw-images/{recipientId}/{caseId}/{imageId}.jpg -- misma forma que
# packages/contracts/schemas/uploadEvidenceCommand.schema.json#s3Key, con
# grupos nombrados para extraer imageId y verificar que el caseId embebido
# en la ruta coincide con el caseId de nivel superior (guia, seccion 8, paso 2).
_S3_KEY_PATTERN = re.compile(
    r"^raw-images/(?P<recipient>[a-z0-9-]{1,64})/"
    r"(?P<case_id>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})/"
    r"(?P<image_id>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\.jpg$"
)
_UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# <1 MB, igual que el limite acordado con el backend (guia, seccion 8, paso 5).
MAX_IMAGE_BYTES = 1_048_576

HandleOutcome = Literal["ACCEPTED", "REJECTED", "CONFLICT", "RENEWED", "RESENT", "DROPPED"]

PublishFn = Callable[[str, dict], None]
PutFn = Callable[[str, bytes], None]
CaptureCurrentFn = Callable[[], Optional[bytes]]

# Alineado con el timeout tipico de RequestEvidenceUpload/URL prefirmada del
# backend (~90s): si nadie reclama la reserva en ese plazo, el backend ya
# habra abandonado ese intento de evidencia de todos modos.
DEFAULT_VISUAL_EVIDENCE_TTL_MS = 90_000


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _monotonic_ms() -> int:
    return int(time.monotonic() * 1000)


def _looks_like_uuid(value: object) -> bool:
    return isinstance(value, str) and bool(_UUID_PATTERN.match(value))


@dataclass
class _PendingVisualEvidence:
    """La (unica) reserva de evidencia BUFFERED pendiente por dispositivo.
    Ver limitacion de demo documentada en el docstring del modulo."""

    event_id: str
    reserved_at_ms: int
    expires_at_ms: int


class EvidenceCommandProcessor:
    def __init__(
        self,
        device_id: str,
        ring_buffer: FrameRingBuffer,
        capture_current_fn: CaptureCurrentFn,
        publish_fn: PublishFn,
        put_fn: PutFn = http_put_jpeg,
        clock: Callable[[], str] = _utcnow_iso,
        clock_ms: Callable[[], int] = _monotonic_ms,
        visual_evidence_ttl_ms: int = DEFAULT_VISUAL_EVIDENCE_TTL_MS,
    ) -> None:
        self._device_id = device_id
        self._ring_buffer = ring_buffer
        self._capture_current = capture_current_fn
        self._publish = publish_fn
        self._put = put_fn
        self._clock = clock
        self._clock_ms = clock_ms
        self._visual_evidence_ttl_ms = visual_evidence_ttl_ms
        self._records: Dict[str, CommandRecord] = {}
        self._pending_visual_evidence: Optional[_PendingVisualEvidence] = None

    def try_reserve_visual_evidence(self, event_id: str, now_ms: int) -> bool:
        """Intenta reservar la (unica) evidencia BUFFERED pendiente para
        este dispositivo. Retorna False si ya hay una reserva vigente: el
        llamador (`vision_service.py`) debe entonces SUPRIMIR la nueva
        anomalia (no publicarla, no pinear su frame) en vez de arriesgar una
        correlacion incorrecta con una anomalia distinta. Ver limitacion de
        demo documentada en el docstring del modulo."""
        self._expire_visual_evidence_if_stale(now_ms)
        if self._pending_visual_evidence is not None:
            return False
        self._pending_visual_evidence = _PendingVisualEvidence(
            event_id=event_id,
            reserved_at_ms=now_ms,
            expires_at_ms=now_ms + self._visual_evidence_ttl_ms,
        )
        return True

    def has_pending_visual_evidence(self, now_ms: Optional[int] = None) -> bool:
        self._expire_visual_evidence_if_stale(now_ms if now_ms is not None else self._clock_ms())
        return self._pending_visual_evidence is not None

    def _expire_visual_evidence_if_stale(self, now_ms: int) -> None:
        pending = self._pending_visual_evidence
        if pending is not None and now_ms >= pending.expires_at_ms:
            logger.info("reserva de evidencia visual expirada sin reclamar (eventId=%s)", pending.event_id)
            self._ring_buffer.discard_pinned(pending.event_id)
            self._pending_visual_evidence = None

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
            # Orden ya resuelta: reenviar exactamente los mismos resultados.
            self._resend_final(existing)
            return "RESENT"

        if existing is not None:
            # Misma orden logica, todavia pendiente: solo se renueva la URL
            # en memoria. El frame ya reclamado/capturado no se vuelve a tocar.
            existing.upload_url = raw_command["uploadUrl"]
            logger.info("uploadUrl renovada en memoria (commandId=%s)", command_id)
            return "RENEWED"

        if self._is_expired(raw_command["expiresAt"]):
            ack = self._build_ack(case_id, command_id, accepted=False, reason="EXPIRED")
            self._records[command_id] = CommandRecord(
                command_id, fingerprint, raw_command["uploadUrl"], status="TERMINATED", ack_sent=ack
            )
            self._publish("command-acks", ack)
            return "REJECTED"

        frame_jpeg = self._resolve_frame(raw_command["captureMode"])
        if frame_jpeg is None or len(frame_jpeg) == 0:
            # Ni BUFFERED (frame ya liberado/inexistente) ni CURRENT (fallo de
            # captura) recapturan ni inventan una imagen: fallo de evidencia.
            ack = self._build_ack(case_id, command_id, accepted=False, reason="FRAME_NOT_AVAILABLE")
            self._records[command_id] = CommandRecord(
                command_id, fingerprint, raw_command["uploadUrl"], status="TERMINATED", ack_sent=ack
            )
            self._publish("command-acks", ack)
            return "REJECTED"

        ack = self._build_ack(case_id, command_id, accepted=True)
        self._records[command_id] = CommandRecord(
            command_id,
            fingerprint,
            raw_command["uploadUrl"],
            status="PENDING",
            ack_sent=ack,
            frame_jpeg=frame_jpeg,
        )
        self._publish("command-acks", ack)
        return "ACCEPTED"

    def attempt_upload(self, command_id: str) -> None:
        """Ejecuta el PUT real. Llamar solo tras un resultado ACCEPTED o
        RENEWED de handle_command; no-op seguro en cualquier otro caso
        (orden desconocida o ya terminada)."""
        record = self._records.get(command_id)
        if record is None or record.status == "TERMINATED":
            return

        case_id = record.fingerprint.case_id

        # Revalidado en cada intento: la orden pudo vencer entre el accept y
        # este intento (distinto del EXPIRED de handle_command, que es antes
        # de aceptar).
        if self._is_expired(record.fingerprint.expires_at):
            self._finalize_failure(record, case_id, command_id, "URL_EXPIRED")
            return

        if record.frame_jpeg is None or len(record.frame_jpeg) == 0:
            self._finalize_failure(record, case_id, command_id, "FRAME_NOT_AVAILABLE")
            return

        if len(record.frame_jpeg) > MAX_IMAGE_BYTES:
            logger.error("frame excede MAX_IMAGE_BYTES (commandId=%s)", command_id)
            self._finalize_failure(record, case_id, command_id, "IO_ERROR")
            return

        try:
            self._put(record.upload_url, record.frame_jpeg)
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
        record.frame_jpeg = None  # borrar la copia tan pronto sea seguro (guia, paso 6)
        self._publish("evidence", result)

    # ---- helpers privados ----

    def _resolve_frame(self, capture_mode: str) -> Optional[bytes]:
        if capture_mode == "BUFFERED":
            now_ms = self._clock_ms()
            self._expire_visual_evidence_if_stale(now_ms)
            if self._pending_visual_evidence is None:
                # Sin reserva vigente: nunca se elige "el siguiente frame" ni
                # una foto arbitraria (ver limitacion de demo del modulo).
                return None
            event_id = self._pending_visual_evidence.event_id
            # Se consume la reserva de una sola vez, exitosa o no: un
            # reintento del mismo commandId (RENEWED/RESENT) nunca vuelve a
            # pasar por aqui (ver handle_command), y una segunda orden
            # BUFFERED distinta debe fallar con FRAME_NOT_AVAILABLE en vez de
            # reclamar la misma evidencia dos veces.
            self._pending_visual_evidence = None
            frame = self._ring_buffer.take_pinned(event_id)
            return frame.jpeg_bytes if frame is not None else None
        # CURRENT: siempre una captura nueva; nunca reutiliza una imagen
        # vieja ni toca la reserva de evidencia visual.
        return self._capture_current()

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
        record.frame_jpeg = None
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
            # Sin caseId/commandId confiables no hay con que correlacionar un
            # COMMAND_ACK valido contra el schema: se descarta y se registra,
            # nunca se inventa un ID.
            logger.warning("UPLOAD_EVIDENCE descartado, sin caseId/commandId validos: %s", exc)
            return "DROPPED"
        logger.warning(
            "UPLOAD_EVIDENCE invalido para caseId=%s commandId=%s: %s", case_id, command_id, exc
        )
        self._publish_ack(case_id, command_id, accepted=False, reason="INVALID_CASE")
        return "REJECTED"

    @staticmethod
    def _is_expired(expires_at: str) -> bool:
        naive = expires_at.rstrip("Z").split(".")[0]
        parsed = datetime.strptime(naive, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) >= parsed
