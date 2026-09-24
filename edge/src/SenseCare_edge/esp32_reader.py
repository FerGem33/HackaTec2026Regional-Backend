"""Lee el JSON por linea que manda el ESP32 (ver nodo de sensores del hackathon)
y lo normaliza a los nombres de campo del contrato SenseCare.

Requiere que el sketch tenga OUTPUT_JSON = 1, para que cada linea sea un
objeto JSON como:
  {"t":12,"lux":180.5,"temp":27.30,"hum":48.1,"co2":840,
   "dist_mm":1200,"presencia":false,"db_prom":42.1,"db_pico":55.0}

Campos que SI mapean al contrato SenseCare (packages/contracts/schemas/telemetry.schema.json):
  temp      -> temperatureC
  hum       -> humidityPct
  co2       -> co2Ppm
  dist_mm   -> proximityCm (dist_mm / 10)
  db_prom   -> dbAvg
  db_pico   -> dbPeak

`motion` ya NO es parte del contrato (se quito en el milestone 3): aunque el
ESP32 sigue mandando `presencia`, ese valor se conserva aqui por si sirve
para reglas locales futuras, pero `main.py` ya no lo incluye en el payload
de telemetria.

`lux` sigue sin existir en el contrato (additionalProperties: false en el
schema). Se conserva en la lectura normalizada para logging/reglas locales,
pero `main.py` lo descarta antes de publicar. Si el equipo decide que la luz
es util para el demo, hay que extender telemetry.schema.json (agregar
luxLevel como propiedad opcional) antes de incluirla en el payload MQTT.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import serial

logger = logging.getLogger("SenseCare_edge.esp32_reader")

PRESENCE_DISTANCE_MM = 1500  # debe coincidir con PRESENCIA_MM del sketch


@dataclass
class SensorReading:
    receivedAt: str
    temperatureC: Optional[float]
    humidityPct: Optional[float]
    co2Ppm: Optional[float]
    proximityCm: Optional[float]
    motion: Optional[bool]
    luxLevel: Optional[float]
    dbAvg: Optional[float]
    dbPeak: Optional[float]
    raw: dict = field(repr=False)


def _to_float(value) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_line(line: str) -> Optional[SensorReading]:
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        return None

    if not isinstance(data, dict):
        return None

    dist_mm = _to_float(data.get("dist_mm"))
    # el sketch reporta -1 cuando esta fuera de rango
    proximity_cm = dist_mm / 10 if dist_mm is not None and dist_mm >= 0 else None

    return SensorReading(
        receivedAt=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        temperatureC=_to_float(data.get("temp")),
        humidityPct=_to_float(data.get("hum")),
        co2Ppm=_to_float(data.get("co2")),
        proximityCm=proximity_cm,
        motion=bool(data.get("presencia")) if "presencia" in data else None,
        luxLevel=_to_float(data.get("lux")),
        dbAvg=_to_float(data.get("db_prom")),
        dbPeak=_to_float(data.get("db_pico")),
        raw=data,
    )


# Rangos fisicos plausibles; una lectura fuera de esto se descarta como ruido/glitch
# del serial en vez de publicarse como si fuera valida.
_RANGE_CHECKS = {
    "temperatureC": (-40, 125),
    "humidityPct": (0, 100),
    "co2Ppm": (0, 10000),
    "proximityCm": (0, 800),
    "dbAvg": (0, 140),
    "dbPeak": (0, 140),
}


def _in_range(reading: SensorReading) -> bool:
    for field_name, (low, high) in _RANGE_CHECKS.items():
        value = getattr(reading, field_name)
        if value is not None and not (low <= value <= high):
            return False
    return True


class ESP32Reader:
    """Lee el puerto serial en un hilo aparte y publica lecturas normalizadas
    en una cola acotada, para que un bloqueo de E/S serial no congele MQTT."""

    def __init__(self, port: str, baud_rate: int, max_queue: int = 50):
        self._port = port
        self._baud_rate = baud_rate
        self.readings: "queue.Queue[SensorReading]" = queue.Queue(maxsize=max_queue)
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.invalid_message_count = 0
        self.last_reading: Optional[SensorReading] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="esp32-reader", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                with serial.Serial(self._port, self._baud_rate, timeout=2) as ser:
                    logger.info("puerto serial abierto: %s @ %s", self._port, self._baud_rate)
                    while not self._stop_event.is_set():
                        raw_line = ser.readline()
                        if not raw_line:
                            continue
                        line = raw_line.decode("utf-8", errors="ignore").strip()
                        if not line:
                            continue
                        reading = _parse_line(line)
                        if reading is None or not _in_range(reading):
                            self.invalid_message_count += 1
                            logger.warning("linea serial invalida descartada: %r", line[:120])
                            continue
                        self.last_reading = reading
                        self._enqueue(reading)
            except serial.SerialException as exc:
                logger.error("error de puerto serial (%s), reintentando en 3s", exc)
                time.sleep(3)

    def _enqueue(self, reading: SensorReading) -> None:
        if self.readings.full():
            try:
                self.readings.get_nowait()  # descarta la lectura mas vieja, no la mas nueva
            except queue.Empty:
                pass
        self.readings.put_nowait(reading)
