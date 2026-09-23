# CareWatch — Especificación detallada de arquitectura AWS

## Alcance

CareWatch monitoriza de forma consentida a una persona dentro de su hogar. El MVP recibe telemetría directamente desde un ESP32, detecta anomalías y, sólo entonces, pide a una laptop-gateway una foto para reunir evidencia. Después puede hacer un check-in de voz y alertar a familiares mediante una aplicación.

La IA no realiza diagnósticos médicos. Como último recurso puede invocar una herramienta de llamada controlada, pero ésta sólo permite un número explícitamente autorizado cuando no responden la persona ni los familiares alertados dentro del plazo configurado.

## Flujos principales

```text
Telemetría:
ESP32 → IoT Core → IoT Rule → SQS → telemetryProcessor → DynamoDB
                                                       └→ EventBridge: AnomalyDetected

Investigación de anomalía:
EventBridge → captureEvidence → comando MQTT a laptop → S3 privado → visionProcessor → Bedrock
                                                                  └→ agente / herramientas: rostro y check-in de voz
Agente → alerta a familiar + check-in de voz → EscalationPolicy → Amazon Connect (sólo fallback autorizado)

App familiar:
Web o móvil → API Gateway → Lambda API → DynamoDB / URLs prefirmadas S3
                    ↑
                 Cognito
```

Mantener todos los recursos en una misma región AWS reduce latencia, complejidad y costos de transferencia. Para el hackathon, `us-east-1` es una opción práctica si la cuenta tiene acceso al modelo de Bedrock elegido.

---

## 1. Gateway: laptop

No es un servicio AWS: es el intermediario local entre hardware, cámara y nube.

| Aspecto | Definición |
| --- | --- |
| Propósito | Tomar evidencia visual bajo demanda, reproducir preguntas y recibir respuesta de voz. |
| Entrada | Comandos desde IoT Core; cámara, micrófono y bocina locales. |
| Salida | Fotos a S3 mediante URL prefirmada, audio de check-in limitado y confirmaciones de comandos. |
| Necesidad | Indispensable en el prototipo porque la cámara es la laptop. |
| Sustitución futura | Raspberry Pi o gateway dedicado. |

Configuración recomendada:

- Servicio local en Python o Node.js.
- Buffer local ante pérdida de internet.
- Fotos JPEG de 1280×720, idealmente menores a 1 MB.
- Sin credenciales AWS estáticas: certificado X.509 para IoT y URLs prefirmadas para S3.
- Indicador visible cuando cámara o micrófono estén activos.

---

## 2. AWS IoT Core

AWS IoT Core es el punto de entrada MQTT seguro para dispositivos conectados.

| Aspecto | Definición |
| --- | --- |
| Propósito | Recibir telemetría del ESP32 y enviar comandos al ESP32 o gateway. |
| Entrada | MQTT TLS desde ambos dispositivos, cada uno con certificado propio. |
| Salida | IoT Rules y comandos MQTT al dispositivo adecuado. |
| Necesidad | Indispensable para el diseño IoT propuesto. |

Topics iniciales:

```text
carewatch/v1/devices/{deviceId}/telemetry
carewatch/v1/devices/{deviceId}/status
carewatch/v1/devices/{deviceId}/command-acks
carewatch/v1/devices/{deviceId}/commands
```

Configuración:

- Crear un `Thing` y certificado por dispositivo físico: uno para ESP32 y otro para gateway.
- Crear y asociar un certificado X.509 por dispositivo.
- MQTT sobre TLS en puerto `8883`.
- QoS 1 para telemetría importante.
- Cada mensaje debe llevar `eventId` UUID y `timestamp` UTC.
- La política IoT debe permitir únicamente conectar, publicar y suscribirse a topics pertenecientes al propio dispositivo.
- Nunca conceder acceso amplio como `carewatch/#`.

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

