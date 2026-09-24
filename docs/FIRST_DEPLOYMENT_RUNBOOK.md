# SenseCare — runbook del primer despliegue de integración

Este runbook cubre el primer despliegue real de `SenseCareDemoStack`
(Hito 2 + primer tramo de Hito 4) y el primer flujo de prueba de punta a
punta:

```
Pi/simulador MQTT → IoT Rule → SQS → Lambda → DynamoDB → EventBridge → Step Functions
```

Ningún paso de este documento lo ejecuta un agente de Claude Code. Todos los
comandos aquí los ejecuta una persona, desde su propia máquina, con sus
propias credenciales AWS.

## Orden de las fases

**El despliegue va primero.** Sólo después de que el stack exista se hace el
seed manual de `Devices` y se aprovisiona el Thing/certificado/política; sólo
después de eso se prueba con el MQTT Test Client.

```
1. Desplegar el stack
2. Seed manual de Devices
3. Aprovisionar Thing + certificado X.509 + adjuntar la política
4. Verificaciones previas
5. Prueba con AWS IoT MQTT Test Client
6. Conectar la Pi real
```

## 1. Desplegar el stack

Prerrequisitos de cuenta/región: una sola cuenta/región AWS ya elegida
(Hito 0 del roadmap), con `aws sts get-caller-identity` verificado.

```bash
cdk bootstrap aws://ACCOUNT_ID/REGION   # una sola vez por cuenta/región
npm test
npx tsc -p infra/tsconfig.json --noEmit
npx cdk synth --strict
npx cdk diff SenseCareDemoStack
npx cdk deploy SenseCareDemoStack
```

Revisar el `cdk diff` antes de confirmar el deploy. No usar hotswap.

## 2. Seed manual de `Devices`

No existe todavía un endpoint de alta (llega en Hito 5). Después de que la
tabla exista (paso 1), dar de alta el dispositivo de demo:

```bash
aws dynamodb put-item \
  --table-name SenseCare-Devices \
  --item '{
    "deviceId": {"S": "pi-demo-01"},
    "recipientId": {"S": "recipient-demo-01"},
    "createdAt": {"S": "2026-09-23T00:00:00Z"}
  }' \
  --condition-expression "attribute_not_exists(deviceId)"
```

`recipientId: "recipient-demo-01"` es un identificador de prueba, nunca un
dato médico real. La condición evita pisar un seed existente por accidente.

## 3. Aprovisionar Thing + certificado X.509 + política

Fuera de CDK y fuera de git, ejecutado por el responsable de credenciales en
su propia máquina:

```bash
aws iot create-thing --thing-name pi-demo-01
aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile device.pem.crt \
  --public-key-outfile public.pem.key \
  --private-key-outfile private.pem.key
aws iot attach-thing-principal --thing-name pi-demo-01 --principal <certificateArn>
aws iot attach-policy --policy-name SenseCare-device-access --target <certificateArn>
```

**Identidad consistente, no negociable:** `ThingName`, el `clientId` MQTT que
usará la Pi al conectarse, y `deviceId` deben ser **exactamente el mismo
valor** (`pi-demo-01`). La política `SenseCare-device-access` (creada por CDK
en el paso 1, ver `infra/lib/constructs/device-access-policy.ts`) usa
`${iot:Connection.Thing.ThingName}` para restringirse a los topics de ese
Thing; si el `clientId` no coincide con el `ThingName`, la variable no
resuelve al `deviceId` esperado y la Pi no podrá publicar/suscribirse a sus
propios topics.

**Orden estricto: `attach-thing-principal` antes de `attach-policy`, y ambos
antes de conectar la Pi.** La política exige la condición
`iot:Connection.Thing.IsAttached: true` en cada permiso (Connect, Publish,
Subscribe, Receive): AWS IoT sólo la satisface si el certificado ya está
adjunto al Thing (`AttachThingPrincipal`) *antes* de que el dispositivo
intente conectarse. Adjuntar la política a un certificado que todavía no
está adjunto a ningún Thing no es suficiente — la conexión será rechazada
hasta que ambos adjuntos existan, en ese orden.

- Los archivos `.pem`/`.key` se entregan por canal privado y se guardan en
  `/etc/SenseCare/iot/` en la Pi (ver `EDGE_IMPLEMENTATION_GUIDE.md` §12).
  **Nunca** en este repositorio.
- Un agente de Claude Code no genera certificados ni ejecuta estos comandos.

## 4. Verificaciones previas

```bash
aws iot describe-endpoint --endpoint-type iot:Data-ATS
aws iot list-topic-rules
aws events list-rules --event-bus-name SenseCare
aws dynamodb get-item --table-name SenseCare-Devices \
  --key '{"deviceId": {"S": "pi-demo-01"}}'
```

Confirmar que las 3 IoT Rules de Hito 2, la regla `SenseCare-AnomalyDetected`
de Hito 4, y el seed de `Devices` existen antes de continuar.

## 5. Prueba con AWS IoT MQTT Test Client (antes de la Pi real)

Desde la consola de AWS IoT Core → MQTT test client:

1. Suscribirse a `SenseCare/v1/devices/pi-demo-01/#`.
2. Publicar un mensaje `Telemetry` válido en
   `SenseCare/v1/devices/pi-demo-01/telemetry` → verificar que aparece en la
   tabla `Telemetry` y que `Devices.lastSeenAt` se actualiza.
3. Publicar un `VISUAL_ANOMALY` de prueba (usar el fixture de
   `gateway-sim --emit-visual-fixture` como referencia de forma, no como
   fuente real) en `.../visual/anomaly` → verificar:
   - una entrada nueva en `EventLog`,
   - una entrada nueva en `OpenCaseLocks`,
   - una ejecución **nueva** en la consola de Step Functions, con nombre
     igual al `caseId` generado,
   - una entrada nueva en `AnomalyCases` con `status: "DETECTED"`.
4. Publicar la **misma** anomalía otra vez (mismo `recipientId` +
   `anomalyType`) → confirmar que **no** aparece una segunda ejecución de
   Step Functions (mismo nombre, duplicado absorbido) y que
   `AnomalyCases.updatedAt` se refresca sin cambiar `createdAt`.

Sólo después de que esta prueba complete sin intervención manual adicional,
continuar al paso 6.

## 6. Conectar la Pi real

Cargar el certificado correcto en `/etc/SenseCare/iot/`, arrancar el
servicio `SenseCare-edge` (ver `EDGE_IMPLEMENTATION_GUIDE.md`) y repetir la
verificación del paso 5 con hardware real en vez del MQTT Test Client.

## Rollback y limpieza

- Las 5 tablas DynamoDB (`Devices`, `Telemetry`, `EventLog`,
  `OpenCaseLocks`, `AnomalyCases`) y el bucket de evidencia tienen
  `RemovalPolicy.RETAIN`: un `cdk destroy` completo **nunca** borra sus
  datos.
- Para revertir un cambio de código, hacer `cdk deploy` de una versión
  previa del stack — no `cdk destroy`.
- Para limpiar datos de prueba, borrar por clave conocida
  (`aws dynamodb delete-item`); nunca un `scan` + borrado masivo.
- Para revocar acceso de un certificado:
  `aws iot update-certificate --certificate-id <id> --new-status INACTIVE`.
  Esto no lo gestiona CDK.
- Antes de cualquier `cdk destroy`, confirmar qué recursos son compartidos o
  tienen datos reales (CLAUDE.md).
