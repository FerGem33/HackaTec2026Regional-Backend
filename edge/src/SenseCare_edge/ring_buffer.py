"""Buffer circular de frames EXCLUSIVAMENTE EN RAM: nunca escribe a disco.

Ventana deslizante de 10 segundos por defecto para el flujo normal de
captura. Cada candidato visual "pinea" (fija) su mejor frame por `eventId`
en el momento de publicarse, de forma independiente de la ventana
deslizante -- si UPLOAD_EVIDENCE llega despues de que ese frame hubiera
salido de la ventana normal, sigue disponible para el modo BUFFERED. Un
frame pineado y no reclamado se descarta despues de `max_pin_age_seconds`
(alineado con el vencimiento del propio comando UPLOAD_EVIDENCE, nunca
recapturado): ver EDGE_IMPLEMENTATION_GUIDE.md seccion 8.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Deque, Dict, Optional

from .frame_source import Frame


@dataclass
class _PinnedFrame:
    frame: Frame
    pinned_at_ms: int


class FrameRingBuffer:
    def __init__(self, window_seconds: float = 10.0):
        self._window_ms = int(window_seconds * 1000)
        self._frames: Deque[Frame] = deque()
        self._pinned: Dict[str, _PinnedFrame] = {}

    def add(self, frame: Frame) -> None:
        self._frames.append(frame)
        self._evict_expired(frame.timestamp_ms)

    def _evict_expired(self, now_ms: int) -> None:
        cutoff = now_ms - self._window_ms
        while self._frames and self._frames[0].timestamp_ms < cutoff:
            self._frames.popleft()

    def latest(self) -> Optional[Frame]:
        return self._frames[-1] if self._frames else None

    def pin_best_frame_for(self, event_id: str, now_ms: int, frame: Optional[Frame] = None) -> bool:
        """Asocia el mejor frame disponible (por defecto, el mas reciente en
        la ventana) al `eventId` de un candidato visual recien publicado.
        Retorna False si no habia ningun frame que pinear (RiskFusionEngine
        debe tratar esto como evidencia no disponible, nunca como error)."""
        candidate = frame or self.latest()
        if candidate is None:
            return False
        self._pinned[event_id] = _PinnedFrame(frame=candidate, pinned_at_ms=now_ms)
        return True

    def take_pinned(self, event_id: str) -> Optional[Frame]:
        """Consume (retira) el frame pineado para un `eventId`. commands.py
        lo llama una sola vez por orden BUFFERED; el frame nunca se
        reutiliza para una segunda subida ni se recaptura."""
        pinned = self._pinned.pop(event_id, None)
        return pinned.frame if pinned else None

    def has_pinned(self, event_id: str) -> bool:
        return event_id in self._pinned

    def discard_pinned(self, event_id: str) -> None:
        self._pinned.pop(event_id, None)

    def evict_stale_pinned(self, now_ms: int, max_age_ms: int) -> None:
        """Higiene periodica: libera frames pineados que nadie reclamo a
        tiempo (el comando UPLOAD_EVIDENCE ya habra vencido igualmente del
        lado del backend). Se llama desde el bucle principal, no aqui."""
        stale = [
            event_id
            for event_id, pinned in self._pinned.items()
            if now_ms - pinned.pinned_at_ms > max_age_ms
        ]
        for event_id in stale:
            del self._pinned[event_id]

    def __len__(self) -> int:
        return len(self._frames)
