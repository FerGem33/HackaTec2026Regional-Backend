import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * Esqueleto de la primera ola: el stack existe pero no instancia ningun
 * recurso AWS todavia. Cada grupo se implementa en su propio hito
 * (ver docs/IMPLEMENTATION_ROADMAP.md), con pruebas, cdk synth --strict,
 * cdk diff y revision humana antes de cualquier cdk deploy (CLAUDE.md).
 */
export class SenseCareDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // TODO(Hito 2 - Dispositivo): IoT Thing, certificado X.509 y politica
    // por deviceId, restringida a los topics de su propio dispositivo
    // (sin comodines como "SenseCare/#").

    // TODO(Hito 2 - Ingesta): IoT Rules separadas para telemetry,
    // visual/anomaly, sensor/anomaly, command-acks y evidence; SQS + DLQ
    // para telemetria y anomalias, Lambdas con ReportBatchItemFailures.

    // TODO(Hito 2 - Datos): tablas DynamoDB (Devices, Telemetry, Alerts,
    // Observations, AnomalyCases, OpenCaseLocks, EventLog,
    // CaregiverAccess) en modo PAY_PER_REQUEST.

    // TODO(Hito 2 - Evidencia): bucket S3 privado, bloqueo de acceso
    // publico, cifrado y ciclo de vida de 7 dias para raw-images/.

    // TODO(Hito 4 - Orquestacion): bus/regla de EventBridge y maquina
    // Step Functions Standard (unico orquestador de plazos/callbacks) por
    // caseId.

    // TODO(Hito 5 - Control de demo): Cognito, API Gateway y Lambdas
    // minimas de consulta/cancelacion/escalamiento, mas el adaptador
    // demoIngestHandler (solo telemetria/anomalias de sensor, allowlist de
    // deviceId demo).

    // TODO(Hito 6 - Notificacion y llamada): SNS y Amazon Connect Customer
    // (Voice) via EscalationPolicy/EmergencyDialer, destino unicamente en
    // allowlist de demo, nunca 911.

    // TODO(Hito 2/3 - Fallas criticas): DLQ y alarma minima DLQ -> SNS.
  }
}
