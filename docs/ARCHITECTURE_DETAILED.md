# SenseCare — Especificación detallada de arquitectura AWS

## Alcance

SenseCare monitoriza de forma consentida a una persona dentro de su hogar. El ESP32 entrega telemetría auxiliar a una Raspberry Pi 4B local. La Pi ejecuta el primer detector visual de anomalías y un motor de reglas locales de sensores, integra cámara/audio/sensores y es el único gateway hacia AWS. Sólo después de una anomalía visual o de sensor y de comprobar consentimiento se sube una foto puntual para análisis multimodal en AWS.

La IA no realiza diagnósticos médicos. Puede solicitar escalamiento anticipado, pero una ejecución Step Functions Standard invoca la política de fallback al vencer el plazo aunque el modelo falle, no responda o no lo solicite.

## Flujos principales

```text
Telemetría y detección inicial:
ESP32 → Raspberry Pi (enlace local) → detectores visuales + RiskFusionEngine + reglas de sensores
                                      └→ IoT Core → IoT Rules → SQS telemetry/anomaly → processors → DynamoDB
                                                                                       └→ EventBridge: AnomalyDetected

Investigación de anomalía:
EventBridge → Step Functions Standard → CheckConsent → comando MQTT a Raspberry Pi → S3 privado
                                          ↑ callback                 ↓
                              respuesta humana / evidenceCallback ← visionProcessor → Bedrock
Step Functions → alerta a familia + check-in de voz → timeout → EscalationPolicy → Amazon Connect Customer (Voice)

Operador y simulador de demo:
CLI/API → API Gateway → Lambda API → DynamoDB / URLs prefirmadas S3
Simulador web autenticado (sólo sensores) → demoIngestHandler → misma SQS de eventos normalizados
                              ↑
                           Cognito
```

Mantener todos los recursos en una misma región AWS reduce latencia, complejidad y costos de transferencia. Para el hackathon, `us-east-1` es una opción práctica si la cuenta tiene acceso al modelo de Bedrock elegido.

---

## 1. Gateway: Raspberry Pi 4B

No es un servicio AWS: es el intermediario local entre hardware, cámara y nube.

| Aspecto | Definición |
| --- | --- |
| Propósito | Recibir sensores ESP32, ejecutar detectores de riesgo visual por secuencia y reglas de sensores, retener sólo evidencia breve en memoria, reproducir preguntas y recibir respuesta de voz. |
| Entrada | ESP32 por Wi-Fi local/HTTP/MQTT local/serial; cámara, micrófono, bocina y comandos desde IoT Core. |
| Salida | Telemetría consolidada, eventos visuales y de sensores, foto puntual S3 mediante URL prefirmada, audio de check-in y `command-acks`. |
| Necesidad | Indispensable: es el gateway y primer detector del MVP. |
| Sustitución futura | Hardware edge con más cómputo/acelerador para ejecutar también el análisis multimodal localmente. |

Configuración recomendada:

- Servicio local en Python o Node.js; procesos separados para adquisición ESP32, cámara/visión y MQTT.
- Modelos ligeros de visión cuantizados; medir FPS, latencia y temperatura en la Pi real. La detección visual abre una anomalía; no se envía video continuo.
- Motor de reglas de sensores con rangos físicos, ventana temporal, histéresis y cooldown. Publica una anomalía de sensor sólo cuando una condición es sostenida/crítica; no reacciona a una lectura aislada.
- Buffer local ante pérdida de internet.
- Mantener un buffer circular exclusivamente en RAM de los últimos frames; borrar el frame una vez enviado o descartado. Fotos JPEG de 1280×720, idealmente menores a 1 MB.
- Sin credenciales AWS estáticas: certificado X.509 de la Pi para IoT y URLs prefirmadas para S3. El ESP32 no recibe credenciales AWS.
- Indicador visible cuando cámara o micrófono estén activos.

### Detección visual amplia por secuencia

La cámara real es la única fuente visual del demo. Puede observar una habitación física o una animación reproducida en una pantalla; en ambos casos los frames pasan por exactamente el mismo pipeline de la Pi. Un MP4/RTSP puede existir sólo como *fixture* interno de prueba, no como atajo de demo hacia la nube.

```text
cámara real → frames con timestamp → detectores ligeros → RiskFusionEngine
                                                ├─ pose + tracking
                                                ├─ persona/objeto + zonas
                                                ├─ humo/fuego especializado (si existe)
                                                └─ salud/oclusión de cámara
                                                   ↓
                               candidato visual + evidencia temporal → MQTT
```

`RiskFusionEngine` no emite diagnósticos ni acusaciones. Emite candidatos de riesgo:

| Candidato | Evidencia local mínima | Límite del nombre |
| --- | --- | --- |
| `POSSIBLE_FALL` | Transición de pose vertical a horizontal y/o movimiento abrupto. | No confirma lesión. |
| `PERSON_PRONE_INACTIVE` | Persona horizontal con falta de movimiento por ventana configurada. | No diagnostica desmayo. |
| `UNEXPECTED_PERSON` | Persona en zona restringida, fuera de horario o con modo hogar armado. | No identifica ni acusa a alguien de robo. |
| `POSSIBLE_SMOKE_OR_FIRE` | Detector especializado consistente en varios frames; sensores pueden reforzar. | No sustituye detector certificado. |
| `CAMERA_TAMPERED` | Oclusión, cambio extremo de imagen, pérdida de frames o cámara desconectada. | Es un fallo técnico, no una emergencia médica. |

Implementación inicial en Pi 4B:

- Leer cámara a 640×480 o 720p y 5–8 FPS; usar timestamps monotónicos.
- Ejecutar pose en cada 2–3 frames, detector de persona/zona a menor frecuencia y detector de humo/fuego sólo si hay modelo TFLite compatible. No cargar modelos pesados simultáneamente sin medir CPU, temperatura y latencia.
- `RiskFusionEngine` mantiene estado por track/persona y zona: postura, movimiento, duración, conteo de personas, hora y estado armado. Exigir dos o más observaciones coherentes y un cooldown por tipo antes de publicar.
- MediaPipe Pose Landmarker y Object Detector admiten video/live stream; el modo live puede omitir frames bajo carga, por lo que las reglas deben usar timestamps y no asumir un frame por intervalo. [Pose Landmarker](https://ai.google.dev/edge/api/mediapipe/python/mp/tasks/vision/PoseLandmarker) y [Object Detector](https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector/python?hl=ko).
- Retener únicamente un buffer circular de frames en RAM. Cuando el motor publica un candidato, asocia el mejor frame y sus métricas al `eventId`; el frame no viaja en MQTT.

Contrato de salida visual:

```json
{
  "eventId": "uuid",
  "eventType": "VISUAL_ANOMALY",
  "deviceId": "pi-demo-01",
  "recipientId": "recipient-demo-01",
  "occurredAt": "2026-09-23T18:30:00Z",
  "anomalyType": "PERSON_PRONE_INACTIVE",
  "confidence": 0.87,
  "candidates": ["POSSIBLE_FALL", "POSSIBLE_UNCONSCIOUSNESS"],
  "evidence": { "personCount": 1, "zone": "living_room", "horizontalSeconds": 14, "motionAfterSeconds": 12 },
  "modelVersions": { "pose": "pose-v1", "person": "person-v1" }
}
```

---

## 2. AWS IoT Core

AWS IoT Core es el punto de entrada MQTT seguro para dispositivos conectados.

| Aspecto | Definición |
| --- | --- |
| Propósito | Recibir telemetría y anomalías visuales/de sensores desde la Pi, y enviarle comandos. |
| Entrada | MQTT TLS desde la Raspberry Pi. |
| Salida | IoT Rules y comandos MQTT al gateway. |
| Necesidad | Indispensable para el diseño IoT propuesto. |

Topics iniciales:

```text
SenseCare/v1/devices/{deviceId}/telemetry
SenseCare/v1/devices/{deviceId}/visual/anomaly
SenseCare/v1/devices/{deviceId}/sensor/anomaly
SenseCare/v1/devices/{deviceId}/status
SenseCare/v1/devices/{deviceId}/command-acks
SenseCare/v1/devices/{deviceId}/commands
SenseCare/v1/devices/{deviceId}/evidence
```

Configuración:

- Crear un `Thing` y certificado X.509 por Raspberry Pi gateway. El ESP32 queda en red local.
- MQTT sobre TLS en puerto `8883`.
- QoS 1 para telemetría importante.
- Cada mensaje debe llevar `eventId` UUID y `timestamp` UTC.
- La política IoT debe permitir únicamente conectar, publicar y suscribirse a topics pertenecientes al propio dispositivo.
- Nunca conceder acceso amplio como `SenseCare/#`.

Ejemplo de telemetría:

```json
{
  "eventId": "01J...",
  "timestamp": "2026-09-23T18:30:00Z",
  "temperatureC": 27.3,
  "humidityPct": 48.1,
  "co2Ppm": 840,
  "proximityCm": 120,
  "motion": false,
  "firmwareVersion": "0.1.0"
}
```

Opcional después: Device Shadow para configuración deseada, como volumen o modo de captura. La captura se solicita por caso de anomalía, no por intervalo. Shadow no debe sustituir a DynamoDB como fuente de verdad de la aplicación.

---

## 3. IoT Rule

Se necesitan reglas IoT separadas para telemetría, anomalía visual, anomalía de sensor, `command-acks` y evidencia. La regla de telemetría no procesa respuestas del gateway.

| Aspecto | Definición |
| --- | --- |
| Propósito | Separar la red de dispositivos del procesamiento de negocio. |
| Entrada | `SenseCare/v1/devices/+/telemetry`, `+/visual/anomaly`, `+/sensor/anomaly`, `+/command-acks` y `+/evidence`. |
| Salida | SQS separadas para telemetría/anomalías y Lambdas de callback para comandos/evidencia. |
| Necesidad | Indispensable dentro de esta arquitectura. |

Consulta inicial:

```sql
SELECT *, topic(4) AS mqttDeviceId
FROM 'SenseCare/v1/devices/+/telemetry'
```

`topic(4)` extrae el `deviceId` real del topic MQTT (AWS IoT SQL indexa segmentos desde 1: `SenseCare`=1, `v1`=2, `devices`=3, `{deviceId}`=4). `mqttDeviceId` es metadato de **transporte**, nunca parte de los contratos de `@sensecare/contracts` (`additionalProperties:false`): cada Lambda de ingesta lo separa del payload y rechaza el mensaje si no coincide exactamente con el `deviceId` declarado dentro del JSON, antes de validar el schema y antes de tocar DynamoDB o EventBridge. Esto evita que un dispositivo autenticado en su propio topic falsifique dentro del cuerpo JSON el `deviceId` de otro. No se agregan otras columnas calculadas como `topic() AS mqttTopic` o `timestamp() AS receivedAt`: eso rompería el schema estricto para todo mensaje real.

Configuración:

- Usar versión SQL `2016-03-23`.
- Acción de telemetría: `sqs:SendMessage` a `telemetry-queue`.
- Acción de anomalía visual: `sqs:SendMessage` a `anomaly-queue` con `eventType`, `confidence`, `modelVersion`, métricas de postura/movimiento y contexto de sensores; nunca frames ni video en MQTT.
- Acción de anomalía de sensor: `sqs:SendMessage` a `anomaly-queue` con `anomalyType`, severidad propuesta, regla/versiones, ventana de lecturas y contexto; nunca fotos ni audio en MQTT.
- Acción de `command-acks`: invocar `commandCallbackHandler`, que valida `caseId` y llama `SendTaskSuccess`/`SendTaskFailure` con el token asociado.
- Acción de evidencia: invocar `evidenceCallbackHandler`, que valida la llave S3 y reanuda la ejecución correspondiente.
- Acción de error para visibilidad de fallos.
- Rol IAM dedicado, limitado a la cola de telemetría.
- Evitar filtros wildcard excesivamente amplios.

---

## 4. Amazon SQS y DLQ

SQS es una cola que desacopla recepción y procesamiento.

| Aspecto | Definición |
| --- | --- |
| Propósito | Evitar pérdida de telemetría si Lambda o DynamoDB fallan temporalmente. |
| Entrada | Mensajes enviados por la IoT Rule. |
| Salida | Lotes a `telemetryProcessor`. |
| Necesidad | Recomendable; indispensable en este diseño por resiliencia. |

Configuración:

- Cola `Standard`; no se requiere orden global.
- `VisibilityTimeout`: al menos seis veces el timeout de Lambda.
- Ejemplo: Lambda de 15 s requiere visibilidad de 90 s.
- `MessageRetentionPeriod`: 4 días para hackathon; 7–14 días en piloto.
- Long polling: 20 segundos.
- DLQ: `telemetry-dlq`.
- `maxReceiveCount`: 3–5.
- Cifrado gestionado por SQS para MVP.

---

## 5. Lambda telemetryProcessor

Lambda procesa telemetría de forma asíncrona.

| Aspecto | Definición |
| --- | --- |
| Propósito | Validar, deduplicar, persistir datos, actualizar estado y crear alertas. |
| Entrada | Lotes de mensajes desde SQS. |
| Salida | DynamoDB, SNS y EventBridge cuando abre un caso. |
| Necesidad | Indispensable. |

Lógica:

1. Validar esquema JSON.
2. Verificar dispositivo y relación con persona monitoreada.
3. Deduplicar con `eventId`.
4. Guardar histórico.
5. Actualizar estado actual del dispositivo.
6. Evaluar reglas.
7. Crear alerta solamente si no existe una alerta activa equivalente.

Configuración inicial:

- Memoria: 512 MB.
- Timeout: 15 segundos.
- Arquitectura: `arm64`.
- Concurrencia reservada: 5.
- Trigger SQS:
  - `BatchSize: 10`
  - `MaximumBatchingWindowInSeconds: 5`
  - `ReportBatchItemFailures`
  - `MaximumConcurrency: 5–10`
- Logs estructurados JSON.
- No agregar VPC durante el hackathon salvo necesidad real.

---

## 6. Reglas de anomalía

No es un servicio independiente: vive dentro de `telemetryProcessor`.

| Condición | Resultado |
| --- | --- |
| Temperatura alta sostenida o ascenso rápido | `TEMPERATURE_ALERT`; `warning` o severidad configurada. |
| CO₂ alto sostenido | `POOR_AIR_QUALITY` / `warning`; indicador de ventilación, no de CO, gas o incendio. |
| Sensor específico de CO alto | `POSSIBLE_CO_EXPOSURE` / `critical` de demostración; alerta humana inmediata. |
| Sensor específico de gas combustible alto | `POSSIBLE_GAS_LEAK` / `critical` de demostración; alerta humana inmediata. |
| Sensor de humo/temperatura/llama con regla compuesta | `POSSIBLE_FIRE` / `critical` de demostración; alerta humana inmediata. |
| Lectura imposible, sensor desconectado o sin calibración | `SENSOR_FAULT`; caso técnico, sin llamada automática. |
| Raspberry Pi publica `visual/anomaly.detected` | Abre caso `POSSIBLE_FALL` / `critical` con evidencia local y sensores auxiliares. |
| Sin movimiento durante `N` minutos en horario activo | Señal auxiliar para confirmar/elevar una anomalía visual. |
| Sin telemetría durante 10 minutos | Watchdog programado abre caso `DEVICE_OFFLINE`; no depende de que llegue otra lectura. |
| Posible caída visual | Evidencia que sube severidad de un caso ya abierto; no es disparador circular. |
| Riesgo alto y falta de ambas respuestas | Evaluar llamada de fallback con política independiente. |

Ejemplo de alerta:

```json
{
  "alertId": "uuid",
  "severity": "warning",
  "type": "HIGH_CO2",
  "recipientId": "recipient-123",
  "deviceId": "device-001",
  "createdAt": "2026-09-23T18:30:00Z",
  "status": "OPEN",
  "evidence": { "co2Ppm": 1650, "durationMinutes": 15 }
}
```

Las reglas usan el `timestamp` de la Pi, no el orden de llegada a SQS. La detección visual y las anomalías de sensores son disparadores pares; cada una aporta contexto a la otra. Una regla de sensor requiere ventana de tiempo, histéresis/cooldown y validación de rango. Antes de crear un caso, `telemetryProcessor`/`anomalyProcessor` intenta un `PutItem` condicional en `OpenCaseLocks` con clave `recipientId#anomalyType`; si ya existe un caso abierto, añade evidencia al existente. Sólo quien obtiene el candado crea `AnomalyCase` y publica `SenseCare.anomaly.detected`.

Los sensores del prototipo son demostrativos: no se certifican como detector de humo, CO o gas ni se validan con llama, fugas o combustión real. CO₂ se interpreta como ventilación; riesgos de CO, combustible o fuego requieren el tipo de sensor específico y la calibración/instalación de su fabricante. El LLM puede añadir contexto visual, pero no rebaja automáticamente una severidad `critical` emitida por una regla de sensor. Referencias: [CDC/NIOSH sobre CO₂ y ventilación](https://www.cdc.gov/niosh/ventilation/faq/index.html) y [CDC sobre monóxido de carbono](https://www.cdc.gov/carbon-monoxide/es/about/informacion-basica-sobre-el-monoxido-de-carbono.html).

---

## 7. DynamoDB

DynamoDB es la base de datos operacional NoSQL.

| Aspecto | Definición |
| --- | --- |
| Propósito | Guardar estado, lecturas, casos, alertas, observaciones y relaciones de acceso. |
| Entrada | Lambdas de telemetría, investigación, escalamiento y API. |
| Salida | Datos para app y motor de reglas. |
| Necesidad | Indispensable. |

Tablas:

| Tabla | Llave | Contenido |
| --- | --- | --- |
| `CareRecipients` | `recipientId` | Perfil mínimo, zona horaria y consentimientos granulares: `camera`, `voice` y `fallbackCall`. |
| `Devices` | `deviceId` | Último contacto, estado, versión, configuración y `recipientId`. |
| `Telemetry` | `deviceId` / `timestamp#eventId` | Historial de sensores. |
| `Alerts` | `recipientId` / `createdAt#alertId` | Severidad, estado, evidencia y confirmación. |
| `Observations` | `recipientId` / `capturedAt#imageId` | Resultado visual, `caseId` y llave S3. |
| `AnomalyCases` | `caseId` | Estado, `executionArn`, evidencia, plazos, respuestas y resultado de escalamiento. |
| `OpenCaseLocks` | `recipientId#anomalyType` | Candado de caso abierto, actualizado/liberado al resolver y protegido con TTL. |
| `EventLog` | `caseId` / `timestamp#eventId` | Trazabilidad de decisiones, llamadas a herramientas y cambios de estado; sin foto, audio ni biometría cruda. |
| `CaregiverAccess` | `userId` / `recipientId` | Relación de autorización uno-a-muchos, rol, prioridad y preferencias de alerta. |

Configuración:

- Billing: `PAY_PER_REQUEST`.
- TTL:
  - Telemetría: 30–90 días.
  - Observaciones: según consentimiento y política de retención.
- GSI opcionales:
  - `AlertsByAlertId` y `ObservationsByObservationId`, o incluir `recipientId` en las rutas de API.
  - `DevicesByRecipient`.
  - `CaregiversByRecipient` para notificar a los familiares de un paciente.
- Habilitar recuperación point-in-time fuera del hackathon.
- Guardar referencias de S3, no fotos ni audio.

---

## 8. Amazon S3

S3 almacena las fotos de forma privada.

| Aspecto | Definición |
| --- | --- |
| Propósito | Guardar evidencia visual y disparar análisis. |
| Entrada | JPEG subido por gateway mediante URL prefirmada. |
| Salida | Evento S3 y URLs prefirmadas de lectura. |
| Necesidad | Indispensable sólo si se incluye cámara/análisis visual. |

Configuración:

- Bucket privado: `SenseCare-private-images-{account}-{region}`.
- Bloqueo de acceso público completo.
- SSE-S3 para hackathon; SSE-KMS en producción.
- Prefijo de entrada:

```text
raw-images/{recipientId}/{caseId}/{imageId}.jpg
```

- Lifecycle:
  - Eliminar fotos a los 7 días.
  - Eliminar cargas incompletas tras 1 día.
- CORS sólo para el dominio de la app cuando sea necesario.
- No escribir archivos generados por Lambda en el mismo prefijo que dispara eventos.

---

## 9. Lambda visionProcessor

| Aspecto | Definición |
| --- | --- |
| Propósito | Analizar una foto recién subida y guardar una observación estructurada. |
| Entrada | Evento `ObjectCreated` de S3, filtrado por `raw-images/` y `.jpg`. |
| Salida | Bedrock, DynamoDB y callback a la ejecución Step Functions del `caseId`. |
| Necesidad | Indispensable sólo para monitoreo visual. |

Configuración inicial:

- Memoria: 1024 MB.
- Timeout: 30 segundos.
- Concurrencia reservada: 2.
- Descargar foto de forma temporal, sin conservar copias; pasar a Bedrock sólo la evidencia necesaria.
- Validar estrictamente el JSON devuelto por el modelo.

Salida esperada:

```json
{
  "personDetected": true,
  "posture": "standing",
  "possibleFall": false,
  "needsHumanReview": false,
  "confidence": 0.82,
  "summary": "Una persona está de pie cerca de la cocina."
}
```

---

## 10. Amazon Bedrock

Bedrock permite usar modelos generativos sin operar infraestructura de modelos.

| Aspecto | Definición |
| --- | --- |
| Propósito | Convertir una foto en una observación limitada y estructurada para el orquestador. |
| Entrada | Imagen JPEG, telemetría resumida, estado del caso y prompt de sistema. |
| Salida | JSON de observación; un timeout/error se normaliza como `uncertain`. |
| Necesidad | Opcional para sensores; indispensable para análisis visual. |

Configuración recomendada:

- Modelo inicial: Amazon Nova Lite.
- API: Converse.
- `maxTokens`: 250–350, establecido explícitamente.
- `temperature`: 0–0.2.
- Validar salida contra un esquema JSON.
- No incluir nombres, direcciones o datos médicos en prompts.
- Desactivar logs de invocación completos o cifrarlos y restringirlos.
- Reintentos exponenciales para throttling.

Prompt conceptual:

```text
Analiza esta imagen de forma no médica.
Devuelve únicamente JSON válido.
No diagnostiques enfermedades.
Marca needsHumanReview=true si existe incertidumbre o posible peligro.
Puedes solicitar sólo herramientas enumeradas por el sistema.
No llames ni solicites marcar un número directamente: una política externa decide el escalamiento.
```

---

## 11. Amazon SNS

SNS entrega alertas a usuarios o a otros sistemas.

| Aspecto | Definición |
| --- | --- |
| Propósito | Avisar a familiares sobre alertas relevantes. |
| Entrada | Alertas creadas por Lambdas. |
| Salida | Email, push, SMS opcional u otra Lambda. |
| Necesidad | Recomendable; indispensable si se necesitan alertas inmediatas. |

Configuración:

- Topic: `SenseCare-alerts`.
- Publicar sólo alertas deduplicadas.
- Email confirmado para demo.
- Push móvil para producción.
- SMS sólo en casos críticos y con límite de gasto.
- Separar topics de warning y critical si necesitan políticas distintas.

---

## 12. Amazon Cognito

Cognito gestiona usuarios y emite tokens JWT.

| Aspecto | Definición |
| --- | --- |
| Propósito | Autenticar familiares y proteger el acceso a información sensible. |
| Entrada | Registro, login y recuperación de contraseña. |
| Salida | JWT de identidad, acceso y renovación. |
| Necesidad | Indispensable para una app multiusuario segura. |

Configuración:

- User Pool: `SenseCare-users`.
- Inicio de sesión por email.
- Verificación de email obligatoria.
- App client SPA/móvil sin client secret.
- OAuth Authorization Code + PKCE.
- MFA opcional para hackathon; recomendable en producción.
- Grupos: `caregiver`, `recipient` y `admin`. Un usuario `recipient` sólo puede consultar/modificar sus propios consentimientos.
- Access token: 60 minutos.
- Refresh token: 7–30 días.

Cognito autentica al usuario. La API debe consultar `CaregiverAccess` para autorizar el acceso a cada persona monitoreada.

El endpoint `PUT /recipients/{recipientId}/consents` permite revocar `camera`, `voice` o `fallbackCall`. La API autoriza al propio `recipient` o a un `admin` explícitamente autorizado, registra el cambio en `EventLog` y hace que ejecuciones futuras (o antes de cada acción sensible) consulten el valor vigente.

---

## 13. API Gateway HTTP API

| Aspecto | Definición |
| --- | --- |
| Propósito | Exponer una API HTTPS segura para la aplicación. |
| Entrada | Requests HTTPS con JWT Cognito. |
| Salida | Lambda `apiHandler`. |
| Necesidad | Indispensable para el cliente web/móvil. |

Rutas:

```text
GET  /me/recipients
GET  /devices/{deviceId}/latest
GET  /devices/{deviceId}/telemetry
GET  /cases/{caseId}/events
POST /demo/devices/{deviceId}/events
GET  /recipients/{recipientId}/dashboard
GET  /recipients/{recipientId}/telemetry
GET  /recipients/{recipientId}/alerts
GET  /recipients/{recipientId}/cases
GET  /recipients/{recipientId}/cases/{caseId}
POST /recipients/{recipientId}/cases/{caseId}/responses
POST /recipients/{recipientId}/alerts/{alertId}/acknowledge
GET  /recipients/{recipientId}/observations/{observationId}/image-url
GET  /recipients/{recipientId}/consents
PUT  /recipients/{recipientId}/consents
```

Configuración:

- Tipo: HTTP API.
- JWT authorizer con issuer del User Pool y audience del App Client.
- CORS limitado al dominio de la app.
- No configurar logs de acceso centralizados en este MVP; `EventLog` conserva la auditoría funcional de acciones de usuario y casos.
- La URL de carga no es una ruta de la app: `captureEvidence` crea una URL PUT prefirmada y la envía junto con `caseId`, llave S3 y vencimiento en el comando MQTT. El gateway no necesita Cognito.
- Validar en Lambda que cada `recipientId` pertenece al usuario autenticado.
- `POST /demo/devices/{deviceId}/events` requiere un claim/grupo `demo-operator`, allowlist de dispositivos demo y rate limit; reutiliza validadores y SQS, no acepta eventos de dispositivos de producción ni comandos.

---

## 14. Lambda apiHandler

| Aspecto | Definición |
| --- | --- |
| Propósito | Aplicar autorización de negocio y consultar/actualizar datos de la app. |
| Entrada | Request de API Gateway y claims JWT. |
| Salida | DynamoDB y URLs prefirmadas S3. |
| Necesidad | Indispensable. |

Configuración:

- Memoria: 512 MB.
- Timeout: 10 segundos.
- Concurrencia reservada: 5.
- Validación de request.
- Consultar `CaregiverAccess` usando el `sub` JWT.
- URLs prefirmadas de lectura para la app con expiración de 5 minutos. Las de escritura las firma `captureEvidence` y están ligadas a un `caseId`.
- No devolver identificadores internos o datos de otras personas.

---

## 15. Step Functions Standard: orquestación durable del caso

Esta capa convierte una anomalía en una ejecución durable por `caseId`. EventBridge sólo inicia el flujo; **Step Functions Standard** guarda el progreso, aplica esperas y timeout, y es el responsable de que exista un escalamiento aunque Bedrock no responda. No se incluye foto periódica.

### Inicio y estados

| Aspecto | Definición |
| --- | --- |
| Propósito | Ejecutar un caso de punta a punta y mantener sus plazos. |
| Entrada | `SenseCare.anomaly.detected` desde EventBridge. |
| Salida | Comandos de evidencia, alertas, callbacks y `EmergencyDialer`. |
| Necesidad | Indispensable. Usar tipo `STANDARD`, no Express. |

Estados mínimos del caso:

```text
DETECTED → CHECK_CONSENT → GATHERING_EVIDENCE → ANALYZING
         → WAITING_FOR_RESPONSES → RESOLVED / HUMAN_REVIEW
                                  └→ TIMED_OUT → ESCALATION_POLICY → ESCALATED
```

La Pi detectó localmente la anomalía y conserva el frame asociado sólo en memoria. Tras `CheckConsent`, la ejecución usa callbacks `waitForTaskToken`: `captureEvidence` obtiene una URL prefirmada, guarda de forma cifrada la correlación del token y publica este comando al `Thing` gateway correspondiente:

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

Configuración:

- Regla EventBridge precisa: `source: SenseCare`, `detail-type: anomaly.detected`; target: `StartExecution` con nombre `caseId`.
- `RequestEvidenceUpload`: callback máximo de 60 s. `commandCallbackHandler` y `evidenceCallbackHandler` validan los mensajes IoT y devuelven `SendTaskSuccess`/`SendTaskFailure`.
- Para un caso de sensor sin frame visual asociado, `reason` es `SENSOR_ANOMALY` y `captureMode` es `CURRENT`: la Pi toma un único frame fresco sólo después del comando y consentimiento. Para el caso visual usa `BUFFERED`; la Pi no toma una foto adicional por defecto.
- Si no hay ack/foto, guardar `evidenceIncomplete=true` y continuar a alerta/check-in; nunca interpretarlo como `safe`.
- `WaitForResponse`: el check-in de persona se registra como evidencia y un `CANCEL_ALERT`/`ESCALATE` de familiar autorizado reanuda la decisión. Sólo `CANCEL_ALERT` detiene fallback; el timeout pasa obligatoriamente a `EscalationPolicy`.
- Configurar `Retry` para errores transitorios y `Catch` para convertir fallas de modelo/foto en incertidumbre. No poner foto, audio, token ni perfil médico en el estado de la ejecución.

### Telemetría consultable casi en tiempo real

`telemetryProcessor` escribe la lectura normalizada en `Telemetry` y actualiza atómicamente `Devices.lastState`, `lastSeenAt` y los indicadores de salud. La API/CLI de demo expone:

```text
GET /devices/{deviceId}/latest
GET /devices/{deviceId}/telemetry?from=<UTC>&to=<UTC>&limit=<n>
GET /cases/{caseId}/events
```

El primero consulta `Devices` para una respuesta rápida; el segundo usa `Query` por `deviceId`/rango temporal; el tercero usa `EventLog`. El perfil de demostración publica telemetría cada cinco segundos y la CLI puede consultar cada 2–5 segundos. Esta es una visualización casi en tiempo real, no una garantía de latencia dura: SQS preserva entrega/reintentos aunque añada segundos.

Para depuración del equipo, AWS IoT MQTT Test Client puede suscribirse a un topic de un dispositivo concreto. No exponer suscripciones MQTT de telemetría directamente a usuarios finales ni poner PII en nombres de topic.

### Adaptador del simulador web

El simulador de habitación no recibe certificado X.509 de la Pi. Publica por HTTPS autenticado a:

```text
POST /demo/devices/{deviceId}/events
```

`demoIngestHandler` sólo acepta `deviceId` de allowlist `demo`, valida exactamente los mismos schemas de `telemetry`, `visual/anomaly` y `sensor/anomaly`, asigna identidad de actor `demo-simulator`, y envía el mensaje normalizado a la misma SQS que usan las IoT Rules. No puede publicar comandos a la Pi ni seleccionar teléfonos. De esta manera, la simulación de caída, incendio, intoxicación o intrusión ejercita el mismo `anomalyProcessor`, deduplicación y Step Functions que el demo físico.

### Watchdog de ausencia de telemetría

EventBridge Scheduler ejecuta `deviceWatchdog` cada minuto. Esta Lambda consulta `Devices.lastSeenAt`; si supera el umbral, adquiere el mismo candado `OpenCaseLocks` y crea `DEVICE_OFFLINE`. Este Scheduler no toma fotos ni sustituye el flujo de Step Functions.

### Agente de decisiones y herramientas

Bedrock se invoca después de que exista evidencia o ésta haya expirado. Recibe un resumen acotado de telemetría, observación visual y estado del caso. No recibe acceso libre a tablas ni permisos de infraestructura. Su salida puede elevar severidad o pedir más evidencia, pero no cerrar un caso ni impedir que el timeout escale. Un despachador valida cada solicitud contra un esquema y ejecuta sólo estas herramientas del MVP:

| Herramienta | Propósito | Límite importante |
| --- | --- | --- |
| `get_case_context` | Leer evidencia mínima y perfil permitido. | No expone todo el expediente ni datos de otros usuarios. |
| `request_fresh_photo` | Pedir otra foto ligada al mismo caso. | La Pi toma un frame nuevo sólo tras consentimiento; frecuencia y vencimiento limitados. |
| `request_voice_checkin` | Pedir una respuesta hablada breve mediante Pi. | Sólo audio intencional y acotado; Transcribe produce texto. |
| `notify_caregiver` | Crear alerta para app/SNS. | Incluye `caseId`, severidad y plazo de respuesta. |
| `emergency_call` | Solicitar escalamiento anticipado. | Puede acelerar la evaluación, pero el timeout también invoca la política de forma independiente. |

El reconocimiento facial y las sugerencias de perfil quedan fuera del MVP: elevan el costo de privacidad y no son necesarios para demostrar el flujo principal. Para voz, el MVP usa transcripción de un check-in intencional; no trata una voz como identidad biométrica entre sesiones. El audio se sube con URL prefirmada a `raw-audio/{recipientId}/{caseId}/`, se transcribe y se borra conforme a la misma retención corta.

### Check-in, alertas y llamada de fallback

La máquina inicia simultáneamente un check-in de voz y una alerta a todos los familiares activos del paciente. La persona puede responder desde el gateway; cualquier familiar autorizado puede responder mediante API/CLI de demo. Las preferencias permiten alertar a todos en paralelo para el demo o usar prioridad/secuencia. El check-in explícito se registra como evidencia; una acción firmada de familiar puede ser `CANCEL_ALERT` o `ESCALATE`. Sólo `CANCEL_ALERT` detiene el fallback.

Al vencer el plazo `x`, `EscalationPolicy` evalúa de forma determinista:

1. El caso sigue abierto y su riesgo es alto.
2. No existe `CANCEL_ALERT` de ninguno de los familiares alertados antes del plazo.
3. El consentimiento de llamada de fallback sigue vigente.
4. El número de destino está en una lista permitida y corresponde al contacto de demo configurado, nunca a 911.
5. No existe ya una llamada para ese `caseId` (idempotencia).

Si el agente invoca `emergency_call`, puede adelantar la entrada a la política; si no lo hace, el timeout llega a la misma política. Al aprobar las condiciones, `EmergencyDialer` inicia Amazon Connect Customer (Voice) con un flujo de contacto que reproduce un aviso de prueba y llama al número autorizado. El resultado se escribe en `EventLog` y `AnomalyCases`. El modelo no recibe credenciales ni permiso IAM directo para Connect.

---

## 16. CloudTrail (fuera de alcance del MVP)

| Aspecto | Definición |
| --- | --- |
| Propósito | Auditoría de cambios a infraestructura y permisos. |
| Necesidad | Recomendable para producción; fuera de alcance del MVP. |

Configuración:

- Trail multirregión.
- Bucket S3 de auditoría.
- Validación de archivos de log.
- Acceso mínimo al bucket.
- Registrar cambios de IAM, IoT Core, S3, Cognito y Bedrock.

---

## 17. IAM y KMS

IAM define permisos. KMS controla llaves de cifrado.

| Rol | Permiso mínimo |
| --- | --- |
| IoT Rule | `sqs:SendMessage` sólo a telemetría. |
| telemetryProcessor | Consumir SQS, escritura condicional DynamoDB y `events:PutEvents` sólo al bus SenseCare. |
| deviceWatchdog | Leer `Devices`, adquirir `OpenCaseLocks`, crear caso y publicar evento. |
| Step Functions | Invocar Lambdas del flujo, publicar SNS y llamar sólo a `EscalationPolicy`; sin permisos abiertos de S3/Connect. |
| commandCallbackHandler / evidenceCallbackHandler | Leer correlación mínima y `states:SendTaskSuccess`/`states:SendTaskFailure` sólo para la máquina SenseCare. |
| visionProcessor | Leer prefijo S3 del caso, invocar Bedrock y escribir observaciones. |
| voiceCheckinHandler | Firmar audio, iniciar Transcribe y devolver resultado al `caseId`. |
| apiHandler | Acceder sólo a tablas necesarias y firmar URLs S3. |
| captureEvidence | Firmar la subida necesaria y publicar sólo `UPLOAD_EVIDENCE` al topic de la Pi indicada. |
| decisionAgent | Invocar Bedrock y el despachador de herramientas; no puede invocar Connect ni resolver un caso. |
| escalationPolicy | Leer caso, consentimientos y respuestas; sólo puede solicitar `EmergencyDialer`. |
| emergencyDialer | `connect:StartOutboundVoiceContact` para la instancia, flujo y destinos permitidos. |

Reglas:

- No usar `AdministratorAccess`.
- No usar `s3:*`, `bedrock:*` ni permisos amplios. La restricción de contenido `command=UPLOAD_EVIDENCE` se valida en aplicación; IAM sólo puede restringir topic/ARN.
- No guardar claves estáticas en código.
- Cifrado AWS administrado para MVP; CMK de KMS si producción, cumplimiento o auditoría lo requieren.

---

## Implementación por fases

1. IoT Core, IoT Rules para telemetría/acks/evidencia, SQS, DynamoDB y candado `OpenCaseLocks`.
2. Step Functions Standard, callbacks y el flujo simulado completo: anomalía → timeout → `EscalationPolicy` → llamada demo.
3. EventBridge Scheduler + `deviceWatchdog` y alarma mínima DLQ → SNS.
4. Simuladores de ESP32/gateway que responden comandos y callbacks.
5. Cognito, API Gateway y dashboard de casos/respuestas/consentimientos.
6. Captura S3 bajo demanda, `visionProcessor`, Bedrock y check-in de voz.

## Camino mínimo funcional

```text
ESP32/simulador → IoT Core → SQS → Lambda → DynamoDB → App
                                     └→ SNS si hay anomalía
```

La cámara, Bedrock, audio y escalamiento se activan sobre casos de anomalía, no como monitoreo visual o de audio continuo.
