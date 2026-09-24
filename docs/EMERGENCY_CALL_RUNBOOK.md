# SenseCare — runbook de escalamiento y llamada de fallback (Amazon Connect)

Este documento cubre el hito de escalamiento: la espera de una decisión
humana con callback de Step Functions, `EscalationPolicyFn` (determinista,
sin permisos Connect) y `EmergencyDialerFn` (la única Lambda de todo
SenseCare con `connect:StartOutboundVoiceContact`). Es continuación directa
de [ALERTS_AND_CASE_ACTIONS_RUNBOOK.md](ALERTS_AND_CASE_ACTIONS_RUNBOOK.md):
lee ese documento primero para el significado de `notificationStatus` y
`humanDecision`.

**Nunca llama al 911 ni a ningún servicio público de emergencia real.**
`EmergencyDialerFn` sólo puede marcar el único destino de demo fijado a
mano en un parámetro SSM `SecureString`, fuera de Git y de CloudFormation.

## 1. Qué se agregó al desplegar

- Tabla `SenseCare-CaseActionCallbacks` (PK `caseId`, SK `callbackType`,
  TTL): guarda el `taskToken` de Step Functions mientras la máquina espera
  una decisión humana. **Nunca** se copia a `AnomalyCases`, `EventLog`,
  `Alerts` ni al estado propio de la ejecución — sólo vive aquí, de forma
  efímera.
- Campo nuevo en `SenseCare-AnomalyCases`: `dialStatus`
  (`DIALING`/`CALLED`/`BLOCKED`/`FAILED`, ausente si nunca se evaluó el
  fallback), más `dialingClaimedAt`/`calledAt`/`connectContactId`/
  `dialBlockedReason`/`dialFailedReason`. Es un campo *distinto* de
  `humanDecision` y `notificationStatus` (ver runbook de alertas) — un
  `sns:Publish` exitoso nunca implica que hubo, o habrá, una llamada.
  `AnomalyCases.status` (el ciclo de vida de Step Functions) sigue sin
  tocarlo nada de este hito.
- CMK propia (`FallbackCallSecret`) y el *nombre*/ARN del parámetro SSM
  `SecureString` del número de destino de demo. **CDK nunca crea el
  valor del parámetro** — sólo la llave y el nombre — exactamente igual
  que el certificado X.509 de un dispositivo.
- 5 Lambdas nuevas en el tramo final de la máquina de estados:
  `RequestHumanDecisionFn` (espera con `taskToken`), `ReconcileHumanDecisionFn`
  (libera el callback efímero antes de reevaluar), `EscalationPolicyFn`
  (decide, nunca llama), `EmergencyDialerFn` (única con Connect) y
  `RecordCallOutcomeFn` (audita el resultado, sin permisos Connect/SSM/KMS).

## 2. Aprovisionar Amazon Connect (manual, fuera de CDK a propósito)

Ninguno de estos 3 recursos se crea por CDK — reclamar una instancia/número
de teléfono real de Connect no es una operación idempotente ni segura de
repetir en cada `cdk deploy`, y un número de teléfono real nunca debe vivir
en el código fuente.

1. Crear (o reutilizar) una instancia de Amazon Connect en la consola,
   región del stack. Anotar su `InstanceId`.
2. Reclamar un número de teléfono de origen para la instancia (Claim a
   number). Anotar el número en formato E.164 — este es
   `CONNECT_SOURCE_PHONE_NUMBER`, **no** el número de destino de demo.
3. Crear un contact flow mínimo tipo "Outbound whisper flow" (o el flow
   por defecto de salida) que reproduzca un mensaje de audio fijo indicando
   que es una llamada de demo de SenseCare y pidiendo confirmación verbal.
   No conectar el flow a ningún IVR de recolección de datos sensibles ni a
   una cola de agentes humanos: el demo termina en la reproducción del
   mensaje. Anotar su `ContactFlowId`.
4. Verificar (o solicitar, si la cuenta está en sandbox de Connect) que el
   número de destino de demo esté autorizado a recibir llamadas de esa
   instancia — las cuentas de Connect en sandbox sólo pueden llamar a
   números verificados explícitamente.

