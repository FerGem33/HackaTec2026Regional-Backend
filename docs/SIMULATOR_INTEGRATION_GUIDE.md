# SenseCare — guía de integración para el simulador de demo

Esta guía sirve a quien construya el simulador de la habitación. Define qué
puede enviar, qué puede consultar y qué queda deliberadamente fuera de su
alcance. El simulador no es un segundo gateway ni un atajo hacia los servicios
críticos: es una fuente controlada de datos de sensores y una interfaz de
consulta para el demo.

El contrato ejecutable es el contenido de
[`packages/contracts/schemas/`](../packages/contracts/schemas/). Los ejemplos
de este documento son ilustrativos; el JSON Schema es la fuente de verdad.

## 1. Dos caminos de demo que no se deben mezclar

| Escenario | Origen | Cómo llega a AWS | Quién puede producirlo |
| --- | --- | --- | --- |
| Sensores físicos | ESP32 → Raspberry Pi | MQTT TLS de la Pi a AWS IoT Core | La Pi |
| Sensores simulados | Interfaz web de la habitación | HTTPS autenticado a la API de demo; el backend lo normaliza a la misma ingesta | El simulador web, sólo con `deviceId` de demo permitido |
| Riesgo visual real | Cámara física de la Pi ve una habitación | La Pi ejecuta visión local y publica una anomalía MQTT | La Pi |
| Riesgo visual con animación | Una pantalla reproduce la animación; la cámara física de la Pi la ve | Exactamente el mismo pipeline visual de la Pi | La Pi, nunca el navegador |

La regla importante es: **el navegador no publica `VISUAL_ANOMALY`**. Una
animación sirve para ensayar el detector de visión porque la cámara la observa;
no sirve para inventar un evento desde la interfaz. Así el demo demuestra el
flujo edge real.

## 2. Estado actual y puntos de integración futuros

Hoy existen schemas, validadores y un simulador local de gateway. Aún no hay
AWS desplegado, API HTTP, autenticación ni base de datos.

| Pieza | Estado | Qué puede hacer la persona del simulador |
| --- | --- | --- |
| `@sensecare/contracts` | Disponible | Importar validadores/tipos o cargar los JSON Schema para validar fixtures. |
| `@sensecare/gateway-sim` | Disponible | Generar NDJSON local de telemetría y anomalías de sensor para ensayos. |
| MQTT/AWS IoT, SQS, DynamoDB | Próximo hito | No usar credenciales AWS ni conectar el navegador directamente. |
| `POST /demo/devices/{deviceId}/events` | Hito 5; no existe aún | Preparar un adaptador/mocking local, sin asumir URL o JWT definitivos. |
| Consulta de estado/casos | Hito 5; no existe aún | Diseñar la UI contra un `DemoApi` intercambiable y usar fixtures locales por ahora. |

Una estructura práctica para el simulador web es separar:

```text
simulator-ui/
  domain/              estado de habitación, escenarios y conversiones a eventos
  fixtures/            payloads que pasan los JSON Schema
  api/DemoApi.ts       interfaz de envío/consulta
  api/LocalDemoApi.ts  implementación temporal en memoria
  api/HttpDemoApi.ts   implementación futura; POST/GET al backend
  ui/                  controles y visualización
```

No hagan que componentes de interfaz construyan JSON MQTT ni conozcan tokens,
topics o reglas de emergencia.

## 3. Flujo cuando el sistema esté completo

```text
Controles del simulador ──► Telemetry o SENSOR_ANOMALY
                                  │ HTTPS + JWT (sólo deviceId demo)
                                  ▼
                         demoIngestHandler
                                  │ valida schema, asigna origen DEMO
                                  ▼
                        misma cola/ingesta que AWS IoT
                                  ▼
              Devices, Telemetry, EventLog y AnomalyCase
                                  │
                         API de consulta ◄── UI consulta cada 2–5 s

Pantalla con animación ──► cámara física Pi ──► visión local ──► VISUAL_ANOMALY
                                                              │ MQTT TLS
                                                              └──► misma ingesta
```

Una `SENSOR_ANOMALY` o `VISUAL_ANOMALY` puede abrir o enriquecer un caso. El
backend deduplica por `eventId` y evita casos simultáneos equivalentes. Si un
caso requiere evidencia, **la nube ordena a la Pi**, no al navegador, capturar
una imagen puntual. La Pi recibe `UPLOAD_EVIDENCE`, sube a la URL prefirmada y
publica el resultado.

El simulador puede mostrar en pantalla que existe un caso o que un familiar lo
canceló, pero nunca invoca Amazon Connect ni decide el escalamiento. Esa acción
pertenece al backend y a la política determinista.

