# SenseCare — guía de estudio para la defensa técnica

Documento de preparación personal (no es contrato ni fuente de verdad de
diseño — esos siguen siendo `ARCHITECTURE.md`/`ARCHITECTURE_DETAILED.md`/
`IMPLEMENTATION_ROADMAP.md`). Aquí se consolida, en un solo lugar y con
honestidad explícita sobre qué está implementado/probado vs. qué sigue
siendo visión conceptual, todo lo necesario para defender el proyecto:
flujo completo, cada capa, cada regla de seguridad y el porqué detrás de
cada decisión difícil.

Estado verificado contra HEAD `ee5b546` ("feat: call to emergency 2"),
resultado de fusionar dos ramas de trabajo en paralelo: escalamiento
telefónico (Amazon Connect) y notificaciones push (Amazon Pinpoint/FCM).

---

## 0. El pitch (30 segundos / 2 minutos)

**30 segundos:** SenseCare monitorea a una persona en casa sin cámara ni
audio continuos. Un Raspberry Pi corre detección visual y reglas de
sensores localmente; sólo cuando detecta una anomalía real (caída,
inmovilidad, aire/temperatura fuera de rango) abre un caso en la nube,
pide **una** foto puntual, la analiza con IA, avisa a los familiares por
correo y push, espera una decisión humana con un plazo, y si nadie
cancela, hace una llamada telefónica de último recurso a un número de
demo autorizado. Nunca al 911.

**2 minutos (para cuando pidan "explica el flujo completo"):**
1. ESP32 (sensores auxiliares) → Raspberry Pi por serial/Wi-Fi local.
2. La Pi ejecuta visión local (MediaPipe) + reglas de sensores en un
   bucle continuo; no sube nada a AWS salvo telemetría agregada y un
   heartbeat cada 60s.
3. Si un detector confirma una anomalía sostenida (no un frame aislado),
   la Pi publica un evento MQTT **sin imagen** a AWS IoT Core.
4. El backend deduplica (un candado condicional en DynamoDB) y abre **un
   solo** `AnomalyCase`, arrancando una ejecución de Step Functions
   **Standard** nombrada por `caseId` — así un reintento nunca duplica
   nada.
5. Si el sensor es crítico, se avisa a los familiares **de inmediato**,
   antes de esperar evidencia o IA (nunca depender de una IA lenta o
   caída para decisiones de seguridad).
6. Con consentimiento de cámara vigente, la máquina pide a la Pi **una**
   foto puntual vía un comando MQTT firmado con URL prefirmada de S3; la
   Pi la sube; Amazon Bedrock la analiza con salida JSON estructurada y
   cerrada (nunca texto libre de diagnóstico).
7. Se notifica a los familiares (correo SNS + push a la app), y la
   máquina espera con un `taskToken` de Step Functions a que un familiar
   autorizado decida `CANCEL_ALERT` o `ESCALATE`.
8. Si nadie cancela dentro del plazo (o si escalan explícitamente), una
   Lambda **determinista** (`EscalationPolicy`, sin ningún permiso de
   Connect) revalida 7 condiciones de seguridad y, sólo si todas pasan,
   la única Lambda con permiso de llamar (`EmergencyDialer`) marca al
   número de demo guardado en un parámetro SSM cifrado — nunca un número
   que llegue por HTTP/MQTT/IA.

---

## 1. Qué está realmente implementado y probado (léase primero)

Este proyecto tiene documentos conceptuales (`ARCHITECTURE.md`,
`ARCHITECTURE_DETAILED.md`) que describen una visión más amplia que la
construida (agente Bedrock con herramientas, check-in de voz con
Transcribe, tabla `CareRecipients`). **Si el jurado pregunta por algo de
esa visión, es mejor decir explícitamente "eso es roadmap, no está
implementado" que improvisar.** Tabla honesta:

| Capa/funcionalidad | Estado |
| --- | --- |
| Ingesta MQTT (telemetría, anomalía visual, anomalía de sensor) | ✅ Implementado y probado |
| Dedup de casos (`OpenCaseLocks`) | ✅ Implementado y probado |
| Orquestación Step Functions Standard (registro → evidencia → análisis → decisión humana → escalamiento) | ✅ Implementado y probado |
| Consentimiento de cámara y transporte de evidencia puntual (BUFFERED/CURRENT) | ✅ Implementado y probado |
| Análisis visual con Bedrock Converse (salida JSON cerrada) | ✅ Implementado y probado |
| Alertas SNS (email) deduplicadas por caso | ✅ Implementado y probado |
| Notificaciones push (Android/FCM vía Pinpoint) | ✅ Implementado y probado, **opcional** en deploy (sin credencial FCM, se omite entero) |
| `CANCEL_ALERT`/`ESCALATE` autenticados (API) | ✅ Implementado y probado |
| `GET /cases` (listado por usuario) | ✅ Implementado y probado, con 1 inconsistencia conocida (ver §11) |
| Espera de decisión humana con callback de Step Functions | ✅ Implementado y probado |
| `EscalationPolicy` determinista | ✅ Implementado y probado |
| `EmergencyDialer` (Amazon Connect) | ✅ Implementado y probado en código/infra; **la instancia Connect real, el contact flow y el número de destino no están aprovisionados** (paso manual pendiente, ver `EMERGENCY_CALL_RUNBOOK.md`) |
| Detección visual/sensor en el edge (Raspberry Pi) | ✅ Implementado con pruebas propias (`edge/`), cámara real vía `FixtureFrameSource` (carpeta de imágenes) — **adaptador de hardware real de cámara (CSI/USB) pendiente** |
| Check-in de voz (Transcribe) | ❌ No implementado — roadmap |
| Agente Bedrock con herramientas / `decisionAgent` autónomo | ❌ No implementado — la decisión de escalar es una Lambda determinista, no un agente |
| `deviceWatchdog` (DEVICE_OFFLINE) | ❌ No implementado — roadmap |
| Tabla `CareRecipients` | ❌ No existe — el consentimiento vive como booleanos en `Devices` |
| Detección de humo/fuego (`POSSIBLE_SMOKE_OR_FIRE`) | ⚠️ Código presente pero **deshabilitado por defecto** (`smoke_fire_enabled: false`) — sin modelo TFLite validado |
| Reconocimiento facial / biometría | ❌ Explícitamente fuera de alcance |