Una IoT Rule escucha topics MQTT y envía eventos a otros servicios AWS.

| Aspecto | Definición |
| --- | --- |
| Propósito | Separar la red de dispositivos del procesamiento de negocio. |
| Entrada | `carewatch/v1/devices/+/telemetry`. |
| Salida | Mensaje normalizado a SQS. |
| Necesidad | Indispensable dentro de esta arquitectura. |

Consulta inicial:

```sql
SELECT *, topic() AS mqttTopic, timestamp() AS receivedAt
FROM 'carewatch/v1/devices/+/telemetry'
```

Configuración:

- Usar versión SQL `2016-03-23`.
- Acción principal: `sqs:SendMessage`.
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
| Temperatura alta sostenida | Alerta `warning`. |
| CO₂ alto sostenido | Alerta `warning`. |
| Sin telemetría durante 10 minutos | Alerta de dispositivo desconectado. |
| Posible caída visual + falta de movimiento | Alerta `critical`. |
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

Las reglas deterministas son el mecanismo principal del MVP. Al crear una alerta relevante, `telemetryProcessor` crea un `AnomalyCase` y publica un evento `carewatch.anomaly.detected`. El análisis visual, facial y de voz aumenta contexto, pero ninguna evidencia aislada debe activar la llamada de fallback.

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
| `CareRecipients` | `recipientId` | Perfil mínimo, consentimiento, zona horaria y contactos. |
| `CareProfiles` | `recipientId` | Edad, condiciones, medicamentos y contexto ingresado manualmente. Las sugerencias del LLM se guardan como pendientes. |
| `Devices` | `deviceId` | Último contacto, estado, versión, configuración y `recipientId`. |
| `Telemetry` | `deviceId` / `timestamp#eventId` | Historial de sensores. |
| `Alerts` | `recipientId` / `createdAt#alertId` | Severidad, estado, evidencia y confirmación. |
| `Observations` | `recipientId` / `capturedAt#imageId` | Resultado visual y llave S3. |
| `AnomalyCases` | `caseId` | Estado del caso, evidencia, plazos, respuestas y resultado de escalamiento. |
| `EventLog` | `caseId` / `timestamp#eventId` | Trazabilidad de decisiones, llamadas a herramientas y cambios de estado; sin foto, audio ni biometría cruda. |
| `CaregiverAccess` | `userId` / `recipientId` | Relación de autorización uno-a-muchos, rol, prioridad y preferencias de alerta. |

Configuración:

- Billing: `PAY_PER_REQUEST`.
- TTL:
  - Telemetría: 30–90 días.
  - Observaciones: según consentimiento y política de retención.
- GSI opcionales:
  - `AlertsByStatus`.
  - `DevicesByRecipient`.
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

- Bucket privado: `carewatch-private-images-{account}-{region}`.
- Bloqueo de acceso público completo.
- SSE-S3 para hackathon; SSE-KMS en producción.
- Prefijo de entrada:

```text
raw-images/{recipientId}/{yyyy}/{mm}/{dd}/{imageId}.jpg
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
| Salida | Bedrock, DynamoDB y el caso de anomalía. |
| Necesidad | Indispensable sólo para monitoreo visual. |

Configuración inicial:

- Memoria: 1024 MB.
- Timeout: 30 segundos.
- Concurrencia reservada: 2.
- Descargar foto de forma temporal, sin conservar copias.
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
| Propósito | Convertir una foto en una observación limitada y estructurada; razonar sobre evidencia de un caso con herramientas controladas. |
| Entrada | Imagen JPEG, telemetría resumida, estado del caso y prompt de sistema. |
| Salida | JSON de observación o solicitud estructurada de una herramienta permitida. |
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

- Topic: `carewatch-alerts`.
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

- User Pool: `carewatch-users`.
- Inicio de sesión por email.
- Verificación de email obligatoria.
- App client SPA/móvil sin client secret.
- OAuth Authorization Code + PKCE.
- MFA opcional para hackathon; recomendable en producción.
- Grupos: `caregiver` y `admin`.
- Access token: 60 minutos.
- Refresh token: 7–30 días.

Cognito autentica al usuario. La API debe consultar `CaregiverAccess` para autorizar el acceso a cada persona monitoreada.

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
GET  /recipients/{recipientId}/dashboard
GET  /recipients/{recipientId}/telemetry
GET  /recipients/{recipientId}/alerts
POST /alerts/{alertId}/acknowledge
POST /images/upload-url
GET  /observations/{observationId}/image-url
```

