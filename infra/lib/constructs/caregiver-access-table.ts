import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Relacion usuario <-> dispositivo emparejado por QR (Hito 5, control de
 * acceso de lectura). `userId` es el `sub` del JWT de Cognito (identifica
 * a la persona, no el deviceId ni el email); `deviceId` es el dispositivo
 * al que esa persona emparejo con exito via POST /devices/{deviceId}/pair.
 * Sin una fila aqui, GET /devices/{deviceId}/latest y /telemetry responden
 * 403 para ese usuario+dispositivo, sin importar que su JWT sea valido.
 *
 * RemovalPolicy.RETAIN: un `cdk destroy` no debe borrar a quien ya
 * empareja su dispositivo.
 *
 * GSI `CaregiverAccessByDevice` (PK deviceId, Hito de alertas): la tabla
 * base solo responde "¿este userId tiene acceso a este deviceId?" en O(1).
 * DispatchAlertFn necesita la pregunta inversa -- "¿que usuarios estan
 * emparejados con el deviceId de este caso?" -- para poblar la auditoria
 * `notifiedCaregiverIds` de Alerts sin un Scan. La entrega real de SNS
 * sigue siendo un solo topic con suscripciones configuradas fuera de este
 * repositorio (ver dispatchAlertFn.ts); este GSI es solo para auditoria de
 * quien estaba autorizado al momento de alertar, no para direccionar el
 * envio por caregiver.
 */
export class CaregiverAccessTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "CaregiverAccessTable", {
      tableName: "SenseCare-CaregiverAccess",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "CaregiverAccessByDevice",
      partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
  }
}
