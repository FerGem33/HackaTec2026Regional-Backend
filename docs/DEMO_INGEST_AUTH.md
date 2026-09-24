# SenseCare — autenticación y uso del API de demo (ingesta + consulta)

Este documento es para quien conecte un cliente HTTP al backend: el
simulador web (`frontend-equipo404`, para mandar datos como dispositivo
simulado) o la app móvil (`app_hackatec_regional`, para **consultar** datos
de cualquier dispositivo, incluida la Raspberry Pi física real). Complementa
[SIMULATOR_INTEGRATION_GUIDE.md](SIMULATOR_INTEGRATION_GUIDE.md); ese
documento explica QUÉ se puede mandar (schemas), este explica CÓMO
autenticarse y a qué URL exacta llamar contra el `DemoIngestApi` ya
desplegado (Hito 5).

Las 4 rutas expuestas comparten el mismo API y el mismo tipo de token JWT,
pero tienen alcance distinto:

| Ruta | Quién la usa | Qué `deviceId` acepta |
| --- | --- | --- |
| `POST /demo/devices/{deviceId}/events` | Solo el simulador web (escritura) | Solo los de la allowlist de demo (`sim-room-01`) |
| `POST /devices/{deviceId}/pair` | Simulador web y app móvil (emparejar por QR) | Cualquiera, si se sabe su `pairingCode` |
| `GET /devices/{deviceId}/latest` | Simulador web y app móvil (lectura) | Solo dispositivos que ESE usuario ya emparejó |
| `GET /devices/{deviceId}/telemetry` | Simulador web y app móvil (lectura) | Solo dispositivos que ESE usuario ya emparejó |

**Privacidad: el emparejamiento es obligatorio antes de leer.** Un JWT válido
por sí solo ya NO basta para leer cualquier `deviceId` — hay que emparejar
primero (sección 5.0). Esto evita que cualquier usuario autenticado pueda
espiar los datos de otra persona con solo adivinar/probar un `deviceId`.

El simulador web **nunca** usa certificados X.509 (eso es solo para
dispositivos físicos con TLS mutuo). Usa un token JWT de Cognito por HTTPS
normal, igual que cualquier aplicación web.

## 1. Qué existe después de `cdk deploy`

El stack expone 3 outputs (visibles al correr `cdk deploy` o en CloudFormation
→ el stack `SenseCareDemoStack` → pestaña **Outputs**):

- `DemoUserPoolId` — el User Pool de Cognito.
- `DemoUserPoolClientId` — el cliente (sin secreto) que usa el navegador.
- `DemoIngestApiUrl` — la URL base del API, algo como
  `https://abc123xyz.execute-api.us-east-1.amazonaws.com/`.

## 2. Crear un usuario de demo (una sola vez, quien tenga AWS CLI)

No hay auto-registro. Se crea a mano:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <DemoUserPoolId> \
  --username sim-operator \
  --temporary-password "Temp1234!" \
  --message-action SUPPRESS \
  --region us-east-1

aws cognito-idp admin-set-user-password \
  --user-pool-id <DemoUserPoolId> \
  --username sim-operator \
  --password "SimuladorDemo2026!" \
  --permanent \
  --region us-east-1
```

`--permanent` evita el flujo de "cambia tu contraseña la primera vez", que
complicaría integrarlo directo en el simulador web.

## 3. Obtener un JWT (esto sí lo hace el navegador, en cada sesión)

```bash
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id <DemoUserPoolClientId> \
  --auth-parameters USERNAME=sim-operator,PASSWORD=SimuladorDemo2026! \
  --region us-east-1
```

La respuesta trae `AuthenticationResult.IdToken` — ese es el JWT. Dura 1
hora (`accessTokenValidity`/`idTokenValidity` en `DemoAuth`).

Desde JavaScript en el navegador, el equivalente es llamar al mismo endpoint
`InitiateAuth` de Cognito con `amazon-cognito-identity-js` o el SDK de AWS
para el navegador — no hay que reinventar el protocolo, solo mandar
`USERNAME`/`PASSWORD` y guardar el `IdToken` devuelto.

## 4. Mandar telemetría

```bash
curl -X POST "https://<DemoIngestApiUrl>/demo/devices/sim-room-01/events" \
  -H "Authorization: Bearer <IdToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "550e8400-e29b-41d4-a716-446655440000",
    "deviceId": "sim-room-01",
    "occurredAt": "2026-09-24T18:30:00Z",
    "firmwareVersion": "1.0.0",
    "temperatureC": 24.1,
    "humidityPct": 45,
    "co2Ppm": 700,
    "proximityCm": 200,
    "dbAvg": 32.1,
    "dbPeak": 40.5
  }'
