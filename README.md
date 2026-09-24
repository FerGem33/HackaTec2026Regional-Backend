# SenseCare

Sistema ubicuo para monitorear y apoyar el cuidado consentido de una persona en su hogar. Proyecto para la categoría **Smart Software** de HackatecNM 2026.

SenseCare usa una Raspberry Pi 4B como gateway del hogar: recibe señales auxiliares de un ESP32 y ejecuta localmente detectores ligeros de riesgos visuales y reglas de sensores. Cualquiera de los dos detectores activa una investigación puntual: la Pi puede enviar una foto a AWS para análisis multimodal, pedir un check-in de voz y alertar a los familiares autorizados.

No pretende diagnosticar enfermedades ni sustituir atención médica.

## Problema

Una persona que requiere acompañamiento puede vivir sola o pasar periodos sin supervisión inmediata. Un familiar necesita conocer situaciones potencialmente riesgosas sin convertir el hogar en un sistema de vigilancia continua.

## Propuesta

El sistema evita capturas periódicas de cámara y audio. Sólo cuando una anomalía relevante abre un caso, reúne evidencia adicional y coordina una respuesta.

```text
ESP32 → Raspberry Pi + visión local + reglas de sensores → anomalía → evidencia puntual a AWS
                                                           → IA + herramientas → check-in / alerta → fallback
```

El fallback consiste en una llamada al número de demo previamente autorizado —nunca al 911 durante el hackathon— y sólo como último recurso.

## Flujo del MVP

1. El ESP32 entrega telemetría auxiliar a la Raspberry Pi por Wi-Fi local o serial.
2. La Pi ejecuta continuamente modelos ligeros de visión y reglas locales de sensores. Detecta candidatos de riesgo —caída, persona inmóvil, persona inesperada, humo/fuego o fallo de cámara— y sólo publica un evento cuando la evidencia temporal supera un umbral; no envía video continuo a la nube.
3. AWS crea/reutiliza un `AnomalyCase` y Step Functions Standard coordina callbacks y plazos. El simulador web de demo usa una API autenticada que produce los mismos eventos, sin recibir certificados de la Pi.
4. Tras comprobar consentimiento de cámara, la Pi sube únicamente el frame puntual asociado al evento visual o un frame actual solicitado para un caso de sensor. Amazon Bedrock analiza la imagen, sensores y contexto. Puede:
   - Solicitar otra foto.
   - Pedir un check-in de voz y transcribir la respuesta.
   - Alertar a los familiares autorizados.
   - Solicitar escalamiento anticipado, sin poder cerrar un caso ni evitar el timeout.
5. La respuesta de la persona aporta evidencia; si ningún familiar autorizado cancela explícitamente la alerta antes de un plazo configurable, Step Functions invoca `EscalationPolicy`, que puede permitir una llamada al número demo autorizado.

## Arquitectura

El diagrama actualizado está disponible aquí: [Arquitectura AWS del MVP](diagrams/aws-architecture-mvp.svg).

Servicios principales:

| Componente | Propósito |
| --- | --- |
| ESP32 | Lectura de sensores auxiliares hacia la Raspberry Pi. |
| Raspberry Pi 4B | Gateway, cámara/audio/bocina, fusión temporal de riesgos visuales y reglas de sensores. |
| AWS IoT Core | Conectividad MQTT de la Raspberry Pi con certificado X.509. |
| SQS + Lambda | Ingesta resiliente de telemetría, anomalías visuales y anomalías de sensores. |
| DynamoDB | Estado, historial, perfiles, casos y eventos funcionales. |
| EventBridge + Step Functions Standard | Inicio y orquestación durable de cada caso, con callbacks y plazos. |
| S3 | Evidencia visual privada con retención corta. |
| Amazon Bedrock | Análisis de evidencia y agente de decisiones con herramientas restringidas. |
| Transcribe | Check-in de voz intencional. |
| SNS | Notificaciones para familiares. |
| Cognito + API Gateway | Identidad y API de la aplicación familiar. |
| Amazon Connect Customer (Voice) | Llamada de fallback al contacto demo autorizado. |

