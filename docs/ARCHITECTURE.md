# CareWatch — Arquitectura AWS para el MVP

## Propósito y alcance

CareWatch monitoriza de forma consentida a una persona en su hogar. Un ESP32 recoge telemetría ambiental y de presencia directamente en la nube; una laptop-gateway aporta cámara, micrófono y bocina. La cámara **no toma fotos periódicas**: sólo captura evidencia cuando una anomalía abre un caso.

El MVP puede hacer una llamada de *fallback* al número autorizado para el demo, nunca al 911. Como último recurso, el agente puede invocar la herramienta controlada `emergency_call`; ésta sólo marca tras comprobar riesgo alto, consentimiento explícito, falta de respuesta de la persona y de los familiares alertados, destino permitido e idempotencia. No es una capacidad de telefonía abierta del LLM.

## Arquitectura propuesta

Diagrama editable con iconos oficiales: [aws-architecture-mvp.svg](../diagrams/aws-architecture-mvp.svg).

```mermaid
flowchart LR
  subgraph Home[Hogar]
    S[ESP32 + sensores]
    G[Gateway: laptop<br/>cámara, audio y bocina]
  end

  subgraph AWS[AWS]
    I[AWS IoT Core<br/>MQTT + certificados X.509]
    R[IoT Rules]
    Q[SQS: telemetry queue]
    L[Lambda: ingestión<br/>y detección de reglas]
    D[(DynamoDB)]
    B[S3 privado<br/>fotos y audio opcional]
    V[Lambda: análisis visual]
    M[Amazon Bedrock<br/>agente de decisiones]
    E[EventBridge]
    W[Step Functions Standard<br/>orquestador por caseId]
    X[Lambda: captura / check-in]
    T[Transcribe<br/>transcripción de check-in]
    K[EscalationPolicy<br/>+ Amazon Connect]
    N[SNS<br/>email/SMS de alerta]
    A[API Gateway + Lambda API]
    C[Amazon Cognito]
  end

  subgraph Client[Aplicación del familiar]
    P[Web o móvil]
  end

  S -->|MQTT TLS| I
  I --> R --> Q --> L --> D
  L -->|AnomalyDetected| E --> W
  W --> X
  X -->|MQTT CAPTURE_IMAGE| G
  G -->|URL prefirmada| B
  B -->|ObjectCreated + caseId| V --> W
  W --> M
  M --> T
  M -->|propuesta| W
  W -->|alerta / check-in| N
  W -->|al vencer plazo| K
  P <-->|JWT| A
  C --> A
  A --> D
  A --> B
  P -->|consulta casos / responde| A
```

La laptop es un gateway deliberadamente: evita intentar ejecutar cámara, audio, subidas pesadas y modelos en el ESP32. En producción puede sustituirse por una Raspberry Pi, sin cambiar los contratos con la nube.

## Componentes

| Necesidad | Servicio / componente | Decisión para el MVP |
| --- | --- | --- |
| Identidad y conectividad del dispositivo | AWS IoT Core | Un `Thing` y certificado X.509 por ESP32 y por gateway; MQTT sobre TLS. |
| Ingreso confiable de telemetría | IoT Rule + SQS | La cola desacopla al dispositivo de la lógica y permite reintentos. |
| Datos de consulta rápida | DynamoDB | Estado actual, lecturas recientes, alertas, usuarios y vínculos de cuidado. |
| Evidencia multimedia | S3 privado | Fotos con URL prefirmada; sin acceso público. Ciclo de vida con borrado automático. |
| Orquestación de caso | Step Functions Standard | Ejecución durable por `caseId`: espera foto y respuestas, mide plazos y mantiene la historia del caso. |
| Coordinación de eventos | EventBridge | Inicia la ejecución y activa el watchdog de inactividad; no almacena ni espera estado. |
| Interpretación y decisión | Bedrock + despachador de herramientas | El agente propone severidad o evidencia adicional; no puede cerrar ni evitar el escalamiento por sí solo. |
| Escalamiento telefónico | Step Functions + EscalationPolicy + Amazon Connect | El timeout lleva siempre a la política determinista; el agente puede pedirlo antes, pero no es requisito para el fallback. |
| API de la aplicación | API Gateway + Lambda | REST, autorizada por Cognito. |
| Login y roles | Cognito | Roles mínimos: `caregiver` y `admin`; el usuario sólo accede a sus pacientes/dispositivos. |
| Alertas | SNS (MVP) | Email/SMS para demo; el dashboard consulta casos por API. |

