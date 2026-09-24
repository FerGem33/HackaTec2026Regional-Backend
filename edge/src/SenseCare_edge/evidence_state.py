"""Estado en memoria de las ordenes UPLOAD_EVIDENCE en curso o resueltas.

Mismo diseno probado en
simulators/evidence-device-sim/src/evidence_device_sim/state.py, mas
`frame_jpeg`: aqui el frame reclamado (BUFFERED) o recien capturado
(CURRENT) se guarda en el propio registro, porque a diferencia del
simulador (que relee un fixture fijo del disco en cada intento) el frame
real del ring buffer se consume una sola vez (`take_pinned`) y no puede
volver a obtenerse en un reintento de PUT.

Sin persistencia en disco todavia: la guia edge (seccion 8) pide conservar
metadatos protegidos 15 minutos tras un reinicio para deduplicar sin guardar
material sensible; queda pendiente (ver README) y no bloquea el contrato
mientras el proceso no se reinicie con una orden pendiente.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class CommandFingerprint:
    """Campos inmutables de una orden UPLOAD_EVIDENCE (todo excepto
    `uploadUrl`). Dos mensajes con el mismo `commandId` son la MISMA orden
    logica solo si coinciden exactamente aqui (ver
    docs/EDGE_IMPLEMENTATION_GUIDE.md, seccion de reintentos). `imageId` se
    deriva de `s3Key`, no es un campo propio del contrato."""

    case_id: str
    command: str
    reason: str
    capture_mode: str
    s3_key: str
    image_id: str
    expires_at: str

    @staticmethod
    def from_command(command: dict, image_id: str) -> "CommandFingerprint":
        return CommandFingerprint(
            case_id=command["caseId"],
            command=command["command"],
            reason=command["reason"],
            capture_mode=command["captureMode"],
            s3_key=command["s3Key"],
            image_id=image_id,
            expires_at=command["expiresAt"],
        )


@dataclass
class CommandRecord:
    command_id: str
    fingerprint: CommandFingerprint
    upload_url: str
    status: str  # "PENDING" | "TERMINATED"
    ack_sent: Optional[dict] = None
    final_result: Optional[dict] = None
    frame_jpeg: Optional[bytes] = None