Configuración:

- Tipo: HTTP API.
- JWT authorizer con issuer del User Pool y audience del App Client.
- CORS limitado al dominio de la app.
- No configurar logs de acceso centralizados en este MVP; `EventLog` conserva la auditoría funcional de acciones de usuario y casos.
- No subir imágenes mediante API Gateway: entregar URL prefirmada S3.
- Validar en Lambda que cada `recipientId` pertenece al usuario autenticado.

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
- URLs prefirmadas S3 con expiración de 5 minutos.
- No devolver identificadores internos o datos de otras personas.

---

## 15. EventBridge, agente de decisiones y escalamiento controlado

Esta capa convierte una anomalía en un caso investigable. Sustituye por completo la captura periódica: una foto existe sólo si se abrió un caso.

### EventBridge y `captureEvidence`

| Aspecto | Definición |
| --- | --- |
| Propósito | Coordinar los pasos asíncronos de un caso y pedir evidencia bajo demanda. |
| Entrada | Evento `carewatch.anomaly.detected` emitido por `telemetryProcessor`. |
| Salida | `captureEvidence`, agente de decisiones y eventos de auditoría. |
| Necesidad | Recomendable; indispensable en este diseño basado en casos. |

Estados mínimos del caso:

```text
DETECTED → GATHERING_EVIDENCE → WAITING_FOR_RESPONSES → RESOLVED
                                  └→ ESCALATION_REQUESTED → ESCALATED
```

`captureEvidence` obtiene una URL prefirmada, publica este comando sólo al `Thing` gateway correspondiente y espera el `command-ack`:

```json
{
  "caseId": "case-uuid",
  "command": "CAPTURE_IMAGE",
  "reason": "ANOMALY_INVESTIGATION",
  "expiresAt": "2026-09-23T18:35:00Z"
}
```

Configuración:

- Regla por patrón `source: carewatch`, `detail-type: anomaly.detected`; no publicar un evento por cada lectura cruda.
- DLQ y reintentos para `captureEvidence` y cada consumidor.
- `caseId` obligatorio en comandos, observaciones, alertas y acciones para correlación e idempotencia.
- Si el gateway no confirma o no hay foto dentro del plazo, registrar evidencia incompleta; no asumir que equivale a una emergencia.

### Agente de decisiones y herramientas

Bedrock recibe un resumen acotado de telemetría, la observación visual, el estado de consentimientos y el historial inmediato del caso. No recibe acceso libre a tablas ni permisos de infraestructura. Un despachador valida cada solicitud contra un esquema y ejecuta sólo estas herramientas:

| Herramienta | Propósito | Límite importante |
| --- | --- | --- |
| `get_case_context` | Leer evidencia mínima y perfil permitido. | No expone todo el expediente ni datos de otros usuarios. |
| `request_fresh_photo` | Pedir otra foto ligada al mismo caso. | Frecuencia y vencimiento limitados. |
| `verify_enrolled_face` | Comparar el rostro con el enrolamiento consentido. | Resultado: `MATCH`, `NO_MATCH`, `NO_FACE`, `MULTIPLE_FACES` o `UNCERTAIN`; no identifica desconocidos. |
| `request_voice_checkin` | Pedir una respuesta hablada breve mediante laptop. | Sólo audio intencional y acotado; Transcribe produce texto. |
| `notify_caregiver` | Crear alerta para app/SNS. | Incluye `caseId`, severidad y plazo de respuesta. |
| `create_profile_suggestion` | Proponer contexto para revisión humana. | Nunca modifica automáticamente enfermedades o medicamentos. |
| `emergency_call` | Activar el último recurso para un caso. | Sólo acepta `caseId`; `EscalationPolicy` aplica todas las validaciones antes de marcar. |

