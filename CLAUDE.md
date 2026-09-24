# Instrucciones para agentes de SenseCare

## Propósito y alcance actual

SenseCare es un MVP de monitoreo consentido. El alcance de este repositorio es **infraestructura, backend y coordinación/integración edge**; la implementación real de Raspberry Pi/ESP32 la realiza un responsable externo conforme a `docs/EDGE_IMPLEMENTATION_GUIDE.md`. No implementar frontend, dashboard, aplicación móvil ni UI de consentimientos salvo solicitud explícita. El flujo demo termina en SNS, API/CLI de control y llamada a un número de prueba autorizado.

Nunca implementar llamadas al 911 ni a servicios públicos de emergencia. `EmergencyDialer` sólo puede marcar un destino demo incluido en allowlist y validado por `EscalationPolicy`.

## Leer antes de editar

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/ARCHITECTURE_DETAILED.md`
4. `docs/IMPLEMENTATION_ROADMAP.md`
5. Según el área: `docs/EDGE_IMPLEMENTATION_GUIDE.md` o `docs/AWS_COST_ESTIMATE.md`

Las decisiones y contratos definidos en esos documentos prevalecen sobre suposiciones del agente.

## Contratos que no se cambian unilateralmente

- ESP32 → Pi es local; ESP32 nunca recibe credenciales AWS.
- La Pi es el único gateway cloud y usa MQTT TLS con un certificado X.509 por `deviceId`.
- No hay video/audio continuo en AWS. Evidencia puntual se sube sólo tras anomalía, consentimiento y URL prefirmada.
- Topics MQTT: `SenseCare/v1/devices/{deviceId}/telemetry`, `visual/anomaly`, `sensor/anomaly`, `status`, `commands`, `command-acks`, `evidence`.
- `caseId`, `eventId` y timestamps UTC son obligatorios en eventos aplicables.
- Step Functions **Standard** es el único orquestador de plazos/callbacks de caso.
- Sólo un `CANCEL_ALERT` de familiar autorizado detiene el fallback; una respuesta de voz del usuario es evidencia, no cierre automático.
- El LLM no tiene permisos IAM para Connect, no puede cerrar casos ni seleccionar teléfonos.

Si un cambio necesita modificar un contrato, el agente debe proponerlo con compatibilidad, actualizar todos los documentos afectados y esperar revisión del coordinador antes de implementarlo.

## Propiedad de áreas y coordinación

| Área | Archivos/recursos principales | Regla |
| --- | --- | --- |
| Infraestructura | `infra/`, CDK, IAM, IoT, S3, SQS, DynamoDB, Step Functions | No modificar contratos edge sin coordinación. |
| Backend | `services/`, Lambdas, schemas, pruebas de integración | Mantener idempotencia, callbacks y políticas deterministas. |
| Integración edge | Simuladores, schemas y guía edge | No implementar/configurar Pi real ni añadir permisos cloud o topics nuevos. |
| QA/integración | `tests/`, runbook y escenarios demo | No cambiar lógica de producción para ocultar fallos. |
| Documentación | `README.md`, `docs/`, `diagrams/` | Actualizar si cambia un contrato o alcance. |

Un agente por vez debe modificar cada archivo compartido de contrato/infraestructura. Usar ramas o worktrees separados y someter cambios pequeños para revisión.

## Estándares de implementación

- TypeScript para CDK y Lambdas; Python para edge salvo decisión explícita contraria.
- Validar toda entrada MQTT/API con esquema en runtime.
- Usar IDs UUID y timestamps UTC ISO-8601.
- Aplicar mínimo privilegio IAM; prohibidos `AdministratorAccess`, `Action: "*"`, `s3:*` y secretos en código.
- Las Lambdas deben ser idempotentes y reportar fallos parciales al consumir SQS.
- No guardar bytes de imagen/audio ni URLs prefirmadas en DynamoDB, EventLog o estado de Step Functions.
- Antes de desplegar: pruebas, `cdk synth --strict`, `cdk diff` y revisión humana. No usar hotswap para el despliegue del demo.
- Usar `apply_patch` para editar archivos y preservar cambios ajenos del worktree.

## Pruebas y criterios de entrega

Cada cambio debe incluir pruebas proporcionales y conservar estos escenarios: telemetría sana no sube evidencia; anomalías duplicadas crean un solo caso; Pi sin evidencia produce incertidumbre; `CANCEL_ALERT` detiene fallback; timeout pasa por política; allowlist/consentimiento inválidos bloquean llamadas.

Al finalizar, el agente debe informar: archivos modificados, contratos impactados, pruebas ejecutadas, recursos AWS que requerirían despliegue y riesgos pendientes. No desplegar ni activar telefonía sin instrucción explícita.
