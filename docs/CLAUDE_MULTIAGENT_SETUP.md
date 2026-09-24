# SenseCare — uso de subagentes con Claude Code

El proyecto incluye perfiles de Claude Code en `.claude/agents/` y las reglas compartidas en `AGENTS.md`. Los perfiles no contienen credenciales ni permisos de despliegue; son instrucciones versionadas para dividir el trabajo sin romper los contratos del MVP.

## Perfiles disponibles

| Perfil | Uso | Propiedad |
| --- | --- | --- |
| `architecture-coordinator` | Inicio de cada ola e integración de cambios transversales | Contratos, decisiones y revisión final. |
| `infrastructure-engineer` | Construcción/revisión CDK | Recursos AWS, IAM, reglas IoT y despliegue reproducible. |
| `backend-orchestrator` | Casos, Lambdas y Step Functions | Backend, schemas y pruebas unitarias/integración. |
| `edge-integration-reviewer` | Interfaz con responsable de Pi/ESP32 | Simulador, payloads MQTT y checklist; no hardware real. |
| `qa-security-reviewer` | Antes de integrar y antes del demo | Privacidad, seguridad, casos de falla y runbook. |

La implementación real de Raspberry Pi/ESP32 queda fuera de este repositorio por ahora y se entrega conforme a [EDGE_IMPLEMENTATION_GUIDE.md](EDGE_IMPLEMENTATION_GUIDE.md).

## Forma de trabajo recomendada

1. Abrir una sesión principal y asignarle `architecture-coordinator` para leer documentos, fijar el siguiente entregable y dividir tareas.
2. Crear worktrees o ramas por agente. No permitir que dos agentes modifiquen al mismo tiempo CDK, schemas compartidos o documentos de arquitectura.
3. Ejecutar en paralelo `infrastructure-engineer` y `edge-integration-reviewer`/simulador después de fijar contratos.
4. Ejecutar `backend-orchestrator` cuando los contratos y nombres de recursos estén estables.
5. Pedir a `qa-security-reviewer` que revise cada integración antes de fusionar.
6. El coordinador integra en este orden: infraestructura mínima → simulador → casos/orquestación → API/CLI de demo → SNS/Connect → ensayo.

Cada agente debe devolver archivos modificados, pruebas ejecutadas, contratos impactados, recursos que requerirían despliegue y riesgos pendientes. Ninguno despliega o realiza llamadas sin una orden explícita de la persona responsable.

## Prompts iniciales sugeridos

Para la sesión principal:

```text
Usa el perfil architecture-coordinator. Lee AGENTS.md y docs/. Planea el siguiente
entregable mínimo: contratos y simulador. No edites aún; enumera dependencias,
archivos y criterios de aceptación.
```

Para infraestructura:

```text
Usa infrastructure-engineer. Implementa únicamente la infraestructura mínima del
Hito 2 que soporte telemetría, anomalías y el simulador. No despliegues, no generes
certificados reales y no cambies contratos MQTT. Ejecuta synth/tests locales y reporta
los parámetros manuales pendientes.
```

Para backend:

```text
Usa backend-orchestrator. Implementa únicamente creación idempotente de AnomalyCase
y OpenCaseLock con tests. No modifiques CDK ni Step Functions todavía. Respeta los
schemas de docs/ y reporta cualquier ambigüedad.
```

Para revisión edge:

```text
Usa edge-integration-reviewer. Crea o revisa el simulador de Pi contra
EDGE_IMPLEMENTATION_GUIDE.md. Valida payloads MQTT y UPLOAD_EVIDENCE; no intentes
configurar una Pi real ni uses secretos.
```

## Guardrails

- No activar telefonía ni usar `--dangerously-skip-permissions`.
- No guardar `.env`, certificados, claves privadas, números telefónicos o tokens en Git.
- No iniciar tareas paralelas que escriban los mismos archivos.
- No implementar frontend mientras no sea una prioridad explícita.
- Siempre revisar `git diff`, ejecutar pruebas aplicables y conservar el worktree de otros agentes.
