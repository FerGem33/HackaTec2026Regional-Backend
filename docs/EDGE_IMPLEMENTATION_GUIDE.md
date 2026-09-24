# SenseCare — guía de implementación edge (Raspberry Pi 4B + ESP32)

Este documento es el contrato de trabajo para quien implemente el equipo del hogar. Su responsabilidad termina en la Raspberry Pi: recibir sensores del ESP32, detectar localmente anomalías visuales **y de sensores**, conservar evidencia breve y comunicarse de forma segura con AWS IoT Core. No debe implementar AWS CDK, Step Functions, DynamoDB, Bedrock, el backend ni la telefonía.

## Resultado esperado

En condiciones normales, la Raspberry Pi transmite telemetría consolidada y un heartbeat. Ejecuta visión local y reglas locales de sensores, pero no transmite video, fotos ni audio de manera continua.

Al detectar una `POSSIBLE_FALL` o una anomalía de sensor sostenida/crítica, publica un evento MQTT sin imagen. Para visión retiene el frame relacionado; para sensores espera un comando cloud antes de tomar un frame actual. Sólo si recibe un comando cloud válido `UPLOAD_EVIDENCE`, sube **ese único frame** por URL prefirmada y confirma el resultado. Puede reproducir una pregunta de check-in y capturar un fragmento breve de audio únicamente cuando el backend lo solicita y existe consentimiento.

## Límites de seguridad y privacidad no negociables

- El ESP32 **nunca** se conecta a AWS ni almacena certificado o llaves AWS.
- La Pi no envía video continuo, frames periódicos ni audio continuo.
- No subir nada a S3 sin un comando asociado a `caseId`, URL prefirmada vigente y el tipo de evidencia solicitado.
- No aceptar comandos que no provengan de la conexión MQTT TLS autenticada de AWS IoT Core.
- No almacenar tokens de Step Functions, contraseñas AWS, números de teléfono ni llaves privadas en Git, logs o payloads MQTT.
- El detector local puede abrir una anomalía, pero no decide llamadas ni intenta contactar servicios de emergencia.
- Un LED/indicador físico debe reflejar cámara activa y otro, si se usa, micrófono captando audio. El demo debe explicarlo.

## 1. Material y conexiones

### Material mínimo

| Elemento | Recomendación de demo | Validación |
| --- | --- | --- |
| Cómputo | Raspberry Pi 4B, fuente estable y carcasa/ventilación | No hay reinicios bajo cámara + inferencia. |
| Almacenamiento | microSD confiable; reservar espacio para SO, logs limitados y dependencias | El SO inicia tras un corte controlado de energía. |
| Cámara | Cámara CSI compatible o webcam USB | `camera-test` produce un frame 1280×720. |
| Audio | Micrófono USB y bocina USB/3.5 mm/HDMI | Se graba y reproduce una frase de prueba. |
| Sensores | ESP32 conectado a Pi por USB serial para el demo | Se reciben mensajes válidos durante 10 min. |
| Red | Ethernet preferido; Wi-Fi y hotspot como respaldo | DNS, NTP y MQTT TLS funcionan. |

Para el demo, usar **USB serial** entre ESP32 y Pi: reduce la superficie de red local y facilita depurar. Si se utiliza Wi-Fi/HTTP o MQTT local, documentar IP, autenticación y reintentos; no abrir el ESP32 a Internet.

### Cableado y estabilidad

1. Conectar la cámara antes de arrancar; conectar el ESP32 por USB.
2. Conectar micrófono y bocina, etiquetar sus puertos y registrar qué dispositivo ALSA se usará.
3. Colocar la Pi en una superficie ventilada. No ocultarla bajo tela ni alimentarla desde un puerto USB débil.
4. Reservar un hotspot y cable Ethernet para el ensayo. La conexión a la nube es saliente; no abrir puertos entrantes en el router.

## 2. Instalar y endurecer la Raspberry Pi

