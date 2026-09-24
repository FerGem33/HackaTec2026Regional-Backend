import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Correlacion privada taskToken<->decision humana (hito de escalamiento),
 * mismo diseno que EvidenceCallbacksTable: PK caseId + SK callbackType fijo
 * ("HUMAN_DECISION") habilita idempotencia por caso/fase sin GSI.
 *
 * El taskToken de Step Functions vive UNICAMENTE aqui -- nunca en
 * AnomalyCases, EventLog, Alerts ni en ningun otro estado de la ejecucion
 * (contrato explicito del hito de escalamiento). TTL sobre
 * ttlEpochSeconds: esta tabla es efimera por diseno.
 *
 * RemovalPolicy.RETAIN, igual que el resto de tablas operativas de
 * SenseCare.
 */
export class CaseActionCallbacksTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "CaseActionCallbacksTable", {
      tableName: "SenseCare-CaseActionCallbacks",
      partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "callbackType", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttlEpochSeconds",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
