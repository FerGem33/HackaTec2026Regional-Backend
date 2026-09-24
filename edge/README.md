# SenseCare edge (Raspberry Pi + ESP32)

Implementa la parte de sensores del contrato descrito en
[`../docs/EDGE_IMPLEMENTATION_GUIDE.md`](../docs/EDGE_IMPLEMENTATION_GUIDE.md):
lee el ESP32 por serial, aplica reglas locales con ventana temporal y publica
por MQTT TLS a AWS IoT Core usando los mismos JSON Schema de
[`../packages/contracts/schemas/`](../packages/contracts/schemas/).

**Visión local y evidencia:** ya implementadas (`frame_source.py`,
`ring_buffer.py`, `vision_detectors.py`, `risk_fusion.py`, `vision_service.py`,
`commands.py`, `evidence.py`, `evidence_state.py`). La decisión de hardware de
cámara (CSI/USB/celular) sigue pendiente: mientras no se elija un adaptador
concreto, `main.py` sólo activa visión si `vision.fixtureFramesDir` apunta a
una carpeta de JPEGs de prueba (ver sección 8 de este README); sin eso,
publica `status` con `visionState: DEGRADED` y continúa la telemetría de
sensores sin cambios.

**Fuera de alcance todavía:** check-in de voz (`audio.py`) y persistencia
local de órdenes `UPLOAD_EVIDENCE` tras un reinicio (hoy sólo en memoria).

## Estructura

```text
edge/
  requirements.txt              # dependencias base (sensores/MQTT), sin cámara
  requirements-vision.txt       # mediapipe/opencv/numpy, instalar sólo con cámara real
  config/example.yaml          # copiar a /etc/SenseCare/config.yaml en la Pi
  src/SenseCare_edge/
    config.py                  # carga y valida config.yaml, falla rapido si falta algo
    esp32_reader.py            # hilo que lee el serial y normaliza JSON -> contrato
    sensor_rules.py            # ventana + cooldown para POOR_AIR_QUALITY / TEMPERATURE_ALERT
    mqtt_client.py             # MQTT TLS con reconexion, backoff y suscripción a `commands`
    schemas.py                 # valida contra packages/contracts/schemas/*.json
    frame_source.py            # abstracción de cámara (hardware pendiente) + fixture de pruebas
    ring_buffer.py             # buffer de frames en RAM (10s) + frames "pineados" por eventId
    vision_types.py            # dataclasses de observaciones de detectores
    vision_detectors.py        # adaptadores MediaPipe (import perezoso) + monitor de salud de cámara
    risk_fusion.py             # POSSIBLE_FALL / PERSON_PRONE_INACTIVE / UNEXPECTED_PERSON / POSSIBLE_SMOKE_OR_FIRE / CAMERA_TAMPERED
    vision_service.py          # bucle de captura adaptativo 2fps base / 6fps ráfaga
    evidence_state.py          # fingerprint/estado en memoria de órdenes UPLOAD_EVIDENCE
    commands.py                # UPLOAD_EVIDENCE: ack, dedup/retry, COMMAND_CONFLICT
    evidence.py                # PUT HTTP directo a la URL prefirmada
    main.py                    # arranque y loop principal
  systemd/SenseCare-edge.service
  tests/
```

## 1. Mapeo de campos: tu ESP32 -> el contrato SenseCare

El sketch del nodo de sensores (BH1750, SHT31, VL53L0X, SCD41, INMP441) debe
compilarse con `OUTPUT_JSON = 1` para que cada línea sea un objeto JSON.

| Campo del ESP32 | Campo del contrato (`telemetry.schema.json`) | Nota |
| --- | --- | --- |
| `temp` | `temperatureC` | directo |
| `hum` | `humidityPct` | directo |
| `co2` | `co2Ppm` | directo |
| `dist_mm` | `proximityCm` | se divide entre 10 en `esp32_reader.py` |
| `db_prom` | `dbAvg` | directo |
| `db_pico` | `dbPeak` | directo |
| `presencia` | *(ya no existe en el contrato)* | se lee y se conserva localmente por si sirve para reglas futuras, pero ya no se publica (`motion` se quitó del schema en el milestone 3) |
| `lux` | *(no existe en el contrato)* | se descarta antes de publicar |

El schema tiene `additionalProperties: false`, así que **no se puede** mandar
`lux` tal cual ni el viejo `motion`: AWS Lambda rechazaría el mensaje.
`esp32_reader.py` sí guarda `lux`/`presencia` en la lectura normalizada (por
si quieres usarlos en reglas locales o logging), pero `main.py` los quita
antes de armar el payload MQTT.