Usar **Raspberry Pi OS Lite de 64 bits**, instalado con Raspberry Pi Imager. La opción Lite es apropiada para un gateway headless y la arquitectura de 64 bits corresponde a Pi 4B. Configurar en Imager antes del primer arranque: hostname `SenseCare-pi-demo`, usuario no predeterminado, contraseña única, Wi-Fi, zona horaria, SSH y una clave pública SSH. La documentación oficial recomienda Lite para instalaciones headless y permite preconfigurar red, credenciales y acceso remoto desde Imager. [Raspberry Pi: Getting started](https://www.raspberrypi.com/documentation/computers/getting-started.html)

En el primer arranque, la persona responsable debe ejecutar y registrar el resultado de:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y git python3-venv python3-pip python3-opencv v4l-utils \
  alsa-utils ffmpeg ca-certificates jq
timedatectl status
vcgencmd measure_temp
```

Después:

1. Confirmar que SSH permite clave pública. Desactivar autenticación por contraseña sólo cuando otra sesión con llave ya funcione.
2. Usar `raspi-config` para confirmar zona horaria, hostname e interfaces necesarias. No habilitar servicios no usados.
3. Mantener actualizado el reloj por NTP: eventos sin hora UTC confiable no deben enviarse.
4. Crear un usuario de servicio sin inicio de sesión, por ejemplo `SenseCare`, propietario de `/opt/SenseCare` y `/etc/SenseCare`.
5. Guardar certificados y claves de IoT en `/etc/SenseCare/iot/`, propiedad `root:SenseCare`, modo `0640` para certificados y `0640`/`0600` para la clave privada según el usuario del proceso. Nunca dejarlos en el directorio del proyecto.
6. No instalar claves de acceso IAM, `aws configure` con credenciales estáticas ni roles de cuenta en la Pi. El único material cloud persistente es el certificado X.509 de AWS IoT.

Quien administra AWS debe entregar por un canal privado `device.pem.crt`,
`private.pem.key`, `AmazonRootCA1.pem` y el endpoint ATS. Instalar los tres
archivos desde el directorio donde se recibieron:

```bash
sudo install -d -o root -g SenseCare -m 0750 /etc/SenseCare/iot
sudo install -o root -g SenseCare -m 0640 device.pem.crt \
  /etc/SenseCare/iot/device.pem.crt
sudo install -o root -g SenseCare -m 0640 private.pem.key \
  /etc/SenseCare/iot/private.pem.key
sudo install -o root -g SenseCare -m 0644 AmazonRootCA1.pem \
  /etc/SenseCare/iot/AmazonRootCA1.pem
```

El usuario/grupo del servicio puede tener otro nombre, pero el proceso edge no
debe ejecutarse como `root`. El certificado privado nunca se guarda en Git,
capturas de pantalla, mensajes públicos ni archivos de configuración.

Antes de seguir, comprobar:

```bash
uname -m
libcamera-hello --version || rpicam-hello --version || true
v4l2-ctl --list-devices
arecord -l
aplay -l
```

Los nombres de utilidades de cámara cambian entre versiones de Raspberry Pi OS; el implementador debe usar la alternativa disponible y encapsular la captura en código, no en scripts de demo.

## 3. Estructura del servicio edge

Implementar en Python 3 y ejecutar en un entorno virtual independiente. Python facilita OpenCV, acceso serial y el SDK de AWS IoT; AWS publica un Device SDK para Python con MQTT y certificados X.509. [AWS IoT Device SDKs](https://docs.aws.amazon.com/iot/latest/developerguide/iot-sdks.html)

Estructura sugerida:

```text
edge/
  pyproject.toml | requirements.txt
  src/SenseCare_edge/
    main.py                 # arranque, ciclo de vida y apagado seguro
    config.py               # carga/validación de configuración
    esp32_reader.py         # serial o adaptador local equivalente
    camera.py               # captura de frame; abstrae CSI/USB
    frame_source.py         # cámara CSI/USB; única fuente visual de demo
    vision.py               # pose, persona/zonas, humo/fuego opcional y métricas
    risk_fusion.py          # evidencia temporal y candidatos de riesgo
    sensor_rules.py         # ventanas, rangos, histéresis y anomalías de sensores
    ring_buffer.py          # buffer en RAM de frames recientes
    mqtt_client.py          # MQTT TLS, QoS, reconexión y suscripciones
    commands.py             # validación y ejecución de comandos cloud
    evidence.py             # PUT URL prefirmada y notificación de resultado
    audio.py                # reproducción/captura explícita de check-in
    schemas.py              # Pydantic/dataclasses o JSON Schema compartido
    health.py               # heartbeat, métricas y estado local
  tests/
  systemd/SenseCare-edge.service
  config/example.yaml
```

Separar procesos o hilos con colas internas acotadas:

```text
ESP32 reader ─┐
              ├─ normalizador ─→ telemetría MQTT (cada 30–60 s)
cámara ─→ detectores visuales ─→ RiskFusionEngine ─→ evento visual MQTT
              │                                      └→ frame asociado en ring buffer RAM
MQTT commands ─→ validador ─→ carga de evidencia / check-in de voz
```

No permitir que un bloqueo de red congele la cámara/visión. Si una cola está llena, descartar telemetría vieja y conservar el evento de anomalía más reciente; registrar un contador local, no el frame.

## 4. Configuración local

Crear `/etc/SenseCare/config.yaml` desde una plantilla sin secretos. Ejemplo:

```yaml
deviceId: pi-demo-01
awsRegion: us-east-1
iotEndpoint: "<account-specific-ats-endpoint>"
clientId: pi-demo-01
topics:
  telemetry: SenseCare/v1/devices/pi-demo-01/telemetry
  visualAnomaly: SenseCare/v1/devices/pi-demo-01/visual/anomaly
  sensorAnomaly: SenseCare/v1/devices/pi-demo-01/sensor/anomaly
  status: SenseCare/v1/devices/pi-demo-01/status
  commands: SenseCare/v1/devices/pi-demo-01/commands
  commandAcks: SenseCare/v1/devices/pi-demo-01/command-acks
  evidence: SenseCare/v1/devices/pi-demo-01/evidence
iot:
  caPath: /etc/SenseCare/iot/AmazonRootCA1.pem
  certificatePath: /etc/SenseCare/iot/device.pem.crt
  privateKeyPath: /etc/SenseCare/iot/private.pem.key
  port: 8883
  qos: 1
telemetryIntervalSeconds: 5 # perfil demo; producción/prototipo normal: 30–60
heartbeatIntervalSeconds: 60
camera:
  width: 1280
  height: 720
  maxFps: 8
  jpegQuality: 80
vision:
  poseModelPath: /opt/SenseCare/models/pose.task
  personModelPath: /opt/SenseCare/models/person.tflite
  smokeFireModelPath: null # habilitar sólo si se valida un modelo compatible
  anomalyThreshold: 0.80
  cooldownSeconds: 120
  ringBufferSeconds: 10
riskFusion:
  minConsistentFrames: 2
  proneInactiveSeconds: 12
  armedZones: ["entry", "living_room"]
audio:
  enabled: true
  maxRecordSeconds: 8
  inputDevice: "default"
  outputDevice: "default"
```

`ThingName`, `clientId` MQTT y `deviceId` deben ser exactamente el mismo valor.
El administrador obtiene el valor de `iotEndpoint` con:

```bash
aws iot describe-endpoint \
  --endpoint-type iot:Data-ATS \
  --query endpointAddress \
  --output text \
  --region us-east-1 \
  --profile default
```

La Pi sólo recibe el hostname resultante; no requiere ni debe contener el
perfil, las credenciales ni la configuración AWS CLI del administrador. La
configuración debe fallar al iniciar si `deviceId`, `clientId`, endpoint, rutas
de certificado, topics o límites de evidencia faltan.

## 5. Integración ESP32 → Pi

### Protocolo recomendado: serial USB, JSON por línea

Configurar el ESP32 a 115200 baudios, UTF-8, un objeto JSON por línea y final `\n`. Usar una ruta estable `/dev/serial/by-id/...` mediante una regla udev; no depender de `/dev/ttyUSB0`, que puede cambiar después de reiniciar.

Mensaje mínimo del ESP32:

```json
{
  "eventId": "uuid-generado-por-esp32",
  "occurredAt": "2026-09-23T18:30:00Z",
  "firmwareVersion": "0.1.0",
  "temperatureC": 27.3,
  "humidityPct": 48.1,
  "co2Ppm": 840,
  "proximityCm": 120,
  "dbAvg": 42.5,
  "dbPeak": 68.2
}
```

Reglas del lector:

- Validar tipos, rangos físicos y tamaño máximo antes de aceptar una línea.
- Descartar JSON corrupto sin terminar el proceso; incrementar un contador `invalidSensorMessages`.
- Si el ESP32 no tiene reloj confiable, marcar la lectura como `sourceTimestampUnavailable` y asignar `receivedAt` en Pi. No fingir una hora exacta.
- La Pi agrega `deviceId`, `firmwareVersion` y `occurredAt` UTC antes de publicar telemetría. No incluye `recipientId`: el backend lo resuelve desde `SenseCare-Devices`.
- El motor `sensor_rules.py` puede emitir anomalías, pero nunca sube una imagen por sí mismo: el backend abre/reutiliza caso, valida consentimiento y ordena la evidencia. Una lectura aislada no es anomalía.

Publicar telemetría consolidada cada 5 segundos en perfil `demo` y cada 30–60 segundos fuera de demo; nunca publicar un frame en este topic.

### Reglas locales de sensores

`sensor_rules.py` recibe lecturas normalizadas y aplica rango físico, una ventana temporal, histéresis y cooldown por tipo. Debe emitir `sensor/anomaly` con la regla/versiones y la ventana que justificó la decisión. Reglas iniciales seguras:

- `POOR_AIR_QUALITY`: CO₂ alto sostenido; describe ventilación, no gas, CO ni fuego.
- `TEMPERATURE_ALERT`: temperatura alta sostenida o ascenso rápido; requiere confirmación por ventana.
- `SENSOR_FAULT`: lectura fuera de rango, sensor desconectado o falta de calibración; nunca activa llamada automática.
- `POSSIBLE_CO_EXPOSURE`, `POSSIBLE_GAS_LEAK`, `POSSIBLE_FIRE`: sólo si existe el sensor físico específico, se documenta su calibración y se habilita la regla por configuración de demo.

No validar sensores con encendedor, llama, combustión ni fuga real. El prototipo no es una alarma certificada. Los escenarios de incendio/intoxicación se ejercitan con el simulador web; el backend tratará los eventos críticos de sensor como alerta humana inmediata y el LLM sólo añade contexto.

## 6. Cámara, visión y detector local

### Captura

- Abrir una sola sesión de cámara desde `camera.py`; no ejecutar procesos de captura paralelos.
- La cámara real observa la habitación o la pantalla que reproduce una animación. No crear un `AnimationSource` ni enviar eventos visuales desde el navegador: ambos demos deben recorrer la cámara y el pipeline de visión de la Pi.
- Configurar 1280×720 y limitar la inferencia a 5–8 FPS inicialmente. Ajustar sólo con mediciones reales de temperatura, CPU y latencia.
- Encender el LED de cámara antes de leer frames y apagarlo al detener el servicio.
- Mantener un ring buffer en RAM de 10 segundos, con copia reducida si es necesario. No escribir automáticamente los frames al disco.

### Detectores y fusión de riesgos

No usar un único modelo que afirme entender todos los accidentes. `vision.py` combina detectores ligeros y `risk_fusion.py` aplica reglas temporales:

- Pose + tracking: transición vertical/horizontal e inmovilidad para `POSSIBLE_FALL` y `PERSON_PRONE_INACTIVE`.
- Persona/zonas: `UNEXPECTED_PERSON` sólo si hay zona restringida, horario armado o condición de vivienda vacía; no identifica a nadie ni lo etiqueta como ladrón.
- Humo/fuego: modelo especializado TFLite opcional y varias detecciones coherentes para `POSSIBLE_SMOKE_OR_FIRE`; no sustituye una alarma certificada.
- Salud de cámara: oclusión, imagen extrema, pérdida de frames o desconexión para `CAMERA_TAMPERED`.

La salida interna estable debe incluir candidatos y evidencia temporal:

```json
{
  "anomaly": true,
  "anomalyType": "PERSON_PRONE_INACTIVE",
  "confidence": 0.87,
  "candidates": ["POSSIBLE_FALL", "POSSIBLE_UNCONSCIOUSNESS"],
  "personCount": 1,
  "zone": "living_room",
  "horizontalSeconds": 14,
  "motionAfterSeconds": 12,
  "modelVersions": { "pose": "pose-v1", "person": "person-v1" },
  "inferenceLatencyMs": 143
}
```

El primer modelo puede ser un detector de pose cuantizado compatible con ARM y un detector de persona. MediaPipe ofrece modos de video y live stream para pose y objetos; usar timestamps monotónicos porque bajo carga puede omitir frames. [Pose Landmarker](https://ai.google.dev/edge/api/mediapipe/python/mp/tasks/vision/PoseLandmarker) y [Object Detector](https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector/python?hl=ko). No se debe afirmar que el resultado diagnostica una caída o desmayo.

### Antirruido

- Exigir `confidence >= anomalyThreshold` y, si el modelo lo permite, dos o más inferencias coherentes dentro de una ventana de 1–2 s. Para inmovilidad, usar una ventana mayor configurable.
- Aplicar `cooldownSeconds` de 120 s por tipo de candidato; durante el cooldown, actualizar métricas/estado pero no publicar una nueva anomalía. El backend deduplica de nuevo por caso abierto.
- Registrar localmente FPS efectivo, p50/p95 de latencia, temperatura de Pi, contador de frames y número de anomalías; no registrar imágenes.
- Si cámara/modelo falla, publicar `status` con `visionState: DEGRADED` y continuar telemetría. No inventar una anomalía ni enviar imágenes antiguas.

## 7. MQTT AWS IoT Core

Usar MQTT sobre TLS con certificado X.509 de la Pi, puerto 8883 y QoS 1 para telemetría, anomalías, acknowledgements y evidencia. AWS IoT Core autentica dispositivos MQTT mediante certificados X.509; MQTT sobre TLS es el protocolo previsto. [AWS IoT: X.509 client certificates](https://docs.aws.amazon.com/iot/latest/developerguide/x509-client-certs.html) y [protocolos](https://docs.aws.amazon.com/iot/latest/developerguide/protocols.html).

### Topics permitidos

| Dirección | Topic |
| --- | --- |
| Pi → cloud | `SenseCare/v1/devices/{deviceId}/telemetry` |
| Pi → cloud | `SenseCare/v1/devices/{deviceId}/visual/anomaly` |
| Pi → cloud | `SenseCare/v1/devices/{deviceId}/sensor/anomaly` |
| Pi → cloud | `SenseCare/v1/devices/{deviceId}/status` |
| cloud → Pi | `SenseCare/v1/devices/{deviceId}/commands` |
| Pi → cloud | `SenseCare/v1/devices/{deviceId}/command-acks` |
| Pi → cloud | `SenseCare/v1/devices/{deviceId}/evidence` |

El cliente sólo sustituye `{deviceId}` por su propio ID. No se suscribe a `#`, `+` ni a topics de otros dispositivos. La política IoT del backend debe reforzar esa misma restricción.

### Publicación y reconexión

- Generar UUID v4 por mensaje y usar `occurredAt` UTC ISO-8601.
- Persistir una cola local pequeña sólo para eventos de anomalía/ack/evidence mientras no hay conexión; cifra o protege el directorio y aplica TTL de 15 minutos. La telemetría vieja se puede resumir o descartar.
- Usar backoff exponencial con jitter en reconexiones. No publicar en un bucle rápido.
- Enviar `status` al conectar y cada 60 s: versión de software, estado de cámara/modelo, último contacto ESP32 y conectividad. No incluir IP, secretos, audio ni frames.
- Validar JSON contra esquema antes de publicar. Un error de serialización no debe matar el proceso.

## 8. Contrato de anomalía y evidencia

### Evento de anomalía (sin imagen)

Topic: `SenseCare/v1/devices/{deviceId}/visual/anomaly`

```json
{
  "eventId": "uuid",
  "eventType": "VISUAL_ANOMALY",
  "deviceId": "pi-demo-01",
  "occurredAt": "2026-09-23T18:00:00Z",
  "anomalyType": "POSSIBLE_FALL",
  "confidence": 0.86,
  "localVision": {
    "modelVersion": "local-v1",
    "personPresent": true,
    "posture": "lying_or_fallen",
    "motionAfterSeconds": 12,
    "inferenceLatencyMs": 143
  },
  "sensors": { "temperatureC": 25.1, "co2Ppm": 720 }
}
```

Asociar internamente `eventId` con el mejor frame del ring buffer. El frame nunca se codifica base64 ni se agrega al MQTT.

### Evento de anomalía de sensor (sin imagen)

Topic: `SenseCare/v1/devices/{deviceId}/sensor/anomaly`

```json
{
  "eventId": "uuid",
  "eventType": "SENSOR_ANOMALY",
  "deviceId": "pi-demo-01",
  "occurredAt": "2026-09-23T18:00:00Z",
  "anomalyType": "TEMPERATURE_ALERT",
  "severity": "warning",
  "sensorRule": {
    "ruleVersion": "sensor-rules-v1",
    "windowSeconds": 60,
    "trigger": "temperature_rise"
  },
  "sensors": { "temperatureC": 44.2, "co2Ppm": 720 }
}
```

No incluir evidencia multimedia. El backend decide si el caso requiere un frame actual bajo consentimiento.

### Comando `UPLOAD_EVIDENCE`

El backend publicará al topic de comandos:

```json
{
  "caseId": "case-uuid",
  "command": "UPLOAD_EVIDENCE",
  "reason": "LOCAL_VISUAL_ANOMALY",
  "captureMode": "BUFFERED",
  "s3Key": "raw-images/recipient-123/case-uuid/image-uuid.jpg",
  "uploadUrl": "https://...",
  "expiresAt": "2026-09-23T18:35:00Z"
}
```

Al recibirlo, `commands.py` debe:

1. Verificar que el JSON y `command` son válidos y que `expiresAt` no venció.
2. Verificar que `s3Key` inicia con `raw-images/{recipientId}/{caseId}/` y termina en `.jpg`; rechazar rutas distintas.
3. Si `captureMode` es `BUFFERED`, encontrar el frame asociado al evento aún presente. Si ya fue liberado o no existe, no tomar una foto automática; responder fallo de evidencia. Si es `CURRENT`, capturar un solo frame nuevo y fresco para un `SENSOR_ANOMALY` tras validar consentimiento/expiración; no iniciar streaming ni reutilizar una imagen antigua.
4. Publicar inmediatamente `COMMAND_ACK` con `accepted: true/false`, `caseId`, `command`, `eventId` y motivo seguro de error.
5. Si aceptó, hacer un HTTP `PUT` directo a `uploadUrl` con `Content-Type: image/jpeg`, límite de tamaño < 1 MB y timeout corto. No usar SDK AWS ni credenciales para esta carga.
6. Si el PUT termina con éxito, borrar la copia/búfer asociado tan pronto sea seguro y publicar `EVIDENCE_UPLOADED` con `caseId`, `s3Key`, `imageId` y `uploadedAt`.
7. Si falla, publicar `EVIDENCE_FAILED` con código de error no sensible. No reintentar después de que la URL expire.

El `COMMAND_ACK` se publica en `command-acks`; el resultado final en `evidence`. Ambos incluyen `caseId` y su propio `eventId`.

## 9. Check-in de voz

El check-in no es escucha ambiental. Sólo se activa al recibir un comando separado y válido, con texto predefinido o limitado y una duración máxima configurada.

Flujo:

1. Reproducir por bocina una frase del backend, por ejemplo: «SenseCare detectó una posible situación de riesgo. ¿Te encuentras bien?».
2. Encender indicador de micrófono, grabar como máximo 8 segundos y detenerse.
3. Apagar indicador, conservar temporalmente el audio y solicitar/invocar el mecanismo de subida que defina backend.
4. Subir sólo el fragmento solicitado mediante URL prefirmada a `raw-audio/{recipientId}/{caseId}/`; confirmar por MQTT.
5. Borrar el archivo temporal local tras éxito/error final y nunca usarlo para identificación de voz.

Si este contrato de comando/audio aún no está implementado por backend, dejar `audio.enabled: false` y simular la respuesta en las pruebas. No inventar topics ni mandar audio por el topic de evidencia de imágenes.

## 10. Ejecutar como servicio systemd

Crear `/etc/systemd/system/SenseCare-edge.service`:

```ini
[Unit]
Description=SenseCare edge gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=SenseCare
Group=SenseCare
WorkingDirectory=/opt/SenseCare/edge
Environment=SenseCare_CONFIG=/etc/SenseCare/config.yaml
ExecStart=/opt/SenseCare/edge/.venv/bin/python -m SenseCare_edge.main
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ReadWritePaths=/var/lib/SenseCare

[Install]
WantedBy=multi-user.target
```

Crear `/var/lib/SenseCare` para cola local efímera y otorgarlo al usuario de servicio. Instalar y observar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now SenseCare-edge
systemctl status SenseCare-edge
journalctl -u SenseCare-edge -f
```

Los logs deben ser estructurados y contener `eventId`, `caseId` cuando exista, nivel, módulo y código de error; nunca payloads completos de imágenes/audio, URL prefirmadas, certificados ni datos sensibles.

## 11. Pruebas de aceptación del responsable edge

| Prueba | Evidencia de aprobación |
| --- | --- |
| Arranque | El servicio inicia tras reiniciar la Pi y publica `status` en menos de 90 s. |
| ESP32 | 10 min de lecturas seriales válidas; una línea corrupta no detiene el proceso. |
| Cámara | Se detecta la cámara y el modelo procesa al menos 5 FPS sostenidos o se documenta la tasa real. |
| Privacidad sana | Durante 10 min sin anomalía no se publica imagen/audio ni se crean archivos de frames persistentes. |
| Anomalía visual real | Una caída/escena controlada o una animación reproducida en pantalla y vista por la cámara publica un único evento válido sin frame MQTT. |
| Candidatos | Probar `POSSIBLE_FALL`, `PERSON_PRONE_INACTIVE`, `UNEXPECTED_PERSON`, `POSSIBLE_SMOKE_OR_FIRE` y `CAMERA_TAMPERED` con escenas seguras; no afirmar diagnóstico/robo/incendio confirmado. |
| Sensor | Regla con ventana/histéresis publica un único `sensor/anomaly`; una lectura aislada no lo hace. |
| Comando inválido | URL vencida, `s3Key` incorrecto o `caseId` ausente produce ack de rechazo y no sube archivo. |
| Evidencia válida | `UPLOAD_EVIDENCE` sube un JPEG <1 MB y emite ack + `EVIDENCE_UPLOADED`. |
| Red caída | Se conserva un evento crítico/ack temporalmente y se reconecta con backoff; la cámara no se bloquea. |
| Audio | Sólo tras comando se enciende indicador, se graban ≤8 s y se borra temporal al terminar. |
| Temperatura | Una ejecución de 20 min no alcanza throttling ni reinicios; registrar temperatura máxima. |

Entregar al equipo backend: `deviceId`, endpoint IoT (sin secretos), versión de software/modelo, prueba de cada topic, esquema real de eventos, y cualquier diferencia respecto a este documento. Entregar certificados únicamente mediante un canal privado acordado con quien despliega AWS.

El aprovisionamiento de Thing, certificado, política y la prueba de humo MQTT
del lado administrador están en
[DEVICE_PROVISIONING_AND_SMOKE_TEST.md](DEVICE_PROVISIONING_AND_SMOKE_TEST.md).

## 12. Checklist de integración con backend

Antes de conectar al entorno demo, ambos responsables deben confirmar:

- [ ] El `deviceId` de config coincide con el Thing, certificados y política IoT.
- [ ] Los seis topics tienen los nombres exactos del contrato.
- [ ] El backend creó reglas para `command-acks` y `evidence`, no sólo telemetría.
- [ ] El endpoint IoT ATS, CA, certificado y clave funcionan por MQTT TLS.
- [ ] El backend envía URL prefirmada junto con `caseId`, `s3Key` y expiración.
- [ ] La Pi no necesita ni posee credenciales AWS estáticas.
- [ ] El backend confirma qué comando de audio soporta antes de activar check-in.
- [ ] El simulador cloud puede sustituir temporalmente a la Pi y la Pi puede apuntar a entorno `demo`, nunca a producción.

## Fuentes de configuración

- [Raspberry Pi OS y configuración headless](https://www.raspberrypi.com/documentation/computers/getting-started.html)
- [Raspberry Pi OS: arquitecturas y edición Lite](https://www.raspberrypi.com/documentation/computers/os.html)
- [AWS IoT Device SDKs](https://docs.aws.amazon.com/iot/latest/developerguide/iot-sdks.html)
- [AWS IoT: certificados X.509](https://docs.aws.amazon.com/iot/latest/developerguide/x509-client-certs.html)
- [AWS IoT: protocolos MQTT/TLS](https://docs.aws.amazon.com/iot/latest/developerguide/protocols.html)