Exportar antes de `cdk deploy` (nunca commitear estos valores):

```bash
export CONNECT_INSTANCE_ID="<InstanceId del paso 1>"
export CONNECT_CONTACT_FLOW_ID="<ContactFlowId del paso 3>"
export CONNECT_SOURCE_PHONE_NUMBER="+1..."   # numero de origen, E.164
```

`FALLBACK_CALL_DESTINATION_PARAMETER_NAME` es opcional — si se omite, el
stack usa por defecto `/sensecare/demo/fallback-call-destination` (es sólo
un nombre, no un secreto).

## 3. Fijar el número de destino de demo (manual, después del deploy)

El **valor** del parámetro nunca se fija por CDK ni por ningún script de
este repositorio. Después de `cdk deploy`, con el número de prueba
autorizado ya decidido por el equipo:

```bash
aws ssm put-parameter \
  --name "/sensecare/demo/fallback-call-destination" \
  --type "SecureString" \
  --key-id "<KeyId del CMK 'FallbackCallSecret', ver Outputs/CloudFormation>" \
  --value "+52..." \
  --region us-east-1 \
  --profile default
```

Verificar sin exponer el valor en la terminal (nunca usar `--with-decryption`
en un demo compartido en pantalla):

```bash
aws ssm get-parameter \
  --name "/sensecare/demo/fallback-call-destination" \
  --region us-east-1 \
  --query "Parameter.LastModifiedDate"
```

Sin este valor, `EmergencyDialerFn` falla de forma segura con
`dialStatus: "FAILED"` / `dialFailedReason: "DIAL_FAILED"` — nunca marca a
un destino alterno ni deja el caso en un estado ambiguo.

## 4. Dar consentimiento y allowlist a un dispositivo de demo

Dos condiciones adicionales e independientes del consentimiento de cámara
(ver [DEVICE_PROVISIONING_AND_SMOKE_TEST.md](DEVICE_PROVISIONING_AND_SMOKE_TEST.md)
sección 1, que ahora también documenta el seed de `fallbackCallConsent`):

- `Devices.fallbackCallConsent === true` (booleano estricto) para el
  `deviceId` del caso.
- El mismo `deviceId` debe estar en `ESCALATION_ALLOWED_DEVICE_IDS` (env
  var del deploy, opcional — por defecto `pi-demo-01,sim-room-01`).

Cualquier otro valor, o su ausencia, bloquea el fallback con
`CONSENT_MISSING` o `DEVICE_NOT_ALLOWED` respectivamente — nunca hay un
default permisivo.

## 5. El gate de canal humano de notificación (por qué el fallback está bloqueado por defecto)

`HUMAN_NOTIFICATION_CHANNEL_CONFIRMED` es `false` por defecto. Mientras lo
sea, **`EscalationPolicyFn` bloquea siempre** el fallback automático con
`NO_ACTIVE_HUMAN_NOTIFICATION_CHANNEL`, sin importar que `notificationStatus`
sea `PUBLISHED`, que el riesgo sea elegible o que el consentimiento y la
allowlist estén correctos: un `sns:Publish` exitoso sólo prueba que SNS
aceptó el mensaje, nunca que un familiar lo leyó, y hoy no hay
correo/push/WhatsApp confirmados como canal real (ver
ALERTS_AND_CASE_ACTIONS_RUNBOOK.md sección 2).

Sólo cambiar a `true` cuando el operador haya confirmado manualmente que
existe un canal humano de notificación activo:

```bash
export HUMAN_NOTIFICATION_CHANNEL_CONFIRMED="true"
```

**No usar este flag para "probar que Connect funciona".** Para eso, usar la
prueba aislada de la sección 7 — nunca relajar la política normal del caso
para forzar una llamada de demostración.

## 6. Cómo decide EscalationPolicyFn (orden exacto, todo o nada)

