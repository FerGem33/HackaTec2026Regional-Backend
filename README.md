# CareWatch

Sistema ubicuo para monitorear y apoyar el cuidado consentido de una persona en su hogar. Proyecto para la categoría **Smart Software** de HackatecNM 2026.

CareWatch usa una Raspberry Pi 4B como gateway del hogar: recibe señales auxiliares de un ESP32 y ejecuta localmente el primer detector de anomalías visuales. Una anomalía activa una investigación puntual: la Pi puede enviar una foto a AWS para análisis multimodal, pedir un check-in de voz y alertar a los familiares autorizados.

No pretende diagnosticar enfermedades ni sustituir atención médica.

## Problema

Una persona que requiere acompañamiento puede vivir sola o pasar periodos sin supervisión inmediata. Un familiar necesita conocer situaciones potencialmente riesgosas sin convertir el hogar en un sistema de vigilancia continua.

## Propuesta

El sistema evita capturas periódicas de cámara y audio. Sólo cuando una anomalía relevante abre un caso, reúne evidencia adicional y coordina una respuesta.

```text
ESP32 → Raspberry Pi + visión local → anomalía → evidencia puntual a AWS
                                      → IA + herramientas → check-in / alerta → fallback
```

El fallback consiste en una llamada al número de demo previamente autorizado —nunca al 911 durante el hackathon— y sólo como último recurso.

## Flujo del MVP

1. El ESP32 entrega telemetría auxiliar a la Raspberry Pi por Wi-Fi local o serial.
2. La Pi ejecuta continuamente un modelo ligero de visión. Sólo publica un evento cuando detecta una anomalía visual; no envía video continuo a la nube.
3. AWS crea/reutiliza un `AnomalyCase` y Step Functions Standard coordina callbacks y plazos.
4. Tras comprobar consentimiento de cámara, la Pi sube únicamente el frame puntual asociado al evento. Amazon Bedrock analiza la imagen, sensores y contexto. Puede:
   - Solicitar otra foto.
   - Pedir un check-in de voz y transcribir la respuesta.
   - Alertar a los familiares autorizados.
   - Solicitar escalamiento anticipado, sin poder cerrar un caso ni evitar el timeout.
5. Si no hay respuesta humana válida de la persona ni de los familiares alertados antes de un plazo configurable, Step Functions invoca `EscalationPolicy`, que puede permitir una llamada al número demo autorizado.

## Arquitectura

El diagrama actualizado está disponible aquí: [Arquitectura AWS del MVP](diagrams/aws-architecture-mvp.svg).

Servicios principales:

| Componente | Propósito |
| --- | --- |
| ESP32 | Lectura de sensores auxiliares hacia la Raspberry Pi. |
| Raspberry Pi 4B | Gateway, cámara/audio/bocina y primer detector visual local. |
| AWS IoT Core | Conectividad MQTT de la Raspberry Pi con certificado X.509. |
| SQS + Lambda | Ingesta resiliente de telemetría y detección de anomalías. |
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

- Telemetría IoT y reglas de anomalía.
- Dashboard para familiares, alertas y confirmación de casos.
- Detección visual local continua; foto puntual y análisis asistido sólo ante anomalía.
- Check-in de voz como evidencia.
- Llamada de demostración a un número autorizado.

Fuera de alcance:

- Diagnósticos médicos.
- Llamadas reales al 911 o a servicios públicos de emergencia.
- Audio o video continuo.
- Reconocimiento facial e identificación biométrica.
- Observabilidad operativa avanzada, excepto alarma de DLQ → SNS.

## Documentación

- [Resumen de arquitectura](docs/ARCHITECTURE.md)
- [Especificación técnica detallada](docs/ARCHITECTURE_DETAILED.md)
- [Diagrama AWS](diagrams/aws-architecture-mvp.svg)
- [Cotización AWS reproducible](docs/AWS_COST_ESTIMATE.md)

## Estado

Arquitectura definida; la implementación de infraestructura, servicios backend y aplicación está pendiente.
