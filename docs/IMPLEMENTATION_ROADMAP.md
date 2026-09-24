# SenseCare — roadmap de implementación y despliegue para el demo

Este plan entrega primero un flujo completo, demostrable y seguro: una anomalía visual **o de sensor** detectada en la Raspberry Pi (o emitida por el simulador web autorizado) abre un caso, obtiene evidencia puntual, avisa a familiares y, si ninguno cancela la alerta dentro del plazo, realiza una llamada al número de prueba autorizado. No se llama al 911 ni se realizan llamadas a números que no hayan sido autorizados explícitamente.

El plan asume la arquitectura definida en [ARCHITECTURE.md](ARCHITECTURE.md): ESP32 → Raspberry Pi 4B → AWS IoT Core → procesamiento y orquestación en AWS. La Pi conserva el video localmente; AWS recibe sólo un frame asociado a una anomalía y los datos de sensores necesarios para investigarla.

## Definición de «listo para demo»

El demo está listo cuando, con la Pi, cámara y ESP32 reales (o con el simulador de respaldo), se puede completar esta secuencia sin intervención técnica:

1. La visión local o las reglas de sensores detectan una anomalía y publican un evento; el simulador web puede reproducir el mismo contrato de forma autenticada.
2. El backend crea **un solo** caso para ese incidente y pide a la Pi la evidencia puntual.
3. La Pi sube el frame privado usando una URL prefirmada; Bedrock devuelve una evaluación estructurada.
4. La Pi formula un check-in por bocina y SNS informa a todos los familiares autorizados.
5. Una cancelación explícita, enviada mediante la API/CLI de demo por un familiar de prueba autorizado, cierra el flujo de fallback.
6. Si nadie cancela antes del plazo de demo, una política determinista valida el caso y Amazon Connect Customer llama únicamente al teléfono de prueba permitido.
7. La API y `EventLog` exponen el estado y la línea de tiempo del caso para la demostración técnica.

La respuesta de voz de la persona es evidencia para el análisis y se registra en el caso, pero en el MVP **no cancela por sí sola** la llamada automática. La decisión final de detener el fallback corresponde a un familiar autorizado mediante la acción explícita `CANCEL_ALERT`. Esto evita que una interpretación errónea de voz o del LLM cierre un caso de riesgo.

## Alcance controlado del demo

Para asegurar un flujo creíble antes de ampliar capacidades, el demo implementa candidatos visuales priorizados: `POSSIBLE_FALL`/`PERSON_PRONE_INACTIVE`, `UNEXPECTED_PERSON`, `POSSIBLE_SMOKE_OR_FIRE` y `CAMERA_TAMPERED`; además de un conjunto reducido de anomalías de sensores: `POOR_AIR_QUALITY`, `TEMPERATURE_ALERT`, `SENSOR_FAULT` y, sólo si hay sensor específico, `POSSIBLE_CO_EXPOSURE`, `POSSIBLE_GAS_LEAK` o `POSSIBLE_FIRE`. Los candidatos no son diagnósticos ni acusaciones.

La animación se reproduce en una pantalla y es vista por la cámara real de la Pi. Por lo tanto, el demo de animación usa la misma inferencia, fusión temporal, MQTT y flujo cloud que la habitación física. El simulador web sólo puede inyectar telemetría/anomalías de sensores cuando se requiera probar escenarios no físicos.

CO₂ se usa como señal de ventilación, no para afirmar incendio, CO o fuga de gas. No se usa llama, fuga ni combustión real para las pruebas: escenarios de fuego/intoxicación se representan mediante animación en pantalla observada por la cámara, y cualquier sensor físico se prueba conforme a su fabricante. Ningún sensor del prototipo se presenta como alarma certificada.

Se posponen para después del hackathon: reconocimiento facial, identificación de voz, sugerencias automáticas de perfil médico, video/audio continuo en la nube, diagnóstico médico y llamadas a servicios públicos de emergencia.

## Decisiones de implementación