`EscalationPolicyFn` evalúa, en este orden, y bloquea con un código cerrado
propio en el primer punto que falle (nunca continúa "por si acaso"):

| # | Condición | Código de bloqueo si falla |
| --- | --- | --- |
| 1 | El caso existe y `humanDecision !== "CANCELLED"` (releído en caliente) | `CASE_NOT_FOUND` / `CASE_CANCELLED` |
| 2 | `HUMAN_NOTIFICATION_CHANNEL_CONFIRMED === true` (sección 5) | `NO_ACTIVE_HUMAN_NOTIFICATION_CHANNEL` |
| 3 | `notificationStatus === "PUBLISHED"` para este caso | `NOTIFICATION_NOT_PUBLISHED` |
| 4 | Riesgo elegible: sensor `severity: critical`, o visual `POSSIBLE_FALL`/`PERSON_PRONE_INACTIVE` | `RISK_NOT_ELIGIBLE` |
| 5 | `Devices.fallbackCallConsent === true` | `CONSENT_MISSING` |
| 6 | `deviceId` en `ESCALATION_ALLOWED_DEVICE_IDS` | `DEVICE_NOT_ALLOWED` |
| 7 | Reclamo atómico de `dialStatus = DIALING` (idempotencia + carrera con `CANCEL_ALERT`, ver sección 8) | `CASE_CANCELLED` / `ALREADY_DIALED` |

`UNEXPECTED_PERSON`, `CAMERA_TAMPERED` y cualquier anomalía de sensor no
crítica quedan excluidos del riesgo elegible por defecto — nunca disparan
el fallback automático de llamada.

Cualquier bloqueo escribe `dialStatus: "BLOCKED"` (sólo si `dialStatus` aún
no existía — nunca pisa un `DIALING`/`CALLED` real) y una fila
`ESCALATED_BLOCKED` en `EventLog` con el código. Un fallo de invocación
técnica de la Lambda (no una condición de negocio) se trata igual de
estricto: la máquina de estados lo mapea a `allowed: false` con
`ESCALATION_POLICY_INVOCATION_ERROR`, nunca a "permitido por defecto".

## 7. Probar EmergencyDialer de forma aislada (sin canal humano confirmado)

Para verificar que la integración con Connect funciona de punta a punta
*antes* de tener push/WhatsApp/correo confirmado como canal real, invocar
`SenseCare-emergencyDialer` directamente con un `caseId` de prueba — nunca
relajar `HUMAN_NOTIFICATION_CHANNEL_CONFIRMED` ni ninguna otra condición de
`EscalationPolicyFn` para lograr esto:

```bash
aws lambda invoke \
  --function-name SenseCare-emergencyDialer \
  --payload '{"caseId":"test-connect-demo-01"}' \
  --cli-binary-format raw-in-base64-out \
  --region us-east-1 \
  --profile default \
  /tmp/emergency-dialer-test-output.json

cat /tmp/emergency-dialer-test-output.json
```

Salida esperada: `{"outcome":"CALLED","contactId":"..."}`. Esto **no** pasa
por `EscalationPolicyFn` ni por la máquina de estados — no crea ni modifica
ningún `AnomalyCases`/`EventLog` real, y el `caseId` de prueba nunca debe
coincidir con uno real en uso. Es exclusivamente una prueba manual de la
integración de Connect.

## 8. La carrera crítica CANCEL_ALERT vs. EscalationPolicy

Ambas transiciones son condicionales sobre el **mismo** ítem de
`AnomalyCases`, con guardias simétricas — exactamente una de las dos puede
ganar, nunca ambas ni ninguna:

- `CANCEL_ALERT` (`alertDecision.ts`) sólo puede escribir
  `humanDecision = CANCELLED` si `dialStatus` **no** es `DIALING`/`CALLED`
  todavía.
- `EscalationPolicyFn` sólo puede reclamar `dialStatus = DIALING` si
  `humanDecision` **no** es `CANCELLED` todavía.

