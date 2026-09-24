import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import type { Construct } from "constructs";
// CDK ejecuta estas fuentes con ts-node en CommonJS (ver cdk.json). Las
// extensiones .js funcionan tras compilar a dist/, pero no existen durante
// `npx cdk list/synth/deploy` desde el source tree; imports sin extension
// permiten que ts-node resuelva los .ts y que tsc emita require() correcto.
import { IngestionTables } from "./constructs/ingestion-tables";
import { EvidenceBucket } from "./constructs/evidence-bucket";
import { IngestionQueues } from "./constructs/ingestion-queues";
import { IotIngestionRules } from "./constructs/iot-ingestion-rules";
import { IngestionFunctions } from "./constructs/ingestion-functions";
import { AnomalyCasesTable } from "./constructs/anomaly-cases-table";
import { EvidenceCallbacksTable } from "./constructs/evidence-callbacks-table";
import { EvidenceCallbackQueues } from "./constructs/evidence-callback-queues";
import { EvidenceCallbackRules } from "./constructs/evidence-callback-rules";
import { EvidenceCallbackHandlers } from "./constructs/evidence-callback-handlers";
import { CaseOrchestration } from "./constructs/case-orchestration";
import { DeviceAccessPolicy } from "./constructs/device-access-policy";
import { DemoAuth } from "./constructs/demo-auth";
import { DemoIngestApi } from "./constructs/demo-ingest-api";
import { CaregiverAccessTable } from "./constructs/caregiver-access-table";

/**
 * Hito 2 (infraestructura base e ingesta) + Hito 4 completo (EventBridge ->
 * Step Functions Standard por caseId, seguido del transporte seguro de
 * evidencia puntual: consentimiento, UPLOAD_EVIDENCE con URL prefirmada,
 * callbacks MQTT y reconciliacion final) + Hito 5 parcial (Cognito + API
 * Gateway HTTP para el endpoint de ingesta del simulador web, ver
 * DemoIngestApi; las rutas de consulta/cancelacion/escalamiento de
 * familiares siguen pendientes). Sin Bedrock, SNS, Connect, frontend ni
 * check-in de voz/audio todavia (ver docs/IMPLEMENTATION_ROADMAP.md). No
 * instancia Thing ni certificado X.509 (aprovisionamiento por dispositivo,
 * fuera de CDK a proposito: ver runbook de pre-despliegue).
 */
