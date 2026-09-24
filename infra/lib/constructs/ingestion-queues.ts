import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface IngestionQueuePair {
  queue: sqs.Queue;
  deadLetterQueue: sqs.Queue;
}

/**
 * 3 colas separadas (telemetry, visual-anomaly, sensor-anomaly), cada una
 * con su propia DLQ y redrive policy. Configuracion segun
 * docs/ARCHITECTURE_DETAILED.md seccion 4: Standard, visibilidad 90s (6x
 * el timeout de Lambda de 15s), retencion 4 dias, long polling 20s,
 * maxReceiveCount 5, cifrado gestionado por SQS.
 */
export class IngestionQueues extends Construct {
  public readonly telemetry: IngestionQueuePair;
  public readonly visualAnomaly: IngestionQueuePair;
  public readonly sensorAnomaly: IngestionQueuePair;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.telemetry = this.createQueuePair("Telemetry", "SenseCare-telemetry");
    this.visualAnomaly = this.createQueuePair("VisualAnomaly", "SenseCare-visual-anomaly");
    this.sensorAnomaly = this.createQueuePair("SensorAnomaly", "SenseCare-sensor-anomaly");
  }

  private createQueuePair(idPrefix: string, queueName: string): IngestionQueuePair {
    const deadLetterQueue = new sqs.Queue(this, `${idPrefix}Dlq`, {
      queueName: `${queueName}-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const queue = new sqs.Queue(this, `${idPrefix}Queue`, {
      queueName,
      retentionPeriod: cdk.Duration.days(4),
      visibilityTimeout: cdk.Duration.seconds(90),
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
