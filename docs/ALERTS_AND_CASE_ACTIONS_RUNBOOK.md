# SenseCare — runbook de alertas y acciones humanas de caso

Este documento cubre el hito de alertas: notificación SNS deduplicada por
caso (`DispatchAlertFn`) y las 3 rutas humanas autenticadas
(`GET /cases/{caseId}/events`, `POST /cases/{caseId}/cancel`,
`POST /cases/{caseId}/escalate`). El hito de escalamiento (espera de
decisión humana, `EscalationPolicy` y `EmergencyDialer`) consume
`humanDecision`/`dialStatus` tal como los deja este hito, pero su propio
runbook (Amazon Connect, la instancia/contact flow/número de demo, el
parámetro SSM) vive en
[EMERGENCY_CALL_RUNBOOK.md](EMERGENCY_CALL_RUNBOOK.md) — no lo repitas aquí.

## 1. Qué se agregó al desplegar

- Tabla `SenseCare-Alerts` (PK `caseId`), sin TTL.
- GSI `CaregiverAccessByDevice` (PK `deviceId`) sobre la tabla existente
  `SenseCare-CaregiverAccess`.
- Dos topics SNS: `SenseCare-Alerts` (familiares) y
  `SenseCare-OperationalAlarms` (equipo técnico, alarmas de DLQ).
- 6 alarmas CloudWatch, una por cada DLQ crítica ya existente (telemetría,
  anomalía visual, anomalía de sensor, command-acks, evidence,
  case-dispatcher), publicando a `SenseCare-OperationalAlarms`.
- 3 rutas nuevas en el mismo `DemoIngestApi` (misma URL base, mismo JWT de
  Cognito ya usado por las rutas de Hito 5).
- Campos nuevos en `SenseCare-AnomalyCases`, separados a propósito en 3
  concerns distintos (un `sns:Publish` exitoso sólo prueba que SNS aceptó
  el mensaje, nunca que un familiar lo leyó):
  - `notificationStatus` (`PENDING`/`PUBLISHED`/`FAILED`): estado de la
    publicación SNS, escrito únicamente por `DispatchAlertFn`.
  - `humanDecision` (`CANCELLED`/`ESCALATED`, ausente si no hay decisión
    aún): la decisión de un cuidador autorizado, más `cancelledAt`/
    `cancelledBy`/`escalatedAt`/`escalatedBy`.
  - `dialStatus` (`DIALING`/`CALLED`/`BLOCKED`, ausente si nunca se evaluó
    el fallback): sólo lo escriben `EscalationPolicy`/`EmergencyDialer`/
    `RecordCallOutcome` (ver EMERGENCY_CALL_RUNBOOK.md); ninguna ruta de
    este hito lo toca.
  `AnomalyCases.status` (el ciclo de vida gestionado por Step Functions)
  **no lo toca** nada de este hito.

## 2. Confirmar las suscripciones de email (paso manual obligatorio)

SNS nunca entrega a una dirección de email sin que esa dirección confirme
la suscripción con un enlace que SNS le envía; esto no se puede automatizar
desde CDK ni desde ningún script.

Si el deploy se hizo con `ALERT_SUBSCRIPTION_EMAILS`/
`OPERATIONAL_SUBSCRIPTION_EMAILS` (ver sección 3), cada dirección recibirá
un correo de AWS con el asunto "AWS Notification - Subscription
Confirmation"; hay que abrirlo y hacer clic en "Confirm subscription".
Verificar el estado:

```bash
aws sns list-subscriptions-by-topic \
  --topic-arn <ARN de SenseCare-Alerts, ver Outputs/CloudFormation> \
  --region us-east-1
```

Una suscripción con `"SubscriptionArn": "PendingConfirmation"` todavía no
recibirá mensajes.

Si no se pasaron emails en el deploy, agregar la suscripción a mano:

```bash
aws sns subscribe \
  --topic-arn <ARN de SenseCare-Alerts> \
  --protocol email \
  --notification-endpoint familiar-demo@example.com \
  --region us-east-1
```

