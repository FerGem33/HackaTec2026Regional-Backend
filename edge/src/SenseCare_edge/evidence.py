"""Sube el frame reclamado a la URL prefirmada mediante HTTP PUT directo
(docs/EDGE_IMPLEMENTATION_GUIDE.md, seccion 8, paso 5). Solo biblioteca
estandar: sin SDK de AWS ni credenciales, igual que
simulators/evidence-device-sim/src/evidence_device_sim/uploader.py.
"""

from __future__ import annotations

import logging
import socket
import urllib.error
import urllib.request

logger = logging.getLogger("SenseCare_edge.evidence")

DEFAULT_TIMEOUT_SECONDS = 10.0


class PutTimeoutError(Exception):
    """El PUT no completo dentro del timeout configurado."""


class PutIoError(Exception):
    """El PUT fallo por una razon distinta a timeout (rechazo HTTP, red)."""


def http_put_jpeg(upload_url: str, image_bytes: bytes, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
    """Lanza PutTimeoutError/PutIoError; no retorna nada en exito.

    Nunca loguea `upload_url` completa: es una URL S3 prefirmada (lleva la
    firma SigV4 en la query string) y se trata como secreto para que nunca
    quede en logs de systemd/journalctl.
    """
    request = urllib.request.Request(upload_url, data=image_bytes, method="PUT")
    request.add_header("Content-Type", "image/jpeg")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
    except urllib.error.HTTPError as exc:
        logger.warning("PUT rechazado por S3 (status=%s)", exc.code)
        raise PutIoError(f"S3 respondio {exc.code}") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (socket.timeout, TimeoutError)):
            raise PutTimeoutError("timeout subiendo evidencia") from exc
        raise PutIoError(str(exc.reason)) from exc
    except (socket.timeout, TimeoutError) as exc:
        raise PutTimeoutError("timeout subiendo evidencia") from exc

    if status >= 300:
        raise PutIoError(f"S3 respondio status inesperado: {status}")
