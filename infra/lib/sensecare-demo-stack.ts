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
import { DemoAuth } from "./constructs/demo-auth";
import { DemoIngestApi } from "./constructs/demo-ingest-api";
import { CaregiverAccessTable } from "./constructs/caregiver-access-table";
import { AlertsTable } from "./constructs/alerts-table";
import { AlertsTopic } from "./constructs/alerts-topic";
import { CasesApi } from "./constructs/cases-api";
import { DlqAlarms } from "./constructs/dlq-alarms";
import { CaregiverPushEndpointsTable } from "./constructs/caregiver-push-endpoints-table";
import { AlertDeliveriesTable } from "./constructs/alert-deliveries-table";
import { PushApplication } from "./constructs/push-application";
import { PushDevicesApi } from "./constructs/push-devices-api";
import { CaseActionCallbacksTable } from "./constructs/case-action-callbacks-table";
import { FallbackCallSecret } from "./constructs/fallback-call-secret";

export interface SenseCareDemoStackProps extends cdk.StackProps {
  // Requeridos, sin default: deben venir de una verificacion manual de
  // solo lectura (aws bedrock list-foundation-models/list-inference-profiles)
  // hecha por el operador antes de cada despliegue, nunca de un valor fijo
  // en el codigo. Ver bin/sensecare-demo.ts.
  bedrockModelId: string;
  bedrockInferenceProfileArn: string;
  bedrockFoundationModelArns: string[];
  // Opcionales, nunca con default ni email real hardcodeado (ver
  // alerts-topic.ts). Sin ellos, las suscripciones se agregan a mano tras
  // el deploy (ver runbook de alertas).
  alertSubscriptionEmails?: string[];
  operationalSubscriptionEmails?: string[];
  // Opcional, sin default (hito de notificaciones): el JSON de cuenta de
  // servicio de Firebase (API HTTP v1 de FCM). Sin esto, todo el tramo de
  // push (tabla de endpoints se crea igual, pero la App de Pinpoint, las
  // rutas /me/push-devices y la Task de push en Step Functions NO se
  // construyen) queda omitido y el stack despliega exactamente igual que
  // sin este hito. Ver infra/lib/constructs/push-application.ts para la
  // advertencia de vigencia de este servicio (retiro anunciado 2026-10-30).
  fcmServiceAccountJson?: string;
  // --- Hito de escalamiento --- Sin default para ninguno de los 3
  // valores de Connect: instancia, contact flow y numero de origen se
  // reclaman a mano antes del deploy (ver docs/EMERGENCY_CALL_RUNBOOK.md).
  connectInstanceId: string;
  connectContactFlowId: string;
  connectSourcePhoneNumber: string;
  // Nombre (no el valor) del parametro SSM SecureString del numero de
  // fallback de demo. El valor real se fija a mano DESPUES del deploy.
  fallbackCallDestinationParameterName: string;
  // Allowlist propia de escalamiento (deviceId de demo), nunca el numero
  // real. Por defecto solo el dispositivo fisico y el simulador de demo.
  escalationAllowedDeviceIds?: string[];
  // Gate global explicito: por defecto false (bloquea SIEMPRE el camino
  // automatico de llamada hasta que el operador confirme un canal humano
  // de notificacion real -- ver docs/ALERTS_AND_CASE_ACTIONS_RUNBOOK.md).
  humanNotificationChannelConfirmed?: boolean;
  humanDecisionWaitSeconds?: number;
}

