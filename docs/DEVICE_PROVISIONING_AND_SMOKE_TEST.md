# SenseCare — aprovisionar un dispositivo y prueba de humo MQTT

Esta guía configura un dispositivo demo `pi-demo-01` después de desplegar
`SenseCareDemoStack`. También valida el primer recorrido real de datos:

```text
Publicador MQTT → AWS IoT Rule → SQS → Lambda → DynamoDB
                                  └→ EventBridge → Step Functions
```

No aprovisiona ni conecta físicamente una Raspberry Pi; esa integración se
realiza conforme a [EDGE_IMPLEMENTATION_GUIDE.md](EDGE_IMPLEMENTATION_GUIDE.md).

## Antes de empezar

- El stack debe estar en estado CloudFormation `CREATE_COMPLETE` o
  `UPDATE_COMPLETE` en la misma cuenta y región de prueba.
- Los ejemplos usan `us-east-1` y el perfil AWS CLI `default`. Sustituirlos si
  corresponde.
- Usar valores de prueba. Nunca incluir nombres reales, datos médicos, fotos,
  audio, llaves privadas ni certificados en payloads MQTT.
- El `ThingName`, el `clientId` MQTT de la Pi y el `deviceId` del payload deben
  ser idénticos: `pi-demo-01`.

## 1. Registrar el dispositivo en DynamoDB

Antes de aceptar telemetría, el backend busca el `recipientId` a partir del
`deviceId` en `SenseCare-Devices`. No se confía en un `recipientId` enviado
por MQTT.

`cameraConsent` debe quedar en `true` (booleano, no string) **explícitamente**
para `pi-demo-01` en el entorno demo. `cameraConsentFn` (tramo de evidencia,
ver `docs/ARCHITECTURE_DETAILED.md`) trata cualquier otro valor —incluida su
ausencia— como consentimiento denegado: sin este seed, toda anomalía real
resuelve en `evidenceStatus = SKIPPED_NO_CONSENT` y nunca se llega a probar
`UPLOAD_EVIDENCE` de punta a punta.

```bash
aws dynamodb put-item \
  --table-name SenseCare-Devices \
  --region us-east-1 \
  --profile default \
  --item '{
    "deviceId": {"S": "pi-demo-01"},
    "recipientId": {"S": "recipient-demo-01"},
    "cameraConsent": {"BOOL": true},
    "createdAt": {"S": "2026-09-24T00:00:00Z"}
  }' \
  --condition-expression "attribute_not_exists(deviceId)"
```

La condición evita sobrescribir por accidente un dispositivo existente. Para
verificarlo:

```bash
aws dynamodb get-item \
  --table-name SenseCare-Devices \
  --region us-east-1 \
  --profile default \
  --key '{"deviceId":{"S":"pi-demo-01"}}'
```

Si `pi-demo-01` ya fue provisionado antes de que existiera el tramo de
evidencia (sin `cameraConsent` en el item), añadirlo con una actualización
idempotente en vez de repetir el `put-item` condicional:

```bash
aws dynamodb update-item \
  --table-name SenseCare-Devices \
  --region us-east-1 \
  --profile default \
  --key '{"deviceId":{"S":"pi-demo-01"}}' \
  --update-expression "SET cameraConsent = :consent" \
  --expression-attribute-values '{":consent":{"BOOL":true}}' \
  --condition-expression "attribute_exists(deviceId)"
```

`fallbackCallConsent` (hito de escalamiento, ver
[EMERGENCY_CALL_RUNBOOK.md](EMERGENCY_CALL_RUNBOOK.md)) sigue exactamente el
mismo patrón que `cameraConsent`: `EscalationPolicyFn` trata cualquier valor
distinto de `true` booleano —incluida su ausencia— como consentimiento
denegado (`CONSENT_MISSING`), y nunca permite el fallback automático de
llamada sin él. Es un campo independiente; dar `cameraConsent: true` no
otorga `fallbackCallConsent`.

```bash
aws dynamodb update-item \
  --table-name SenseCare-Devices \
  --region us-east-1 \
  --profile default \
  --key '{"deviceId":{"S":"pi-demo-01"}}' \
  --update-expression "SET fallbackCallConsent = :consent" \
  --expression-attribute-values '{":consent":{"BOOL":true}}' \
  --condition-expression "attribute_exists(deviceId)"
```

## 2. Crear Thing y certificado X.509

Ejecutar fuera del repositorio. Los archivos de certificado no deben entrar a
Git ni compartirse por canales públicos.

```bash
mkdir -p ~/sensecare-device
cd ~/sensecare-device
umask 077

aws iot create-thing \
  --thing-name pi-demo-01 \
  --region us-east-1 \
  --profile default
```

