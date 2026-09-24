from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import schemas
from .commands import EvidenceCommandProcessor
from .config import EdgeConfig, load_config
from .esp32_reader import ESP32Reader
from .frame_source import FixtureFrameSource, FrameSource, load_fixture_frames_from_dir
from .mqtt_client import MqttPublisher
from .ring_buffer import FrameRingBuffer
from .sensor_rules import SensorRulesEngine
from .vision_detectors import ModelUnavailableError
from .vision_service import VisionService, create_vision_service

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
    # Solo se incluyen los campos que el contrato admite hoy. `motion` ya no
    # es parte del contrato (milestone 3); `lux` se queda en la lectura
    # normalizada (ver esp32_reader.py) por si el equipo decide extender
    # telemetry.schema.json mas adelante.
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
    return payload


def _build_frame_source(vision_config: dict) -> Optional[FrameSource]:
    """La decision de hardware de camara (CSI/USB/celular) sigue pendiente
    (ver frame_source.py). Mientras tanto, solo se admite una fuente de
    fixture (`vision.fixtureFramesDir`) para la prueba fisica inicial y el
    demo; sin ella, `main()` continua en visionState=DEGRADED en vez de
    fallar el proceso completo (la vision es un subsistema opcional)."""
    fixture_dir = vision_config.get("fixtureFramesDir")
    if not fixture_dir:
        return None
    frames = load_fixture_frames_from_dir(Path(fixture_dir), fps=float(vision_config.get("baseFps", 2.0)))
    return FixtureFrameSource(frames)


def _capture_current_frame(frame_source: FrameSource):
    """Para `captureMode: CURRENT`: siempre un frame nuevo, nunca uno
    reciclado del ring buffer (ver commands.py). Si la fuente no tiene un
    frame listo en este instante, la orden falla con FRAME_NOT_AVAILABLE en
    vez de esperar o reutilizar uno viejo."""
    frame = frame_source.read()
    return frame.jpeg_bytes if frame is not None else None


def _build_vision(
    config: EdgeConfig, mqtt_client: MqttPublisher
) -> tuple[Optional[VisionService], Optional[EvidenceCommandProcessor], bool]:
    """Retorna (vision_service, commands_processor, degraded). Nunca lanza:
    cualquier fallo de construccion de vision se reporta como DEGRADED,
    dejando la telemetria de sensores intacta (guia, seccion 6, antirruido)."""
    if not config.vision_enabled:
        return None, None, False

    frame_source = _build_frame_source(config.vision_config)
    if frame_source is None:
        logger.warning(
            "bloque 'vision' configurado pero sin adaptador de camara concreto "
            "(hardware pendiente); visionState=DEGRADED"
        )
        return None, None, True

    ring_buffer = FrameRingBuffer(window_seconds=float(config.vision_config.get("ringBufferSeconds", 10.0)))

    commands_processor = None
    if config.topic_commands and config.topic_command_acks and config.topic_evidence:
        topic_map = {"command-acks": config.topic_command_acks, "evidence": config.topic_evidence}

        def _publish_command_topic(logical_topic: str, payload: dict) -> None:
            mqtt_client.publish(topic_map[logical_topic], payload)

        commands_processor = EvidenceCommandProcessor(
            device_id=config.device_id,
            ring_buffer=ring_buffer,
            capture_current_fn=lambda: _capture_current_frame(frame_source),
            publish_fn=_publish_command_topic,
            visual_evidence_ttl_ms=int(
                float(config.vision_config.get("visualEvidenceTtlSeconds", 90.0)) * 1000
            ),
        )

    try:
        vision_service = create_vision_service(
            device_id=config.device_id,
            vision_config=config.vision_config,
            camera_config=config.camera_config,
            risk_fusion_config=config.risk_fusion_config,
            frame_source=frame_source,
            ring_buffer=ring_buffer,
            publish_fn=mqtt_client.publish,
            topic_visual_anomaly=config.topic_visual_anomaly,
            commands_processor=commands_processor,
        )
    except ModelUnavailableError as exc:
        logger.error("modelo de vision no disponible, continuando en DEGRADED: %s", exc)
        return None, commands_processor, True

    return vision_service, commands_processor, False


def main() -> None:
    config = load_config()
    logger.info("iniciando SenseCare edge, deviceId=%s", config.device_id)

    reader = ESP32Reader(port=config.serial_port, baud_rate=config.baud_rate)
    reader.start()

    rules = SensorRulesEngine(config.sensor_rules)

    mqtt_client = MqttPublisher(config.device_id, config.iot)
    mqtt_client.connect_with_backoff()

    vision_service, commands_processor, vision_degraded = _build_vision(config, mqtt_client)

    if commands_processor is not None and config.topic_commands:
        def _handle_command_message(payload: dict) -> None:
            outcome = commands_processor.handle_command(payload)
            if outcome in ("ACCEPTED", "RENEWED"):
                commands_processor.attempt_upload(payload["commandId"])

        mqtt_client.subscribe(config.topic_commands, _handle_command_message)

    vision_thread: Optional[threading.Thread] = None
    vision_stop_event = threading.Event()
    if vision_service is not None:
        vision_thread = threading.Thread(
            target=vision_service.run_forever, args=(vision_stop_event,), name="vision-service", daemon=True
        )
        vision_thread.start()

    def _vision_status_fields() -> dict:
        if vision_service is not None:
            return vision_service.status_snapshot()
        if vision_degraded:
            return {"visionState": "DEGRADED"}
        return {}

    if config.topic_status:
        mqtt_client.publish(config.topic_status, {
            "deviceId": config.device_id,
            "occurredAt": _now_iso(),
            "firmwareVersion": config.firmware_version,
            "esp32Connected": reader.last_reading is not None,
            **_vision_status_fields(),
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
                    **_vision_status_fields(),
                })
                last_status_at = now

            time.sleep(0.5)
    except KeyboardInterrupt:
        logger.info("apagando por senal de interrupcion")
    finally:
        vision_stop_event.set()
        if vision_thread is not None:
            vision_thread.join(timeout=2)
        reader.stop()
        mqtt_client.close()


if __name__ == "__main__":
    main()