---

## 2. Arquitectura de componentes

```
┌─────────────┐   serial/Wi-Fi    ┌──────────────────────────────┐
│   ESP32     │ ────────────────► │   Raspberry Pi 4B (gateway)  │
│ (sensores)  │   local, nunca    │  RiskFusionEngine (visión) +  │
└─────────────┘   toca AWS        │  sensor_rules.py + cámara/mic │
                                   └──────────────┬───────────────┘
                                                   │ MQTT TLS + X.509
                                                   ▼
                                   ┌──────────────────────────────┐
                                   │        AWS IoT Core          │
                                   └──────────────┬───────────────┘
                          IoT Rules (3, 1 por topic) │
                                                   ▼
                         ┌─────────────────────────────────────┐
                         │  SQS (telemetry / visual / sensor)   │
                         └───────────────┬───────────────────────┘
                                          ▼
                         Lambdas de ingesta (valida, deduplica,
                         escribe Devices/Telemetry/EventLog,
                         abre/reutiliza AnomalyCase)
                                          │ EventBridge: anomaly.detected
                                          ▼
                         ┌─────────────────────────────────────┐
                         │  Step Functions Standard (1 por caseId) │
                         └───────────────┬───────────────────────┘
             ┌───────────┬───────────────┼───────────────┬──────────────┐
             ▼           ▼               ▼               ▼              ▼
        Registro    Evidencia (S3)   Análisis        Alertas       Decisión humana
        (locks,     BUFFERED/CURRENT (Bedrock         (SNS +       + Escalamiento
        AnomalyCase)  vía Pi          Converse)        Pinpoint)   (Connect)
```

Componentes AWS (tabla completa en `README.md`/`ARCHITECTURE.md`; aquí
sólo los que exigen explicación en la defensa):

| Servicio | Por qué éste y no otro |
| --- | --- |
| Step Functions **Standard** (no Express) | Necesitamos ejecuciones durables de horas/días con historial auditable y `waitForTaskToken`; Express no garantiza "exactly once" ni conserva historial visible para depuración en vivo del demo. |
| SQS delante de cada Lambda de ingesta | MQTT/IoT Rules no reintenta por sí solo con backoff; SQS + DLQ absorbe picos y fallos transitorios sin perder eventos. |
| DynamoDB condicional (no locks externos) | Cada regla de negocio crítica (un solo caso, un solo dial, una sola decisión) se resuelve con `ConditionExpression` atómica sobre la clave primaria — sin necesidad de un lock service aparte, y con la garantía de atomicidad nativa de DynamoDB por ítem. |
| Bedrock Converse con salida JSON validada (Ajv) | Nunca se confía en texto libre de un LLM para decisiones; toda salida se fuerza a un esquema cerrado y cualquier desviación se trata como incierta, no como una alucinación silenciosa. |
| Amazon Connect sólo para `EmergencyDialer` | Es la única Lambda de todo el sistema con permiso de telefonía; aislar la superficie de ataque de "quién puede hacer sonar un teléfono" a una sola función con una sola acción IAM. |

---

## 3. El viaje completo de un incidente (con nombres exactos de estado)

Ejemplo: una anomalía de sensor crítica (ej. `TEMPERATURE_ALERT`,
`severity: critical`).

### Fase 0 — Ingesta y apertura de caso (fuera de Step Functions)

1. La Pi publica a `SenseCare/v1/devices/{deviceId}/sensor/anomaly`.
2. IoT Rule → SQS `SenseCare-sensor-anomaly` → Lambda
   `sensorAnomalyIngestHandler` (`anomalyIngestCore.ts`):
   - Verifica que `mqttDeviceId` (4º segmento del topic) coincide
     exactamente con `payload.deviceId` — si no, rechaza con cero
     escrituras (defensa contra suplantación de dispositivo).
   - Valida contra el JSON Schema (`additionalProperties: false`).
   - Resuelve `recipientId` desde `Devices` (nunca confía en uno enviado
     por MQTT).
   - Intenta un `PutItem` condicional en `OpenCaseLocks`
     (`lockKey = recipientId#anomalyType`,
     `attribute_not_exists(lockKey) OR expiresAt <= :now`). El primero
     que gana acuña un `caseId`; los demás leen (consistente) el
     `caseId` del ganador — **nunca abren un segundo caso**.
   - Escribe `EventLog` (dedup por `eventId`) y publica
     `anomaly.detected` a EventBridge bajo un "lease" que impide
     republicar el mismo caso dos veces.
