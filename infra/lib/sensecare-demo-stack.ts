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
import { ObservationsTable } from "./constructs/observations-table";
import { CaseOrchestration } from "./constructs/case-orchestration";
import { DeviceAccessPolicy } from "./constructs/device-access-policy";

export interface SenseCareDemoStackProps extends cdk.StackProps {
  // Requeridos, sin default: deben venir de una verificacion manual de
  // solo lectura (aws bedrock list-foundation-models/list-inference-profiles)
  // hecha por el operador antes de cada despliegue, nunca de un valor fijo
  // en el codigo. Ver bin/sensecare-demo.ts.
  bedrockModelId: string;
  bedrockInferenceProfileArn: string;
  bedrockFoundationModelArns: string[];
}

/**
 * Hito 2 (infraestructura base e ingesta) + Hito 4 completo (EventBridge ->
 * Step Functions Standard por caseId, transporte seguro de evidencia
 * puntual, y analisis visual estructurado con Amazon Bedrock Converse tras
 * evidenceStatus AVAILABLE). Sin SNS, Connect, Cognito, API Gateway,
 * frontend, check-in de voz/audio, Bedrock Agents ni herramientas
 * autonomas todavia (ver docs/IMPLEMENTATION_ROADMAP.md). No instancia
 * Thing ni certificado X.509 (aprovisionamiento por dispositivo, fuera de
 * CDK a proposito: ver runbook de pre-despliegue).
 */
export class SenseCareDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SenseCareDemoStackProps) {
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

    const observations = new ObservationsTable(this, "ObservationsTable");

    new CaseOrchestration(this, "CaseOrchestration", {
      eventBus,
      openCaseLocksTable: tables.openCaseLocksTable,
      anomalyCasesTable: anomalyCases.table,
      devicesTable: tables.devicesTable,
      evidenceCallbacksTable: evidenceCallbacks.table,
      eventLogTable: tables.eventLogTable,
      evidenceBucket: evidenceBucket.bucket,
      observationsTable: observations.table,
      bedrockModelId: props.bedrockModelId,
      bedrockInferenceProfileArn: props.bedrockInferenceProfileArn,
      bedrockFoundationModelArns: props.bedrockFoundationModelArns,
    });

    // Politica IoT declarativa y versionada, sin Thing/certificado/llave
    // privada y sin adjuntarla a ningun principal (paso manual, ver
    // runbook de pre-despliegue).
    new DeviceAccessPolicy(this, "DeviceAccessPolicy");

    // TODO(Hito 4 - Orquestacion, siguiente tramo): renovar el TTL de
    // OpenCaseLocks periodicamente mientras el caso siga abierto (este
    // hito solo renueva una vez, al iniciar) y liberarlo/dejarlo expirar
    // al cerrarlo o escalarlo. El tramo de evidencia puntual (consentimiento,
    // UPLOAD_EVIDENCE con URL prefirmada, callbacks MQTT y reconciliacion)
    // ya esta implementado en CaseOrchestration.

    // TODO(Hito 5 - Control de demo): Cognito, API Gateway y Lambdas
    // minimas de consulta/cancelacion/escalamiento, mas el adaptador
    // demoIngestHandler (solo telemetria/anomalias de sensor, allowlist de
    // deviceId demo). Incluye el mecanismo de alta de Devices/recipientId
    // que este hito todavia no tiene. demoIngestHandler NO pasa por AWS
    // IoT Core y por lo tanto nunca produce mqttDeviceId (ver
    // services/ingestion/src/envelope.ts); su autorizacion de deviceId es
    // una allowlist explicita validada dentro de ese propio handler, no la
    // verificacion topic/payload de este hito.

    // TODO(Hito 6 - Notificacion y llamada): SNS y Amazon Connect Customer
    // (Voice) via EscalationPolicy/EmergencyDialer, destino unicamente en
    // allowlist de demo, nunca 911. Incluye la alarma DLQ -> SNS pendiente
    // (las DLQ de ingesta, dispatcher y callbacks de evidencia ya existen,
    // sin alarma todavia).
  }
}