```

Respuesta esperada: `202 { "accepted": true, "eventId": "..." }`.

## 5. Mandar una anomalía de sensor

Mismo endpoint, mismo `deviceId`, agregando `eventType`, `anomalyType`,
`severity`, `sensorRule` y `sensors` (ver
[SIMULATOR_INTEGRATION_GUIDE.md](SIMULATOR_INTEGRATION_GUIDE.md) sección
4.2 para el schema completo). El backend deduplica por `eventId` y abre/
reutiliza un `AnomalyCase` igual que si viniera de una Pi real por MQTT.

## 5.0 Emparejar un dispositivo por QR (obligatorio antes de leer)

Cada dispositivo (físico o simulado) tiene un `pairingCode` propio, guardado
en `SenseCare-Devices` y **nunca** devuelto por ninguna ruta de lectura. El
QR que se muestra junto al dispositivo (pantalla del simulador, o una
etiqueta impresa cerca de la Pi) codifica un JSON plano con ambos datos:

```json
{ "deviceId": "sim-room-01", "pairingCode": "AB12CD" }
```

La app que escanea el QR extrae esos dos campos y llama:

```bash
curl -X POST "https://<DemoIngestApiUrl>/devices/sim-room-01/pair" \
  -H "Authorization: Bearer <IdToken>" \
  -H "Content-Type: application/json" \
  -d '{ "pairingCode": "AB12CD" }'
```

Respuesta si el código coincide: `200 { "paired": true, "deviceId": "sim-room-01" }`.
A partir de ahí, **ese usuario** (identificado por el `sub` de su JWT, no por
el dispositivo desde el que llama) puede usar `GET .../latest` y
`GET .../telemetry` para ese `deviceId` — desde cualquier app, cualquier
sesión, mientras vuelva a loguearse con la misma cuenta de Cognito.

El emparejamiento es por-usuario, no por-instalación: si dos personas
distintas escanean el mismo QR con sus propias cuentas, ambas quedan
emparejadas de forma independiente (dos filas en `CaregiverAccess`, cada
una con su propio `sub`). Nadie más puede leer ese dispositivo sin también
escanear el QR (o conocer el código) y emparejarse.

El código sirve también como respaldo manual si la cámara falla: puede
escribirse a mano, la comparación no distingue mayúsculas/minúsculas ni
espacios.

## 5.1 Consultar la última lectura de un dispositivo (simulador o app móvil)

Requiere haber emparejado primero (sección 5.0); si no, responde `403`.

```bash
curl "https://<DemoIngestApiUrl>/devices/pi-demo-01/latest" \
  -H "Authorization: Bearer <IdToken>"
```

Respuesta:

```json
{
  "deviceId": "pi-demo-01",
  "lastSeenAt": "2026-09-24T18:30:00Z",
  "latestTelemetry": {
    "deviceId": "pi-demo-01",
    "occurredAt": "2026-09-24T18:30:00Z",
    "temperatureC": 27.3,
    "humidityPct": 48.1,
    "co2Ppm": 840,
    "proximityCm": 12,
    "dbAvg": 32.1,
    "dbPeak": 40.5,
    "receivedAt": "2026-09-24T18:30:01.203Z"
  }
}
```

Si el dispositivo nunca ha reportado, `lastSeenAt` y `latestTelemetry` vienen
`null` (no es un error, es `200`).

## 5.2 Consultar historial para graficar (simulador o app móvil)

```bash
curl "https://<DemoIngestApiUrl>/devices/pi-demo-01/telemetry?from=2026-09-24T00:00:00Z&to=2026-09-24T23:59:59Z&limit=200" \
  -H "Authorization: Bearer <IdToken>"
