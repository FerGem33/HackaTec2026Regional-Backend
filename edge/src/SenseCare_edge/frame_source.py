"""Abstraccion de fuente de frames de camara.

La decision de hardware (CSI/Picamera2, webcam USB/V4L2, o camara de
celular por red local) todavia no esta tomada; este modulo evita acoplar
el resto del sistema (RiskFusionEngine, ring buffer, commands.py) a un
adaptador concreto. Picamera2 queda reservada exclusivamente para CSI
cuando se decida; no se usa como supuesto para USB o celular.

Mientras no haya adaptador de hardware, FixtureFrameSource sirve para
pruebas de unidad/integracion: reproduce una secuencia fija de frames JPEG
con timestamps monotonicos crecientes, igual que exigiria una fuente real.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, List, Optional, Protocol


@dataclass(frozen=True)
class Frame:
    jpeg_bytes: bytes
    timestamp_ms: int
    width: int
    height: int


class FrameSource(Protocol):
    """Contrato minimo que cualquier adaptador de camara debe cumplir.

    `read()` nunca bloquea indefinidamente: retorna None si no hay un frame
    nuevo disponible todavia, para que el bucle de captura aplique su propio
    ritmo (FPS base/rafaga) sin depender de que la fuente lo haga.
    """

    def read(self) -> Optional[Frame]: ...

    def close(self) -> None: ...

    @property
    def healthy(self) -> bool:
        """False si la fuente detecta desconexion/perdida sostenida; lo usa
        CAMERA_TAMPERED. Una fuente que no puede saberlo retorna True."""
        ...


class FixtureFrameSource:
    """Reproduce una secuencia fija de frames para pruebas e integracion sin
    hardware. `frames` debe venir ya ordenado por timestamp_ms creciente."""

    def __init__(self, frames: Iterable[Frame]):
        self._frames: Iterator[Frame] = iter(frames)
        self._closed = False
        self._healthy = True

    def read(self) -> Optional[Frame]:
        if self._closed:
            return None
        return next(self._frames, None)

    def close(self) -> None:
        self._closed = True

    @property
    def healthy(self) -> bool:
        return self._healthy and not self._closed

    def simulate_disconnect(self) -> None:
        """Solo para pruebas de CAMERA_TAMPERED: simula perdida de fuente."""
        self._healthy = False


def load_fixture_frames_from_dir(directory: Path, fps: float) -> List[Frame]:
    """Carga los .jpg de un directorio, en orden alfabetico, asignando
    timestamps monotonicos crecientes segun `fps`. Util para la prueba
    fisica inicial con fotogramas capturados a mano antes de elegir
    adaptador (ver plan de aceptacion en docs/EDGE_IMPLEMENTATION_GUIDE.md)."""
    interval_ms = int(1000 / fps)
    frames: List[Frame] = []
    for index, path in enumerate(sorted(directory.glob("*.jpg"))):
        data = path.read_bytes()
        frames.append(Frame(jpeg_bytes=data, timestamp_ms=index * interval_ms, width=0, height=0))
    return frames
