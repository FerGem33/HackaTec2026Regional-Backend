"""Arma el mismo payload de telemetria que main.py mandaria a AWS IoT Core y
lo valida contra el contrato, usando lecturas reales del ESP32. No necesita
certificados ni conexion: sirve para confirmar que el mapeo de campos y los
rangos son correctos antes de que exista un endpoint de AWS IoT Core.

Uso:
  python scripts/build_telemetry_debug.py <puerto_serial> <deviceId> [baud_rate]
"""

from __future__ import annotations

import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from SenseCare_edge import schemas  # noqa: E402
from SenseCare_edge.esp32_reader import ESP32Reader  # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def main() -> None:
    if len(sys.argv) < 3:
        print("uso: python build_telemetry_debug.py <puerto_serial> <deviceId> [baud_rate]")
        sys.exit(1)

    port = sys.argv[1]
    device_id = sys.argv[2]
    baud_rate = int(sys.argv[3]) if len(sys.argv) > 3 else 115200

    reader = ESP32Reader(port=port, baud_rate=baud_rate)
    reader.start()

    print(f"leyendo {port} y armando telemetria para deviceId={device_id}. Ctrl+C para salir.\n")
    try:
        while True:
            time.sleep(5)
            reading = reader.last_reading
            if reading is None:
                print("... sin datos todavia")
                continue

            payload = {
                "eventId": str(uuid.uuid4()),
                "deviceId": device_id,
                "occurredAt": _now_iso(),
                "firmwareVersion": "1.0.0",
            }
            if reading.temperatureC is not None:
                payload["temperatureC"] = reading.temperatureC
            if reading.humidityPct is not None:
                payload["humidityPct"] = reading.humidityPct
            if reading.co2Ppm is not None:
                payload["co2Ppm"] = reading.co2Ppm
            if reading.proximityCm is not None:
                payload["proximityCm"] = reading.proximityCm
            if reading.dbAvg is not None:
                payload["dbAvg"] = reading.dbAvg
            if reading.dbPeak is not None:
                payload["dbPeak"] = reading.dbPeak

            try:
                schemas.validate_telemetry(payload)
                print("OK  ", payload)
            except schemas.SchemaValidationError as exc:
                print("MAL ", payload, "->", exc)
    except KeyboardInterrupt:
        pass
    finally:
        reader.stop()


if __name__ == "__main__":
    main()
