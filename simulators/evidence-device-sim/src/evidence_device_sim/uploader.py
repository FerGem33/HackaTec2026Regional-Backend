"""Sube el fixture JPEG a la URL prefirmada mediante HTTP PUT directo.

Sin SDK de AWS ni credenciales, exactamente lo que exige
docs/EDGE_IMPLEMENTATION_GUIDE.md (seccion 8, paso 5). Usa unicamente la
biblioteca estandar para no anadir dependencias a esta herramienta temporal.
"""

from __future__ import annotations

import logging
import socket
import urllib.error
import urllib.request

from .errors import PutIoError, PutTimeoutError

logger = logging.getLogger("evidence_device_sim.uploader")

DEFAULT_TIMEOUT_SECONDS = 10.0


def http_put_jpeg(upload_url: str, image_bytes: bytes, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
    """Lanza PutTimeoutError/PutIoError; no retorna nada en exito.

    Nunca loguea `upload_url` completa: es una URL S3 prefirmada (lleva la
    firma SigV4 en la query string) y tratarla como secreto evita que quede
    en logs de este simulador o de la terminal de quien lo corre.
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
