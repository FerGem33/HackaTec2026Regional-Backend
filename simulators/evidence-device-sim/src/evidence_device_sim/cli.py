"""Punto de entrada CLI del simulador de dispositivo de evidencia.

Herramienta TEMPORAL de integracion (ver README.md de este simulador): NO es
software final de la Raspberry Pi. Sirve para probar de punta a punta el
tramo de evidencia ya desplegado en AWS (services/evidence + la extension de
Step Functions) sin esperar a que exista camara/vision reales.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Optional

from .mqtt_client import EvidenceSimMqttClient
from .processor import EvidenceOrderProcessor
from .uploader import http_put_jpeg

logger = logging.getLogger("evidence_device_sim.cli")


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    import os

    return os.environ.get(name, default)


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Simulador temporal de dispositivo de evidencia SenseCare "
            "(MQTT TLS sobre AWS IoT Core, sin SDK de AWS)."
        )
    )
    parser.add_argument(
        "--device-id",
        default=_env("EVIDENCE_SIM_DEVICE_ID"),
        help="deviceId = ThingName = clientId MQTT (env: EVIDENCE_SIM_DEVICE_ID)",
    )
    parser.add_argument(
        "--endpoint",
        default=_env("EVIDENCE_SIM_IOT_ENDPOINT"),
        help="endpoint ATS de AWS IoT Core (env: EVIDENCE_SIM_IOT_ENDPOINT)",
    )
    parser.add_argument("--port", type=int, default=int(_env("EVIDENCE_SIM_PORT", "8883") or "8883"))
    parser.add_argument("--qos", type=int, default=int(_env("EVIDENCE_SIM_QOS", "1") or "1"))
    parser.add_argument(
        "--ca-path",
        default=_env("EVIDENCE_SIM_CA_PATH"),
        help="ruta a la CA raiz de Amazon (env: EVIDENCE_SIM_CA_PATH)",
    )
    parser.add_argument(
        "--cert-path",
        default=_env("EVIDENCE_SIM_CERT_PATH"),
        help="ruta al certificado X.509 del dispositivo (env: EVIDENCE_SIM_CERT_PATH)",
    )
    parser.add_argument(
        "--key-path",
        default=_env("EVIDENCE_SIM_PRIVATE_KEY_PATH"),
        help="ruta a la llave privada del dispositivo (env: EVIDENCE_SIM_PRIVATE_KEY_PATH)",
    )
    parser.add_argument(
        "--image-path",
        default=_env("EVIDENCE_SIM_IMAGE_PATH"),
        help="JPEG de prueba <1MB, nunca subido a git (env: EVIDENCE_SIM_IMAGE_PATH)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        default=_env("EVIDENCE_SIM_ONCE") is not None,
        help="procesa una sola orden UPLOAD_EVIDENCE (ACK + resultado final) y sale",
    )
    parser.add_argument(
        "--run-timeout-seconds",
        type=float,
        default=float(_env("EVIDENCE_SIM_RUN_TIMEOUT_SECONDS", "120") or "120"),
        help="en modo --once, limite de espera antes de salir con error",
    )
    parser.add_argument("--log-level", default=_env("EVIDENCE_SIM_LOG_LEVEL", "INFO"))

    args = parser.parse_args(argv)

    missing = [
        name
        for name, value in (
            ("--device-id/EVIDENCE_SIM_DEVICE_ID", args.device_id),
            ("--endpoint/EVIDENCE_SIM_IOT_ENDPOINT", args.endpoint),
            ("--ca-path/EVIDENCE_SIM_CA_PATH", args.ca_path),
            ("--cert-path/EVIDENCE_SIM_CERT_PATH", args.cert_path),
            ("--key-path/EVIDENCE_SIM_PRIVATE_KEY_PATH", args.key_path),
            ("--image-path/EVIDENCE_SIM_IMAGE_PATH", args.image_path),
        )
        if not value
    ]
    if missing:
        parser.error("faltan valores requeridos: " + ", ".join(missing))

    return args


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    image_path = Path(args.image_path)
    if not image_path.is_file():
        logger.error("no existe el JPEG fixture indicado: %s", image_path)
        return 1

    state = {"finished": False}

    def publish_fn(kind: str, payload: dict) -> None:
        client.publish(kind, payload)

    processor = EvidenceOrderProcessor(device_id=args.device_id, image_path=image_path, publish_fn=publish_fn)

    def on_command(payload: dict) -> None:
        command_id = payload.get("commandId")
        outcome = processor.handle_command(payload)
        if outcome in ("ACCEPTED", "RENEWED") and isinstance(command_id, str):
            processor.attempt_upload(command_id, http_put_jpeg)
        if args.once:
            state["finished"] = True

    client = EvidenceSimMqttClient(
        device_id=args.device_id,
        endpoint=args.endpoint,
        port=args.port,
        ca_path=args.ca_path,
        cert_path=args.cert_path,
        key_path=args.key_path,
        qos=args.qos,
        on_command=on_command,
    )

    client.connect_with_backoff(max_attempts=5)
    logger.info(
        "suscrito y esperando UPLOAD_EVIDENCE en SenseCare/v1/devices/%s/commands", args.device_id
    )

    try:
        if args.once:
            waited = 0.0
            while not state["finished"] and waited < args.run_timeout_seconds:
                time.sleep(0.2)
                waited += 0.2
            if not state["finished"]:
                logger.error("timeout (%ss) esperando UPLOAD_EVIDENCE", args.run_timeout_seconds)
                return 1
            return 0
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("interrumpido por el usuario")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