```

`from`, `to` y `limit` son opcionales. `from`/`to` deben ser ISO-8601 UTC
terminados en `Z` (igual formato que `occurredAt`). Sin `limit`, regresa
hasta 100 lecturas; el máximo permitido es 500 por llamada — para rangos más
largos, pedir varias páginas moviendo `from`. Respuesta:

```json
{ "deviceId": "pi-demo-01", "count": 2, "items": [ { "...": "..." }, { "...": "..." } ] }
```

Los resultados vienen ordenados del más viejo al más nuevo dentro del rango.

## 6. `deviceId` permitidos (solo aplica a la ruta de ESCRITURA)

Solo `sim-room-01` está en la allowlist de **ingesta** por ahora (variable de
entorno `DEMO_DEVICE_ALLOWLIST` de la Lambda `SenseCare-demoIngest`, definida
en `infra/lib/sensecare-demo-stack.ts`). Cualquier otro `deviceId` — incluido
`pi-demo-01`, el de la Pi física — responde `403` en `POST
/demo/devices/{deviceId}/events` a propósito: este camino HTTPS nunca debe
poder suplantar a un dispositivo con certificado X.509 real. Para agregar más
"salas" simuladas, añadir el `deviceId` a la lista en el stack y volver a
desplegar.

Esta allowlist **no aplica** a las rutas de lectura: lo que las protege es
el emparejamiento (sección 5.0), no esta lista.

## 7. Requisito antes de usar el dispositivo: sembrarlo con su `pairingCode`

Igual que con la Pi física (ver
[DEVICE_PROVISIONING_AND_SMOKE_TEST.md](DEVICE_PROVISIONING_AND_SMOKE_TEST.md)
sección 1), la tabla `SenseCare-Devices` necesita una fila para
`sim-room-01` antes de que la telemetría se acepte río abajo (si no, el
mensaje llega a SQS pero la Lambda de ingesta lo rechaza por
`DeviceNotFoundError` y termina en la DLQ tras varios reintentos). Ahora
también hay que incluir `pairingCode` — sin él, nadie puede emparearse ni
leer ese dispositivo:

```bash
aws dynamodb put-item \
  --table-name SenseCare-Devices \
  --region us-east-1 \
  --item '{
    "deviceId": {"S": "sim-room-01"},
    "recipientId": {"S": "recipient-demo-01"},
    "pairingCode": {"S": "AB12CD"},
    "createdAt": {"S": "2026-09-24T00:00:00Z"}
  }' \
  --condition-expression "attribute_not_exists(deviceId)"
```

Genera el código con algo no adivinable, por ejemplo:

```bash
openssl rand -hex 3 | tr 'a-z' 'A-Z'   # ej: 7F3A0B
```

Si `pi-demo-01` ya existía sin `pairingCode` (sembrado antes de este
cambio), agrégaselo con `update-item`:

```bash
aws dynamodb update-item \
  --table-name SenseCare-Devices \
  --region us-east-1 \
  --key '{"deviceId": {"S": "pi-demo-01"}}' \
  --update-expression "SET pairingCode = :code" \
  --expression-attribute-values '{":code": {"S": "9K2M7X"}}'
```

## Errores comunes

| Código | Causa |
| --- | --- |
| `401` | Falta el header `Authorization`, o el JWT expiró (dura 1 hora, vuelve a `initiate-auth`) |
| `403` con `"deviceId no autorizado"` | El `deviceId` no está en la allowlist, o no coincide entre la URL y el cuerpo del JSON |
| `403` con `"eventType ... no permitido"` | Se intentó mandar `VISUAL_ANOMALY`; el simulador web nunca puede producirla |
| `400` (en `POST .../events`) | El JSON no pasa el schema — revisar `details` en la respuesta |
| `400` (en `GET .../telemetry`) | `from`/`to` no es ISO-8601 UTC terminado en `Z`, o `limit` no es un entero positivo |
| El mensaje nunca llega a DynamoDB | Falta sembrar `sim-room-01` en `SenseCare-Devices` (paso 7) |
| `GET .../latest` responde `lastSeenAt: null` | El dispositivo nunca ha publicado telemetría, o su `deviceId` está mal escrito |
| `403` en `POST .../pair` | El `pairingCode` no coincide con el guardado en `SenseCare-Devices` |
| `404` en `POST .../pair` | El `deviceId` no existe en `SenseCare-Devices` (falta sembrarlo, paso 7) |
| `403` en `GET .../latest` o `.../telemetry` con `"No tienes acceso a este dispositivo"` | El usuario nunca emparejó ese `deviceId` — llamar primero a `POST .../pair` (sección 5.0) |