La trazabilidad funcional se conserva en `EventLog`. Se mantiene una alarma mínima de DLQ → SNS para detectar fallos de entrega críticos.

## Seguridad y privacidad

- El monitoreo requiere consentimiento explícito y revocable.
- Cámara, voz y llamada de fallback requieren consentimientos independientes, modificables desde la aplicación.
- No se graba audio continuo; sólo respuestas de voz intencionales para un check-in.
- No se transmiten videos continuos: la imagen está ligada a un `caseId` de anomalía y requiere consentimiento de cámara vigente.
- Las imágenes se guardan privadas en S3 y se eliminan conforme a una política de retención corta.
- Un paciente puede tener varios familiares autorizados; las alertas se pueden enviar en paralelo o por prioridad.
- El agente no recibe credenciales de telefonía. `EscalationPolicy` es invocada por el timeout aunque el agente falle o no solicite escalamiento.

Antes de una llamada, la política exige como mínimo: riesgo alto, falta de respuesta de persona y familiares alertados, consentimiento vigente, número en lista permitida e idempotencia por `caseId`.

## Alcance del hackathon

Incluido:

- Telemetría IoT consultable casi en tiempo real, reglas de anomalía visual y de sensores, y adaptador autenticado para simulador web.
- Dashboard para familiares, alertas y confirmación de casos.
- Detección visual local continua; foto puntual y análisis asistido sólo ante anomalía.
- La animación del demo se reproduce en una pantalla y la observa la cámara real de la Pi; no existe un atajo de eventos visuales desde la animación a AWS.
- Check-in de voz como evidencia.
- Llamada de demostración a un número autorizado.

Fuera de alcance:

- Diagnósticos médicos.
- Identificación de delincuentes, diagnóstico de desmayo o confirmación autónoma de incendio.
- Llamadas reales al 911 o a servicios públicos de emergencia.
- Audio o video continuo.
- Reconocimiento facial e identificación biométrica.
- Observabilidad operativa avanzada, excepto alarma de DLQ → SNS.

## Documentación

- [Resumen de arquitectura](docs/ARCHITECTURE.md)
- [Especificación técnica detallada](docs/ARCHITECTURE_DETAILED.md)
- [Diagrama AWS](diagrams/aws-architecture-mvp.svg)
- [Cotización AWS reproducible](docs/AWS_COST_ESTIMATE.md)
- [Roadmap de implementación y despliegue](docs/IMPLEMENTATION_ROADMAP.md)
- [Guía de implementación edge: Raspberry Pi 4B + ESP32](docs/EDGE_IMPLEMENTATION_GUIDE.md)
- [Aprovisionamiento de dispositivo y prueba de humo MQTT](docs/DEVICE_PROVISIONING_AND_SMOKE_TEST.md)
- [Runbook de alertas SNS y acciones humanas de caso](docs/ALERTS_AND_CASE_ACTIONS_RUNBOOK.md)
- [Configuración de subagentes para Claude Code](docs/CLAUDE_MULTIAGENT_SETUP.md)
- [Guía de desarrollo del monorepo (contratos, pruebas, simulador)](docs/DEVELOPMENT.md)
- [Guía de integración del simulador de demo](docs/SIMULATOR_INTEGRATION_GUIDE.md)
- [Runbook del primer despliegue de integración](docs/FIRST_DEPLOYMENT_RUNBOOK.md)

## Estado

Arquitectura definida. Primera ola en desarrollo: contratos compartidos (`packages/contracts`), simulador local de gateway (`simulators/gateway-sim`) y esqueleto de infraestructura CDK (`infra/`, sin recursos ni despliegue). El resto de servicios backend, la integración edge real y la aplicación siguen pendientes.

Implementado desde entonces (no reflejado arriba): ingesta IoT completa, orquestación de casos con Step Functions Standard, transporte de evidencia puntual, análisis visual con Bedrock, Cognito + API HTTP para el simulador/app móvil, y el hito de alertas (SNS deduplicado por caso + `CANCEL_ALERT`/`ESCALATE` autenticados). Ver `docs/IMPLEMENTATION_ROADMAP.md` para el detalle por hito.