| Decisión | Aplicación en el demo |
| --- | --- |
| Infraestructura | AWS CDK con TypeScript, un stack `SenseCareDemoStack` para reducir fricción. Separar datos y aplicación sólo si el equipo necesita conservar recursos entre despliegues. |
| Orquestación | AWS Step Functions **Standard**, una ejecución por `caseId`; requiere callbacks, esperas durables y trazabilidad visible. |
| Detección inicial | Modelo de visión ligero y motor local de reglas de sensores en Raspberry Pi. Ambos pueden abrir/reutilizar un caso; cada uno aporta contexto al otro. |
| Dos demos, un backend | La Pi física publica MQTT con certificado X.509. La animación se ve por su cámara y usa ese mismo camino visual; el simulador web usa API autenticada sólo para telemetría/anomalías de sensores, con allowlist de `deviceId` demo. |
| Evidencia | La Pi conserva el frame en memoria/búfer local y lo sube a S3 sólo después de recibir `UPLOAD_EVIDENCE` para un `caseId`. |
| Cierre y fallback | Sólo `CANCEL_ALERT` de un familiar autorizado evita el fallback. El timeout siempre alcanza `EscalationPolicy`, incluso si Bedrock o una Lambda fallan. |
| Telefonía | Amazon Connect Customer (Voice), con un destino de demo en lista permitida y una prueba de llamada antes del ensayo. |
| Operación mínima | DLQ para mensajes críticos y una alarma DLQ → SNS. No se construye dashboard operativo de CloudWatch para el MVP. |

## Orden de trabajo

### Hito 0 — Preparar cuentas, dispositivos y límites de seguridad

**Objetivo:** eliminar bloqueos externos antes de escribir lógica de negocio.

- Elegir una sola región AWS que tenga acceso al modelo de Bedrock elegido y donde se cree la instancia de Amazon Connect Customer.
- Solicitar/habilitar acceso al modelo de Bedrock y registrar su `modelId` como configuración, no en código.
- Crear la instancia de Connect, reclamar/configurar el número de origen necesario y crear un contacto de voz que anuncie claramente: «llamada de demostración SenseCare». Permitir únicamente el número celular de prueba del equipo.
- Establecer un presupuesto y alerta de costo para la cuenta de demo.
- Preparar la Raspberry Pi 4B: fuente de alimentación estable, cámara, micrófono, bocina, red Wi-Fi y almacenamiento suficiente. Verificar que el ESP32 transmite telemetría localmente por serial, HTTP o MQTT local, y acordar qué sensores físicos son sólo contexto y cuáles pueden emitir anomalías.
- Crear una cuenta de prueba por rol: persona monitoreada, dos familiares y administrador. Nunca usar datos médicos reales en el demo.
- Crear certificados X.509 por Raspberry Pi/Thing. Las llaves privadas no se guardan en Git ni se incluyen en capturas de pantalla.
- Entregar a quien implemente edge la [guía detallada de Raspberry Pi y ESP32](EDGE_IMPLEMENTATION_GUIDE.md) y acordar `deviceId`, cámara, enlace ESP32 y responsable de las credenciales mediante un canal privado.

**Criterio de salida:** la Pi puede leer cámara/sensores, reproducir y captar un check-in; una llamada manual de Connect llega al teléfono autorizado; Bedrock responde a una invocación de prueba.

### Hito 1 — Contratos, simulador y datos de prueba

**Objetivo:** que hardware, cloud y los clientes futuros se integren con mensajes estables.

Definir JSON Schema y pruebas de validación para, como mínimo:

```json
{
  "eventId": "uuid",
  "eventType": "VISUAL_ANOMALY",
  "deviceId": "pi-demo-01",
  "recipientId": "recipient-demo-01",
  "occurredAt": "2026-09-23T18:00:00Z",
  "anomalyType": "POSSIBLE_FALL",
  "confidence": 0.86,
  "localVision": {
    "modelVersion": "local-v1",
    "personPresent": true,
    "motionAfterSeconds": 12
  },
  "sensors": { "temperatureC": 25.1, "co2Ppm": 720 }
}
```

También definir:

- Telemetría auxiliar con `eventId`, `occurredAt` generado por dispositivo y versión de esquema.
- Anomalía de sensores con `eventType: SENSOR_ANOMALY`, `anomalyType`, `severity`, versión de regla, ventana de lecturas y contexto; sin foto/audio en el payload.
- Candidato visual con `anomalyType`, `confidence`, lista de `candidates`, evidencia temporal (zona, postura, inmovilidad/conteo) y versiones de modelo; sin frame/video en el payload.
- Comando MQTT `UPLOAD_EVIDENCE` con `caseId`, `s3Key`, URL prefirmada y fecha de expiración.
- `COMMAND_ACK` y `EVIDENCE_UPLOADED` con el mismo `caseId`.
- Respuestas de familiares: `CANCEL_ALERT` y `ESCALATE`; ambas autenticadas y auditadas.
- Resultado estructurado de Bedrock: severidad, hipótesis, evidencia, acción recomendada y confianza. No puede devolver una instrucción de telefonía ejecutable.

Crear un simulador de Pi que publique telemetría, anomalías visuales y de sensores, atienda `UPLOAD_EVIDENCE` y suba una imagen de prueba. Para el demo visual, preparar animaciones reproducibles en una pantalla observada por la cámara real, no inyección de eventos. El adaptador HTTPS del simulador web queda limitado a telemetría/anomalías de sensores y valida los mismos schemas antes de insertarlos en la misma SQS; el navegador no recibe certificado IoT de la Pi.

**Criterio de salida:** pruebas automatizadas rechazan mensajes incompletos; el simulador puede completar un intercambio MQTT + carga S3 sin hardware.

### Hito 2 — Infraestructura reproducible con CDK

**Objetivo:** levantar el entorno completo desde código, sin clics manuales salvo los requisitos inevitables de cuenta/Connect.

Implementar inicialmente un solo stack CDK con estos grupos de recursos:

| Grupo | Recursos y configuración esencial |
| --- | --- |
| Dispositivo | AWS IoT Core Thing, certificado y política por dispositivo. La política limita `Connect`, `Publish`, `Subscribe` y `Receive` a los topics de su propio `deviceId`; no usa comodines globales. |
| Ingesta | IoT Rules separadas para telemetría, anomalía visual, anomalía de sensor, acknowledgements y evidencia. Telemetría/anomalías tienen SQS y DLQ; Lambdas consumen con `ReportBatchItemFailures`. |
| Datos | DynamoDB para `Devices`, `AnomalyCases`, `OpenCaseLocks`, `CaregiverAccess`, `Consent`, `EventLog` y estado de callbacks. La creación del lock es condicional por `recipientId#anomalyType`. |
| Evidencia | Bucket S3 privado, cifrado, bloqueo de acceso público, claves `raw-images/{recipientId}/{caseId}/{imageId}.jpg` y ciclo de vida de siete días. |
| Orquestación | Bus/rules de EventBridge y máquina Step Functions Standard. Cada caso conserva sólo referencias S3, nunca bytes de imagen/audio en el estado. |
| Control de demo | API Gateway, Cognito y Lambdas API mínimas para consultar estado/telemetría/casos, enviar `CANCEL_ALERT`/`ESCALATE` y aceptar eventos del simulador web. No se implementa aplicación familiar. |
| Notificación y llamada | SNS para avisos y Amazon Connect Customer para el fallback. El número de destino permitido se almacena como parámetro/secret seguro, nunca en el repositorio. |
| Fallas críticas | DLQ y alarma mínima que publica en SNS si una cola recibe mensajes fallidos. |

Usar etiquetas de costo como `Project=SenseCare`, `Environment=demo` y `Owner=<equipo>`. Configurar retención corta y política de eliminación sólo para evidencia; no borrar historial funcional necesario para el demo.

Secuencia de despliegue:

```bash
aws login
cdk bootstrap aws://ACCOUNT_ID/REGION
npm ci
npm test
npx cdk synth --strict
npx cdk diff SenseCareDemoStack
npx cdk deploy SenseCareDemoStack
```

Se revisa el resultado de `cdk diff` antes de cada despliegue. El despliegue final no usa hotswap ni cambios manuales no documentados. Los identificadores que Connect no pueda crear por CDK se guardan como parámetros explícitos de stack y se anotan en el runbook.