El reconocimiento facial es verificación 1:1 de la persona previamente enrolada y con consentimiento explícito; no es vigilancia ni búsqueda de identidades. Para voz, el MVP usa transcripción de comandos/check-in: no trata una voz como identidad biométrica entre sesiones.

### Check-in, alertas y llamada de fallback

Si el agente considera la evidencia relevante, puede solicitar simultáneamente un check-in de voz y una alerta a todos los familiares activos del paciente. La persona puede responder desde el gateway; cualquier familiar autorizado puede responder desde la aplicación. Las preferencias permiten alertar a todos en paralelo para el demo o usar prioridad/secuencia. Una respuesta válida cancela o lleva a revisión el caso según la política.

Al vencer el plazo `x`, `EscalationPolicy` evalúa de forma determinista:

1. El caso sigue abierto y su riesgo es alto.
2. No existe respuesta válida de la persona ni confirmación de ninguno de los familiares alertados.
3. El consentimiento de llamada de fallback sigue vigente.
4. El número de destino está en una lista permitida y corresponde al contacto de demo configurado, nunca a 911.
5. No existe ya una llamada para ese `caseId` (idempotencia).

Si el agente invoca `emergency_call` y se aprueban esas condiciones, `EmergencyDialer` inicia Amazon Connect con un flujo de contacto que reproduce un aviso de prueba y llama al número autorizado. El resultado de la llamada se escribe en `EventLog` y `AnomalyCases`. El modelo no recibe credenciales ni permiso IAM directo para Connect: la herramienta controlada es su única vía.

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
| telemetryProcessor | Consumir SQS, escribir DynamoDB, publicar SNS. |
| visionProcessor | Leer prefijo S3, invocar Bedrock y escribir observaciones/alertas. |
| apiHandler | Acceder sólo a tablas necesarias y firmar URLs S3. |
| captureEvidence | Firmar la subida necesaria y publicar sólo `CAPTURE_IMAGE` al topic del gateway indicado. |
| decisionAgent | Invocar Bedrock y el despachador de herramientas; no puede invocar Connect. |
| escalationPolicy | Leer el caso, consentimientos y respuestas; sólo puede solicitar `EmergencyDialer`. |
| emergencyDialer | `connect:StartOutboundVoiceContact` para la instancia, flujo y destinos permitidos. |

Reglas:

- No usar `AdministratorAccess`.
- No usar `s3:*`, `bedrock:*` ni permisos amplios.
- No guardar claves estáticas en código.
- Cifrado AWS administrado para MVP; CMK de KMS si producción, cumplimiento o auditoría lo requieren.

---

## Implementación por fases

1. IoT Core, IoT Rule, SQS, telemetryProcessor y DynamoDB.
2. Simulador de gateway.
3. Cognito, API Gateway y dashboard web.
4. Alertas SNS y confirmación.
5. EventBridge, `AnomalyCases`, captura S3 bajo demanda, `visionProcessor` y Bedrock.
6. Check-in de voz, alertas con vencimiento y verificación facial consentida.
7. `EscalationPolicy` y Amazon Connect con un único número de demo permitido y aviso de prueba.

## Camino mínimo funcional

```text
ESP32/simulador → IoT Core → SQS → Lambda → DynamoDB → App
                                     └→ SNS si hay anomalía
```

La cámara, Bedrock, audio y escalamiento se activan sobre casos de anomalía, no como monitoreo visual o de audio continuo.