### Bash / Zsh

```bash
CERT_ARN=$(aws iot create-keys-and-certificate \
  --set-as-active \
  --certificate-pem-outfile device.pem.crt \
  --public-key-outfile public.pem.key \
  --private-key-outfile private.pem.key \
  --query certificateArn \
  --output text \
  --region us-east-1 \
  --profile default)

echo "$CERT_ARN"
```

### Fish

```fish
set CERT_ARN (aws iot create-keys-and-certificate \
  --set-as-active \
  --certificate-pem-outfile device.pem.crt \
  --public-key-outfile public.pem.key \
  --private-key-outfile private.pem.key \
  --query certificateArn \
  --output text \
  --region us-east-1 \
  --profile default)

echo $CERT_ARN
```

Si se cometió un error al capturar la variable, no crear otro certificado de
inmediato. Primero comprobar si ya se generaron `device.pem.crt` y
`private.pem.key`, y listar certificados activos:

```bash
aws iot list-certificates \
  --region us-east-1 \
  --profile default \
  --query 'certificates[?status==`ACTIVE`].[certificateArn,certificateId,creationDate]' \
  --output table
```

## 3. Asociar certificado, Thing y política

El certificado debe estar adjunto al Thing antes de adjuntar la política y
antes de intentar la conexión MQTT.

### Bash / Zsh

```bash
aws iot attach-thing-principal \
  --thing-name pi-demo-01 \
  --principal "$CERT_ARN" \
  --region us-east-1 \
  --profile default

aws iot attach-policy \
  --policy-name SenseCare-device-access \
  --target "$CERT_ARN" \
  --region us-east-1 \
  --profile default
```

### Fish

```fish
aws iot attach-thing-principal \
  --thing-name pi-demo-01 \
  --principal $CERT_ARN \
  --region us-east-1 \
  --profile default

aws iot attach-policy \
  --policy-name SenseCare-device-access \
  --target $CERT_ARN \
  --region us-east-1 \
  --profile default
```

Verificar ambas asociaciones:

```bash
aws iot list-thing-principals \
  --thing-name pi-demo-01 \
  --region us-east-1 \
  --profile default

aws iot list-attached-policies \
  --target <CERTIFICATE_ARN> \
  --region us-east-1 \
  --profile default
```

La política `SenseCare-device-access` autoriza a la Pi sólo para sus propios
topics. Permite publicar telemetría/anomalías/respuestas y recibir sólo
`SenseCare/v1/devices/pi-demo-01/commands`.

## 4. Publicar telemetría de prueba

### Opción A: AWS IoT MQTT Test Client

En AWS IoT Core, región `us-east-1`, abrir **MQTT test client**, conectar y
publicar en:

```text
SenseCare/v1/devices/pi-demo-01/telemetry
```

```json
{
  "eventId": "11111111-1111-4111-8111-111111111111",
  "deviceId": "pi-demo-01",
  "occurredAt": "2026-09-24T23:00:00Z",
  "firmwareVersion": "1.0.0",
  "temperatureC": 27.3,
  "humidityPct": 48,
  "co2Ppm": 840,
  "proximityCm": 120,
  "dbAvg": 38.5,
  "dbPeak": 56.2
}
```

El MQTT Test Client utiliza las credenciales de consola; valida el backend y
las IoT Rules, pero no prueba el certificado X.509 de la Pi.

### Opción B: AWS CLI (fallback si el WebSocket del navegador falla)

Justo después de activar AWS IoT, la consola puede informar que la conexión
WebSocket aún no está disponible. Se puede usar el plano de datos IoT con CLI
sin esperar a esa interfaz.

#### Fish

```fish
set IOT_ENDPOINT (aws iot describe-endpoint \
  --endpoint-type iot:Data-ATS \
  --region us-east-1 \
  --profile default \
  --query endpointAddress \
  --output text)

aws iot-data publish \
  --endpoint-url https://$IOT_ENDPOINT \
  --topic SenseCare/v1/devices/pi-demo-01/telemetry \
  --qos 1 \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "eventId": "11111111-1111-4111-8111-111111111111",
    "deviceId": "pi-demo-01",
    "occurredAt": "2026-09-24T23:00:00Z",
    "firmwareVersion": "1.0.0",
    "temperatureC": 27.3,
    "humidityPct": 48,
    "co2Ppm": 840,
    "proximityCm": 120,
    "dbAvg": 38.5,
    "dbPeak": 56.2
  }' \
  --region us-east-1 \
  --profile default
```

Para Bash/Zsh, usar `IOT_ENDPOINT=$(...)` y `$IOT_ENDPOINT` de forma
equivalente.

