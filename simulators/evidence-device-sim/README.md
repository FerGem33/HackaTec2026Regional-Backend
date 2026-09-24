# SenseCare — simulador temporal de dispositivo de evidencia

Herramienta **temporal de integración**, no el software final de la
Raspberry Pi. Simula únicamente la parte de `commands.py`/`evidence.py`
descrita en
[`../../docs/EDGE_IMPLEMENTATION_GUIDE.md`](../../docs/EDGE_IMPLEMENTATION_GUIDE.md)
(sección 8 y su subsección de reintentos): recibe `UPLOAD_EVIDENCE` por MQTT,
responde `COMMAND_ACK`, sube un JPEG de prueba local por PUT a la URL
prefirmada, y publica `EVIDENCE_UPLOADED`/`EVIDENCE_FAILED`. No implementa
cámara, visión ni ningún otro tramo del edge real.

Sirve para probar de punta a punta, contra AWS ya desplegado, el tramo de
evidencia de `services/evidence/` y la extensión de Step Functions en
`infra/lib/constructs/case-orchestration.ts`, sin esperar a que exista la
implementación final de la Pi.

**Cuando el responsable edge implemente `commands.py`/`evidence.py` reales,
este simulador es la referencia práctica** de la semántica de deduplicación
y códigos de error acordada.

## Qué NO hace (a propósito)

- No implementa cámara, visión, `RiskFusionEngine`, check-in de voz ni audio.
- No persiste nada en disco entre ejecuciones (estado en memoria únicamente;
  la guía edge pide 15 minutos de persistencia protegida tras un reinicio,
  pero eso es responsabilidad de la implementación final de la Pi).
- No usa credenciales ni SDK de AWS: solo MQTT TLS con certificado X.509 y un
  `PUT` HTTP directo a la URL prefirmada, igual que se le exige a la Pi real.
- No incluye JPEGs de prueba en git. Debes indicar tu propio fixture con
  `--image-path`/`EVIDENCE_SIM_IMAGE_PATH` (JPEG real, menor a 1 MB).
- No sube ni imprime `uploadUrl`, tokens, certificados ni llaves privadas en
  los logs.

## Estructura

```text
evidence-device-sim/
  requirements.txt
  src/evidence_device_sim/
    schemas.py       # valida contra packages/contracts/schemas/*.json (no duplica el contrato)
    state.py          # CommandFingerprint / CommandRecord (estado en memoria)
    processor.py       # logica pura: dedup, COMMAND_CONFLICT, ACK, resultado final
    uploader.py          # HTTP PUT del JPEG con la biblioteca estandar (sin requests, sin AWS SDK)
    mqtt_client.py         # MQTT TLS/X.509 hacia AWS IoT Core (paho-mqtt)
    cli.py                  # entrypoint: variables de entorno o flags, modo --once
  test/
    test_processor.py        # pruebas unitarias sin AWS ni red real
```

## Instalar

```bash
cd simulators/evidence-device-sim
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Ejecutar las pruebas unitarias (sin AWS, sin red, sin JPEG real)

```bash
PYTHONPATH=src python -m unittest discover -s test -v
```

Cubren: payload válido; deduplicación exacta (pendiente y tras resultado
terminal); `COMMAND_CONFLICT` por cambio de campo inmutable o de `s3Key`;
renovación de `uploadUrl` mientras la orden sigue pendiente (usa la URL más
reciente, sin recapturar ni reenviar el ACK); ACK + subida exitosa;
expiración antes de aceptar (`EXPIRED`) y expiración entre el accept y el
intento de subida (`URL_EXPIRED`); fallo de `PUT` por timeout (`UPLOAD_TIMEOUT`)
o por error HTTP (`IO_ERROR`); ausencia del fixture, fixture sin firma JPEG
válida y fixture demasiado grande (los tres como `FRAME_NOT_AVAILABLE`);
inconsistencia `caseId` vs. `s3Key` (`INVALID_S3_KEY`); y payload
inválido contra el schema, con y sin IDs reconocibles (`INVALID_CASE` o
descarte silencioso).

## Configurar (variables de entorno o flags — lo que prefieras)

| Variable de entorno | Flag equivalente | Descripción |
| --- | --- | --- |
| `EVIDENCE_SIM_DEVICE_ID` | `--device-id` | `deviceId` = `ThingName` = `clientId` MQTT (p. ej. `pi-demo-01`) |
| `EVIDENCE_SIM_IOT_ENDPOINT` | `--endpoint` | Endpoint ATS de AWS IoT Core |
| `EVIDENCE_SIM_PORT` | `--port` | Puerto MQTT TLS (por defecto `8883`) |
| `EVIDENCE_SIM_QOS` | `--qos` | QoS MQTT (por defecto `1`) |
| `EVIDENCE_SIM_CA_PATH` | `--ca-path` | Ruta a `AmazonRootCA1.pem` |
| `EVIDENCE_SIM_CERT_PATH` | `--cert-path` | Ruta a `device.pem.crt` |
| `EVIDENCE_SIM_PRIVATE_KEY_PATH` | `--key-path` | Ruta a `private.pem.key` |
| `EVIDENCE_SIM_IMAGE_PATH` | `--image-path` | Ruta a un JPEG local, <1 MB (tu fixture, no incluido en git) |
| `EVIDENCE_SIM_ONCE` (cualquier valor) | `--once` | Procesa una sola orden `UPLOAD_EVIDENCE` (ACK + resultado final) y sale |
| `EVIDENCE_SIM_RUN_TIMEOUT_SECONDS` | `--run-timeout-seconds` | En modo `--once`, límite de espera antes de salir con error (por defecto 120s) |
| `EVIDENCE_SIM_LOG_LEVEL` | `--log-level` | Nivel de logging (por defecto `INFO`) |

Certificado, llave privada y CA deben ser los mismos ya entregados para
`pi-demo-01` (ver
[`../../docs/DEVICE_PROVISIONING_AND_SMOKE_TEST.md`](../../docs/DEVICE_PROVISIONING_AND_SMOKE_TEST.md)).
**Nunca los subas a git.**

## Ejecutar una prueba real de punta a punta (modo `--once`)

Este simulador **sí abre una conexión real a AWS IoT Core**; no ejecuta
ningún comando de despliegue ni de infraestructura. Requiere que
`SenseCareDemoStack` ya esté desplegado, que `pi-demo-01` tenga certificado
X.509 adjunto y `cameraConsent: true` en `SenseCare-Devices` (ver runbook
enlazado arriba).

```bash
cd simulators/evidence-device-sim
source .venv/bin/activate