## 4. Datos que el simulador puede enviar

### 4.1 Telemetría (`Telemetry`)

La telemetría representa una lectura normal: no abre por sí sola un caso. En
el demo se enviará por el futuro endpoint HTTPS y el backend la tratará como
si hubiera llegado por el topic MQTT de telemetría.

Campos obligatorios:

| Campo | Regla |
| --- | --- |
| `eventId` | UUID v4 nuevo por publicación. Nunca reutilizarlo al cambiar una lectura. |
| `deviceId` | Identificador minúsculo, por ejemplo `pi-demo-01`. Debe pertenecer a la allowlist de demo. |
| `occurredAt` | Fecha UTC real, ISO-8601 terminada en `Z`, por ejemplo `2026-09-23T18:30:00Z`. |
| `firmwareVersion` | SemVer, por ejemplo `0.1.0` o `simulator-1.0.0` no es válido; usar `1.0.0`. |

Los sensores son opcionales en el contrato porque el hardware puede variar:
`temperatureC`, `humidityPct`, `co2Ppm`, `proximityCm` y `motion`.

```json
{
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "deviceId": "pi-demo-01",
  "occurredAt": "2026-09-23T18:30:00Z",
  "firmwareVersion": "1.0.0",
  "temperatureC": 28.2,
  "humidityPct": 46,
  "co2Ppm": 950,
  "proximityCm": 120,
  "motion": false
}
```

Para el perfil de demo, una lectura cada 5 segundos es suficiente. En uso
normal la Pi puede publicar cada 30–60 segundos. No intenten simular tiempo
real enviando decenas de eventos por segundo.

### 4.2 Anomalía de sensor (`SENSOR_ANOMALY`)

Úsela sólo cuando el estado de la habitación representa una condición que la
regla local habría sostenido. La anomalía incluye las lecturas que la justifican
y la regla aplicada; no se manda texto libre ni un diagnóstico médico.

Campos extra obligatorios:

| Campo | Valores / regla |
| --- | --- |
| `eventType` | Siempre `SENSOR_ANOMALY`. |
| `anomalyType` | `POOR_AIR_QUALITY`, `TEMPERATURE_ALERT`, `SENSOR_FAULT`, `POSSIBLE_CO_EXPOSURE`, `POSSIBLE_GAS_LEAK` o `POSSIBLE_FIRE`. |
| `severity` | `warning` o `critical`. |
| `sensorRule` | `ruleVersion`, `windowSeconds` mayor que cero y `trigger`. |
| `sensors` | Al menos una lectura numérica que respalda el evento. |

```json
{
  "eventId": "550e8400-e29b-41d4-a716-446655440001",
  "eventType": "SENSOR_ANOMALY",
  "deviceId": "pi-demo-01",
  "occurredAt": "2026-09-23T18:31:00Z",
  "anomalyType": "POOR_AIR_QUALITY",
  "severity": "warning",
  "sensorRule": {
    "ruleVersion": "demo-air-v1",
    "windowSeconds": 120,
    "trigger": "co2Ppm >= 1200 sostenido"
  },
  "sensors": { "co2Ppm": 1350, "temperatureC": 29.1 }
}
```

`CO2` indica ventilación deficiente; no debe usarse para afirmar incendio,
monóxido de carbono o fuga de gas. Los tres tipos específicos sólo se usan si
la simulación declara que representa un sensor específico equivalente. Para el
demo físico no se debe producir humo, flama ni gas: usen valores simulados o
la animación de pantalla.

### 4.3 Lo que el simulador web no puede enviar

- `VISUAL_ANOMALY`: la única fuente válida es la Pi tras observar la cámara.
- `UPLOAD_EVIDENCE`, `COMMAND_ACK`, `EVIDENCE_UPLOADED` o `EVIDENCE_FAILED`:
  pertenecen al canal privado nube ↔ Pi.
- `recipientId`: AWS deriva la persona monitorizada a partir de `deviceId`.
- URLs de S3, llaves S3, certificados IoT, `taskToken`, números telefónicos,
  consentimientos o decisiones de emergencia.

## 5. Datos que la interfaz recibirá

Las rutas definitivas se implementan en Hito 5; la interfaz debe encapsularlas
tras `DemoApi`. La intención es esta:

