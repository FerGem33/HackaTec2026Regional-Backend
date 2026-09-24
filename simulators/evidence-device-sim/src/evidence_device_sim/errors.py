"""Excepciones de transporte para la subida HTTP PUT del fixture JPEG.

Separadas en su propio modulo para que processor.py (logica pura) y
uploader.py (unico punto que toca la red) puedan compartirlas sin que uno
dependa del otro.
"""

from __future__ import annotations


class PutTimeoutError(Exception):
    """El PUT no completo dentro del timeout configurado."""


class PutIoError(Exception):
    """El PUT fallo por una razon de red/HTTP (status inesperado, conexion, etc.)."""
