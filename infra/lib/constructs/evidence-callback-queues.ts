import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface EvidenceCallbackQueuePair {
  queue: sqs.Queue;
  deadLetterQueue: sqs.Queue;
}

/**
 * 2 colas separadas para los callbacks MQTT de evidencia (command-acks,
 * evidence), simetricas a IngestionQueues (Hito 2): Standard, cifrado
 * gestionado por SQS, DLQ propia, maxReceiveCount 5, retencion 4 dias,
 * long polling 20s.
 *
 * VisibilityTimeout = 20s: a proposito NO sigue la regla general de "6x el
 * timeout de la Lambda" del resto de colas de SenseCare
 * (docs/ARCHITECTURE_DETAILED.md), aunque se mantiene por encima del
 * timeout de las Lambdas consumidoras (15s, ver
 * evidence-callback-handlers.ts) para nunca redisponibilizar un mensaje
 * mientras aun se esta procesando. Se acorta deliberadamente para que, ante
 * un fallo transitorio (p. ej. throttling de DynamoDB), varios reintentos
 * de entrega quepan dentro de los ~90s que RequestEvidenceUpload espera en
 * Step Functions (ver case-orchestration.ts): con maxReceiveCount 5 hay
 * margen para al menos 3 intentos completos antes de ese timeout. Ver
 * infra/test/evidence-timing.test.ts para la relacion numerica exacta.
 *
 * Un reintento verdaderamente agotado (los 5 intentos fallan) puede, aun
 * asi, exceder el timeout de Step Functions: eso sigue siendo seguro,
 * porque recordEvidenceOutcomeFn reconcilia EvidenceCallbacks de forma
 * incondicional sin importar por que camino llego la ejecucion (exito,
 * States.Timeout o el catch-all de error), asi que una resolucion tardia
 * nunca deja el registro huerfano (ver
 * services/evidence/src/callbackStore.ts:reconcileAfterWorkflowOutcome).
 */
export class EvidenceCallbackQueues extends Construct {
  public readonly commandAcks: EvidenceCallbackQueuePair;
  public readonly evidence: EvidenceCallbackQueuePair;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.commandAcks = this.createQueuePair("CommandAcks", "SenseCare-command-acks");
    this.evidence = this.createQueuePair("Evidence", "SenseCare-evidence");
  }

  private createQueuePair(idPrefix: string, queueName: string): EvidenceCallbackQueuePair {
    const deadLetterQueue = new sqs.Queue(this, `${idPrefix}Dlq`, {
      queueName: `${queueName}-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const queue = new sqs.Queue(this, `${idPrefix}Queue`, {
      queueName,
      retentionPeriod: cdk.Duration.days(4),
      visibilityTimeout: cdk.Duration.seconds(20),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 5,
      },
    });

    return { queue, deadLetterQueue };
  }
}
