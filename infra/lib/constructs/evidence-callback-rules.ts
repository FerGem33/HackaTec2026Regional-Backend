import * as cdk from "aws-cdk-lib";
import * as iot from "aws-cdk-lib/aws-iot";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface EvidenceCallbackRulesProps {
  commandAcksQueue: sqs.IQueue;
  evidenceQueue: sqs.IQueue;
}

/**
 * 2 IoT Rules nuevas para el tramo de evidencia: command-acks y evidence.
 * El Hito 2 (iot-ingestion-rules.ts) solo cubria telemetry/visual-anomaly/
 * sensor-anomaly; estos dos topics de callback Pi->nube no tenian regla
 * todavia (confirmado: sin ellas, la Pi puede publicar COMMAND_ACK y
 * EVIDENCE_UPLOADED/EVIDENCE_FAILED pero ningun mensaje llega a SQS).
 *
 * Mismo patron exacto que Hito 2: SELECT * mas topic(4) AS mqttDeviceId (el
 * 4to segmento de "SenseCare/v1/devices/{deviceId}/..."), un rol IAM por
 * regla limitado a sqs:SendMessage sobre UNA sola cola, sin comodines de
 * topic ni de ARN.
 */
export class EvidenceCallbackRules extends Construct {
  constructor(scope: Construct, id: string, props: EvidenceCallbackRulesProps) {
    super(scope, id);

    this.createRule("CommandAcks", "command-acks", props.commandAcksQueue);
    this.createRule("Evidence", "evidence", props.evidenceQueue);
  }

  private createRule(idPrefix: string, topicSuffix: string, queue: sqs.IQueue): void {
    const errorLogGroup = new logs.LogGroup(this, `${idPrefix}RuleErrors`, {
      logGroupName: `/sensecare/iot-rules/${idPrefix}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ruleRole = new iam.Role(this, `${idPrefix}RuleRole`, {
      assumedBy: new iam.ServicePrincipal("iot.amazonaws.com"),
    });

    // grantSendMessages otorga sqs:SendMessage escopado unicamente al ARN
    // de esta cola (igual que iot-ingestion-rules.ts).
    queue.grantSendMessages(ruleRole);
    errorLogGroup.grantWrite(ruleRole);

    new iot.CfnTopicRule(this, `${idPrefix}Rule`, {
      ruleName: `SenseCare_${idPrefix}Callback`,
      topicRulePayload: {
        sql: `SELECT *, topic(4) AS mqttDeviceId FROM 'SenseCare/v1/devices/+/${topicSuffix}'`,
        awsIotSqlVersion: "2016-03-23",
        actions: [
          {
            sqs: {
              queueUrl: queue.queueUrl,
              roleArn: ruleRole.roleArn,
              useBase64: false,
            },
          },
        ],
        errorAction: {
          cloudwatchLogs: {
            logGroupName: errorLogGroup.logGroupName,
            roleArn: ruleRole.roleArn,
          },
        },
      },
    });
  }
}
