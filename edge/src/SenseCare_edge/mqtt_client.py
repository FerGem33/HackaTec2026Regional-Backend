"""Cliente MQTT TLS hacia AWS IoT Core.

AWS IoT Core no exige su propio SDK: acepta cualquier cliente MQTT 3.1.1/5
que hable TLS mutuo con certificado X.509 en el puerto 8883. Se usa
paho-mqtt aqui porque es liviano e instala sin friccion en Raspberry Pi OS.
"""

from __future__ import annotations

import json
import logging
import random
import time
from typing import Callable, Dict

import paho.mqtt.client as mqtt

logger = logging.getLogger("SenseCare_edge.mqtt_client")


class MqttPublisher:
    def __init__(self, device_id: str, iot_config: dict):
        self._device_id = device_id
        self._qos = int(iot_config.get("qos", 1))
        self._endpoint = iot_config["endpoint"]
        self._port = int(iot_config.get("port", 8883))

        self._client = mqtt.Client(client_id=device_id, protocol=mqtt.MQTTv311)
        self._client.tls_set(
            ca_certs=iot_config["caPath"],
            certfile=iot_config["certificatePath"],
            keyfile=iot_config["privateKeyPath"],
        )
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message
        self._connected = False
        # topic -> handler para `commands` (unico topic cloud->Pi del contrato).
        # Reconstruido en cada reconexion porque una sesion no persistente
        # (clean session) de paho-mqtt no conserva suscripciones del broker.
        self._subscriptions: Dict[str, Callable[[dict], None]] = {}

    def _on_connect(self, _client, _userdata, _flags, rc):
        self._connected = rc == 0
        if self._connected:
            logger.info("conectado a AWS IoT Core (%s)", self._endpoint)
            for topic in self._subscriptions:
                self._client.subscribe(topic, qos=self._qos)
        else:
            logger.error("fallo de conexion MQTT, rc=%s", rc)

    def _on_message(self, _client, _userdata, message) -> None:
        handler = self._subscriptions.get(message.topic)
        if handler is None:
            return
        try:
            payload = json.loads(message.payload.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            logger.warning("mensaje MQTT no-JSON descartado (topic=%s)", message.topic)
            return
        try:
            handler(payload)
        except Exception:  # noqa: BLE001 - un handler que falla no debe tumbar el hilo MQTT
            logger.exception("handler de mensaje MQTT fallo (topic=%s)", message.topic)

    def subscribe(self, topic: str, handler: Callable[[dict], None]) -> None:
        """Registra `handler(payload_dict)` para `topic`. Solo se usa para
        `commands` (cloud->Pi); el cliente nunca se suscribe a `#`/`+` ni a
        topics de otros dispositivos (ver EDGE_IMPLEMENTATION_GUIDE.md,
        seccion 7)."""
        self._subscriptions[topic] = handler
        if self._connected:
            self._client.subscribe(topic, qos=self._qos)

    def _on_disconnect(self, _client, _userdata, rc):
        self._connected = False
        if rc != 0:
            logger.warning("desconexion inesperada de MQTT (rc=%s), reintentando", rc)

    def connect_with_backoff(self, max_attempts: int | None = None) -> None:
        attempt = 0
        while max_attempts is None or attempt < max_attempts:
            try:
                self._client.connect(self._endpoint, self._port, keepalive=30)
                self._client.loop_start()
                # espera breve a que el callback confirme conexion
                for _ in range(50):
                    if self._connected:
                        return
                    time.sleep(0.1)
            except OSError as exc:
                logger.error("no se pudo conectar a IoT Core: %s", exc)

            attempt += 1
            backoff = min(60, (2 ** attempt)) + random.uniform(0, 1)
            logger.info("reintentando conexion MQTT en %.1fs", backoff)
            time.sleep(backoff)

        raise ConnectionError("no se pudo conectar a AWS IoT Core tras varios intentos")

    @property
    def is_connected(self) -> bool:
        return self._connected

    def publish(self, topic: str, payload: dict) -> bool:
        if not self._connected:
            logger.warning("publish omitido, sin conexion MQTT (topic=%s)", topic)
            return False
        result = self._client.publish(topic, json.dumps(payload), qos=self._qos)
        result.wait_for_publish(timeout=5)
        return result.is_published()

    def close(self) -> None:
        self._client.loop_stop()
        self._client.disconnect()