**Criterio de salida:** un entorno nuevo se despliega desde un clon limpio; una Pi con certificado válido se conecta y un certificado ajeno no puede publicar en sus topics.

### Hito 3 — Gateway Raspberry Pi y ESP32

**Responsable externo / entregable de integración:** este hito no lo implementa el responsable de backend. Quien se encargue de hardware debe seguir la [guía edge](EDGE_IMPLEMENTATION_GUIDE.md), que detalla instalación de Pi, configuración de cámara/audio/ESP32, servicio systemd, MQTT TLS, privacidad, pruebas y entrega. Debe implementar `RiskFusionEngine` para pose/inmovilidad, persona/zona, salud de cámara y, si se consigue un modelo compatible, humo/fuego.

El equipo backend debe proporcionarle: `deviceId`, endpoint IoT, certificado X.509 y CA mediante canal privado, topics definitivos, schemas y un entorno `demo`. El responsable edge debe devolver: versión de gateway/modelos/reglas de sensores, pruebas de cámara/ESP32/MQTT, métricas de FPS/latencia/temperatura, ejemplos de cada candidato visual y un gateway o simulador que complete `UPLOAD_EVIDENCE`.

**Criterio de salida:** no existe video continuo ni imagen en AWS durante operación saludable; una anomalía real o simulada sube sólo un frame asociado a un caso y pasa las pruebas de aceptación de la guía edge.

### Hito 4 — Casos, evidencia y orquestación durable

**Objetivo:** implementar la vida completa de un incidente y sus plazos.

1. `anomalyProcessor` valida un evento visual o de sensor y adquiere condicionalmente `OpenCaseLock`. Si ya hay un caso abierto, añade evidencia al existente en vez de abrir otro.
2. Crea `AnomalyCase`, escribe `EventLog` y publica `CaseOpened` a EventBridge.
3. EventBridge inicia una ejecución Standard de Step Functions con `caseId` y referencias mínimas.
4. La máquina ejecuta este flujo:

```text
ClassifySource
  ├─ sensor critical → NotifyCaregiversImmediately
  └─ otros          → continue
  → CheckCameraConsent
  → RequestEvidenceUpload (BUFFERED visual / CURRENT sensor; callback de Pi; timeout ≈ 60 s)
  → AnalyzeEvidence (Lambda + Bedrock; error = resultado "incierto")
  → RequestVoiceCheckIn + NotifyCaregiversIfNotAlready
  → WaitForCaregiverDecision (callback; timeout configurable)
       ├─ CANCEL_ALERT autorizado → ResolveCase / liberar lock
       ├─ ESCALATE autorizado     → EscalationPolicy
       └─ timeout o error         → EscalationPolicy
                                  → EmergencyDialer o estado EscalatedBlocked
```

Las anomalías críticas de sensor alertan a familiares antes/en paralelo con la evidencia. La solicitud de audio sólo se ejecuta con consentimiento de voz. Si falta cámara, Pi u Bedrock, el estado queda como evidencia incompleta/incierta y el caso sigue hacia aviso humano; no se cierra automáticamente. Bedrock nunca reduce automáticamente una severidad crítica emitida por regla de sensor.

Los callbacks de la Pi y de API deben recuperar el token de tarea por `caseId` desde una tabla privada y validar actor, estado y expiración antes de llamar a `SendTaskSuccess` o `SendTaskFailure`.

`EscalationPolicy` es código determinista: verifica severidad/estado, consentimiento `fallbackCall`, destino de allowlist, ausencia de `CANCEL_ALERT` e idempotencia por `caseId`. Sólo después invoca `EmergencyDialer`, cuyo rol posee los permisos mínimos de Connect. Bedrock no tiene ese permiso.

Agregar `deviceWatchdog` programado cada minuto para detectar falta de telemetría/heartbeat de la Pi. En el MVP abre un caso `DEVICE_OFFLINE` o avisa a familiares; no ejecuta llamada automática.

**Criterio de salida:** un evento repetido no duplica casos ni llamadas; los timeouts avanzan aun si el LLM falla; una cancelación válida detiene de forma verificable el fallback.