Si `EscalationPolicyFn` gana la carrera y reclama `DIALING` primero, un
`CANCEL_ALERT` posterior recibe `409` con
`conflictReason: "CALL_ALREADY_IN_PROGRESS"` — la API nunca finge haber
cancelado una llamada que ya empezó. Si `CANCEL_ALERT` gana primero,
`EscalationPolicyFn` nunca logra reclamar `DIALING` y bloquea con
`CASE_CANCELLED`.

Una respuesta de voz de la persona monitoreada durante la llamada (si el
contact flow la captura) es evidencia, nunca un cierre automático del
caso: sólo un `CANCEL_ALERT` de un cuidador autorizado detiene el
fallback, y sólo antes de que `dialStatus` llegue a `DIALING`.

## 9. Probar el flujo completo de punta a punta

Con `HUMAN_NOTIFICATION_CHANNEL_CONFIRMED=true`, consentimiento y allowlist
correctos (secciones 4–5):

1. Provocar una anomalía elegible (sensor crítico, o visual
   `POSSIBLE_FALL`/`PERSON_PRONE_INACTIVE`) para `pi-demo-01`/`sim-room-01`.
2. **Caso A — timeout sin decisión:** no llamar a `cancel`/`escalate`.
   Esperar `humanDecisionWaitSeconds` (300s por defecto). Confirmar en
   CloudWatch Logs de `SenseCare-escalationPolicy` que corrió, y en
   `AnomalyCases` que `dialStatus` terminó en `CALLED` (o `BLOCKED`/`FAILED`
   con su razón, si alguna otra condición no se cumplía).
3. **Caso B — CANCEL_ALERT antes del timeout:** llamar a
   `POST /cases/{caseId}/cancel` (ver runbook de alertas) mientras la
   máquina sigue en `RequestHumanDecision`. Confirmar que el caso termina
   en `CaseResolvedByCancel` sin que `dialStatus` exista nunca.
4. **Caso C — ESCALATE explícito:** llamar a
   `POST /cases/{caseId}/escalate`. Confirmar que la máquina resuelve el
   callback de inmediato (sin esperar el timeout completo) y continúa hacia
   `EscalationPolicyFn` con las mismas 7 condiciones de la sección 6 — un
   `ESCALATE` humano nunca se salta la política.
5. Repetir el mismo `caseId` una vez que `dialStatus` ya sea `CALLED`
   (reintentando manualmente la ejecución, o invocando `EscalationPolicyFn`
   de nuevo con el mismo `caseDetail`) y confirmar que **nunca** hay una
   segunda llamada: `ALREADY_DIALED`.
6. Revisar `EventLog` del caso: cada paso (bloqueo, llamada iniciada,
   llamada fallida) debe dejar exactamente una fila auditada, nunca el
   número de destino ni el `taskToken`.

## 10. Riesgos y límites conocidos

- Una cuenta de Connect en sandbox sólo puede llamar a números de destino
  verificados explícitamente — verificar esto en la sección 2 antes del
  demo, o la llamada fallará con un código de Connect que
  `emergencyDialerFn.ts` traduce genéricamente a `DIAL_FAILED`.
- El `taskToken` de la espera humana vive únicamente en
  `SenseCare-CaseActionCallbacks` (TTL) mientras está pendiente; nunca en
  `AnomalyCases`, `EventLog`, `Alerts` ni en el estado de la ejecución de
  Step Functions — verificar esto con `aws stepfunctions describe-execution`
  si se audita el flujo, nunca esperar encontrarlo ahí.
- Ningún Lambda de este hito, salvo `SenseCare-emergencyDialer`, tiene
  ningún permiso `connect:`/`ssm:`/`kms:` — incluido `analyzeEvidenceFn`,
  que sólo tiene Bedrock (ver AGENTS.md: "El LLM no tiene permisos IAM para
  Connect, no puede cerrar casos ni seleccionar teléfonos").
- Cambiar `humanDecisionWaitSeconds` a un valor muy corto para acelerar un
  demo reduce el margen real que tiene un cuidador para reaccionar antes
  del fallback automático — usarlo con criterio, nunca como valor por
  defecto de producción.
