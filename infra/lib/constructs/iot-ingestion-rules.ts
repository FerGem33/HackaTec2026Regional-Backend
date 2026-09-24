import * as cdk from "aws-cdk-lib";
import * as iot from "aws-cdk-lib/aws-iot";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface IotIngestionRulesProps {
  telemetryQueue: sqs.IQueue;
  visualAnomalyQueue: sqs.IQueue;
  sensorAnomalyQueue: sqs.IQueue;
}

/**
 * 3 IoT Rules separadas (telemetry, visual/anomaly, sensor/anomaly), cada
 * una con su propio rol IAM limitado a `sqs:SendMessage` sobre UNA sola
 * cola (sin comodines de topic ni de ARN de cola). No crea Thing ni
 * certificado X.509: eso queda fuera de este hito.
 */
export class IotIngestionRules extends Construct {
  constructor(scope: Construct, id: string, props: IotIngestionRulesProps) {
    super(scope, id);

    this.createRule("Telemetry", "telemetry", props.telemetryQueue);
    this.createRule("VisualAnomaly", "visual/anomaly", props.visualAnomalyQueue);
    this.createRule("SensorAnomaly", "sensor/anomaly", props.sensorAnomalyQueue);
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

    // grantSendMessages otorga sqs:SendMessage (+ atributos de la cola de
    // forma minima) escopado unicamente al ARN de esta cola.
    queue.grantSendMessages(ruleRole);
    errorLogGroup.grantWrite(ruleRole);

    new iot.CfnTopicRule(this, `${idPrefix}Rule`, {
      ruleName: `SenseCare_${idPrefix}Ingestion`,
      topicRulePayload: {
        // SELECT * mas topic(4) AS mqttDeviceId: deviceId es el 4to
        // segmento de "SenseCare/v1/devices/{deviceId}/...". mqttDeviceId
        // viaja como metadato de TRANSPORTE, fuera de los contratos de
        // @sensecare/contracts (additionalProperties:false) — por eso no
        // se agregan otras columnas calculadas como "topic() AS mqttTopic"
        // o "timestamp() AS receivedAt", que si rompen el schema.
        // Cada handler de ingesta separa mqttDeviceId del payload y lo
        // compara contra payload.deviceId ANTES de validar el schema (ver
        // services/ingestion/src/envelope.ts): una Pi solo puede publicar
        // en su propio topic, pero sin esta verificacion podria falsificar
        // dentro del JSON el deviceId de otra Pi.
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