export class SenseCareDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tables = new IngestionTables(this, "IngestionTables");
    const evidenceBucket = new EvidenceBucket(this, "EvidenceBucket");
    const queues = new IngestionQueues(this, "IngestionQueues");

    const eventBus = new events.EventBus(this, "SenseCareEventBus", {
      eventBusName: "SenseCare",
    });

    new IotIngestionRules(this, "IotIngestionRules", {
      telemetryQueue: queues.telemetry.queue,
      visualAnomalyQueue: queues.visualAnomaly.queue,
      sensorAnomalyQueue: queues.sensorAnomaly.queue,
    });

    new IngestionFunctions(this, "IngestionFunctions", {
      telemetryQueue: queues.telemetry.queue,
      visualAnomalyQueue: queues.visualAnomaly.queue,
      sensorAnomalyQueue: queues.sensorAnomaly.queue,
      devicesTable: tables.devicesTable,
      telemetryTable: tables.telemetryTable,
      eventLogTable: tables.eventLogTable,
      openCaseLocksTable: tables.openCaseLocksTable,
      eventBus,
    });

    const anomalyCases = new AnomalyCasesTable(this, "AnomalyCasesTable");
    const evidenceCallbacks = new EvidenceCallbacksTable(this, "EvidenceCallbacksTable");
    const evidenceCallbackQueues = new EvidenceCallbackQueues(this, "EvidenceCallbackQueues");

    new EvidenceCallbackRules(this, "EvidenceCallbackRules", {
      commandAcksQueue: evidenceCallbackQueues.commandAcks.queue,
      evidenceQueue: evidenceCallbackQueues.evidence.queue,
    });

    new EvidenceCallbackHandlers(this, "EvidenceCallbackHandlers", {
      commandAcksQueue: evidenceCallbackQueues.commandAcks.queue,
      evidenceQueue: evidenceCallbackQueues.evidence.queue,
      evidenceCallbacksTable: evidenceCallbacks.table,
      eventLogTable: tables.eventLogTable,
      evidenceBucket: evidenceBucket.bucket,
    });

    new CaseOrchestration(this, "CaseOrchestration", {
      eventBus,
      openCaseLocksTable: tables.openCaseLocksTable,
      anomalyCasesTable: anomalyCases.table,
      devicesTable: tables.devicesTable,
      evidenceCallbacksTable: evidenceCallbacks.table,
      eventLogTable: tables.eventLogTable,
      evidenceBucket: evidenceBucket.bucket,
    });

    // Politica IoT declarativa y versionada, sin Thing/certificado/llave
    // privada y sin adjuntarla a ningun principal (paso manual, ver
    // runbook de pre-despliegue).
    new DeviceAccessPolicy(this, "DeviceAccessPolicy");

    // Hito 5 (ingesta del simulador web + emparejamiento por QR + consulta
    // de solo lectura para simulador/app movil). Cognito emite el JWT
    // (usuarios de demo se crean a mano, ver docs/DEMO_INGEST_AUTH.md);
    // demoIngestHandler valida schema + una allowlist explicita de deviceId
    // (nunca deviceId de una Pi real con certificado X.509) y empuja al
    // MISMO SQS que las IoT Rules -- ver comentario en
    // services/ingestion/src/demoIngestHandler.ts sobre por que nunca
    // produce mqttDeviceId via transporte MQTT real.
    //
    // Las rutas de lectura SI pueden devolver datos de pi-demo-01 (la Pi
    // fisica real): la allowlist de deviceId solo restringe quien puede
    // ESCRIBIR por HTTPS. Lo que restringe quien puede LEER es
    // CaregiverAccessTable: un usuario debe emparejar su cuenta con un
    // deviceId especifico via POST /devices/{deviceId}/pair (QR +
    // pairingCode del dispositivo) antes de que GET /latest o /telemetry
    // le devuelvan algo distinto de 403 -- ver caregiverAccess.ts.
    //
    // El "mecanismo de alta de Devices/recipientId" que un deviceId
    // necesita (fisico o de demo) sigue siendo manual (mismo paso que
    // docs/DEVICE_PROVISIONING_AND_SMOKE_TEST.md Seccion 1), y ahora
    // TAMBIEN debe incluir el atributo `pairingCode` en ese PutItem (ver
    // docs/DEMO_INGEST_AUTH.md).
    const demoAuth = new DemoAuth(this, "DemoAuth");
    const caregiverAccess = new CaregiverAccessTable(this, "CaregiverAccessTable");
    const demoIngestApi = new DemoIngestApi(this, "DemoIngestApi", {
      telemetryQueue: queues.telemetry.queue,
      sensorAnomalyQueue: queues.sensorAnomaly.queue,
      devicesTable: tables.devicesTable,
      telemetryTable: tables.telemetryTable,
      caregiverAccessTable: caregiverAccess.table,
      userPool: demoAuth.userPool,
      userPoolClient: demoAuth.userPoolClient,
      demoDeviceAllowlist: ["sim-room-01"],
    });

    new cdk.CfnOutput(this, "DemoUserPoolId", { value: demoAuth.userPool.userPoolId });
    new cdk.CfnOutput(this, "DemoUserPoolClientId", { value: demoAuth.userPoolClient.userPoolClientId });
    // Base para las 4 rutas: POST {url}demo/devices/{deviceId}/events,
    // POST {url}devices/{deviceId}/pair, GET {url}devices/{deviceId}/latest,
    // GET {url}devices/{deviceId}/telemetry
    new cdk.CfnOutput(this, "DemoIngestApiUrl", { value: demoIngestApi.httpApi.apiEndpoint });

    // TODO(Hito 4 - Orquestacion, siguiente tramo): renovar el TTL de
    // OpenCaseLocks periodicamente mientras el caso siga abierto (este
    // hito solo renueva una vez, al iniciar) y liberarlo/dejarlo expirar
    // al cerrarlo o escalarlo. El tramo de evidencia puntual (consentimiento,
    // UPLOAD_EVIDENCE con URL prefirmada, callbacks MQTT y reconciliacion)
    // ya esta implementado en CaseOrchestration.

    // TODO(Hito 5 - Control de demo, resto): GET /devices/{deviceId}/latest,
    // GET /devices/{deviceId}/telemetry y POST /devices/{deviceId}/pair ya
    // estan arriba (DemoIngestApi), protegidas por CaregiverAccessTable.
    // Falta: GET /cases/{caseId}/events y la accion humana autorizada
    // (POST /cases/{caseId}/cancel, /escalate) -- esas necesitan verificar
    // que el sujeto del JWT tiene acceso al recipientId del caso (via el
    // deviceId que ya emparejo), no solo repetir el chequeo de deviceId.

    // TODO(Hito 6 - Notificacion y llamada): SNS y Amazon Connect Customer
    // (Voice) via EscalationPolicy/EmergencyDialer, destino unicamente en
    // allowlist de demo, nunca 911. Incluye la alarma DLQ -> SNS pendiente
    // (las DLQ de ingesta, dispatcher y callbacks de evidencia ya existen,
    // sin alarma todavia).
  }
}
