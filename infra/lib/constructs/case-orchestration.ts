import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "node:path";

export interface CaseOrchestrationProps {
  eventBus: events.IEventBus;
  openCaseLocksTable: dynamodb.ITable;
  anomalyCasesTable: dynamodb.ITable;
  devicesTable: dynamodb.ITable;
  evidenceCallbacksTable: dynamodb.ITable;
  eventLogTable: dynamodb.ITable;
  evidenceBucket: s3.IBucket;
  observationsTable: dynamodb.ITable;
  // Sin default: el operador debe verificar disponibilidad/acceso real del
  // modelo (aws bedrock list-foundation-models/list-inference-profiles,
  // solo lectura) antes de desplegar. bedrockModelId es el valor que se
  // pasa como `modelId` a ConverseCommand (acepta tanto un modelId plano
  // como un inference-profile id/ARN). bedrockInferenceProfileArn y
  // bedrockFoundationModelArns son necesarios para el IAM exacto: Bedrock
  // exige permiso tanto sobre el inference profile como sobre cada
  // foundation model al que ese profile puede enrutar.
  bedrockModelId: string;
  bedrockInferenceProfileArn: string;
  bedrockFoundationModelArns: string[];
  openCaseLockTtlSeconds?: number;
  evidenceUploadTimeoutSeconds?: number;
  evidenceCallbackTtlBufferSeconds?: number;
  evidenceWaitTimeoutSeconds?: number;
  bedrockMaxTokens?: number;
  bedrockTemperature?: number;
}

// Resuelto desde __dirname (no process.cwd()): estable sin importar desde
// que directorio se invoque `cdk`/`npm test` (misma correccion aplicada a
// ingestion-functions.ts en Hito 2).
const ORCHESTRATION_ENTRY_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "services",
  "orchestration",
  "src",
);
const EVIDENCE_ENTRY_ROOT = path.resolve(__dirname, "..", "..", "..", "services", "evidence", "src");
const ANALYSIS_ENTRY_ROOT = path.resolve(__dirname, "..", "..", "..", "services", "analysis", "src");

/**
 * Hito 4 completo: EventBridge -> Step Functions Standard por caseId,
 * seguido del tramo de transporte seguro de evidencia puntual
 * (CheckCameraConsent -> RequestEvidenceUpload con waitForTaskToken ->
 * RecordEvidenceOutcome). No incluye Bedrock, SNS, Connect, Cognito, API
 * Gateway, frontend ni check-in de voz/audio (ver
 * docs/IMPLEMENTATION_ROADMAP.md).
 *
 * Sin CloudWatch Logs en la State Machine (decision explicita de esta
 * ola). El unico waitForTaskToken de todo el sistema es
 * RequestEvidenceUpload; el token nunca se escribe en AnomalyCases,
 * EventLog ni en ningun estado posterior de la propia ejecucion (solo
 * transita, de forma inherente al patron nativo de AWS, como parte de los
 * parametros de invocacion de esa unica Task mientras espera).
 */
