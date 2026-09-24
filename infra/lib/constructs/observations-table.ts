import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Resultado estructurado de analisis visual (Bedrock Converse), uno por
 * imagen analizada. PK caseId + SK imageId: un caso puede en el futuro
 * generar mas de una observacion (re-analisis, una foto fresca adicional),
 * sin necesitar migracion de esquema.
 *
 * Solo se escribe una fila aqui cuando analysisStatus === "COMPLETED"; un
 * resultado UNCERTAIN nunca crea fila (mismo principio que
 * EvidenceCallbacks: SKIPPED_NO_CONSENT nunca crea registro).
 *
 * TTL sobre ttlEpochSeconds (numero, epoch segundos): protege el resumen
 * narrativo (`summary`, texto libre) atado al mismo ciclo de vida que la
 * foto que lo origino (lifecycle de 7 dias en EvidenceBucket). Los campos
 * cerrados/estructurados equivalentes (riskIndicators, needsHumanReview,
 * confidence) se copian ademas a AnomalyCases, que si es permanente.
 *
 * RemovalPolicy.RETAIN: el TTL de DynamoDB decide cuando expira cada fila;
 * un `cdk destroy` nunca debe borrar datos antes de tiempo.
 */
export class ObservationsTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "ObservationsTable", {
      tableName: "SenseCare-Observations",
      partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "imageId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttlEpochSeconds",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
