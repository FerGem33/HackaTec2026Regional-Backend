# SenseCare — desarrollo del monorepo (contratos, pruebas y simulador)

Alcance de este documento: cómo instalar dependencias, ejecutar las pruebas
de los contratos compartidos y correr el simulador local de gateway. No
cubre despliegue de infraestructura ni configuración de la Raspberry Pi
real (ver [EDGE_IMPLEMENTATION_GUIDE.md](EDGE_IMPLEMENTATION_GUIDE.md) y
[IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)).

## Estructura

```text
packages/contracts/     JSON Schema + validadores Ajv + tipos TS compartidos
simulators/gateway-sim/ Simulador local de telemetría/anomalías (sin MQTT real)
infra/                  Esqueleto CDK de SenseCareDemoStack (sin recursos aún)
```

## Requisitos

- Node.js 20 o superior (probado con Node 22).
- npm 9 o superior (usa npm workspaces).

## Instalación

```bash
npm install
```

Instala las dependencias de todos los workspaces (`packages/*`,
`simulators/*`, `infra`).

## Contratos compartidos (`packages/contracts`)

Los JSON Schema en `packages/contracts/schemas/` son la fuente de verdad en
tiempo de ejecución para: `Telemetry`, `VISUAL_ANOMALY`, `SENSOR_ANOMALY`,
`UPLOAD_EVIDENCE`, `COMMAND_ACK` y el resultado de evidencia
(`EVIDENCE_UPLOADED` / `EVIDENCE_FAILED`, en un único schema
`evidenceResult.schema.json` porque ambos son las dos salidas posibles del
mismo comando). Cada schema es un archivo JSON Schema draft 2020-12
autocontenido (sin `$ref` entre archivos) para que el responsable edge
pueda reutilizarlo tal cual con `jsonschema` en Python, sin necesidad de un
resolver de referencias cruzadas.

`src/types.ts` mantiene tipos TypeScript escritos a mano en espejo de los
schemas (no generados automáticamente). Si cambia un contrato, actualiza el
schema y este archivo juntos.

Notas de validación adicionales:

- `occurredAt`/`expiresAt` usan `"format": "date-time"` con un validador
  propio (`src/formats.ts`) que rechaza fechas sintácticamente válidas pero
  inexistentes (30 de febrero, mes 13, 29 de febrero en año no bisiesto,
  etc.), además del `pattern` de forma. Un integrador en Python debe
  habilitar un `FormatChecker` RFC3339 equivalente
  (`jsonschema.FormatChecker`) para obtener la misma garantía sobre estos
  mismos archivos `.schema.json`.
- `COMMAND_ACK`, `EVIDENCE_UPLOADED` y `EVIDENCE_FAILED` incluyen `eventId`
  (UUID v4) para deduplicación en MQTT QoS 1; `commandId` sigue
  correlacionando la orden y `caseId` el incidente.
- `COMMAND_ACK` exige `reason` cuando `accepted:false` y lo prohíbe cuando
  `accepted:true` (mutuamente excluyentes).
- Semántica confirmada de `VISUAL_ANOMALY`: `anomalyType` es el riesgo
  local que abrió el evento; `candidates` son hipótesis/señales
  alternativas consideradas por el modelo y **no** tienen por qué incluir
  `anomalyType` (ver el ejemplo canónico en `ARCHITECTURE_DETAILED.md`).
  No existe ni debe existir una regla de schema o de dominio que rechace
  eventos por esto; ambos campos siguen siendo enums cerrados, sin texto
  libre.

Estos paquetes (`packages/contracts`, `simulators/gateway-sim`) se ejecutan
en esta ola mediante `vitest`/`tsx`, sin paso de `build` explícito. Un
futuro empaquetado para Lambda (Hito 4 en adelante) añadirá compilación
explícita.

## Pruebas

```bash
npm test
```

Ejecuta Vitest sobre `packages/contracts` y `simulators/gateway-sim`,
validando payloads válidos e inválidos contra los seis contratos y
verificando que los generadores del simulador producen eventos que pasan
sus propios schemas.

## Simulador local de gateway

```bash
npm run start -w @sensecare/gateway-sim -- --once
npm run start -w @sensecare/gateway-sim -- --interval-ms=5000 --sensor-anomaly-every=6
```

Genera telemetría y anomalías de sensor válidas (mismos schemas que usará
el gateway real) y las imprime como NDJSON a `stdout` con el topic MQTT
correspondiente. No abre ninguna conexión de red ni publica a AWS IoT Core.
Ver [simulators/gateway-sim/README.md](../simulators/gateway-sim/README.md)
para el detalle de flags, incluido `--emit-visual-fixture` (fixture interno
de pruebas, no el camino real del demo visual).

## Infraestructura (esqueleto, sin desplegar)

`infra/` define `SenseCareDemoStack` con comentarios `TODO` por grupo de
recursos (Hito 2 en adelante de
[IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)). No instancia
recursos AWS todavía.

```bash
npx tsc -p infra/tsconfig.json --noEmit   # chequeo de tipos del esqueleto
```

No ejecutar `cdk synth`, `cdk diff` ni `cdk deploy` con intención de
aprovisionar sin instrucción explícita del coordinador; cuando corresponda,
seguir la secuencia de `CLAUDE.md`/`AGENTS.md` (pruebas, `cdk synth
--strict`, `cdk diff`, revisión humana, sin hotswap).
