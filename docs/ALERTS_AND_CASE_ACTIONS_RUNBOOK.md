# SenseCare — runbook de alertas y acciones humanas de caso

Este documento cubre el hito de alertas: notificación SNS deduplicada por
caso (`DispatchAlertFn`) y las 3 rutas humanas autenticadas
(`GET /cases/{caseId}/events`, `POST /cases/{caseId}/cancel`,
`POST /cases/{caseId}/escalate`). No incluye Amazon Connect ni telefonía:
`ESCALATE` sólo registra la intención humana, y `CANCEL_ALERT` no detiene
ningún fallback todavía porque no existe uno en este hito.

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
- Campos nuevos en `SenseCare-AnomalyCases`: `alertStatus`
  (`PENDING`/`SENT`/`FAILED`/`CANCELLED`/`ESCALATED`), `cancelledAt`,
  `cancelledBy`, `escalatedAt`, `escalatedBy`. `AnomalyCases.status` (el
  ciclo de vida gestionado por Step Functions) **no lo toca** nada de este
  hito.

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
   `alertStatus: "SENT"` y `notifiedCaregiverIds` con los `userId`
   emparejados a ese `deviceId`.
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
| Repetir el mismo `cancel`/`escalate` | `200` idempotente, mismo `alertStatus` |
| `cancel` después de que ya se aplicó `escalate` (o viceversa) | `409`, con el `alertStatus` real vigente |
| Cualquiera de los casos anteriores | Una fila nueva en `EventLog` con el intento (aplicado, no-op o rechazado) |

Ningún resultado cierra `AnomalyCases.status` ni dispara una llamada: este
hito termina en el registro de la decisión humana.

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
- `ESCALATE` no tiene ningún efecto más allá de registrar la intención; no
  existe todavía una `EscalationPolicy` ni `EmergencyDialer` que lo consuma.