3. EventBridge (source `SenseCare`, detail-type `anomaly.detected`,
   `detail.severity` presente **sólo** si `eventType === SENSOR_ANOMALY`)
   dispara `SenseCare-caseDispatcher`, que llama `StartExecution` con
   **el `caseId` como nombre de ejecución** — si EventBridge reintenta
   la entrega, Step Functions rechaza el duplicado por nombre repetido.

### Fase 1 — Registro (dentro de Step Functions)

`RenewOpenCaseLock` → `UpsertAnomalyCase` → `ClassifySeverity` (Choice):
- Sensor crítico → `DispatchAlertImmediate` (SNS) →
  `DispatchPushImmediate` (Pinpoint, si el deploy tiene push habilitado)
  → `PrepareEvidencePhase`. **Los familiares se enteran antes de que
  exista cualquier foto o análisis de IA.**
- Cualquier otro caso → directo a `PrepareEvidencePhase`.

Fallo técnico en cualquiera de las dos primeras tasks → `CaseRegistrationFailed` (Fail).

### Fase 2 — Evidencia puntual

`PrepareEvidencePhase` → `CheckCameraConsent` (lee `Devices.cameraConsent`,
booleano estricto) → `CameraConsentGranted?`:
- `false` → `MapToSkippedNoConsent` (`evidenceStatus: SKIPPED_NO_CONSENT`)
- `true` → `RequestEvidenceUpload` (`waitForTaskToken`, ~90s):
  1. Reserva una fila única en `EvidenceCallbacks` (PK `caseId`, SK fija
     `IMAGE_EVIDENCE` — un solo pedido de evidencia por caso).
  2. Firma una URL S3 `PutObject` (60s, `raw-images/{recipientId}/{caseId}/...`).
  3. Publica `UPLOAD_EVIDENCE` (`captureMode`: `BUFFERED` para anomalía
     visual — la Pi ya tiene el frame en su buffer de 10s — o `CURRENT`
     para anomalía de sensor, que no tiene foto asociada todavía).
  4. La Pi sube el frame; MQTT `evidence`/`command-acks` regresan por
     SQS a `commandAckHandlerFn`/`evidenceCallbackHandlerFn`, que
     validan `s3Key`/`imageId` exactos, tipo de contenido y tamaño antes
     de resolver el `taskToken`.
  - Catch en códigos cerrados conocidos (`CommandRejected`,
    `EvidenceUploadFailed`, objeto ausente/ inválido, o timeout) →
    `MapToIncomplete` (razón dinámica, pero de un conjunto cerrado).
  - Catch genérico (`States.ALL`) → `MapToError` (razón **fija**
    `INTERNAL_ERROR`, nunca el texto crudo de la excepción).
  - Éxito → `MapToAvailable`.

Los tres convergen en `RecordEvidenceOutcome` → `EvidenceAvailable?`:
- `AVAILABLE` → `AnalyzeEvidence`
- cualquier otro valor → **directo a `NotifyCaregiversIfNotAlready`** —
  la falta de evidencia nunca cierra el caso en silencio.

