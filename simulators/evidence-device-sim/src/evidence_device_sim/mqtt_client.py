"""Cliente MQTT TLS hacia AWS IoT Core para el simulador de evidencia.

Mismo enfoque que edge/src/SenseCare_edge/mqtt_client.py: paho-mqtt hablando
MQTT 3.1.1 sobre TLS mutuo con certificado X.509, sin SDK de AWS ni llaves de
acceso. A diferencia del cliente de ingesta (solo publica), este ademas se
suscribe al topic de comandos (cloud -> Pi), que es cloud -> Pi.
"""

from __future__ import annotations

import json
import logging
import random
import time
from typing import Callable, Optional

import paho.mqtt.client as mqtt

logger = logging.getLogger("evidence_device_sim.mqtt_client")

OnCommandFn = Callable[[dict], None]


class EvidenceSimMqttClient:
    def __init__(
        self,
        device_id: str,
        endpoint: str,
        port: int,
        ca_path: str,
        cert_path: str,
        key_path: str,
        qos: int,
        on_command: OnCommandFn,
    ) -> None:
        self._device_id = device_id
        self._endpoint = endpoint
        self._port = port
        self._qos = qos
        self._on_command = on_command

        # Unicos topics permitidos (ver docs/EDGE_IMPLEMENTATION_GUIDE.md
        # seccion 7): nunca se suscribe a "#"/"+" ni a topics de otro
        # deviceId.
        self._commands_topic = f"SenseCare/v1/devices/{device_id}/commands"
        self._command_acks_topic = f"SenseCare/v1/devices/{device_id}/command-acks"
        self._evidence_topic = f"SenseCare/v1/devices/{device_id}/evidence"

        # clientId == deviceId == ThingName (requisito explicito de este
        # simulador y de la guia edge).
        self._client = mqtt.Client(client_id=device_id, protocol=mqtt.MQTTv311)
        self._client.tls_set(ca_certs=ca_path, certfile=cert_path, keyfile=key_path)
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message
        self._connected = False

    def _on_connect(self, client: mqtt.Client, _userdata: object, _flags: dict, rc: int) -> None:
        self._connected = rc == 0
        if self._connected:
            logger.info("conectado a AWS IoT Core (%s) como %s", self._endpoint, self._device_id)
            client.subscribe(self._commands_topic, qos=self._qos)
        else:
            logger.error("fallo de conexion MQTT, rc=%s", rc)

    def _on_disconnect(self, _client: mqtt.Client, _userdata: object, rc: int) -> None:
        self._connected = False
        if rc != 0:
            logger.warning("desconexion inesperada de MQTT (rc=%s)", rc)

    def _on_message(self, _client: mqtt.Client, _userdata: object, message: mqtt.MQTTMessage) -> None:
        try:
            payload = json.loads(message.payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            logger.warning("mensaje MQTT no es JSON valido en %s: %s", message.topic, exc)
            return
        if not isinstance(payload, dict):
            logger.warning("mensaje MQTT no es un objeto JSON en %s", message.topic)
            return
        # Nunca loguear el payload completo: podria contener uploadUrl
        # (URL S3 prefirmada, tratada como secreto). Solo IDs de correlacion.
        logger.info(
            "UPLOAD_EVIDENCE recibido: caseId=%s commandId=%s",
            payload.get("caseId"),
            payload.get("commandId"),
        )
        self._on_command(payload)

    def connect_with_backoff(self, max_attempts: Optional[int] = None) -> None:
        attempt = 0
        while max_attempts is None or attempt < max_attempts:
            try:
                self._client.connect(self._endpoint, self._port, keepalive=30)
                self._client.loop_start()
                for _ in range(50):
                    if self._connected:
                        return
                    time.sleep(0.1)
            except OSError as exc:
                logger.error("no se pudo conectar a IoT Core: %s", exc)

            attempt += 1
            backoff = min(60, (2**attempt)) + random.uniform(0, 1)
            logger.info("reintentando conexion MQTT en %.1fs", backoff)
            time.sleep(backoff)

        raise ConnectionError("no se pudo conectar a AWS IoT Core tras varios intentos")

    @property
    def is_connected(self) -> bool:
        return self._connected

    def publish(self, kind: str, payload: dict) -> bool:
        """`kind` es "command-acks" o "evidence"; misma firma que
        `processor.PublishFn` para poder pasarse directo como `publish_fn`.
        """
        topic = self._command_acks_topic if kind == "command-acks" else self._evidence_topic
        if not self._connected:
            logger.warning("publish omitido, sin conexion MQTT (topic=%s)", topic)
            return False
        result = self._client.publish(topic, json.dumps(payload), qos=self._qos)
        result.wait_for_publish(timeout=5)
        return result.is_published()

    def close(self) -> None:
        self._client.loop_stop()
        self._client.disconnect()
