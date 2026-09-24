import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface DlqAlarmsProps {
  operationalAlarmsTopic: sns.ITopic;
  /** Una entrada por DLQ critica ya existente en el stack. */
  deadLetterQueues: Record<string, sqs.IQueue>;
}

/**
 * Alarma minima de DLQ -> SNS (ver docs/ARCHITECTURE.md, "se mantiene una
 * alarma minima de DLQ -> SNS para detectar fallos de entrega criticos").
 * Una alarma por cada DLQ critica ya desplegada: 3 de ingesta
 * (telemetry/visual-anomaly/sensor-anomaly), 2 de callbacks de evidencia
 * (command-acks/evidence) y la del case-dispatcher. No crea colas nuevas,
 * solo observa las que ya existen.
 *
 * `treatMissingData: NOT_BREACHING`: la ausencia de datapoints significa
 * "sin mensajes visibles que reportar" (una DLQ sana no publica metricas
 * constantemente), nunca una condicion de alarma -- lo contrario
 * generaria falsos positivos permanentes en una DLQ que nunca ha fallado.
 */
export class DlqAlarms extends Construct {
  public readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: DlqAlarmsProps) {
    super(scope, id);

    const action = new cloudwatchActions.SnsAction(props.operationalAlarmsTopic);

    for (const [name, queue] of Object.entries(props.deadLetterQueues)) {
      const alarm = new cloudwatch.Alarm(this, `${name}DlqAlarm`, {
        alarmName: `SenseCare-${name}-dlq-messages`,
        alarmDescription: `Mensajes visibles en la DLQ ${name}: revisar fallos de entrega/procesamiento.`,
        metric: queue.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
      this.alarms.push(alarm);
    }
  }
}
