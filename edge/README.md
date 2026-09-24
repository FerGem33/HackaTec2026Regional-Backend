# SenseCare edge (Raspberry Pi + ESP32)

Implementa la parte de sensores del contrato descrito en
[`../docs/EDGE_IMPLEMENTATION_GUIDE.md`](../docs/EDGE_IMPLEMENTATION_GUIDE.md):
lee el ESP32 por serial, aplica reglas locales con ventana temporal y publica
por MQTT TLS a AWS IoT Core usando los mismos JSON Schema de
[`../packages/contracts/schemas/`](../packages/contracts/schemas/).

**Fuera de alcance de este esqueleto:** cámara, visión (`RiskFusionEngine`),
check-in de voz y manejo de `UPLOAD_EVIDENCE`. Esas piezas requieren la cámara
física y se agregan como módulos aparte (`camera.py`, `vision.py`,
`commands.py`, `audio.py`) siguiendo la misma guía cuando haya cámara conectada.

## Estructura

```text
edge/
  requirements.txt
  config/example.yaml          # copiar a /etc/SenseCare/config.yaml en la Pi
  src/SenseCare_edge/
    config.py                  # carga y valida config.yaml, falla rapido si falta algo
    esp32_reader.py            # hilo que lee el serial y normaliza JSON -> contrato
    sensor_rules.py            # ventana + cooldown para POOR_AIR_QUALITY / TEMPERATURE_ALERT
    mqtt_client.py             # MQTT TLS con reconexion y backoff
    schemas.py                 # valida contra packages/contracts/schemas/*.json
    main.py                    # arranque y loop principal
  systemd/SenseCare-edge.service
  tests/test_sensor_rules.py
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

## 5. Correr las pruebas de las reglas de sensores

Estas pruebas no necesitan hardware ni red; simulan lecturas y verifican que
una lectura aislada nunca dispare una anomalía, que sí dispara tras sostenerse
la ventana configurada, y que el cooldown evita reemitir de inmediato:

```bash
python -m unittest discover -s tests -v
```

## 6. Instalar como servicio systemd (arranque automático)

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

## 7. Verificar de punta a punta

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

- `health.py` / topic `status` con heartbeat cada 60 s (hay una versión
  mínima ya integrada en `main.py`; falta enriquecerla con temperatura de la
  Pi, FPS de visión, etc. cuando exista cámara).
- Cola local persistente para anomalías mientras no hay red (hoy, si MQTT está
  desconectado, el evento simplemente no se publica y se pierde).
- `camera.py`, `vision.py`, `risk_fusion.py`, `commands.py`, `evidence.py`,
  `audio.py`: todo el pipeline visual y de evidencia, que depende de tener la
  cámara física conectada.