Nunca usar `--protocol sms`: este hito excluye explícitamente
SMS/telefonía.

## 3. Configurar las suscripciones en el deploy (opcional)

Antes de `cdk deploy`, exportar (nunca commitear un email real):

```bash
export ALERT_SUBSCRIPTION_EMAILS="familiar1@example.com,familiar2@example.com"
export OPERATIONAL_SUBSCRIPTION_EMAILS="equipo-tecnico@example.com"
```

Ambas son opcionales; sin ellas, el deploy crea los topics sin ninguna
suscripción y hay que agregarlas a mano (sección 2).

## 4. Probar el flujo de alerta

1. Provocar una anomalía de sensor crítica (por ejemplo, una temperatura
   muy por encima del umbral vía el simulador web) o esperar a que una
   anomalía visual complete su tramo de evidencia/análisis.
2. Confirmar en CloudWatch Logs de `SenseCare-dispatchAlert` que se invocó
   y publicó a SNS (nunca debe aparecer el cuerpo del mensaje con datos
   sensibles: sólo `caseId`, `eventType`, `anomalyType`, `severity` si
   aplica, `occurredAt` y una instrucción fija).
3. Confirmar en `SenseCare-Alerts` (tabla) que el `caseId` tiene
   `notificationStatus: "PUBLISHED"` y `notifiedCaregiverIds` con los
   `userId` emparejados a ese `deviceId`.
4. Repetir la misma anomalía (o dejar que ambos puntos de invocación de
   `DispatchAlertFn` corran para el mismo caso) y confirmar que **no** llega
   un segundo correo — sólo una publicación por caso.

## 5. Probar CANCEL_ALERT / ESCALATE

Reutilizar el token JWT obtenido según
[DEMO_INGEST_AUTH.md](DEMO_INGEST_AUTH.md) sección 3, y un usuario que ya
haya emparejado el `deviceId` del caso (sección 5.0 del mismo documento).

```bash
# Linea de tiempo auditada del caso
curl "https://<DemoIngestApiUrl>/cases/<caseId>/events" \
  -H "Authorization: Bearer <IdToken>"

# CANCEL_ALERT
curl -X POST "https://<DemoIngestApiUrl>/cases/<caseId>/cancel" \
  -H "Authorization: Bearer <IdToken>"

# ESCALATE
curl -X POST "https://<DemoIngestApiUrl>/cases/<caseId>/escalate" \
  -H "Authorization: Bearer <IdToken>"
```

Resultados esperados:

| Escenario | Resultado |
| --- | --- |
| Usuario sin `CaregiverAccess` sobre el `deviceId` del caso | `403`, sin datos del caso en el body |
| `caseId` inexistente | `404` |
| Repetir el mismo `cancel`/`escalate` | `200` idempotente, mismo `humanDecision` |
| `cancel` después de que ya se aplicó `escalate` (o viceversa) | `409`, `conflictReason: "OPPOSITE_DECISION_ALREADY_APPLIED"`, con el `humanDecision` real vigente |
| `cancel` después de que `EscalationPolicy` ya reclamó `dialStatus: "DIALING"`/`"CALLED"` | `409`, `conflictReason: "CALL_ALREADY_IN_PROGRESS"` — nunca finge haber cancelado una llamada ya iniciada (ver EMERGENCY_CALL_RUNBOOK.md, carrera crítica) |
| Cualquiera de los casos anteriores | Una fila nueva en `EventLog` con el intento (aplicado, no-op o rechazado) |

Ningún resultado cierra `AnomalyCases.status` directamente: `cancel`
resuelve de inmediato el callback de Step Functions en espera (si lo hay)
y termina el fallback; `escalate` sólo dobla la intención humana —
`EscalationPolicy` decide igual si el fallback procede (ver
EMERGENCY_CALL_RUNBOOK.md).

## 5.1. Historial de casos (`GET /cases`) — hito de notificaciones

Mismo token JWT que la sección anterior. A diferencia de
`/cases/{caseId}/events` (requiere conocer un `caseId`), esta ruta lista los
casos de TODOS los `deviceId` que el usuario tiene emparejados:

```bash
curl "https://<DemoIngestApiUrl>/cases?limit=20" \
  -H "Authorization: Bearer <IdToken>"
```

Un usuario sin ningún `deviceId` emparejado recibe `200` con `items: []`,
nunca `403` (ver `services/cases/src/listCasesHandler.ts`).

## 5.2. Push dirigido — hito de notificaciones (requiere Firebase real)

Solo aplica si el stack se desplegó con `FCM_SERVICE_ACCOUNT_JSON` (ver
`docs/IMPLEMENTATION_ROADMAP.md`, "Hito de notificaciones push y
confirmación de voz"); sin esa variable, `PinpointApplicationId` no aparece
en los Outputs del stack y las rutas `/me/push-devices` no existen.

```bash
# Registrar el token FCM del dispositivo del usuario autenticado
curl -X POST "https://<DemoIngestApiUrl>/me/push-devices" \
  -H "Authorization: Bearer <IdToken>" \
  -H "Content-Type: application/json" \
  -d '{"platform":"android","token":"<token FCM del dispositivo>"}'

# Baja
curl -X DELETE "https://<DemoIngestApiUrl>/me/push-devices/<endpointId>" \
  -H "Authorization: Bearer <IdToken>"
```

Provocar una anomalía (sección 4) con al menos un endpoint activo
registrado debe generar, ademas del correo de `DispatchAlertFn`, una fila en
`SenseCare-AlertDeliveries` (PK `caseId`) con `status: "PUBLISHED"` por cada
endpoint. Un token FCM inválido/desinstalado marca esa fila `FAILED` y pone
`SenseCare-CaregiverPushEndpoints.status` en `DISABLED` para ese endpoint,
sin bloquear el resto del caso.

## 6. Riesgos y límites conocidos

- Si `DispatchAlertFn` muere exactamente entre reservar el envío y llamar a
  `sns:Publish`, la alerta queda `PENDING` hasta que el segundo punto de
  invocación (`NotifyCaregiversIfNotAlready`, al final del tramo de
  evidencia/análisis) la retome tras ~2 minutos. Para una anomalía de
  sensor crítica cuyo tramo de evidencia falle muy rápido, ese margen
  podría no alcanzar a autocorregirse dentro del demo; verificar
  manualmente `SenseCare-Alerts` si un caso crítico no genera ningún correo.
- La entrega de SNS es por topic completo, no dirigida por caregiver:
  `notifiedCaregiverIds` es sólo auditoría de quién estaba autorizado al
  momento de alertar, no una lista de destinatarios reales de ese envío.
- `dispatchPushFn` (hito de notificaciones) NO tiene el mismo mecanismo de
  auto-recuperación que `dispatchAlertFn`: si la invocación que gana el
  `claim` muere entre reservarlo y llamar a Pinpoint, ese caso simplemente
  no recibe push (el correo de `dispatchAlertFn` sigue siendo el canal
  garantizado). Simplificación deliberada, ver docstring de
  `dispatchPushFn.ts`.
- El push usa Amazon Pinpoint (`AWS::Pinpoint::App`/`GCMChannel`), que AWS
  anunció que retira el **2026-10-30**. Seguro para el demo del hackathon;
  cualquier uso posterior a esa fecha necesita migrar (ver docstring de
  `infra/lib/constructs/push-application.ts`).
- Mientras no haya un canal humano de notificación real confirmado
  (`HUMAN_NOTIFICATION_CHANNEL_CONFIRMED=false`, el valor por defecto),
  `EscalationPolicy` bloquea siempre el fallback automático con
  `NO_ACTIVE_HUMAN_NOTIFICATION_CHANNEL`, sin importar que `notificationStatus`
  sea `PUBLISHED`: un `sns:Publish` exitoso no prueba que un familiar la
  leyó. Ver EMERGENCY_CALL_RUNBOOK.md para el detalle completo de
  `EscalationPolicy`/`EmergencyDialer`.