Si el equipo decide que luz y sonido son útiles para el demo (por ejemplo,
para justificar una anomalía combinada), la vía correcta es extender el
contrato: agregar `luxLevel`, `soundDbAvg` y `soundDbPeak` como propiedades
opcionales en `../packages/contracts/schemas/telemetry.schema.json` y avisar
al equipo de backend/simulador, porque ese archivo es la fuente de verdad
compartida (también la usa `@sensecare/gateway-sim` y la validación en AWS
Lambda).

## 2. Configurar

```bash
cp config/example.yaml /tmp/config.yaml   # editar deviceId, endpoint IoT, puerto serial
sudo mkdir -p /etc/SenseCare/iot
# copiar AmazonRootCA1.pem, device.pem.crt y private.pem.key a /etc/SenseCare/iot/
# (entregados por quien despliega AWS, nunca por Git — ver EDGE_IMPLEMENTATION_GUIDE.md)
sudo cp /tmp/config.yaml /etc/SenseCare/config.yaml
```

`config.py` valida al arrancar que existan `deviceId`, endpoints, rutas de
certificado y topics; si falta algo, el proceso sale con código 1 en vez de
publicar telemetría a medias.

## 3. Encontrar el puerto serial correcto (evitar `/dev/ttyUSB0`)

```bash
ls -l /dev/serial/by-id/
```

Usa esa ruta estable (no cambia entre reinicios) en `esp32.serialPort` del
config. Confirma que el ESP32 está reportando JSON válido antes de continuar:

```bash
screen /dev/serial/by-id/usb-... 115200
# deberias ver una linea JSON por segundo; Ctrl+A luego K para salir
```

## 4. Instalar y correr localmente (en la Pi, dentro del venv)

```bash
cd edge
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
SenseCare_CONFIG=/etc/SenseCare/config.yaml PYTHONPATH=src python -m SenseCare_edge.main
```

Deberías ver en el log: conexión a IoT Core, y cada
`telemetryIntervalSeconds` un intento de publicación. Si el broker rechaza el
certificado, revisa que la política IoT del `Thing` permita publicar en los
topics de `config.yaml`.

## 5. Correr las pruebas

Ninguna prueba necesita hardware, red ni `mediapipe` instalado: los
detectores de visión usan Protocols con implementaciones falsas inyectables
(ver `tests/test_risk_fusion.py`, `tests/test_integration_fixture.py`); los
adaptadores reales de MediaPipe sólo se importan de forma perezosa dentro de
sus propias clases (`vision_detectors.py`).

```bash
python -m unittest discover -s tests -v
```

Cubren: reglas de sensores (ventana + cooldown), `FrameSource`/`FrameRingBuffer`
en RAM, los 5 candidatos de `RiskFusionEngine` (transición válida, frame
aislado, inmovilidad sostenida, cooldown, zona armada, módulo de humo/fuego
apagado por defecto, cámara degradada, timestamps fuera de orden), el ciclo
de `UPLOAD_EVIDENCE` en `commands.py` (URL vencida, `s3Key` inválido,
duplicado con URL renovada, `COMMAND_CONFLICT`, frame `BUFFERED` faltante) y
una integración de punta a punta con `FixtureFrameSource` que confirma
exactamente un `VISUAL_ANOMALY` sin imagen.

## 6. Activar visión con un fixture (sin decidir hardware todavía)

Mientras la cámara física no esté elegida, `vision.fixtureFramesDir` permite
probar todo el pipeline (`vision_service.py`, `risk_fusion.py`,
`commands.py`) con una carpeta de JPEGs capturados a mano, tal como pide la
"prueba física inicial" de `docs/EDGE_IMPLEMENTATION_GUIDE.md`:

```yaml
topics:
  visualAnomaly: SenseCare/v1/devices/pi-demo-01/visual/anomaly
  commands: SenseCare/v1/devices/pi-demo-01/commands
  commandAcks: SenseCare/v1/devices/pi-demo-01/command-acks
  evidence: SenseCare/v1/devices/pi-demo-01/evidence
vision:
  fixtureFramesDir: /home/SenseCare/fixture-frames   # .jpg ordenados alfabéticamente
  poseModelPath: /opt/SenseCare/models/pose.task
  personModelPath: /opt/SenseCare/models/person.tflite
  baseFps: 2
  burstFps: 6
riskFusion:
  armedZones: ["entry"]
```

