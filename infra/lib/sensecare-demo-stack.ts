import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import type { Construct } from "constructs";
import { IngestionTables } from "./constructs/ingestion-tables.js";
import { EvidenceBucket } from "./constructs/evidence-bucket.js";
import { IngestionQueues } from "./constructs/ingestion-queues.js";
import { IotIngestionRules } from "./constructs/iot-ingestion-rules.js";
import { IngestionFunctions } from "./constructs/ingestion-functions.js";
import { AnomalyCasesTable } from "./constructs/anomaly-cases-table.js";
import { CaseOrchestration } from "./constructs/case-orchestration.js";
import { DeviceAccessPolicy } from "./constructs/device-access-policy.js";

/**
 * Hito 2 (infraestructura base e ingesta) + Hito 4, primer tramo
 * (EventBridge -> Step Functions Standard por caseId). Sin Bedrock,
 * S3/evidencia en el flujo, SNS, Connect, Cognito, API Gateway ni frontend
 * todavia (ver docs/IMPLEMENTATION_ROADMAP.md). No instancia Thing ni
 * certificado X.509 (aprovisionamiento por dispositivo, fuera de CDK a
 * proposito: ver runbook de pre-despliegue).
 */
export class SenseCareDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tables = new IngestionTables(this, "IngestionTables");
    // Bucket de evidencia sin consumidores todavia (llega en Hito 4+).
    new EvidenceBucket(this, "EvidenceBucket");
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

    new CaseOrchestration(this, "CaseOrchestration", {
      eventBus,
      openCaseLocksTable: tables.openCaseLocksTable,
      anomalyCasesTable: anomalyCases.table,
    });

    // Politica IoT declarativa y versionada, sin Thing/certificado/llave
    // privada y sin adjuntarla a ningun principal (paso manual, ver
    // runbook de pre-despliegue).
    new DeviceAccessPolicy(this, "DeviceAccessPolicy");

    // TODO(Hito 4 - Orquestacion, siguiente tramo): CheckCameraConsent,
    // RequestEvidenceUpload y los estados de espera subsecuentes. Ese
    // tramo debe renovar el TTL de OpenCaseLocks periodicamente mientras
    // el caso siga abierto (este hito solo renueva una vez, al iniciar) y
    // liberarlo/dejarlo expirar al cerrarlo.

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
    // (las 3 DLQ de este hito ya existen, sin alarma todavia).
  }
}
