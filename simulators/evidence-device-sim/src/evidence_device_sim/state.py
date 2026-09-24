"""Estado en memoria de las ordenes UPLOAD_EVIDENCE en curso o ya resueltas.

Sin persistencia en disco a proposito (ver README.md de este simulador): la
guia edge pide que la Pi conserve metadatos protegidos por 15 minutos tras
un reinicio, pero eso es responsabilidad de la implementacion final de la Pi
(`commands.py`), no de esta herramienta temporal de integracion.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class CommandFingerprint:
    """Campos inmutables de una orden UPLOAD_EVIDENCE (todo excepto `uploadUrl`).

    Dos mensajes con el mismo `commandId` son la MISMA orden logica solo si
    coinciden exactamente en estos campos (ver
    docs/EDGE_IMPLEMENTATION_GUIDE.md, seccion "Reintentos y reenvio de
    UPLOAD_EVIDENCE con el mismo commandId"). `imageId` se deriva de
    `s3Key`, no es un campo propio del contrato, pero se compara aparte por
    claridad con la guia.
    """

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