AWS IoT Core usa MQTT y su Rules Engine puede enrutar mensajes hacia S3, DynamoDB, Lambda o SQS; aquí se elige SQS antes de Lambda para tolerar picos y errores transitorios. [Documentación de AWS IoT Core](https://docs.aws.amazon.com/iot/latest/developerguide/aws-iot-how-it-works.html)

## Flujos principales

### 1. Telemetría y presencia

1. El ESP32 publica una lectura cada 30–60 segundos a `carewatch/v1/devices/{deviceId}/telemetry` en AWS IoT Core con su certificado X.509.
2. Una regla IoT envía el mensaje a SQS. Lambda valida el esquema, deduplica por `eventId`, persiste la lectura y actualiza el estado actual.
3. La misma Lambda evalúa reglas con `timestamp` del dispositivo, no por orden de llegada, y adquiere un candado condicional `recipientId#anomalyType`. Sólo el primer evento inicia un caso abierto.

### 2. Investigación de una anomalía

1. EventBridge inicia una ejecución **Step Functions Standard** nombrada con el `caseId`.
2. La máquina verifica el consentimiento de cámara y envía `CAPTURE_IMAGE` con una URL prefirmada, llave S3 y `taskToken`. Espera un máximo de 60 s el `command-ack` y la foto; si faltan, conserva `evidenceIncomplete=true` y continúa.
3. `visionProcessor` asocia la imagen al `caseId` y devuelve la observación a la ejecución. Sólo entonces se invoca Bedrock con evidencia estructurada.
4. Un error, timeout o incertidumbre del análisis significa `uncertain`, nunca `safe` ni cierre automático.

### 3. Alerta y confirmación

1. La máquina inicia en paralelo un check-in de voz y alerta a los familiares. Ambos usan callback con `taskToken` y comparten el plazo `x`.
2. Una respuesta válida es: persona que responde a la pregunta esperada mediante check-in explícito, o familiar autorizado que confirma `SAFE`, `CONTACTING` o `ESCALATE`. La IA no puede emitir esa respuesta.
3. Una respuesta humana puede resolver o llevar el caso a revisión; el LLM no puede bajar severidad ni cerrar por sí solo.
4. Al vencer el plazo sin respuesta, Step Functions llama **siempre** a `EscalationPolicy`. Sólo ésta permite a `EmergencyDialer` usar Amazon Connect, tras comprobar consentimiento, riesgo, allowlist e idempotencia.

## Contratos MQTT iniciales

| Dirección | Topic |
| --- | --- |
| ESP32 → nube | `carewatch/v1/devices/{deviceId}/telemetry` |
| ESP32 → nube | `carewatch/v1/devices/{deviceId}/status` |
| Nube → gateway | `carewatch/v1/devices/{deviceId}/commands` |
| Gateway → nube | `carewatch/v1/devices/{deviceId}/command-acks` |
| Gateway → nube | `carewatch/v1/devices/{deviceId}/evidence` |

Ejemplo de telemetría:

```json
{
  "eventId": "01J...",
  "timestamp": "2026-09-23T18:30:00Z",
  "temperatureC": 27.3,
  "humidityPct": 48.1,
  "co2Ppm": 840,
  "proximityCm": 120,
  "motion": false,
  "firmwareVersion": "0.1.0"
}
```

No almacenar audio continuo en el MVP. Si se habilita voz, guardar sólo comandos activados intencionalmente (push-to-talk o palabra de activación), con aviso y consentimiento visible.

## Modelo de datos DynamoDB

| Tabla | PK / SK | Contenido |
| --- | --- | --- |
| `CareRecipients` | `recipientId` | Perfil mínimo, zona horaria y consentimientos granulares (`camera`, `voice`, `fallbackCall`). |
| `Devices` | `deviceId` | Estado, último contacto, `recipientId`, versión, configuración. |
| `Telemetry` | `deviceId` / `timestamp#eventId` | Lecturas normalizadas; TTL de 30–90 días para MVP. |
| `Alerts` | `recipientId` / `createdAt#alertId` | Severidad, evidencia, estado, confirmación y auditoría. |
| `Observations` | `recipientId` / `capturedAt#imageId` | Resultado visual, `caseId` y llave S3 con `caseId`. |
| `AnomalyCases` | `caseId` | Estado, evidencia, `executionArn`, task tokens cifrados, plazos y resultado. |
| `OpenCaseLocks` | `recipientId#anomalyType` | Candado condicional con TTL para impedir casos duplicados. |
| `EventLog` | `caseId` / `timestamp#eventId` | Trazabilidad de decisiones, herramientas, alertas y respuestas, sin material biométrico crudo. |
| `CaregiverAccess` | `userId` / `recipientId` | Relación uno-a-muchos de familiares, rol, prioridad y preferencias de alerta. |

## Motor de anomalías: fases

**Hackathon:** reglas interpretables y configurables: CO₂ alto sostenido, temperatura fuera de rango, inmovilidad durante `N` minutos dentro de horario activo, y watchdog programado que detecta ausencia de telemetría. La inmovilidad abre el caso; la foto puede confirmar o aportar contexto, pero no es requisito para dispararlo.

**Después:** guardar telemetría etiquetada y entrenar/pilotear detección de anomalías por persona. No presentar un modelo como diagnóstico médico ni actuar sólo por una predicción sin una política de seguridad.

## Seguridad, privacidad y costos

- Consentimiento revocable por persona monitoreada, incluyendo consentimiento independiente para cámara, voz y llamada de fallback; indicador físico de cámara/micrófono activos.
- Cifrado TLS en tránsito, S3/DynamoDB cifrados en reposo, mínimo privilegio IAM y certificados distintos por dispositivo.
- Políticas IoT restringidas a los topics de su propio `deviceId`; no usar credenciales AWS estáticas en ESP32 ni gateway.
- S3 privado, bloqueo de acceso público, URLs prefirmadas de corta vida y regla de ciclo de vida (por ejemplo, borrar fotos a los 7 días en demo).
- El MVP no incluye reconocimiento facial ni `create_profile_suggestion`; reducen el valor de demo frente a su costo de privacidad y complejidad.
- No pasar fotos, audio, perfiles médicos, tokens ni secretos por el estado de Step Functions; almacenar objetos privados en S3 y pasar sólo llaves/identificadores.
- `EscalationPolicy` exige riesgo alto, ausencia de respuesta de persona y familiares alertados, consentimiento vigente, destino permitido e idempotencia antes de invocar Amazon Connect.
- Aunque CloudWatch no sea una funcionalidad del producto, se mantiene una alarma mínima de DLQ → SNS para no perder fallos de entrega.

## Implementación sugerida en orden

1. Infraestructura como código: IoT, SQS, DynamoDB, Step Functions Standard, EventBridge, S3, Lambda, Cognito, API Gateway, SNS y alarma de DLQ.
2. Flujo simulado punta a punta: anomalía → espera/callback → alerta → timeout → política → llamada demo.
3. Simulador de ESP32/gateway y contratos MQTT de `command-acks` y evidencia.
4. API de familiares: casos, respuestas, consentimientos granulares y control de acceso.
5. Integrar foto/análisis y check-in de voz. Biometría y actualización de perfil quedan fuera del MVP.

## Decisiones aún necesarias

- Región AWS y cuenta disponible para el hackathon.
- Plataforma del cliente: web responsiva (la opción más rápida) o app móvil.
- Sensores que estarán realmente conectados al ESP32; el contrato permite que falten campos.
- Proveedor/modelo de análisis visual y si Bedrock está habilitado en su región. Si no, el adaptador `VisionAnalysisService` permitirá cambiarlo sin rediseñar la plataforma.