### Hito 5 — Control de demo, consentimiento y acciones humanas (sin frontend)

**Objetivo:** que las acciones humanas del flujo estén protegidas y puedan probarse sin construir una aplicación.

- Cargar datos de prueba: persona monitoreada, dos familiares autorizados, relación `CaregiverAccess`, consentimientos granulares y número de fallback autorizado.
- Implementar rutas API mínimas y documentadas: `GET /devices/{deviceId}/latest`, `GET /devices/{deviceId}/telemetry`, `GET /cases/{caseId}/events`, `POST /cases/{caseId}/cancel`, `POST /cases/{caseId}/escalate` y `POST /demo/devices/{deviceId}/events`.
- Proteger las rutas con Cognito/JWT o un mecanismo equivalente de demo; la Lambda valida que el sujeto pertenece a `CaregiverAccess` antes de registrar la decisión.
- Preparar una CLI/script de prueba que obtenga un token, consulte el caso y ejecute `CANCEL_ALERT`. No incluir tokens, contraseñas ni datos personales en Git.
- Aislar `POST /demo/devices/{deviceId}/events` con grupo `demo-operator`, rate limit y allowlist; no permite comandos ni acceso a dispositivos de producción.
- Para esta versión, los consentimientos se cargan como datos de prueba y sólo se consultan/validan en el flujo. La pantalla para que el usuario los modifique queda explícitamente fuera de alcance.

**Estado:** completo. `GET/POST /devices/{deviceId}/{latest,telemetry,pair}` y
`POST /demo/devices/{deviceId}/events` implementadas desde antes;
`GET /cases/{caseId}/events`, `POST /cases/{caseId}/cancel` y
`POST /cases/{caseId}/escalate` implementadas junto con el hito de alertas
(ver más abajo) — autorizan resolviendo `caseId -> deviceId` vía
`AnomalyCases` y verificando `CaregiverAccess`, no un `recipientId` de
`CareRecipients` (esa tabla no existe todavía).

**Criterio de salida:** un familiar de prueba autorizado puede cancelar por API/CLI; otro usuario recibe `403`; la decisión y el actor aparecen en `EventLog`.

### Hito de alertas — SNS deduplicado y acciones humanas (implementado)

**Objetivo:** avisar a los familiares autorizados sin duplicar envíos, y dejar
`CANCEL_ALERT`/`ESCALATE` disponibles para el flujo humano, antes de
construir el fallback telefónico.

- `DispatchAlertFn` (`services/orchestration/src/dispatchAlertFn.ts`),
  invocada en dos puntos de `CaseOrchestration`: inmediato tras abrir el
  caso si es un sensor crítico (sin esperar evidencia ni Bedrock), y como
  red de seguridad al final del tramo de evidencia/análisis para el resto.
  Dedup real vía `PutItem` condicional en la nueva tabla `Alerts` (PK
  `caseId`): solo la invocación que gana esa condición publica a SNS.
- Dos topics SNS (`SenseCare-Alerts` para familiares,
  `SenseCare-OperationalAlarms` para la alarma DLQ del punto siguiente); solo
  email, sin SMS/push.
- 6 alarmas CloudWatch (una por DLQ crítica ya existente) publicando a
  `SenseCare-OperationalAlarms` — cumple el pendiente de "alarma mínima de
  DLQ → SNS" mencionado en `ARCHITECTURE.md`.
- `GET /cases/{caseId}/events`, `POST /cases/{caseId}/cancel`,
  `POST /cases/{caseId}/escalate` (`services/cases/`), en el mismo HttpApi y
  JWT de Cognito que el resto del Hito 5. Decisión atómica y determinista
  (`TransactWriteItems` sobre `AnomalyCases`+`Alerts`): repetir la misma
  acción es idempotente (200); la acción contraria que pierde la carrera
  recibe `409` con el estado real. Todo intento se audita en `EventLog`.
- GSI `CaregiverAccessByDevice` sobre `CaregiverAccess` (auditoría de a
  quién se consideró notificado, no direcciona la entrega real de SNS).