Sin `poseModelPath`/`personModelPath` apuntando a modelos reales instalados
en `/opt/SenseCare/models` (fuera de Git, ver guía), el servicio arranca en
`visionState: DEGRADED` y sigue publicando telemetría de sensores con
normalidad — nunca inventa una anomalía ni aborta el proceso completo. Para
correr el pipeline real hace falta además instalar
`pip install -r requirements-vision.txt` dentro del venv de la Pi.

> **Limitación de demo — una sola evidencia visual BUFFERED pendiente por
> dispositivo:** `UPLOAD_EVIDENCE` no lleva el `eventId` de la
> `VISUAL_ANOMALY` que originó el caso (sólo `caseId`), así que
> `commands.py` no puede saber por el cable a cuál anomalía visual
> corresponde una orden `BUFFERED` si hubiera más de una pendiente a la vez.
> Por eso sólo se admite **una** reserva de evidencia visual a la vez
> (`EvidenceCommandProcessor.try_reserve_visual_evidence`, con TTL propio,
> configurable con `vision.visualEvidenceTtlSeconds`, default 90s): mientras
> esté vigente, `vision_service.py` **suprime** cualquier otra anomalía
> visual (no la publica, no pinea su frame) en vez de arriesgar entregar la
> imagen equivocada a un caso — ver el contador
> `anomaliesSuppressedPendingEvidence` en el heartbeat `status`. Esto es
> correcto para el alcance actual del demo (una anomalía → un caso → una
> orden de evidencia, en ese orden). Cambiar esto requeriría agregar un
> campo de correlación explícito al contrato (por ejemplo `eventId` en
> `UPLOAD_EVIDENCE`), lo cual **no se propone ni se implementa aquí** sin
> aprobación previa del coordinador (ver también
> `docs/EDGE_IMPLEMENTATION_GUIDE.md`, sección 8).

## 7. Instalar como servicio systemd (arranque automático)

```bash
sudo mkdir -p /opt/SenseCare/edge /var/lib/SenseCare
sudo cp -r . /opt/SenseCare/edge
sudo useradd --system --no-create-home SenseCare || true
sudo chown -R SenseCare:SenseCare /opt/SenseCare /var/lib/SenseCare
cd /opt/SenseCare/edge && sudo -u SenseCare python3 -m venv .venv \
  && sudo -u SenseCare .venv/bin/pip install -r requirements.txt

sudo cp systemd/SenseCare-edge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now SenseCare-edge
journalctl -u SenseCare-edge -f
```

## 8. Verificar de punta a punta

1. En la consola de AWS IoT Core, abre el **MQTT test client** y suscríbete a
   `SenseCare/v1/devices/{deviceId}/telemetry` (con el rol/permiso adecuado).
2. Deberías ver una lectura cada `telemetryIntervalSeconds`.
3. Provoca una condición sostenida (por ejemplo, acerca una fuente de calor al
   SHT31 por más de `windowSeconds`) y confirma que llega un único
   `sensor/anomaly` con `anomalyType: TEMPERATURE_ALERT`, no uno por cada
   lectura.
4. Del lado del backend, confirma en DynamoDB (`Devices`/`Telemetry`) que la
   lectura llegó, y que la anomalía abrió/reutilizó un `AnomalyCase`.

## Pendiente para dejarlo "completo" según la guía edge

- Elegir el adaptador real de `FrameSource` (CSI/Picamera2, USB/V4L2 o
  cámara de celular) tras la prueba física inicial; hoy sólo existe
  `FixtureFrameSource` para pruebas y demo.
- `audio.py`: check-in de voz (reproducir pregunta, grabar ≤8 s, subir
  fragmento). Mientras no exista, dejar `audio.enabled: false` en el config.
- Persistencia local de 15 minutos para órdenes `UPLOAD_EVIDENCE` y eventos
  críticos tras un reinicio/desconexión (hoy `commands.py` y la cola de
  anomalías viven sólo en memoria del proceso).
- Enriquecer `status` con temperatura de la Pi (`vcgencmd measure_temp`);
  las métricas de visión (FPS efectivo, p50/p95, frames) ya están en
  `vision_service.py`.
- Añadir un modelo TFLite validado de humo/fuego si se decide habilitar
  `POSSIBLE_SMOKE_OR_FIRE` (hoy `NullSmokeFireDetector` nunca detecta nada,
  a propósito).