export EVIDENCE_SIM_DEVICE_ID=pi-demo-01
export EVIDENCE_SIM_IOT_ENDPOINT="$(aws iot describe-endpoint \
  --endpoint-type iot:Data-ATS --query endpointAddress --output text \
  --region us-east-1 --profile default)"
export EVIDENCE_SIM_CA_PATH=/ruta/local/AmazonRootCA1.pem
export EVIDENCE_SIM_CERT_PATH=/ruta/local/device.pem.crt
export EVIDENCE_SIM_PRIVATE_KEY_PATH=/ruta/local/private.pem.key
export EVIDENCE_SIM_IMAGE_PATH=/ruta/local/fixture.jpg   # JPEG real <1MB, tuyo

PYTHONPATH=src python -m evidence_device_sim.cli --once
```

Pasos manuales para disparar un `UPLOAD_EVIDENCE` real mientras el simulador
espera:

1. En otra terminal, publica una anomalía (visual o de sensor) para
   `pi-demo-01` siguiendo
   [`../../docs/DEVICE_PROVISIONING_AND_SMOKE_TEST.md`](../../docs/DEVICE_PROVISIONING_AND_SMOKE_TEST.md#5-publicar-una-anomalía-visual-de-prueba)
   (sección "Publicar una anomalía visual de prueba"), con un `caseId`/`eventId`
   nuevos.
2. Como `pi-demo-01` ya tiene `cameraConsent: true`, la ejecución de
   `SenseCare-CaseStateMachine` debe llegar al estado `RequestEvidenceUpload`
   y publicar `UPLOAD_EVIDENCE` en `SenseCare/v1/devices/pi-demo-01/commands`.
3. El simulador debe imprimir la recepción del comando, publicar
   `COMMAND_ACK accepted:true`, subir el fixture, publicar
   `EVIDENCE_UPLOADED` y salir con código 0.
4. Confirmar en la consola de Step Functions que la ejecución terminó en
   `CaseEvidencePhaseComplete` (Succeed) y que `SenseCare-AnomalyCases` tiene
   `evidenceStatus: AVAILABLE` para ese `caseId`.
5. Confirmar en S3 (bucket `sensecare-private-images-<cuenta>-<región>`) que
   el objeto quedó en `raw-images/recipient-demo-01/<caseId>/<imageId>.jpg`
   con `Content-Type: image/jpeg`.

Para probar un camino de incertidumbre (por ejemplo `INCOMPLETE`), corre el
simulador **sin** pasarle `--image-path` a un archivo válido (o apúntalo a un
archivo inexistente): responderá `COMMAND_ACK accepted:false` con
`FRAME_NOT_AVAILABLE`, y `RecordEvidenceOutcome` debe marcar
`evidenceStatus: INCOMPLETE`.

## Reglas de deduplicación implementadas

Igual que la guía edge (ver enlace arriba): dos mensajes con el mismo
`commandId` son la misma orden lógica solo si coinciden `caseId`, `command`,
`reason`, `captureMode`, `s3Key`, `imageId` (derivado de `s3Key`) y
`expiresAt`. `uploadUrl` es el único campo que puede cambiar sin que la orden
deje de ser la misma. Mientras la orden sigue pendiente, un reenvío con
`uploadUrl` distinta actualiza la URL en memoria y el siguiente intento de
subida usa la más reciente, sin recapturar el frame ni reenviar el `ACK`.
Una vez publicado `EVIDENCE_UPLOADED`/`EVIDENCE_FAILED`, cualquier reenvío
reproduce exactamente ese mismo resultado. Cualquier cambio en un campo
inmutable se rechaza como `COMMAND_CONFLICT`, sin intentar adivinar cuál
versión es la correcta. Nunca extiende `expiresAt`.

## Códigos usados (todos cerrados, del contrato compartido)

- `COMMAND_ACK` rechazo: `EXPIRED`, `INVALID_S3_KEY`, `FRAME_NOT_AVAILABLE`,
  `INVALID_CASE`, `COMMAND_CONFLICT`.
- `EVIDENCE_FAILED`: `URL_EXPIRED`, `FRAME_NOT_AVAILABLE`, `UPLOAD_TIMEOUT`,
  `IO_ERROR`, `INTERNAL_ERROR`.
