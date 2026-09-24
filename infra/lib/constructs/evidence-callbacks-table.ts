import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Correlacion privada comando<->token de Step Functions para el transporte
 * de evidencia puntual (ver services/evidence/src/callbackStore.ts). PK
 * caseId + SK callbackType fijo ("IMAGE_EVIDENCE") habilita, sin GSI,
 * idempotencia por caso/fase: un solo registro por caso para esta fase, sin
 * importar cuantos comandos o reintentos genere.
 *
 * TTL sobre ttlEpochSeconds (numero, epoch segundos): DynamoDB exige un
 * atributo TTL numerico, nunca un string ISO.
 *
 * RemovalPolicy.RETAIN, igual que el resto de tablas operativas de
 * SenseCare. Nunca contiene uploadUrl ni bytes de imagen/audio (ver
 * docs/EDGE_IMPLEMENTATION_GUIDE.md); el taskToken de Step Functions vive
 * unicamente aqui, en ningun otro lugar del sistema.
 */
export class EvidenceCallbacksTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "EvidenceCallbacksTable", {
      tableName: "SenseCare-EvidenceCallbacks",
      partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "callbackType", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttlEpochSeconds",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
