"""Prueba aislada: solo lee el ESP32 por serial y muestra lo que entiende,
sin tocar MQTT ni AWS. Sirve para confirmar que el cableado/puerto/JSON estan
bien antes de tener certificados de AWS IoT Core.

Uso:
  python scripts/read_serial_debug.py /dev/serial/by-id/usb-...
  python scripts/read_serial_debug.py /dev/serial/by-id/usb-... 115200
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from SenseCare_edge.esp32_reader import ESP32Reader  # noqa: E402


def main() -> None:
    if len(sys.argv) < 2:
        print("uso: python read_serial_debug.py <puerto_serial> [baud_rate]")
        sys.exit(1)

    port = sys.argv[1]
    baud_rate = int(sys.argv[2]) if len(sys.argv) > 2 else 115200

    reader = ESP32Reader(port=port, baud_rate=baud_rate)
    reader.start()

    print(f"leyendo {port} @ {baud_rate} baudios. Ctrl+C para salir.\n")
    try:
        while True:
            time.sleep(1)
            reading = reader.last_reading
            if reading is None:
                print("... sin datos todavia (revisa cableado, baudrate y OUTPUT_JSON=1 en el sketch)")
                continue
            print(
                f"temp={reading.temperatureC} hum={reading.humidityPct} "
                f"co2={reading.co2Ppm} proximityCm={reading.proximityCm} "
                f"lux={reading.luxLevel} "
                f"dbAvg={reading.dbAvg} dbPeak={reading.dbPeak} "
                f"(mensajes invalidos: {reader.invalid_message_count})"
            )
    except KeyboardInterrupt:
        pass
    finally:
        reader.stop()


if __name__ == "__main__":
    main()
