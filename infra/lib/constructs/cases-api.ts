import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import * as path from "node:path";

export interface CasesApiProps {
  httpApi: apigwv2.HttpApi;
  /** El mismo JWT authorizer de DemoIngestApi (DemoAuth), reutilizado tal cual. */
  authorizer: apigwv2.IHttpRouteAuthorizer;
  anomalyCasesTable: dynamodb.ITable;
  alertsTable: dynamodb.ITable;
  eventLogTable: dynamodb.ITable;
  caregiverAccessTable: dynamodb.ITable;
}

const SERVICE_ENTRY_ROOT = path.resolve(__dirname, "..", "..", "..", "services", "cases", "src");

const commonFnProps = {
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  memorySize: 512,
  timeout: cdk.Duration.seconds(10),
  bundling: { format: lambdaNodejs.OutputFormat.CJS, target: "node22" },
  handler: "handler",
} satisfies Partial<lambdaNodejs.NodejsFunctionProps>;

/**
 * Acciones humanas autenticadas sobre un caso (hito de alertas + hito de
 * notificaciones): GET /cases (historial), GET /cases/{caseId}/events,
 * POST /cases/{caseId}/cancel (CANCEL_ALERT), POST /cases/{caseId}/escalate
 * (ESCALATE). Reutiliza el HttpApi y el JWT authorizer YA creados por
 * DemoIngestApi (mismo Cognito User Pool, misma URL base) en vez de
 * levantar un segundo API Gateway.
 *
 * Autorizacion en 2 pasos, siempre en este orden (ver
 * services/cases/src/decisionHandlerCore.ts): resolver caseId -> deviceId
 * via AnomalyCases, luego verificar CaregiverAccess(userId, deviceId). Un
 * 403/404 se responde ANTES de tocar EventLog o el cuerpo de la respuesta;
 * ninguna de las 4 rutas confia en un recipientId/deviceId enviado por el
 * cliente. GET /cases es la unica excepcion deliberada a "403 si no hay
 * acceso": es una vista por-usuario (lista, no un recurso puntual), asi que
 * "sin ningun deviceId emparejado" responde 200 con lista vacia (ver
 * services/cases/src/listCasesHandler.ts).
 */
export class CasesApi extends Construct {
  public readonly listCasesFn: lambdaNodejs.NodejsFunction;
  public readonly getCaseEventsFn: lambdaNodejs.NodejsFunction;
  public readonly cancelCaseFn: lambdaNodejs.NodejsFunction;
  public readonly escalateCaseFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: CasesApiProps) {
    super(scope, id);

    const readEnvironment = {
      ANOMALY_CASES_TABLE_NAME: props.anomalyCasesTable.tableName,
      ALERTS_TABLE_NAME: props.alertsTable.tableName,
      EVENT_LOG_TABLE_NAME: props.eventLogTable.tableName,
      CAREGIVER_ACCESS_TABLE_NAME: props.caregiverAccessTable.tableName,
    };

    this.listCasesFn = new lambdaNodejs.NodejsFunction(this, "ListCasesFn", {
      ...commonFnProps,
      functionName: "SenseCare-listCases",
      entry: path.join(SERVICE_ENTRY_ROOT, "listCasesHandler.ts"),
      environment: {
        ANOMALY_CASES_TABLE_NAME: props.anomalyCasesTable.tableName,
        CAREGIVER_ACCESS_TABLE_NAME: props.caregiverAccessTable.tableName,
      },
    });
    // Solo Query (nunca Scan): CaregiverAccess por PK userId, AnomalyCases
    // por el GSI AnomalyCasesByDevice. Sin dynamodb:GetItem: esta ruta
    // nunca lee un caso puntual, solo listas.
    props.caregiverAccessTable.grant(this.listCasesFn, "dynamodb:Query");
    props.anomalyCasesTable.grant(this.listCasesFn, "dynamodb:Query");

    this.getCaseEventsFn = new lambdaNodejs.NodejsFunction(this, "GetCaseEventsFn", {
      ...commonFnProps,
      functionName: "SenseCare-getCaseEvents",
      entry: path.join(SERVICE_ENTRY_ROOT, "getCaseEventsHandler.ts"),
      environment: readEnvironment,
    });
    props.anomalyCasesTable.grant(this.getCaseEventsFn, "dynamodb:GetItem");
    props.caregiverAccessTable.grant(this.getCaseEventsFn, "dynamodb:GetItem");
    props.eventLogTable.grant(this.getCaseEventsFn, "dynamodb:Query");

    this.cancelCaseFn = new lambdaNodejs.NodejsFunction(this, "CancelCaseFn", {
      ...commonFnProps,
      functionName: "SenseCare-cancelCase",
      entry: path.join(SERVICE_ENTRY_ROOT, "cancelCaseHandler.ts"),
      environment: readEnvironment,
    });
    this.grantDecisionPermissions(this.cancelCaseFn, props);

    this.escalateCaseFn = new lambdaNodejs.NodejsFunction(this, "EscalateCaseFn", {
      ...commonFnProps,
      functionName: "SenseCare-escalateCase",
      entry: path.join(SERVICE_ENTRY_ROOT, "escalateCaseHandler.ts"),
      environment: readEnvironment,
    });
    this.grantDecisionPermissions(this.escalateCaseFn, props);

    props.httpApi.addRoutes({
      path: "/cases",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("ListCasesIntegration", this.listCasesFn),
      authorizer: props.authorizer,
    });

    props.httpApi.addRoutes({
      path: "/cases/{caseId}/events",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("GetCaseEventsIntegration", this.getCaseEventsFn),
      authorizer: props.authorizer,
    });

    props.httpApi.addRoutes({
      path: "/cases/{caseId}/cancel",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("CancelCaseIntegration", this.cancelCaseFn),
      authorizer: props.authorizer,
    });

    props.httpApi.addRoutes({
      path: "/cases/{caseId}/escalate",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("EscalateCaseIntegration", this.escalateCaseFn),
      authorizer: props.authorizer,
    });
  }

  private grantDecisionPermissions(fn: lambdaNodejs.NodejsFunction, props: CasesApiProps): void {
    props.anomalyCasesTable.grant(fn, "dynamodb:GetItem");
    props.caregiverAccessTable.grant(fn, "dynamodb:GetItem");
    props.eventLogTable.grant(fn, "dynamodb:PutItem");
    // Solo TransactWriteItems (nunca PutItem/UpdateItem sueltos): la unica
    // escritura de estas 2 Lambdas es la decision atomica sobre
    // AnomalyCases + Alerts a la vez (ver
    // services/cases/src/alertDecision.ts). Sin sns:Publish: cancel/escalate
    // nunca envian nada, solo registran una decision humana.
    props.anomalyCasesTable.grant(fn, "dynamodb:TransactWriteItems");
    props.alertsTable.grant(fn, "dynamodb:TransactWriteItems");
  }
}