**La carrera resuelta aquí (para explicar si preguntan "¿qué pasa si el
Pi sube tarde?")**: `EvidenceCallbacks` es una máquina de estados con
*lease* exclusivo (`resolutionLeaseId` + expiración). Sólo quien tiene el
lease vigente puede resolver `PENDING/ACK_ACCEPTED → RESOLVING → RESOLVED`.
Si Step Functions ya tomó el timeout y la Pi sube después, el
`commandId`/`s3Key` ya fue "gastado" y una subida tardía nunca resucita
un caso ya decidido. `reconcileAfterWorkflowOutcome` es la autoridad
final e incondicional que sana cualquier fila huérfana, sin importar
quién tenía el lease.

### Fase 3 — Análisis con Bedrock

`AnalyzeEvidence`: revalida por regex que el `caseId`/`imageId`
embebidos en la propia `s3Key` coinciden con los del caso (nunca confía
ciegamente en su propio estado de ejecución) → lee la imagen de S3 →
`ConverseCommand` con un prompt de sistema fijo que exige JSON cerrado:
`personDetected`, `posture`, `riskIndicators` (enum cerrado),
`needsHumanReview`, `confidence`, `summary` (≤280 caracteres). Prohíbe
explícitamente diagnóstico médico y acusar a una persona identificable.
Una respuesta que no valide contra el schema local (Ajv) se trata como
`UNCERTAIN`, nunca como éxito forzado.

- Retry sólo en errores transitorios de Bedrock (throttling/timeout/
  no disponible), 3 intentos.
- 4 ramas de `Catch`, cada una con una razón **fija** distinta
  (`THROTTLED`/`MODEL_TIMEOUT`/`MODEL_UNAVAILABLE`/`INTERNAL_ERROR`) —
  nunca el texto crudo de la excepción hacia `AnomalyCases`/`EventLog`.

Todas las rutas convergen en `RecordAnalysisOutcome` → `NotifyCaregiversIfNotAlready`.

**Por qué la IA nunca puede bajar una severidad crítica de sensor:**
esta fase entera sólo escribe `analysisStatus`/`analysisRiskIndicators`/
etc. — nunca toca `severity` (fijado una sola vez, en la ingesta, por la
regla del sensor) ni `AnomalyCases.status` (el ciclo de vida de Step
Functions).

### Fase 4 — Notificación (red de seguridad + push)

`NotifyCaregiversIfNotAlready` es la **misma** `DispatchAlertFn` que la
Fase 1, invocada de nuevo — el `PutItem` condicional en `Alerts`
(`attribute_not_exists(caseId)`) garantiza que sólo **una** de las dos
invocaciones (la inmediata de sensor crítico, o esta red de seguridad al
final del tramo de evidencia) realmente publica a SNS. Si push está
habilitado, se encadena `DispatchPushIfNotAlready` justo después —
**secuencial, no paralelo**, y cualquier fallo de push (`States.ALL`)
cae igual hacia `RequestHumanDecision`: un push fallido nunca bloquea el
caso.

### Fase 5 — Espera de decisión humana

`RequestHumanDecision` (`waitForTaskToken`, timeout configurable, 300s
por defecto):
- Lee `AnomalyCases.humanDecision` en caliente. Si ya es
  `CANCELLED`/`ESCALATED` (porque `CANCEL_ALERT`/`ESCALATE` llegó
  *antes* de que la máquina entrara a este estado), resuelve su propio
  `taskToken` de inmediato — **nunca** deja un token huérfano en la
  tabla efímera `CaseActionCallbacks`.
- Si no hay decisión aún, persiste el `taskToken` en
  `CaseActionCallbacks` (PK `caseId`, SK `callbackType`, TTL) y espera.
- `POST /cases/{caseId}/cancel` / `.../escalate` (autenticados por JWT +
  `CaregiverAccess`) resuelven ese callback dentro de la **misma**
  transacción atómica (`TransactWriteItems`) que escribe
  `AnomalyCases.humanDecision` + `Alerts` — nunca en dos pasos separados
  que podrían quedar a medias.
- Catch (`States.ALL`, incluye `States.Timeout`) → `MapToHumanDecisionTimeout`
  (`decision: TIMEOUT`) — un timeout y un error técnico van al **mismo**
  destino a propósito: nunca "seguro por defecto".

`HumanDecisionMade?` (Choice):
- `CANCELLED` → `CaseResolvedByCancel` (Succeed). Fin del caso.
- Cualquier otro valor (`ESCALATED` o `TIMEOUT`) →
  `ReconcileHumanDecisionCallback` (limpia cualquier fila de callback
  vencida, sin bloquear el avance si falla) → `EscalationPolicy`.

**El `taskToken` nunca sale de `CaseActionCallbacks`**: nunca se copia a
`AnomalyCases`, `EventLog`, `Alerts` ni al estado propio de la ejecución.

### Fase 6 — EscalationPolicy (determinista, sin permisos de Connect)

Evalúa, en orden, y bloquea en el primer punto que falle (código cerrado
propio, nunca continúa "por si acaso"):

1. El caso existe y `humanDecision !== CANCELLED` (releído en caliente).
2. `HUMAN_NOTIFICATION_CHANNEL_CONFIRMED === true` — **`false` por
   defecto**. Mientras lo sea, bloquea siempre con
   `NO_ACTIVE_HUMAN_NOTIFICATION_CHANNEL`, sin importar que el correo o
   el push ya se hayan enviado. **Confirmado explícitamente**: el push
   de Pinpoint **no** mueve este gate — son mecanismos completamente
   independientes; el equipo decidió a propósito no auto-confirmar el
   canal humano sólo porque un `sns:Publish`/push fue aceptado, porque
   eso no prueba que un familiar lo leyó.
3. `notificationStatus === PUBLISHED` para este caso específico.
4. Riesgo elegible: sensor `severity: critical`, o visual
   `POSSIBLE_FALL`/`PERSON_PRONE_INACTIVE`. `UNEXPECTED_PERSON`,
   `CAMERA_TAMPERED` y sensores no críticos quedan excluidos por
   defecto.
5. `Devices.fallbackCallConsent === true` (booleano estricto).
6. `deviceId` en la allowlist de escalamiento.
7. Reclamo atómico de `dialStatus = DIALING` — ver la carrera crítica
   abajo.

### Fase 7 — EmergencyDialer y cierre

`EscalationAllowed?` (Choice): `allowed: true` → `EmergencyDialer`
(la única Lambda con `connect:StartOutboundVoiceContact`; lee el número
de un solo parámetro SSM `SecureString`, nunca lo loguea ni lo retorna;
`ClientToken: caseId` como idempotencia nativa de Connect) →
`RecordCallOutcome` (audita `CALLED`/`FAILED`, sin ningún permiso
Connect/SSM/KMS) → `CaseEscalationComplete` (Succeed).
`allowed: false` (o un error técnico de invocación) → `CaseEscalatedBlocked`
(Succeed) — **nunca** "permitido por defecto" ante un fallo técnico.

**La carrera crítica más importante para explicar bien**: `CANCEL_ALERT`
y `EscalationPolicy` compiten por el **mismo** ítem de `AnomalyCases`
con condiciones simétricas:
- `CANCEL_ALERT` sólo puede escribir `humanDecision = CANCELLED` si
  `dialStatus` **no** es ya `DIALING`/`CALLED`.
- `EscalationPolicy` sólo puede reclamar `dialStatus = DIALING` si
  `humanDecision` **no** es ya `CANCELLED`.

Exactamente uno de los dos gana. Si `EscalationPolicy` gana primero, un
`CANCEL_ALERT` posterior recibe `409 CALL_ALREADY_IN_PROGRESS` — la API
nunca finge haber cancelado una llamada que ya empezó.

---

## 4. Modelo de datos (DynamoDB, consolidado)

| Tabla | Clave | Campos clave / notas |
| --- | --- | --- |
| `Devices` | `deviceId` | `recipientId`, `lastSeenAt`, `cameraConsent` (bool estricto), `fallbackCallConsent` (bool estricto) — ambos consentimientos son campos independientes. |
| `Telemetry` | `deviceId` / `occurredAtEventId` | TTL de retención. |
| `OpenCaseLocks` | `recipientId#anomalyType` | Candado de dedup, TTL ~2h. |
| `AnomalyCases` | `caseId` | Ver desglose de campos abajo. GSI `AnomalyCasesByDevice` (PK `deviceId`, SK `createdAt`) para `GET /cases`. |
| `EventLog` | `caseId` / `occurredAtEventId` | Auditoría de todo: decisiones, bloqueos, llamadas — nunca imágenes/audio/`taskToken`. |
| `EvidenceCallbacks` | `caseId` / `callbackType` (fijo `IMAGE_EVIDENCE`) | Máquina de estados con lease para el pedido de evidencia. |
| `Observations` | `caseId` / `imageId` | Resultado narrativo de Bedrock, TTL 7 días (mismo ciclo que la foto en S3). |
| `Alerts` | `caseId` | `notificationStatus`, `notifiedCaregiverIds`, `snsMessageId?`. |
| `AlertDeliveries` | `caseId` / `deliveryId` | Fila `CLAIM` (dedup del intento de push) + filas `PUSH#{userId}#{endpointId}` con `status`. |
| `CaregiverAccess` | `userId` / `deviceId` | Autorización familiar↔dispositivo. GSI `CaregiverAccessByDevice`. |
| `CaregiverPushEndpoints` | `userId` / `endpointId` | Registro de dispositivo Android para push (Pinpoint). |
| `CaseActionCallbacks` | `caseId` / `callbackType` | **Efímera** (TTL): único lugar donde vive el `taskToken` de la espera humana. |

**`AnomalyCases` — por qué 3 campos separados y no uno solo**
(`notificationStatus`/`humanDecision`/`dialStatus`, en vez de un
`alertStatus` genérico): un `sns:Publish` exitoso sólo prueba que SNS
aceptó el mensaje, nunca que un familiar lo leyó, ni que hubo una
llamada. Mezclar los tres en un campo habría permitido, por ejemplo, que
un envío de correo exitoso se confundiera con una decisión humana real.
Campos: `severity?`, `notificationStatus` (`PENDING/PUBLISHED/FAILED`),
`humanDecision` (`CANCELLED/ESCALATED`, + `cancelledAt/cancelledBy/
escalatedAt/escalatedBy`), `dialStatus` (`DIALING/CALLED/BLOCKED/FAILED`,
+ `dialingClaimedAt/calledAt/connectContactId/dialBlockedReason/
dialFailedReason`), `evidenceStatus`, `analysisStatus` y derivados. Nunca
`status` (el ciclo de vida propio de Step Functions) es tocado por
ninguna acción humana ni por el escalamiento.

---

## 5. Contratos MQTT

| Topic | Dirección | Propósito |
| --- | --- | --- |
| `SenseCare/v1/devices/{deviceId}/telemetry` | Pi → nube | Lecturas de sensores consolidadas. |
| `SenseCare/v1/devices/{deviceId}/visual/anomaly` | Pi → nube | Candidato visual, **sin imagen**. |
| `SenseCare/v1/devices/{deviceId}/sensor/anomaly` | Pi → nube | Anomalía de sensor sostenida/crítica. |
| `SenseCare/v1/devices/{deviceId}/status` | Pi → nube | Heartbeat cada 60s (salud, nunca IP/secretos/audio). |
| `SenseCare/v1/devices/{deviceId}/commands` | nube → Pi | P. ej. `UPLOAD_EVIDENCE`. |
| `SenseCare/v1/devices/{deviceId}/command-acks` | Pi → nube | Ack/resultado de un comando. |
| `SenseCare/v1/devices/{deviceId}/evidence` | Pi → nube | Confirmación de subida de evidencia. |

ESP32 → Pi es **local** (serial/Wi-Fi), nunca toca AWS ni guarda
credenciales. La Pi es el único gateway cloud: un certificado X.509 por
`deviceId`, política IoT sin comodines globales (Connect/Publish/
Subscribe/Receive acotados a los topics de su propio dispositivo).

---

## 6. Detección en el edge (Raspberry Pi)

`RiskFusionEngine` (`edge/src/SenseCare_edge/risk_fusion.py`) — 5 tipos
de anomalía visual, todos con umbral de confianza, cooldown y validación
de esquema antes de publicar:

| Tipo | Lógica (resumen) |
| --- | --- |
| `POSSIBLE_FALL` | Transición confirmada de pie → ráfaga corta (≤1s) de ≥2 frames consecutivos tumbado. |
| `PERSON_PRONE_INACTIVE` | Postura tumbada continua ≥12s (una lectura `unknown` no reinicia la racha). |
| `UNEXPECTED_PERSON` | Sólo si el sistema está "armado" y la persona está en una zona de la allowlist. |
| `POSSIBLE_SMOKE_OR_FIRE` | **Deshabilitado por defecto** — sin modelo TFLite validado. |
| `CAMERA_TAMPERED` | Salud de cámara no saludable ≥5s (confianza fija 1.0 — heurística, no ML). |

Sensores (`sensor_rules.py`): `POOR_AIR_QUALITY` (CO₂ sostenido,
siempre `warning`) y `TEMPERATURE_ALERT` (`critical` si excede el
umbral+10°C). Estos 5 nombres de anomalía visual son exactamente los
que `EscalationPolicy` conoce — por eso `UNEXPECTED_PERSON`/
`CAMERA_TAMPERED` quedan fuera del fallback automático por diseño, no
por omisión.

**Limitación de demo documentada explícitamente**: `UPLOAD_EVIDENCE` no
lleva el `eventId` original, sólo `caseId` — si hubiera más de una
anomalía visual pendiente de evidencia a la vez, la Pi no podría
distinguir cuál pidieron. Mitigación: sólo se permite **una** reserva de
evidencia visual a la vez (TTL configurable); cualquier otra anomalía
durante esa ventana se suprime (no se publica, no se fija el frame) en
vez de arriesgar entregar la imagen equivocada a un caso.

---

## 7. Reglas de seguridad no negociables (y el porqué)

| Regla | Por qué |
| --- | --- |
| Nunca 911 ni servicios públicos de emergencia | Es un demo de hackathon; una llamada real a emergencias sería tanto ilegal/peligrosa como una falsa alarma para un servicio real. `EmergencyDialer` sólo puede marcar un destino fijado a mano en SSM. |
| El LLM (Bedrock) nunca tiene permiso IAM de Connect, no puede cerrar/escalar un caso ni bajar una severidad crítica | Un modelo puede alucinar o ser manipulado por texto adversarial en un contexto médico; la decisión de llamar a alguien nunca debe depender de la salida no verificada de un LLM. |
| Sólo `CANCEL_ALERT` de un familiar autorizado detiene el fallback; una respuesta de voz es evidencia, no cierre | Evita que una respuesta ambigua ("estoy bien" mal transcrita, o silencio interpretado como "ok") cierre un caso de riesgo real sin que un humano lo haya decidido explícitamente. |
| Step Functions Standard es el único orquestador de plazos/callbacks | Si el timeout dependiera de un cronjob externo o de que Bedrock respondiera, un fallo de esos componentes podría dejar un caso de riesgo sin resolución nunca. |
| El `taskToken` nunca sale de la tabla efímera de callbacks | Un token de Step Functions filtrado a logs/API podría permitir a alguien no autorizado resolver la espera de otro caso. |
| Ningún secreto (número de teléfono, credenciales) en Git/CDK/logs | El repositorio es público/compartido; un número de teléfono real o una credencial en el historial de Git es irreversible. |
| Mínimo privilegio IAM: sin `Action:"*"`, sin `s3:*`, sin `AdministratorAccess`; excepciones documentadas una por una | Reduce el radio de explosión de cualquier Lambda comprometida a exactamente lo que necesita, ni un permiso más. |
| No hay video/audio continuo en AWS; sólo un frame puntual tras anomalía + consentimiento | Es la promesa central de privacidad del producto: "no convertir el hogar en un sistema de vigilancia continua". |

---

## 8. IAM — mínimo privilegio, Lambda por Lambda (lo que un jurado técnico probablemente pida ver)

| Lambda | Permisos (resumen) | Nunca tiene |
| --- | --- | --- |
| Ingesta (telemetría/anomalías) | DynamoDB acotado a sus tablas, `events:PutEvents` al bus exacto | S3, Bedrock, Connect |
| `requestEvidenceUploadFn` | `s3:PutObject` sólo en `raw-images/*`, `iot:Publish` sólo en el sufijo `/commands` | Connect, Bedrock |
| `analyzeEvidenceFn` | `s3:GetObject` en `raw-images/*`, `bedrock:InvokeModel` acotado al perfil de inferencia + modelos, con condición `InferenceProfileArn` | `AnomalyCases`, Connect |
| `dispatchAlertFn` | `sns:Publish` al ARN exacto del topic, `dynamodb:Query` sólo al GSI `CaregiverAccessByDevice` | S3, Bedrock, Connect |
| `dispatchPushFn` | `mobiletargeting:SendMessages` acotado a **una** app de Pinpoint, DynamoDB acotado | Connect, SSM, KMS |
| `requestHumanDecisionFn` | `states:SendTaskSuccess` (única acción sin soporte de permisos a nivel de recurso ⇒ `Resource:"*"` documentado) | Connect |
| `escalationPolicyFn` | DynamoDB (AnomalyCases/Devices/EventLog) | **Cero** permisos `connect:`/`ssm:`/`kms:` — verificado con una prueba dedicada |
| `emergencyDialerFn` | `ssm:GetParameter` al ARN exacto de un parámetro, `kms:Decrypt` a su CMK propia, `connect:StartOutboundVoiceContact` (única excepción con `Resource:"*"`, esa acción no admite scoping) | Acceso directo a `AnomalyCases`/`EventLog` |
| `recordCallOutcomeFn` | DynamoDB (AnomalyCases/EventLog) | Connect, SSM, KMS |

Hay una prueba de infraestructura dedicada que falla si *cualquier*
Lambda del sistema, aparte de `emergencyDialerFn`, tuviera algún permiso
`connect:` — esto es lo primero que enseñaría si preguntan "¿cómo saben
que sólo esa Lambda puede llamar?".

---

## 9. Estrategia de pruebas (para cuando pregunten "¿cómo lo probaron?")

- **432 pruebas automatizadas** en 67 archivos (`npx vitest run`), más
  una suite de Python independiente para el edge (`edge/tests/`, sin
  dependencias de hardware ni red — usan dobles/fakes de las
  interfaces de cámara/MQTT/reloj).
- `cdk synth --strict --no-lookups` limpio: valida que la síntesis de
  CloudFormation no tiene advertencias ni construcciones inseguras.
- `tsc --noEmit` limpio en cada paquete (`infra`, `services/*`).
- Patrones de prueba reutilizados en todo el proyecto:
  - **Condiciones atómicas de DynamoDB** probadas simulando la
    excepción `ConditionalCheckFailedException` con `aws-sdk-client-mock`.
  - **Cold-start de Lambda**: `vi.resetModules()` + `import()` dinámico
    para probar que un módulo de configuración no explota si le falta
    una variable de entorno que esa Lambda en particular nunca recibe
    (bug real detectado y corregido dos veces en este proyecto).
  - **IAM por Lambda**: se localiza el `AWS::IAM::Role` propio de cada
    función (por su `FunctionName`) y se afirma la lista exacta de
    acciones permitidas — no sólo "algo de DynamoDB", sino la acción y
    el recurso exactos.
  - **Máquina de estados**: el `DefinitionString` de Step Functions se
    reconstruye desde el `Fn::Join` sintetizado y se parsea como JSON
    para afirmar transiciones (`Next`), catches y timeouts exactos —
    sin desplegar nada.
- Escenarios explícitamente cubiertos (mencionar si preguntan por
  "casos límite"): telemetría sana nunca sube evidencia; anomalías
  duplicadas generan un solo caso; ausencia de evidencia produce
  incertidumbre (nunca "sano" por defecto); `CANCEL_ALERT` detiene el
  fallback tanto antes como durante la espera; el timeout siempre llega
  a la política; consentimiento/allowlist/riesgo inválidos bloquean la
  llamada; un `caseId` repetido nunca genera una segunda llamada; el
  `taskToken` nunca aparece en logs/EventLog/AnomalyCases/estado.

---

## 10. Costos y despliegue

Ver `docs/AWS_COST_ESTIMATE.md` para el detalle reproducible. Puntos
clave para la defensa: arquitectura *pay-per-request* (SQS, DynamoDB,
Lambda) — sin servidores encendidos permanentemente salvo la instancia
de Connect (que se paga por uso de llamada, no por hora). El feature de
push es **opcional en tiempo de deploy**: sin credencial de Firebase,
CDK omite por completo las tablas/rutas/Lambdas de push en vez de
desplegar algo que fallaría en cada llamada.

---

## 11. Fallas/gaps conocidos (mejor decirlos tú antes de que los encuentren)

1. **`GET /cases` devuelve `alertStatus` siempre `undefined`.** El GSI
   `AnomalyCasesByDevice` proyecta un atributo `alertStatus` que ya no
   se escribe en ningún lado desde el rediseño de campos del hito de
   escalamiento (ahora se escribe `notificationStatus`/`humanDecision`/
   `dialStatus`). Es un gap de integración real entre dos ramas de
   trabajo en paralelo (push notifications y escalamiento), no un error
   de ninguna de las dos por separado. **Arreglo**: renombrar el
   atributo proyectado y el campo del handler a los 3 campos reales.
   Trivial, pendiente.
2. **`Pi temperature` no está en el heartbeat** `status` — roadmap del
   edge, no bloqueante.
3. **Adaptador de cámara real (CSI/USB) del edge no implementado** —
   sólo `FixtureFrameSource` (carpeta de imágenes fijas) para pruebas y
   demo con animación en pantalla.
4. **`AWS::Pinpoint::App`/`CfnGCMChannel` están en ruta de deprecación**
   de AWS (retiro anunciado 30-oct-2026) — seguro para el timeline del
   hackathon, documentado en código como necesidad de migración futura
   a "AWS End User Messaging Push".
5. **El valor real del número de fallback y la instancia de Connect
   nunca se han aprovisionado** — es intencional (paso manual, ver
   `EMERGENCY_CALL_RUNBOOK.md`), pero significa que el flujo de llamada
   real end-to-end sólo se ha probado con `cdk synth`/tests, no con una
   llamada real todavía.
6. **`OpenCaseLocks` no se renueva mientras el caso sigue abierto** (el
   candado sólo se toma una vez, al abrir) — roadmap de Hito 4.
7. **`deviceWatchdog`** (detección de Pi desconectada) no existe.

---

## 12. Preguntas probables del jurado (y cómo responderlas)

**"¿Por qué Step Functions y no sólo Lambdas encadenadas con SQS?"**
Porque necesitamos plazos/timeouts durables (horas), un `waitForTaskToken`
nativo para pausar hasta que un humano responda, e historial de
ejecución auditable para depurar el demo en vivo. Encadenar SQS/Lambda a
mano reimplementaría mal un orquestador con estado.

**"¿Qué pasa si Bedrock está caído o tarda demasiado?"**
Retry acotado a errores transitorios; si aun así falla, el catch
converge a un resultado `UNCERTAIN`/`INTERNAL_ERROR` (nunca "todo bien
por defecto") y el flujo sigue igual hacia la notificación humana — la
seguridad del sistema nunca depende de que la IA responda.

**"¿Cómo evitan que la IA decida hacer una llamada?"**
Arquitectónicamente: Bedrock corre en `analyzeEvidenceFn`, que no tiene
ningún permiso IAM de Connect ni de escritura sobre `humanDecision`/
`dialStatus`. La única Lambda que puede llamar (`emergencyDialerFn`) ni
siquiera recibe la salida de Bedrock como entrada — sólo un `caseId`.
Hay una prueba de infraestructura que falla si esto cambiara.

**"¿Qué pasa si dos personas cancelan y escalan al mismo tiempo?"**
Ambas rutas usan `TransactWriteItems` con `ConditionExpression`
(`attribute_not_exists(humanDecision)`), así que exactamente una gana;
la otra recibe `409` con el estado real vigente, nunca un "200 falso".

**"¿Y si `CANCEL_ALERT` llega justo cuando ya está marcando el
teléfono?"** Ver §3 Fase 7 — condiciones simétricas sobre el mismo
ítem de DynamoDB garantizan que exactamente una de las dos transiciones
gane; la API nunca finge haber cancelado una llamada ya iniciada
(`409 CALL_ALREADY_IN_PROGRESS`).

**"¿Por qué separaron `notificationStatus`/`humanDecision`/`dialStatus`
en vez de un solo campo?"** Ver §4 — mezclar "SNS aceptó el mensaje"
con "un familiar decidió algo" habría permitido a `EscalationPolicy`
malinterpretar un envío de correo exitoso como una alerta humana
efectiva.

**"¿Por qué el fallback de llamada está bloqueado por defecto incluso
con todo configurado?"** El gate `HUMAN_NOTIFICATION_CHANNEL_CONFIRMED`
es una decisión deliberada: mientras no exista una confirmación humana
de que un canal de notificación (correo o push) realmente llega y se
lee, el sistema nunca activa el camino automático de llamada real. Es
una elección de "fallar cerrado", no un bug.

**"¿Qué garantiza que nunca se llama dos veces al mismo caso?"** Dos
capas independientes: (1) el reclamo atómico de `dialStatus=DIALING` en
DynamoDB — sólo el primero en reclamar procede; (2) `ClientToken: caseId`
en la llamada a Connect, idempotencia nativa del lado de AWS.

**"¿Cómo se prueba todo esto sin desplegar de verdad?"** `aws-cdk-lib/
assertions` sintetiza la plantilla de CloudFormation en memoria; se
reconstruye el JSON de la máquina de estados y se afirman transiciones/
catches/IAM exactos — 432 pruebas corren en segundos/minutos sin tocar
una cuenta AWS real.

**"¿Qué falta para que esto sea producción real?"** Aprovisionar Connect
de verdad, un adaptador de cámara real en el edge, `deviceWatchdog`,
renovar `OpenCaseLocks` mientras el caso sigue abierto, arreglar el gap
de `alertStatus` en `GET /cases`, y — la más importante — sustituir el
número/consentimiento de demo por un flujo real de alta de familiares y
verificación de consentimiento desde una app, que está explícitamente
fuera de alcance del hackathon.

---

## 13. Glosario rápido de nombres exactos (para no trabarse en vivo)

- **Lambdas de escalamiento**: `RequestHumanDecisionFn`,
  `ReconcileHumanDecisionFn`, `EscalationPolicyFn`, `EmergencyDialerFn`,
  `RecordCallOutcomeFn`.
- **Estados clave de Step Functions**: `ClassifySeverity`,
  `CheckCameraConsent`, `EvidenceAvailable?`, `HumanDecisionMade?`,
  `EscalationAllowed?`, `CaseResolvedByCancel`, `CaseEscalatedBlocked`,
  `CaseEscalationComplete`.
- **Tablas efímeras (nunca contienen datos permanentes)**:
  `OpenCaseLocks`, `EvidenceCallbacks`, `CaseActionCallbacks`.
- **Env vars sensibles nunca commiteadas**: `FALLBACK_CALL_DESTINATION_PARAMETER_NAME`
  (nombre, no valor — el valor va por SSM SecureString+CMK),
  `FCM_SERVICE_ACCOUNT_JSON`, `CONNECT_INSTANCE_ID/CONTACT_FLOW_ID/
  SOURCE_PHONE_NUMBER`.
- **El único gate manual que hay que recordar mencionar**:
  `HUMAN_NOTIFICATION_CHANNEL_CONFIRMED` — `false` por defecto, bloquea
  siempre el fallback automático hasta confirmación manual del operador.

---

*Fuentes primarias si necesitas profundizar en vivo:
`docs/ARCHITECTURE_DETAILED.md`, `docs/EMERGENCY_CALL_RUNBOOK.md`,
`docs/ALERTS_AND_CASE_ACTIONS_RUNBOOK.md`, `docs/IMPLEMENTATION_ROADMAP.md`,
`docs/EDGE_IMPLEMENTATION_GUIDE.md`, `edge/README.md`.*