- Límites explícitos de este hito: `ESCALATE` solo registra la intención
  humana, no dispara ninguna llamada; `CANCEL_ALERT` no detiene ningún
  fallback todavía porque el Hito 6 (más abajo) no existe aún.

**Criterio de salida:** una anomalía repetida o un reintento de Lambda nunca
produce dos correos para el mismo caso; un fallo de SNS deja el caso
auditado como `FAILED` sin bloquear evidencia/análisis; ver
`docs/ALERTS_AND_CASE_ACTIONS_RUNBOOK.md` para el procedimiento de prueba
completo.

### Hito 6 — Notificaciones y llamada de último recurso

**Objetivo:** comprobar la parte más delicada antes del ensayo final.

- SNS de aviso inicial ya implementado en el hito de alertas (arriba);
  este hito se reduce a la telefonía real.
- Configurar un contact flow de Connect breve, explícitamente identificado como demo y con instrucciones de contacto.
- Ejecutar una prueba aislada del `EmergencyDialer` con un `caseId` de prueba y el teléfono permitido. Verificar que un segundo intento con el mismo `caseId` no vuelve a llamar.
- Probar negativos: consentimiento de fallback revocado, destino fuera de allowlist, caso cancelado y caso ya llamado. Todos deben bloquear la llamada y dejar un evento auditable.
- Extender `CANCEL_ALERT` (ya implementado) para que efectivamente detenga
  el fallback de este hito una vez que exista.

**Criterio de salida:** la llamada real llega sólo al teléfono de prueba y ningún camino de la API/LLM permite escoger un número arbitrario.

### Hito 7 — Pruebas de integración y ensayo

**Objetivo:** demostrar comportamiento seguro ante fallos, no sólo el camino feliz.

Ejecutar y registrar estas pruebas de aceptación:

| Escenario | Resultado esperado |
| --- | --- |
| Telemetría saludable | No se abre caso ni se sube imagen. |
| Anomalía visual | Se crea un caso, se solicita un frame y llegan alertas. |
| Caída/inmovilidad por video | El mismo pipeline detecta una escena real o animada mostrada ante la cámara; no se inyecta un evento visual desde la web. |
| Persona inesperada | Se publica `UNEXPECTED_PERSON` sólo con zona/horario armado y evidencia temporal; no se etiqueta como delincuente. |
| Humo/fuego visual | Sólo se emite `POSSIBLE_SMOKE_OR_FIRE` con detección consistente; se prueba con animación/video, no fuego real. |
| Anomalía de sensor sostenida | Se crea/reutiliza el caso correcto; sensor crítico alerta antes de que Bedrock responda. |
| Simulador web de sensores | Un evento de sensor autenticado llega al mismo procesador/caso que el equivalente físico; un `deviceId` fuera de allowlist recibe rechazo. |
| Anomalías repetidas | Se reutiliza el caso abierto; no hay segunda llamada. |
| Familiar cancela dentro del plazo | Caso resuelto y no hay llamada. |
| Nadie cancela | Timeout → política → una llamada al destino demo. |
| Pi no responde a evidencia | Caso incierto, aviso humano; el workflow no queda bloqueado. |
| Bedrock falla/expira | Caso incierto y fallback controlado por humano/plazo; nunca cierre automático. |
| Consentimiento de cámara revocado | No se solicita/sube foto; se conserva trazabilidad. |
| Consentimiento de fallback revocado | `EscalatedBlocked`, sin llamada. |
| Pi sin heartbeat | Alerta/caso de dispositivo offline, sin llamada automática. |

Hacer al menos un ensayo en la misma red que se usará en el demo. Medir el tiempo desde anomalía hasta alerta y hasta llamada; ajustar los plazos del demo para que sean entendibles para el jurado, no para simular atención médica real. Mostrar el caso mediante la CLI/API o una herramienta REST, no mediante un dashboard.

**Criterio de salida:** todos los escenarios críticos se pueden repetir, tienen resultado esperado y el equipo sabe explicar qué dato sale del hogar y por qué.

### Hito 8 — Congelamiento, despliegue final y operación del demo

**Objetivo:** reducir variables el día de la presentación.

24 horas antes:

- Congelar versiones de Pi, modelo local, dependencias y CDK; etiquetar el commit de demo.
- Ejecutar `npm test`, `cdk synth --strict`, `cdk diff` y el despliegue final. Guardar outputs de stack, IDs de recurso y variables de configuración en un runbook privado.
- Confirmar saldo/cupo, acceso Bedrock, suscripciones SNS, destino Connect, consentimiento de prueba y alarmas de DLQ.
- Cargar en la Pi el certificado correcto, comprobar cámara/micrófono/bocina, y llevar fuente, cableado, hotspot y el simulador.

Durante el demo:

1. Mostrar en AWS IoT Test Client o API/CLI la telemetría de la Pi casi en tiempo real, sin video continuo en AWS.
2. Ejecutar una anomalía controlada física y, después, reproducir en pantalla una animación de caída, persona inesperada o humo/fuego para que la vea la misma cámara de la Pi.
3. Mostrar caso, evidencia puntual, explicación del LLM y la notificación SNS; consultar el estado con la CLI/API de demo.
4. Realizar primero la rama de `CANCEL_ALERT` para probar control humano.
5. Si el contexto permite hacer una segunda ejecución, dejar vencer el plazo y mostrar la llamada al teléfono del equipo. Anunciar antes que es una llamada simulada a un número autorizado.

Después del demo, deshabilitar la allowlist/flujo de llamada o destruir únicamente recursos efímeros tras exportar los datos que el equipo quiera conservar. No ejecutar destrucciones amplias sin revisar qué recursos son compartidos.

## Ruta crítica y prioridades

La prioridad no es perfeccionar el modelo antes de tener producto integrado. El orden que no debe romperse es:

```text
Hito 0 → contratos + simuladores → infraestructura mínima → caso + Step Functions
       → API/CLI + consulta de telemetría → Connect → integración Pi/reglas → ensayo dual
```

Si el tiempo se reduce, conservar: simulador/Pi con disparador manual, `POSSIBLE_FALL` y una anomalía de sensor simulada, una imagen puntual, respuesta estructurada de Bedrock, API/CLI de telemetría/cancelación y llamada permitida. Posponer mejoras de precisión del modelo, más sensores, audio/transcripción y reglas secundarias.

## Riesgos y contingencias

| Riesgo | Mitigación para no perder el demo |
| --- | --- |
| El modelo visual en Pi es lento o poco estable | Mantener un modo de anomalía simulada con el mismo contrato; presentar métricas y el modelo real si está listo. |
| Falta acceso/cuota de Bedrock | Probar en Hito 0; usar una respuesta estructurada determinista sólo para ensayar la tubería, dejando claro que no es análisis IA en la demostración de respaldo. |
| Connect no logra una llamada | Probarlo aisladamente en Hito 0 y Hito 6; no dejar esta integración para el día final. Mantener la respuesta de API/CLI de `EscalationPolicy` bloqueada como respaldo, sin afirmar que se hizo una llamada. |
| Wi-Fi del recinto falla | Llevar hotspot y simulador local; comprobar MQTT antes de iniciar. |
| Falsos positivos | Usar umbral conservador, una sola escena controlada y explicar que la Pi es un primer filtro; Bedrock y familiares investigan antes del fallback. |
| Evidencia sensible | Frame puntual, consentimiento vigente, bucket privado, URL prefirmada de corta duración y ciclo de vida de siete días. |

## Responsables sugeridos

La división puede cambiar según el equipo, pero no se debe bloquear el camino crítico:

- **Infraestructura/backend:** CDK, IoT, SQS, DynamoDB, Lambdas, EventBridge y Step Functions.
- **Edge/IA (responsable externo):** ESP32, Pi, cámara, detector local, MQTT, bocina/micrófono y simulador, siguiendo `EDGE_IMPLEMENTATION_GUIDE.md`.
- **Control/API:** Cognito, rutas mínimas de consulta/cancelación, datos de consentimiento de prueba y guion de demo.
- **Integración/QA:** Connect, SNS, pruebas de aceptación, runbook, ensayo y contingencias.

Cada hito debe cerrar con una demostración corta entre el equipo y una actualización de este documento si cambian contratos, plazos o límites de seguridad.