Tras 10–20 segundos, `SenseCare-Telemetry` debe contener una fila con
`deviceId = pi-demo-01`; `SenseCare-Devices` debe incluir `lastSeenAt` y
`lastTelemetryEventId`.

## 5. Publicar una anomalía visual de prueba

Publicar con MQTT Test Client o con `aws iot-data publish` en:

```text
SenseCare/v1/devices/pi-demo-01/visual/anomaly
```

```json
{
  "eventId": "22222222-2222-4222-8222-222222222222",
  "eventType": "VISUAL_ANOMALY",
  "deviceId": "pi-demo-01",
  "occurredAt": "2026-09-24T23:01:00Z",
  "anomalyType": "PERSON_PRONE_INACTIVE",
  "confidence": 0.87,
  "candidates": ["POSSIBLE_FALL", "POSSIBLE_UNCONSCIOUSNESS"],
  "evidence": {
    "personCount": 1,
    "zone": "living_room",
    "posture": "lying_or_fallen",
    "horizontalSeconds": 14,
    "motionAfterSeconds": 12
  },
  "modelVersions": {
    "pose": "pose-v1",
    "person": "person-v1"
  }
}
```

En 20–30 segundos confirmar:

- `SenseCare-EventLog` contiene un evento `VISUAL_ANOMALY`.
- `SenseCare-OpenCaseLocks` contiene un `lockKey` y un `caseId`.
- `SenseCare-AnomalyCases` contiene el mismo `caseId` con `status: DETECTED`.
- `SenseCare-CaseStateMachine` tiene una ejecución `Succeeded` cuyo nombre es
  ese `caseId`.

Publicar el mismo `eventId` no crea datos nuevos. Publicar otro `eventId` con
el mismo tipo mientras el lock siga vigente añade trazabilidad en `EventLog`,
pero no abre una segunda ejecución ni caso.

## 6. Prueba de seguridad topic/payload

Para comprobar que una Pi no puede suplantar otro dispositivo, publicar en el
topic de `pi-demo-01` un payload válido que afirme `"deviceId": "pi-demo-02"`.
La Lambda debe rechazarlo porque la IoT Rule incluye el `deviceId` real del
topic como `mqttDeviceId`; no debe escribir telemetría, eventos ni iniciar una
ejecución. Un mensaje fallido se reintenta y puede llegar a la DLQ.

## 7. Conectar la Pi real después de la prueba

Copiar por canal privado los archivos necesarios al directorio restringido de
la Pi, por ejemplo `/etc/SenseCare/iot/`:

- `device.pem.crt`
- `private.pem.key`
- CA raíz de Amazon apropiada para el endpoint ATS

Configurar el cliente MQTT de la Pi con:

- endpoint devuelto por `aws iot describe-endpoint --endpoint-type iot:Data-ATS`;
- puerto MQTT TLS 8883;
- `clientId = pi-demo-01`;
- certificado y llave anteriores;
- suscripción a `SenseCare/v1/devices/pi-demo-01/commands`;
- QoS 1 para telemetría, anomalías y comandos importantes.

La Pi debe validar todo `UPLOAD_EVIDENCE`, deduplicar por `commandId` y
publicar `COMMAND_ACK` y el resultado de evidencia. Esa ruta se implementará
en el siguiente hito; por ahora el backend ya valida la ingesta de telemetría
y anomalías.

## Problemas frecuentes

| Síntoma | Revisión |
| --- | --- |
| MQTT Test Client no conecta por WebSocket | Esperar y reintentar; usar `aws iot-data publish` como fallback. |
| Telemetría no llega a DynamoDB | Confirmar seed de `SenseCare-Devices`, topic exacto, JSON válido y región. |
| Mensaje llega a DLQ | Revisar logs de Lambda; causas comunes: schema inválido, `deviceId` desconocido o mismatch topic/payload. |
| La Pi no conecta | Confirmar ThingName/clientId/deviceId iguales, certificado activo, `attach-thing-principal`, `attach-policy` y endpoint ATS. |
| No hay ejecución Step Functions | Revisar `SenseCare-AnomalyDetected`, el dispatcher y `SenseCare-case-dispatcher-dlq`. |

## Revocar o limpiar el dispositivo demo

Para bloquear de inmediato el certificado, cambiarlo a inactivo:

```bash
aws iot update-certificate \
  --certificate-id <CERTIFICATE_ID> \
  --new-status INACTIVE \
  --region us-east-1 \
  --profile default
```

No ejecutar eliminaciones masivas de DynamoDB. Para limpiar datos de demo,
usar `delete-item` con una clave conocida y sólo después de confirmar el
recurso objetivo.
