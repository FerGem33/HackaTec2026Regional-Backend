from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone

from . import schemas
from .config import load_config
from .esp32_reader import ESP32Reader
from .mqtt_client import MqttPublisher
from .sensor_rules import SensorRulesEngine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("SenseCare_edge.main")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _build_telemetry(config, reading) -> dict:
    payload = {
        "eventId": str(uuid.uuid4()),
        "deviceId": config.device_id,
        "occurredAt": _now_iso(),
        "firmwareVersion": config.firmware_version,
    }
    # Solo se incluyen los campos que el contrato admite hoy. lux/soundDb* se
    # quedan en la lectura normalizada (ver esp32_reader.py) por si el equipo
    # decide extender telemetry.schema.json mas adelante.
    if reading.temperatureC is not None:
        payload["temperatureC"] = reading.temperatureC
    if reading.humidityPct is not None:
        payload["humidityPct"] = reading.humidityPct
    if reading.co2Ppm is not None:
        payload["co2Ppm"] = reading.co2Ppm
    if reading.proximityCm is not None:
        payload["proximityCm"] = reading.proximityCm
    if reading.motion is not None:
        payload["motion"] = reading.motion
    return payload


def main() -> None:
    config = load_config()
    logger.info("iniciando SenseCare edge, deviceId=%s", config.device_id)

    reader = ESP32Reader(port=config.serial_port, baud_rate=config.baud_rate)
    reader.start()

    rules = SensorRulesEngine(config.sensor_rules)

    mqtt_client = MqttPublisher(config.device_id, config.iot)
    mqtt_client.connect_with_backoff()

    if config.topic_status:
        mqtt_client.publish(config.topic_status, {
            "deviceId": config.device_id,
            "occurredAt": _now_iso(),
            "firmwareVersion": config.firmware_version,
            "esp32Connected": reader.last_reading is not None,
        })

    last_telemetry_at = 0.0
    last_status_at = 0.0

    try:
        while True:
            reading = reader.last_reading
            now = time.monotonic()

            if reading is not None:
                anomaly = rules.evaluate(reading)
                if anomaly is not None:
                    anomaly["deviceId"] = config.device_id
                    try:
                        schemas.validate_sensor_anomaly(anomaly)
                        mqtt_client.publish(config.topic_sensor_anomaly, anomaly)
                        logger.warning("SENSOR_ANOMALY publicada: %s", anomaly["anomalyType"])
                    except schemas.SchemaValidationError as exc:
                        logger.error("anomalia descartada, no valida contra el schema: %s", exc)

                if now - last_telemetry_at >= config.telemetry_interval_seconds:
                    telemetry = _build_telemetry(config, reading)
                    try:
                        schemas.validate_telemetry(telemetry)
                        mqtt_client.publish(config.topic_telemetry, telemetry)
                        last_telemetry_at = now
                    except schemas.SchemaValidationError as exc:
                        logger.error("telemetria descartada, no valida contra el schema: %s", exc)

            if config.topic_status and now - last_status_at >= config.heartbeat_interval_seconds:
                mqtt_client.publish(config.topic_status, {
                    "deviceId": config.device_id,
                    "occurredAt": _now_iso(),
                    "firmwareVersion": config.firmware_version,
                    "esp32Connected": reading is not None,
                    "invalidSensorMessages": reader.invalid_message_count,
                })
                last_status_at = now

            time.sleep(0.5)
    except KeyboardInterrupt:
        logger.info("apagando por senal de interrupcion")
    finally:
        reader.stop()
        mqtt_client.close()


if __name__ == "__main__":
    main()