/**
 * Hito 2 (infraestructura base e ingesta) + Hito 4 completo (EventBridge ->
 * Step Functions Standard por caseId, seguido del transporte seguro de
 * evidencia puntual: consentimiento, UPLOAD_EVIDENCE con URL prefirmada,
 * callbacks MQTT y reconciliacion final, y analisis visual estructurado con
 * Amazon Bedrock Converse tras evidenceStatus AVAILABLE) + Hito 5 completo
 * (Cognito + API Gateway HTTP para ingesta del simulador web, emparejamiento
 * por QR y consulta de solo lectura, ver DemoIngestApi) + hito de alertas
 * (SNS deduplicado por caso via DispatchAlertFn -- inmediato para sensor
 * critico, sin esperar evidencia ni Bedrock; red de seguridad al final del
 * tramo de evidencia/analisis para el resto -- y las acciones humanas
 * autenticadas CANCEL_ALERT/ESCALATE, ver CasesApi; alarma DLQ -> SNS
 * operativa via DlqAlarms) + hito de escalamiento (espera de decision
 * humana con callback de Step Functions -> EscalationPolicy determinista
 * -> EmergencyDialer, la unica Lambda con connect:StartOutboundVoiceContact,
 * hacia un unico numero demo en SSM SecureString). Sin frontend, check-in
 * de voz/audio, Bedrock Agents ni herramientas autonomas todavia (ver
 * docs/IMPLEMENTATION_ROADMAP.md). No instancia Thing ni certificado X.509,
 * ni la instancia Connect/contact flow/numero reclamado (aprovisionamiento
 * manual fuera de CDK a proposito: ver runbook de pre-despliegue y
 * docs/EMERGENCY_CALL_RUNBOOK.md).
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

    // Hito de alertas: tabla, GSI de correlacion y topics SNS creados ANTES
    // de CaseOrchestration porque esta ultima los necesita como props (el
    // GSI de CaregiverAccessTable debe existir antes de que
    // CaseOrchestration conceda dynamodb:Query sobre el, ver
    // caregiver-access-table.ts).
    const caregiverAccess = new CaregiverAccessTable(this, "CaregiverAccessTable");
    const alerts = new AlertsTable(this, "AlertsTable");
    const alertsTopic = new AlertsTopic(this, "AlertsTopic", {
      alertSubscriptionEmails: props.alertSubscriptionEmails,
      operationalSubscriptionEmails: props.operationalSubscriptionEmails,
    });

    // Hito de notificaciones: las 2 tablas de push se crean SIEMPRE (no
    // dependen de ninguna credencial externa), pero la App de Pinpoint --y
    // por tanto las rutas /me/push-devices y la Task de push en Step
    // Functions-- solo se construyen si hay credencial de Firebase real.
    const caregiverPushEndpoints = new CaregiverPushEndpointsTable(this, "CaregiverPushEndpointsTable");
    const alertDeliveries = new AlertDeliveriesTable(this, "AlertDeliveriesTable");
    const pushApplication = props.fcmServiceAccountJson
      ? new PushApplication(this, "PushApplication", { fcmServiceAccountJson: props.fcmServiceAccountJson })
      : undefined;
    // Hito de escalamiento: tabla efimera del taskToken de decision humana
    // y la CMK/ARN del parametro SSM del numero de fallback (nunca el
    // valor: eso se fija a mano despues del deploy, ver
    // docs/EMERGENCY_CALL_RUNBOOK.md).
    const caseActionCallbacks = new CaseActionCallbacksTable(this, "CaseActionCallbacksTable");
    const fallbackCallSecret = new FallbackCallSecret(this, "FallbackCallSecret", {
      parameterName: props.fallbackCallDestinationParameterName,
    });

    const caseOrchestration = new CaseOrchestration(this, "CaseOrchestration", {
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
      alertsTable: alerts.table,
      caregiverAccessTable: caregiverAccess.table,
      alertsTopic: alertsTopic.alertsTopic,
      pushNotifications: pushApplication
        ? {
            caregiverPushEndpointsTable: caregiverPushEndpoints.table,
            alertDeliveriesTable: alertDeliveries.table,
            pinpointApplicationId: pushApplication.applicationId,
          }
        : undefined,
      caseActionCallbacksTable: caseActionCallbacks.table,
      fallbackCallCmk: fallbackCallSecret.cmk,
      fallbackCallDestinationParameterName: fallbackCallSecret.parameterName,
      fallbackCallDestinationParameterArn: fallbackCallSecret.parameterArn,
      connectInstanceId: props.connectInstanceId,
      connectContactFlowId: props.connectContactFlowId,
      connectSourcePhoneNumber: props.connectSourcePhoneNumber,
      escalationAllowedDeviceIds: props.escalationAllowedDeviceIds ?? ["pi-demo-01", "sim-room-01"],
      humanNotificationChannelConfirmed: props.humanNotificationChannelConfirmed,
      humanDecisionWaitSeconds: props.humanDecisionWaitSeconds,
    });

    new DlqAlarms(this, "DlqAlarms", {
      operationalAlarmsTopic: alertsTopic.operationalAlarmsTopic,
      deadLetterQueues: {
        Telemetry: queues.telemetry.deadLetterQueue,
        VisualAnomaly: queues.visualAnomaly.deadLetterQueue,
        SensorAnomaly: queues.sensorAnomaly.deadLetterQueue,
        CommandAcks: evidenceCallbackQueues.commandAcks.deadLetterQueue,
        Evidence: evidenceCallbackQueues.evidence.deadLetterQueue,
        CaseDispatcher: caseOrchestration.dispatcherDlq,
      },
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

    // Hito de alertas: GET /cases/{caseId}/events, POST /cases/{caseId}/cancel
    // (CANCEL_ALERT), POST /cases/{caseId}/escalate (ESCALATE). Mismo HttpApi
    // y mismo JWT authorizer que DemoIngestApi (misma URL base, un solo
    // Cognito User Pool para todo el demo).
    new CasesApi(this, "CasesApi", {
      httpApi: demoIngestApi.httpApi,
      authorizer: demoIngestApi.authorizer,
      anomalyCasesTable: anomalyCases.table,
      alertsTable: alerts.table,
      eventLogTable: tables.eventLogTable,
      caregiverAccessTable: caregiverAccess.table,
    });

    // Hito de notificaciones: solo si hay App de Pinpoint real (ver arriba).
    if (pushApplication) {
      new PushDevicesApi(this, "PushDevicesApi", {
        httpApi: demoIngestApi.httpApi,
        authorizer: demoIngestApi.authorizer,
        caregiverPushEndpointsTable: caregiverPushEndpoints.table,
        pinpointApplicationId: pushApplication.applicationId,
      });
    }

    new cdk.CfnOutput(this, "DemoUserPoolId", { value: demoAuth.userPool.userPoolId });
    new cdk.CfnOutput(this, "DemoUserPoolClientId", { value: demoAuth.userPoolClient.userPoolClientId });
    // Base para las rutas: POST {url}demo/devices/{deviceId}/events,
    // POST {url}devices/{deviceId}/pair, GET {url}devices/{deviceId}/latest,
    // GET {url}devices/{deviceId}/telemetry, GET {url}cases, GET
    // {url}cases/{caseId}/events, POST {url}cases/{caseId}/cancel, POST
    // {url}cases/{caseId}/escalate y, solo si hay App de Pinpoint, POST
    // {url}me/push-devices / DELETE {url}me/push-devices/{endpointId}.
    new cdk.CfnOutput(this, "DemoIngestApiUrl", { value: demoIngestApi.httpApi.apiEndpoint });
    if (pushApplication) {
      new cdk.CfnOutput(this, "PinpointApplicationId", { value: pushApplication.applicationId });
    }

    // TODO(Hito 4 - Orquestacion, siguiente tramo): renovar el TTL de
    // OpenCaseLocks periodicamente mientras el caso siga abierto (este
    // hito solo renueva una vez, al iniciar) y liberarlo/dejarlo expirar
    // al cerrarlo o escalarlo. El tramo de evidencia puntual (consentimiento,
    // UPLOAD_EVIDENCE con URL prefirmada, callbacks MQTT y reconciliacion)
    // ya esta implementado en CaseOrchestration.

    // Hito de escalamiento (implementado en CaseOrchestration): espera de
    // CANCEL_ALERT/ESCALATE con callback de Step Functions ->
    // EscalationPolicy determinista -> EmergencyDialer (unica Lambda con
    // connect:StartOutboundVoiceContact). Pendiente, manual y fuera de CDK
    // a proposito: reclamar la instancia Connect/contact flow/numero de
    // origen, y fijar el VALOR del parametro SSM
    // `fallbackCallDestinationParameterName` con
    // `aws ssm put-parameter --type SecureString` (ver
    // docs/EMERGENCY_CALL_RUNBOOK.md). Sin ese valor, EmergencyDialer
    // fallaria con DIAL_FAILED de forma segura (nunca marca sin destino).
    // `humanNotificationChannelConfirmed` queda en `false` hasta que el
    // operador confirme un canal humano de notificacion real.
  }
}
