# gateway-sim

Simulador local de la Raspberry Pi/gateway. Genera telemetría y anomalías de
sensor **válidas contra los mismos JSON Schema** que usará el gateway real
(`@sensecare/contracts`) y las imprime como NDJSON a `stdout`, con el topic
MQTT que correspondería a cada evento.

No abre ninguna conexión de red, no publica a AWS IoT Core y no sube nada a
S3. Es exclusivamente un generador de datos de prueba para validar contratos
y para ensayar consumidores (Lambdas, tests de integración) antes de tener
hardware real.

## Uso

```bash
# una sola vuelta (telemetría + posible anomalía de sensor)
npm run start -w @sensecare/gateway-sim -- --once

# loop continuo, telemetría cada 5s, anomalía de sensor cada 6 ticks
npm run start -w @sensecare/gateway-sim -- --interval-ms=5000 --sensor-anomaly-every=6

# deviceId distinto
npm run start -w @sensecare/gateway-sim -- --once --device-id=pi-demo-02
```

Salida (una línea NDJSON por evento):

```json
{"topic":"SenseCare/v1/devices/pi-demo-01/telemetry","payload":{"eventId":"...","deviceId":"pi-demo-01","occurredAt":"...Z","firmwareVersion":"0.1.0", "...": "..."}}
```

## `--emit-visual-fixture`

Emite un único evento `VISUAL_ANOMALY` de ejemplo (`PERSON_PRONE_INACTIVE`)
antes de iniciar el loop de telemetría.

**Esto es exclusivamente un fixture interno para probar el contrato**, no el
camino de demo real. El demo visual (habitación física o animación
reproducida en pantalla) siempre debe pasar por la cámara física de la
Raspberry Pi y su pipeline de visión local — nunca por un atajo desde el
navegador o este simulador hacia AWS. El simulador web de demo autenticado
sólo puede inyectar telemetría/anomalías de **sensor**, nunca eventos
visuales (ver `docs/EDGE_IMPLEMENTATION_GUIDE.md` y
`docs/ARCHITECTURE_DETAILED.md`).

## Qué NO hace este simulador

- No se conecta a AWS IoT Core ni usa certificados X.509.
- No implementa el adaptador HTTPS del simulador web de demo
  (`POST /demo/devices/{deviceId}/events`) — eso es una pieza de backend
  (Hito 5) fuera de esta ola.
- No simula `UPLOAD_EVIDENCE`, `COMMAND_ACK` ni `EVIDENCE_UPLOADED/FAILED`
  todavía; esos contratos ya están definidos en `@sensecare/contracts` y
  cubiertos por sus propias pruebas, pero su simulación de intercambio
  completo queda para una ola posterior.
