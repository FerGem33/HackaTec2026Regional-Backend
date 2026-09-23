# CareWatch

Sistema ubicuo para monitorear y apoyar el cuidado consentido de una persona en su hogar. Proyecto para la categoría **Smart Software** de HackatecNM 2026.

CareWatch reúne señales ambientales y de presencia desde un ESP32, detecta anomalías y activa una investigación puntual: puede solicitar una foto a una laptop-gateway, analizar la evidencia con IA, pedir un check-in de voz y alertar a los familiares autorizados.

No pretende diagnosticar enfermedades ni sustituir atención médica.

## Problema

Una persona que requiere acompañamiento puede vivir sola o pasar periodos sin supervisión inmediata. Un familiar necesita conocer situaciones potencialmente riesgosas sin convertir el hogar en un sistema de vigilancia continua.

## Propuesta

El sistema evita capturas periódicas de cámara y audio. Sólo cuando una anomalía relevante abre un caso, reúne evidencia adicional y coordina una respuesta.

```text
Sensores → anomalía → evidencia puntual → IA + herramientas
         → check-in de voz + alerta familiar → resolución o fallback telefónico
```

El fallback consiste en una llamada al número de demo previamente autorizado —nunca al 911 durante el hackathon— y sólo como último recurso.

## Flujo del MVP

1. El ESP32 publica telemetría de temperatura, humedad, CO₂, proximidad y/o movimiento mediante MQTT seguro.
2. AWS procesa las lecturas y aplica reglas de anomalía interpretables.
3. Un candado de DynamoDB evita casos duplicados y una ejecución de Step Functions Standard coordina cada `AnomalyCase`, sus callbacks y plazos.
4. La ejecución solicita al gateway una foto bajo demanda y, después, un agente basado en Amazon Bedrock analiza la evidencia estructurada. Puede:
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
| ESP32 | Lectura y publicación de sensores. |
| Laptop-gateway | Cámara, micrófono, bocina y ejecución de comandos bajo demanda. |
| AWS IoT Core | Conectividad MQTT con certificados X.509. |
| SQS + Lambda | Ingesta resiliente de telemetría y detección de anomalías. |
| DynamoDB | Estado, historial, perfiles, casos y eventos funcionales. |
| EventBridge + Step Functions Standard | Inicio y orquestación durable de cada caso, con callbacks y plazos. |
| S3 | Evidencia visual privada con retención corta. |
| Amazon Bedrock | Análisis de evidencia y agente de decisiones con herramientas restringidas. |
| Transcribe | Check-in de voz intencional. |
| SNS | Notificaciones para familiares. |
| Cognito + API Gateway | Identidad y API de la aplicación familiar. |
| Amazon Connect | Llamada de fallback al contacto demo autorizado. |

La trazabilidad funcional se conserva en `EventLog`. Se mantiene una alarma mínima de DLQ → SNS para detectar fallos de entrega críticos.

## Seguridad y privacidad

- El monitoreo requiere consentimiento explícito y revocable.
- Cámara, voz y llamada de fallback requieren consentimientos independientes, modificables desde la aplicación.
- No se graba audio continuo; sólo respuestas de voz intencionales para un check-in.
- No se toman fotos periódicas: la captura está ligada a un `caseId` de anomalía.
- Las imágenes se guardan privadas en S3 y se eliminan conforme a una política de retención corta.
- Un paciente puede tener varios familiares autorizados; las alertas se pueden enviar en paralelo o por prioridad.
- El agente no recibe credenciales de telefonía. `EscalationPolicy` es invocada por el timeout aunque el agente falle o no solicite escalamiento.

Antes de una llamada, la política exige como mínimo: riesgo alto, falta de respuesta de persona y familiares alertados, consentimiento vigente, número en lista permitida e idempotencia por `caseId`.

## Alcance del hackathon

Incluido:

- Telemetría IoT y reglas de anomalía.
- Dashboard para familiares, alertas y confirmación de casos.
- Captura de foto bajo demanda y análisis asistido.
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

## Estado

Arquitectura definida; la implementación de infraestructura, servicios backend y aplicación está pendiente.