| Operación planeada | Uso de UI | Respuesta esperada |
| --- | --- | --- |
| `GET /devices/{deviceId}/latest` | Panel de valores en vivo | Última telemetría, hora de recepción y estado del dispositivo. |
| `GET /devices/{deviceId}/telemetry?from=&to=` | Gráficas/historial | Lista paginada de telemetría, no stream de video. |
| `GET /cases/{caseId}/events` | Línea de tiempo de un incidente | Eventos sanitizados: apertura, evidencia solicitada/recibida, alerta, respuesta y escalamiento. |
| Ruta de casos del familiar | Bandeja de alertas | Casos abiertos permitidos por su relación `CaregiverAccess`. |
| Acción de familiar autorizada | Botones de demo | `CANCEL_ALERT` o `ESCALATE`, auditados y asociados a un caso. |

La primera versión puede consultar cada 2–5 segundos. No hace falta WebSocket
para el hackathon. La interfaz debe mostrar **hora del dato** y marcarlo como
obsoleto si no se actualiza; no presentar una lectura vieja como si fuera en
vivo.

Las respuestas no incluirán foto, audio, prompts de LLM, perfiles médicos
completos, certificados ni tokens. Si se requiere mostrar una foto de
evidencia en el futuro, la API autorizará una URL prefirmada de duración corta
para un familiar autorizado; no se expondrá la llave del bucket como URL
pública.

## 6. Canales MQTT de la Pi (referencia, no para el navegador)

| Dirección | Topic | Payload |
| --- | --- | --- |
| Pi → nube | `SenseCare/v1/devices/{deviceId}/telemetry` | `Telemetry` |
| Pi → nube | `SenseCare/v1/devices/{deviceId}/visual/anomaly` | `VISUAL_ANOMALY` |
| Pi → nube | `SenseCare/v1/devices/{deviceId}/sensor/anomaly` | `SENSOR_ANOMALY` |
| Nube → Pi | `SenseCare/v1/devices/{deviceId}/commands` | `UPLOAD_EVIDENCE` |
| Pi → nube | `SenseCare/v1/devices/{deviceId}/command-acks` | `COMMAND_ACK` |
| Pi → nube | `SenseCare/v1/devices/{deviceId}/evidence` | `EVIDENCE_UPLOADED` o `EVIDENCE_FAILED` |

Las publicaciones de la Pi usarán MQTT QoS 1. Cada publicación lleva un
`eventId` UUID v4 para deduplicación. En los mensajes de command/evidence,
`commandId` correlaciona la orden y `caseId` el incidente; el `deviceId` se
obtiene del topic y se comprueba contra la orden pendiente.

## 7. Preparar el simulador desde ahora

1. Define estados de habitación, no eventos aislados: temperatura, humedad,
   CO₂, presencia/movimiento y un escenario seleccionado.
2. Al cambiar un control, genera una telemetría válida con nuevo `eventId`.
3. Sólo después de que el escenario supere una ventana simulada, genera la
   `SENSOR_ANOMALY` que corresponde. Ejemplo: CO₂ alto durante 120 segundos,
   no al mover un slider una sola vez.
4. Implementa `LocalDemoApi` para guardar la última lectura, historial y casos
   ficticios; permitirá avanzar la UI sin backend.
5. Implementa después `HttpDemoApi` contra la ruta oficial, sin modificar
   los componentes de interfaz.
6. Para la parte visual, prepara videos/animaciones que la cámara de la Pi
   pueda ver. Prueben iluminación, encuadre, reflejos, resolución y distancia;
   la animación no debe tener una salida de software hacia AWS.

## 8. Checklist de seguridad y demo

- [ ] Cada evento usa UUID v4 y hora UTC real.
- [ ] Se valida contra los archivos JSON Schema antes de enviarse.
- [ ] Sólo se usan `deviceId` de demo en el endpoint de demo.
- [ ] El navegador no posee credenciales IoT, certificado X.509 ni permisos
      AWS directos.
- [ ] No se simulan eventos visuales por HTTP; la cámara real los genera.
- [ ] No se ponen fotos, audio, nombres, enfermedades o números telefónicos
      dentro de telemetría o anomalías.
- [ ] Ningún botón de UI llama directamente a emergencias. Sólo una respuesta
      autorizada llega al backend; el backend decide el resto.
- [ ] La interfaz comunica que los tipos son riesgos posibles, no diagnósticos
      ni acusaciones.

## 9. Ensayo local disponible hoy

Desde la raíz del repositorio:

```bash
npm install
npm test
npm run start -w @sensecare/gateway-sim -- --once
npm run start -w @sensecare/gateway-sim -- --once --emit-visual-fixture
```

El último comando emite un `VISUAL_ANOMALY` solamente como fixture de contrato.
No debe conectarse a la interfaz ni presentarse como el flujo visual del demo.