export class CaseOrchestration extends Construct {
  public readonly stateMachine: sfn.StateMachine;
  public readonly caseDispatcherFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: CaseOrchestrationProps) {
    super(scope, id);

    // Sin reservedConcurrentExecutions: ver ingestion-functions.ts para el
    // porque (la cuenta debe conservar al menos 10 ejecuciones Lambda no
    // reservadas; reservar en las Lambdas de SenseCare lo violaba).
    const commonFnProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      bundling: { format: lambdaNodejs.OutputFormat.CJS, target: "node22" },
      handler: "handler",
    } satisfies Partial<lambdaNodejs.NodejsFunctionProps>;

    // --- Task Lambdas: registro de caso (tramo original) ---

    const taskEnvironment = {
      OPEN_CASE_LOCKS_TABLE_NAME: props.openCaseLocksTable.tableName,
      ANOMALY_CASES_TABLE_NAME: props.anomalyCasesTable.tableName,
      OPEN_CASE_LOCK_TTL_SECONDS: String(props.openCaseLockTtlSeconds ?? 7200),
    };

    const renewOpenCaseLockFn = new lambdaNodejs.NodejsFunction(this, "RenewOpenCaseLockFn", {
      ...commonFnProps,
      functionName: "SenseCare-renewOpenCaseLock",
      entry: path.join(ORCHESTRATION_ENTRY_ROOT, "renewOpenCaseLockFn.ts"),
      environment: taskEnvironment,
    });
    props.openCaseLocksTable.grant(renewOpenCaseLockFn, "dynamodb:UpdateItem");

    const upsertAnomalyCaseFn = new lambdaNodejs.NodejsFunction(this, "UpsertAnomalyCaseFn", {
      ...commonFnProps,
      functionName: "SenseCare-upsertAnomalyCase",
      entry: path.join(ORCHESTRATION_ENTRY_ROOT, "upsertAnomalyCaseFn.ts"),
      environment: taskEnvironment,
    });
    props.anomalyCasesTable.grant(upsertAnomalyCaseFn, "dynamodb:PutItem", "dynamodb:UpdateItem");

    // --- Task Lambdas: tramo de evidencia ---

    const cameraConsentFn = new lambdaNodejs.NodejsFunction(this, "CameraConsentFn", {
      ...commonFnProps,
      functionName: "SenseCare-cameraConsent",
      entry: path.join(EVIDENCE_ENTRY_ROOT, "cameraConsentFn.ts"),
      environment: {
        DEVICES_TABLE_NAME: props.devicesTable.tableName,
      },
    });
    props.devicesTable.grant(cameraConsentFn, "dynamodb:GetItem");

    const requestEvidenceUploadFn = new lambdaNodejs.NodejsFunction(this, "RequestEvidenceUploadFn", {
      ...commonFnProps,
      functionName: "SenseCare-requestEvidenceUpload",
      entry: path.join(EVIDENCE_ENTRY_ROOT, "requestEvidenceUploadFn.ts"),
      environment: {
        EVIDENCE_CALLBACKS_TABLE_NAME: props.evidenceCallbacksTable.tableName,
        EVENT_LOG_TABLE_NAME: props.eventLogTable.tableName,
        EVIDENCE_BUCKET_NAME: props.evidenceBucket.bucketName,
        EVIDENCE_UPLOAD_TIMEOUT_SECONDS: String(props.evidenceUploadTimeoutSeconds ?? 60),
        EVIDENCE_CALLBACK_TTL_BUFFER_SECONDS: String(props.evidenceCallbackTtlBufferSeconds ?? 3600),
      },
    });
    props.evidenceCallbacksTable.grant(
      requestEvidenceUploadFn,
      "dynamodb:PutItem",
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    );
    props.eventLogTable.grant(requestEvidenceUploadFn, "dynamodb:PutItem");
    // Firmar una URL PUT no hace ninguna llamada a AWS por si mismo, pero
    // la firma resultante se valida contra los permisos IAM de ESTE rol en
    // el momento en que la Pi realiza el PUT real; sin s3:PutObject aqui,
    // la subida de la Pi recibiria 403 pese a tener una URL "valida".
    // Acotado al prefijo raw-images/ del bucket, nunca al bucket completo
    // ni a s3:*.
    requestEvidenceUploadFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [props.evidenceBucket.arnForObjects("raw-images/*")],
      }),
    );
    // iot:Publish, no s3:*/dynamodb:*/Action:"*": una sola accion, acotada
    // por sufijo de topic a "/commands" para cualquier deviceId (esta
    // Lambda sirve casos de cualquier dispositivo, a diferencia de la
    // politica del propio dispositivo en device-access-policy.ts, que
    // resuelve un solo ThingName por conexion). Aprobado explicitamente
    // durante el diseno de este tramo.
    requestEvidenceUploadFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iot:Publish"],
        resources: [
          `arn:aws:iot:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:topic/SenseCare/v1/devices/*/commands`,
        ],
      }),
    );

    const recordEvidenceOutcomeFn = new lambdaNodejs.NodejsFunction(this, "RecordEvidenceOutcomeFn", {
      ...commonFnProps,
      functionName: "SenseCare-recordEvidenceOutcome",
      entry: path.join(EVIDENCE_ENTRY_ROOT, "recordEvidenceOutcomeFn.ts"),
      environment: {
        ANOMALY_CASES_TABLE_NAME: props.anomalyCasesTable.tableName,
        EVIDENCE_CALLBACKS_TABLE_NAME: props.evidenceCallbacksTable.tableName,
        EVENT_LOG_TABLE_NAME: props.eventLogTable.tableName,
      },
    });
    props.anomalyCasesTable.grant(recordEvidenceOutcomeFn, "dynamodb:UpdateItem");
    // Solo UpdateItem: reconcileAfterWorkflowOutcome nunca lee ni crea
    // registros en EvidenceCallbacks, unicamente los cierra a RESOLVED (o
    // no-opea si SKIPPED_NO_CONSENT nunca creo uno).
    props.evidenceCallbacksTable.grant(recordEvidenceOutcomeFn, "dynamodb:UpdateItem");
    props.eventLogTable.grant(recordEvidenceOutcomeFn, "dynamodb:PutItem");

    // --- Task Lambdas: tramo de analisis (Bedrock Converse) ---
    // Solo se invoca despues de evidenceStatus === "AVAILABLE" (ver Choice
    // "EvidenceAvailable?" mas abajo). Nunca cierra ni escala el caso;
    // unicamente produce analysisStatus (COMPLETED|UNCERTAIN), hermano de
    // evidenceStatus, nunca un reemplazo.

    const analysisFnProps = {
      ...commonFnProps,
      // Mas memoria/timeout que el resto de tareas: lee un JPEG de S3 y
      // espera una respuesta de Bedrock (ver services/analysis). Mismo
      // dimensionamiento que el "visionProcessor" propuesto en
      // docs/ARCHITECTURE_DETAILED.md seccion 9.
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
    } satisfies Partial<lambdaNodejs.NodejsFunctionProps>;

    const analyzeEvidenceFn = new lambdaNodejs.NodejsFunction(this, "AnalyzeEvidenceFn", {
      ...analysisFnProps,
      functionName: "SenseCare-analyzeEvidence",
      entry: path.join(ANALYSIS_ENTRY_ROOT, "analyzeEvidenceFn.ts"),
      environment: {
        EVIDENCE_BUCKET_NAME: props.evidenceBucket.bucketName,
        EVENT_LOG_TABLE_NAME: props.eventLogTable.tableName,
        BEDROCK_MODEL_ID: props.bedrockModelId,
        BEDROCK_MAX_TOKENS: String(props.bedrockMaxTokens ?? 400),
        BEDROCK_TEMPERATURE: String(props.bedrockTemperature ?? 0),
      },
    });
    // Solo lectura, acotada al mismo prefijo que ya usa
    // evidenceCallbackHandlerFn; nunca el bucket completo ni s3:*.
    analyzeEvidenceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [props.evidenceBucket.arnForObjects("raw-images/*")],
      }),
    );
    // Bedrock exige permiso tanto sobre el inference profile como sobre
    // cada foundation model al que puede enrutar (ver
    // https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html).
    // La condicion bedrock:InferenceProfileArn impide que este rol invoque
    // los foundation models directamente, fuera del profile geografico
    // "us." elegido (residencia/privacidad).
    analyzeEvidenceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [props.bedrockInferenceProfileArn],
      }),
    );
    analyzeEvidenceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: props.bedrockFoundationModelArns,
        conditions: {
          StringEquals: { "bedrock:InferenceProfileArn": props.bedrockInferenceProfileArn },
        },
      }),
    );
    props.eventLogTable.grant(analyzeEvidenceFn, "dynamodb:PutItem");

    const recordAnalysisOutcomeFn = new lambdaNodejs.NodejsFunction(this, "RecordAnalysisOutcomeFn", {
      ...commonFnProps,
      functionName: "SenseCare-recordAnalysisOutcome",
      entry: path.join(ANALYSIS_ENTRY_ROOT, "recordAnalysisOutcomeFn.ts"),
      environment: {
        ANOMALY_CASES_TABLE_NAME: props.anomalyCasesTable.tableName,
        OBSERVATIONS_TABLE_NAME: props.observationsTable.tableName,
        EVENT_LOG_TABLE_NAME: props.eventLogTable.tableName,
        // Nunca llama a Bedrock; solo deja constancia de procedencia en
        // Observations. Mismos valores que analyzeEvidenceFn.
        BEDROCK_MODEL_ID: props.bedrockModelId,
        BEDROCK_MAX_TOKENS: String(props.bedrockMaxTokens ?? 400),
        BEDROCK_TEMPERATURE: String(props.bedrockTemperature ?? 0),
      },
    });
    props.anomalyCasesTable.grant(recordAnalysisOutcomeFn, "dynamodb:UpdateItem");
    props.observationsTable.grant(recordAnalysisOutcomeFn, "dynamodb:PutItem");
    props.eventLogTable.grant(recordAnalysisOutcomeFn, "dynamodb:PutItem");

    // --- State Machine ---
    // Cada Task del tramo de registro recibe { caseDetail: $, executionArn:
    // $$.Execution.Id } y descarta su propio resultado (JsonPath.DISCARD),
    // asi que "$" nunca cambia entre estados: ambas tasks ven exactamente
    // el mismo detalle de anomalia con el que arranco la ejecucion.
    const taskPayload = sfn.TaskInput.fromObject({
      "caseDetail.$": "$",
      "executionArn.$": "$$.Execution.Id",
    });

    const caseRegistrationFailed = new sfn.Fail(this, "CaseRegistrationFailed", {
      error: "CaseRegistrationFailed",
      cause: "No se pudo registrar/renovar el caso; revisar CloudWatch Logs y EventLog.",
    });

    const renewLockTask = new tasks.LambdaInvoke(this, "RenewOpenCaseLock", {
      lambdaFunction: renewOpenCaseLockFn,
      payload: taskPayload,
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
      // Retry explicito para errores transitorios del servicio Lambda
      // (throttling, timeouts de invocacion del propio Lambda, etc.):
      // Lambda.ServiceException / AWSLambdaException / SdkClientException /
      // ClientExecutionTimeoutException, 2s de intervalo, backoff x2, 6
      // intentos maximos. Ver
      // https://docs.aws.amazon.com/step-functions/latest/dg/bp-lambda-serviceexception.html
      retryOnServiceExceptions: true,
    });
    renewLockTask.addCatch(caseRegistrationFailed, {
      errors: [sfn.Errors.ALL],
      resultPath: "$.error",
    });

    const upsertCaseTask = new tasks.LambdaInvoke(this, "UpsertAnomalyCase", {
      lambdaFunction: upsertAnomalyCaseFn,
      payload: taskPayload,
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
      retryOnServiceExceptions: true,
    });
    upsertCaseTask.addCatch(caseRegistrationFailed, {
      errors: [sfn.Errors.ALL],
      resultPath: "$.error",
    });

    // --- Tramo de evidencia ---
    // A partir de aqui "$" deja de ser el detalle plano de la anomalia: se
    // envuelve una sola vez en { caseDetail, executionArn } para poder
    // acumular campos hermanos (cameraConsent, evidenceStatus, ...) sin
    // ensuciar caseDetail con datos de fases posteriores.
    const prepareEvidencePhase = new sfn.Pass(this, "PrepareEvidencePhase", {
      parameters: {
        "caseDetail.$": "$",
        "executionArn.$": "$$.Execution.Id",
      },
    });

    const evidenceRecordingFailed = new sfn.Fail(this, "EvidenceOutcomeRecordingFailed", {
      error: "EvidenceOutcomeRecordingFailed",
      cause: "No se pudo registrar el resultado final de evidencia; revisar CloudWatch Logs y EventLog.",
    });

    const recordOutcomeTask = new tasks.LambdaInvoke(this, "RecordEvidenceOutcome", {
      lambdaFunction: recordEvidenceOutcomeFn,
      // "$" ya tiene, en cada rama, exactamente la forma de
      // RecordEvidenceOutcomeInput (ver los Pass de cada rama abajo): sin
      // reconstruir el payload campo por campo, lo que evitaria referenciar
      // por error una ruta ausente en alguna rama (p. ej. evidenceReason no
      // existe en la rama AVAILABLE).
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
      retryOnServiceExceptions: true,
    });
    recordOutcomeTask.addCatch(evidenceRecordingFailed, {
      errors: [sfn.Errors.ALL],
      resultPath: "$.error",
    });

    // --- Tramo de analisis (Bedrock) ---

    const caseAnalysisPhaseComplete = new sfn.Succeed(this, "CaseAnalysisPhaseComplete");

    const analysisRecordingFailed = new sfn.Fail(this, "AnalysisOutcomeRecordingFailed", {
      error: "AnalysisOutcomeRecordingFailed",
      cause: "No se pudo registrar el resultado de analisis; revisar CloudWatch Logs y EventLog.",
    });

    const recordAnalysisOutcomeTask = new tasks.LambdaInvoke(this, "RecordAnalysisOutcome", {
      lambdaFunction: recordAnalysisOutcomeFn,
      // "$" ya tiene, en cada rama, exactamente la forma que
      // recordAnalysisOutcomeFn espera (ver PrepareAnalysisOutcome y los
      // MapToAnalysisUncertain* abajo): analysisStatus siempre presente,
      // observation/failureReason siempre presentes (aunque sea null), asi
      // que ninguna rama referencia una ruta ausente.
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
      retryOnServiceExceptions: true,
    });
    recordAnalysisOutcomeTask.addCatch(analysisRecordingFailed, {
      errors: [sfn.Errors.ALL],
      resultPath: "$.error",
    });
    recordAnalysisOutcomeTask.next(caseAnalysisPhaseComplete);

    const prepareAnalysisOutcome = new sfn.Pass(this, "PrepareAnalysisOutcome", {
      parameters: {
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        "evidenceS3Key.$": "$.evidenceS3Key",
        "evidenceImageId.$": "$.evidenceImageId",
        "analysisStatus.$": "$.analysisResult.analysisStatus",
        "observation.$": "$.analysisResult.observation",
        "failureReason.$": "$.analysisResult.failureReason",
      },
    });
    prepareAnalysisOutcome.next(recordAnalysisOutcomeTask);

    // Los 4 destinos de Catch de AnalyzeEvidence usan un failureReason FIJO
    // (nunca $.analysisError.Error): mismo principio de seguridad que
    // MapToError en el tramo de evidencia, nunca propagar texto de
    // excepcion tecnica sin controlar hacia AnomalyCases/EventLog.
    // evidenceS3Key/evidenceImageId siguen presentes en "$" desde
    // MapToAvailable (AnalyzeEvidence nunca los toca ni los descarta), asi
    // que tambien se propagan aqui para que la auditoria de un resultado
    // incierto siga sabiendo a que imagen se referia. Sin `observation:
    // null` explicito: sfn.Pass omite por completo las claves con valor
    // literal null al sintetizar, asi que la clave sencillamente no existe
    // en $ para estas 4 ramas; recordAnalysisOutcomeFn.ts solo lee
    // `observation` dentro de la rama analysisStatus==="COMPLETED", asi que
    // su ausencia aqui es inocua.
    const mapToAnalysisUncertainThrottled = new sfn.Pass(this, "MapToAnalysisUncertainThrottled", {
      parameters: {
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        "evidenceS3Key.$": "$.evidenceS3Key",
        "evidenceImageId.$": "$.evidenceImageId",
        analysisStatus: "UNCERTAIN",
        failureReason: "THROTTLED",
      },
    });
    mapToAnalysisUncertainThrottled.next(recordAnalysisOutcomeTask);

    const mapToAnalysisUncertainTimeout = new sfn.Pass(this, "MapToAnalysisUncertainTimeout", {
      parameters: {
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        "evidenceS3Key.$": "$.evidenceS3Key",
        "evidenceImageId.$": "$.evidenceImageId",
        analysisStatus: "UNCERTAIN",
        failureReason: "MODEL_TIMEOUT",
      },
    });
    mapToAnalysisUncertainTimeout.next(recordAnalysisOutcomeTask);

    const mapToAnalysisUncertainUnavailable = new sfn.Pass(this, "MapToAnalysisUncertainUnavailable", {
      parameters: {
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        "evidenceS3Key.$": "$.evidenceS3Key",
        "evidenceImageId.$": "$.evidenceImageId",
        analysisStatus: "UNCERTAIN",
        failureReason: "MODEL_UNAVAILABLE",
      },
    });
    mapToAnalysisUncertainUnavailable.next(recordAnalysisOutcomeTask);

    const mapToAnalysisUncertainInternal = new sfn.Pass(this, "MapToAnalysisUncertainInternal", {
      parameters: {
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        "evidenceS3Key.$": "$.evidenceS3Key",
        "evidenceImageId.$": "$.evidenceImageId",
        analysisStatus: "UNCERTAIN",
        failureReason: "INTERNAL_ERROR",
      },
    });
    mapToAnalysisUncertainInternal.next(recordAnalysisOutcomeTask);

    const analyzeEvidenceTask = new tasks.LambdaInvoke(this, "AnalyzeEvidence", {
      lambdaFunction: analyzeEvidenceFn,
      payload: sfn.TaskInput.fromObject({
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        "evidenceS3Key.$": "$.evidenceS3Key",
        "evidenceImageId.$": "$.evidenceImageId",
      }),
      payloadResponseOnly: true,
      resultPath: "$.analysisResult",
      retryOnServiceExceptions: true,
    });
    // Solo se reintenta la invocacion completa (relee S3, vuelve a llamar
    // Bedrock) para errores transitorios de Bedrock. ValidationException/
    // AccessDeniedException/ResourceNotFoundException y la validacion de
    // schema de la observacion se atrapan DENTRO del Lambda (ver
    // services/analysis/src/analyzeEvidenceFn.ts) y jamas llegan aqui como
    // excepcion: nunca se reintentan.
    analyzeEvidenceTask.addRetry({
      errors: [
        "ThrottlingException",
        "ModelTimeoutException",
        "ServiceUnavailableException",
        "InternalServerException",
        "ModelErrorException",
      ],
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });
    analyzeEvidenceTask.addCatch(mapToAnalysisUncertainThrottled, {
      errors: ["ThrottlingException"],
      resultPath: "$.analysisError",
    });
    analyzeEvidenceTask.addCatch(mapToAnalysisUncertainTimeout, {
      errors: ["ModelTimeoutException"],
      resultPath: "$.analysisError",
    });
    analyzeEvidenceTask.addCatch(mapToAnalysisUncertainUnavailable, {
      errors: ["ServiceUnavailableException", "InternalServerException", "ModelErrorException"],
      resultPath: "$.analysisError",
    });
    analyzeEvidenceTask.addCatch(mapToAnalysisUncertainInternal, {
      errors: [sfn.Errors.ALL],
      resultPath: "$.analysisError",
    });
    analyzeEvidenceTask.next(prepareAnalysisOutcome);

    const evidenceAvailableChoice = new sfn.Choice(this, "EvidenceAvailable?")
      .when(sfn.Condition.stringEquals("$.evidenceStatus", "AVAILABLE"), analyzeEvidenceTask)
      .otherwise(caseAnalysisPhaseComplete);

    recordOutcomeTask.next(evidenceAvailableChoice);

    const mapToSkippedNoConsent = new sfn.Pass(this, "MapToSkippedNoConsent", {
      parameters: {
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        evidenceStatus: "SKIPPED_NO_CONSENT",
      },
    });
    mapToSkippedNoConsent.next(recordOutcomeTask);

    const mapToAvailable = new sfn.Pass(this, "MapToAvailable", {
      parameters: {
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        evidenceStatus: "AVAILABLE",
        "evidenceS3Key.$": "$.evidenceUploadResult.s3Key",
        "evidenceImageId.$": "$.evidenceUploadResult.imageId",
      },
    });
    mapToAvailable.next(recordOutcomeTask);

    const mapToIncomplete = new sfn.Pass(this, "MapToIncomplete", {
      parameters: {
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        evidenceStatus: "INCOMPLETE",
        "evidenceReason.$": "$.evidenceError.Error",
      },
    });
    mapToIncomplete.next(recordOutcomeTask);

    // A diferencia de MapToIncomplete (que solo recibe codigos cerrados
    // conocidos: REJECTED, UPLOAD_FAILED, OBJECT_INVALID, OBJECT_MISSING,
    // States.Timeout), este es el destino del catch-all States.ALL: puede
    // recibir CUALQUIER error tecnico no controlado (excepcion de runtime,
    // fallo de SDK, etc.). evidenceReason debe ser un codigo fijo y seguro,
    // nunca $.evidenceError.Error, para no propagar texto de error tecnico
    // no controlado hacia AnomalyCases ni EventLog.
    const mapToError = new sfn.Pass(this, "MapToError", {
      parameters: {
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        evidenceStatus: "ERROR",
        evidenceReason: "INTERNAL_ERROR",
      },
    });
    mapToError.next(recordOutcomeTask);

    const checkCameraConsentTask = new tasks.LambdaInvoke(this, "CheckCameraConsent", {
      lambdaFunction: cameraConsentFn,
      payload: sfn.TaskInput.fromObject({
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
      }),
      payloadResponseOnly: true,
      resultPath: "$.cameraConsent",
      retryOnServiceExceptions: true,
    });
    checkCameraConsentTask.addCatch(mapToError, {
      errors: [sfn.Errors.ALL],
      resultPath: "$.evidenceError",
    });

    // Motivos de rechazo/incertidumbre conocidos (COMMAND_ACK
    // accepted:false, resultado de evidencia invalido/ausente, o el
    // timeout nativo del wait) mapean a INCOMPLETE, nunca a un cierre
    // automatico exitoso ni a ERROR. Cualquier otra falla tecnica cae en el
    // catch-all -> ERROR.
    const knownIncompleteErrors = [
      "REJECTED",
      "UPLOAD_FAILED",
      "OBJECT_INVALID",
      "OBJECT_MISSING",
      "States.Timeout",
    ];

    const requestEvidenceUploadTask = new tasks.LambdaInvoke(this, "RequestEvidenceUpload", {
      lambdaFunction: requestEvidenceUploadFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        "caseDetail.$": "$.caseDetail",
        "executionArn.$": "$.executionArn",
        taskToken: sfn.JsonPath.taskToken,
      }),
      // ~90s: por encima de EVIDENCE_UPLOAD_TIMEOUT_SECONDS (60s, el
      // vencimiento propio del comando UPLOAD_EVIDENCE/de la URL prefirmada
      // en EvidenceCallbacks) y con margen suficiente para que las colas de
      // callback (visibilityTimeout ~20s, ver evidence-callback-queues.ts)
      // completen al menos 3 intentos de entrega/procesamiento de un
      // COMMAND_ACK o resultado de evidencia -- por ejemplo tras un
      // throttling transitorio de DynamoDB -- antes de que Step Functions
      // tome el timeout por su cuenta. Ver
      // infra/test/evidence-timing.test.ts para la relacion numerica exacta.
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(props.evidenceWaitTimeoutSeconds ?? 90)),
      resultPath: "$.evidenceUploadResult",
    });
    requestEvidenceUploadTask.addCatch(mapToIncomplete, {
      errors: knownIncompleteErrors,
      resultPath: "$.evidenceError",
    });
    requestEvidenceUploadTask.addCatch(mapToError, {
      errors: [sfn.Errors.ALL],
      resultPath: "$.evidenceError",
    });
    requestEvidenceUploadTask.next(mapToAvailable);

    const cameraConsentGranted = sfn.Condition.booleanEquals("$.cameraConsent", true);
    const cameraConsentChoice = new sfn.Choice(this, "CameraConsentGranted?")
      .when(cameraConsentGranted, requestEvidenceUploadTask)
      .otherwise(mapToSkippedNoConsent);

    const definition = renewLockTask
      .next(upsertCaseTask)
      .next(prepareEvidencePhase)
      .next(checkCameraConsentTask)
      .next(cameraConsentChoice);

    this.stateMachine = new sfn.StateMachine(this, "SenseCareCaseStateMachine", {
      stateMachineName: "SenseCare-CaseStateMachine",
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
    });

    // --- Dispatcher Lambda (target de EventBridge) ---
    // No hay forma de fijar un nombre de ejecucion determinista desde un
    // target nativo de EventBridge hacia Step Functions (verificado contra
    // aws-events-targets.SfnStateMachineProps: solo expone input/role), por
    // eso el target es esta Lambda, que llama StartExecution ella misma.
    this.caseDispatcherFn = new lambdaNodejs.NodejsFunction(this, "CaseDispatcherFn", {
      ...commonFnProps,
      functionName: "SenseCare-caseDispatcher",
      entry: path.join(ORCHESTRATION_ENTRY_ROOT, "caseDispatcherFn.ts"),
      environment: {
        STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
      },
    });
    this.stateMachine.grantStartExecution(this.caseDispatcherFn);

    const dispatcherDlq = new sqs.Queue(this, "CaseDispatcherDlq", {
      queueName: "SenseCare-case-dispatcher-dlq",
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    new events.Rule(this, "AnomalyDetectedRule", {
      ruleName: "SenseCare-AnomalyDetected",
      eventBus: props.eventBus,
      eventPattern: {
        source: ["SenseCare"],
        detailType: ["anomaly.detected"],
      },
      targets: [
        new targets.LambdaFunction(this.caseDispatcherFn, {
          deadLetterQueue: dispatcherDlq,
          retryAttempts: 3,
        }),
      ],
    });
  }
}
