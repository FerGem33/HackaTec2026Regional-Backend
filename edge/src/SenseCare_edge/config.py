from __future__ import annotations

import os
import sys
from dataclasses import dataclass

import yaml

REQUIRED_PATHS = (
    ("deviceId",),
    ("firmwareVersion",),
    ("esp32", "serialPort"),
    ("esp32", "baudRate"),
    ("topics", "telemetry"),
    ("topics", "sensorAnomaly"),
    ("iot", "endpoint"),
    ("iot", "caPath"),
    ("iot", "certificatePath"),
    ("iot", "privateKeyPath"),
)

# Solo se exigen si el bloque `vision` esta presente en config.yaml: la
# vision es un subsistema opcional (requiere camara fisica todavia sin
# decidir), a diferencia de los campos de REQUIRED_PATHS.
VISION_REQUIRED_PATHS = (
    ("vision", "poseModelPath"),
    ("vision", "personModelPath"),
    ("topics", "visualAnomaly"),
    ("topics", "commands"),
    ("topics", "commandAcks"),
    ("topics", "evidence"),
)


def _get(config: dict, path: tuple[str, ...]):
    node = config
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


@dataclass
class EdgeConfig:
    raw: dict

    @property
    def device_id(self) -> str:
        return self.raw["deviceId"]

    @property
    def firmware_version(self) -> str:
        return self.raw["firmwareVersion"]

    @property
    def serial_port(self) -> str:
        return self.raw["esp32"]["serialPort"]

    @property
    def baud_rate(self) -> int:
        return int(self.raw["esp32"]["baudRate"])

    @property
    def topic_telemetry(self) -> str:
        return self.raw["topics"]["telemetry"]

    @property
    def topic_sensor_anomaly(self) -> str:
        return self.raw["topics"]["sensorAnomaly"]

    @property
    def topic_status(self) -> str | None:
        return self.raw["topics"].get("status")

    @property
    def iot(self) -> dict:
        return self.raw["iot"]

    @property
    def telemetry_interval_seconds(self) -> float:
        return float(self.raw.get("telemetryIntervalSeconds", 30))

    @property
    def heartbeat_interval_seconds(self) -> float:
        return float(self.raw.get("heartbeatIntervalSeconds", 60))

    @property
    def sensor_rules(self) -> dict:
        return self.raw.get("sensorRules", {})

    @property
    def vision_enabled(self) -> bool:
        return bool(self.raw.get("vision"))

    @property
    def camera_config(self) -> dict:
        return self.raw.get("camera", {})

    @property
    def vision_config(self) -> dict:
        return self.raw.get("vision", {})

    @property
    def risk_fusion_config(self) -> dict:
        return self.raw.get("riskFusion", {})

    @property
    def topic_visual_anomaly(self) -> str | None:
        return self.raw["topics"].get("visualAnomaly")

    @property
    def topic_commands(self) -> str | None:
        return self.raw["topics"].get("commands")

    @property
    def topic_command_acks(self) -> str | None:
        return self.raw["topics"].get("commandAcks")

    @property
    def topic_evidence(self) -> str | None:
        return self.raw["topics"].get("evidence")


def load_config(path: str | None = None) -> EdgeConfig:
    """Carga y valida config.yaml. Falla rapido (exit 1) si falta algo critico,
    en vez de arrancar a medias y publicar telemetria incompleta o mal dirigida."""
    path = path or os.environ.get("SenseCare_CONFIG", "/etc/SenseCare/config.yaml")

    if not os.path.isfile(path):
        print(f"[config] archivo no encontrado: {path}", file=sys.stderr)
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}

    missing = [".".join(p) for p in REQUIRED_PATHS if _get(raw, p) is None]
    if missing:
        print(f"[config] faltan campos obligatorios: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    if raw.get("vision"):
        missing_vision = [".".join(p) for p in VISION_REQUIRED_PATHS if _get(raw, p) is None]
        if missing_vision:
            print(
                f"[config] bloque 'vision' presente pero incompleto: {', '.join(missing_vision)}",
                file=sys.stderr,
            )
            sys.exit(1)

    for cert_key in ("caPath", "certificatePath", "privateKeyPath"):
        cert_path = raw["iot"][cert_key]
        if not os.path.isfile(cert_path):
            print(f"[config] certificado no encontrado ({cert_key}): {cert_path}", file=sys.stderr)
            sys.exit(1)

    return EdgeConfig(raw=raw)
