import * as cdk from "aws-cdk-lib";
import * as iot from "aws-cdk-lib/aws-iot";
import { Construct } from "constructs";

/**
 * Politica IoT declarativa, sin Thing/certificado/llave privada y sin
 * adjuntarla a ningun principal: eso sigue siendo un paso manual, fuera de
 * CDK y fuera de git (ver runbook de pre-despliegue). Esta politica sola
 * no otorga nada hasta que alguien la asocie (attach-policy) a un
 * certificado X.509 real.
 *
 * Usa la variable de sustitucion de AWS IoT `${iot:Connection.Thing.ThingName}`
 * (NO un token de CDK: es texto literal que AWS IoT evalua en tiempo de
 * conexion segun el ThingName reclamado por el client ID MQTT) para que UNA
 * sola politica sirva cualquier dispositivo sin comodines `#`/`+` ni ARNs
 * fijos de otro deviceId. El ThingName debe ser igual al deviceId usado en
 * los topics (convencion ya usada: "pi-demo-01").
 *
 * Condicion `iot:Connection.Thing.IsAttached: true` en cada statement: sin
 * ella, `${iot:Connection.Thing.ThingName}` se resuelve solo con el client
 * ID que el dispositivo declara al conectar, sin verificar que exista un
 * AttachThingPrincipal real para ese certificado. Como esta politica se
 * comparte entre todos los dispositivos (una sola politica, muchos
 * certificados), sin esta condicion un certificado legitimo podria
 * conectarse con el client ID de OTRO deviceId y heredar sus topics. La
 * condicion obliga a AWS IoT a verificar la asociacion real
 * certificado-Thing antes de resolver la variable.
 *
 * AWS IoT versiona automaticamente esta politica (hasta 5 versiones) cada
 * vez que su documento cambia; no requiere configuracion adicional.
 */
export class DeviceAccessPolicy extends Construct {
  public readonly policy: iot.CfnPolicy;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const thingNameVar = "${iot:Connection.Thing.ThingName}";
    const topicArn = (suffix: string) =>
      `arn:aws:iot:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:topic/SenseCare/v1/devices/${thingNameVar}/${suffix}`;
    const topicFilterArn = (suffix: string) =>
      `arn:aws:iot:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:topicfilter/SenseCare/v1/devices/${thingNameVar}/${suffix}`;
    const clientArn = `arn:aws:iot:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:client/${thingNameVar}`;

    // Exige que el certificado conectado este realmente adjunto (via
    // AttachThingPrincipal) al Thing que reclama ser; sin esto, el
    // aislamiento por ${iot:Connection.Thing.ThingName} es solo nominal.
    const requireAttachedThing = { Bool: { "iot:Connection.Thing.IsAttached": "true" } };

    this.policy = new iot.CfnPolicy(this, "DeviceAccessPolicy", {
      policyName: "SenseCare-device-access",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "iot:Connect",
            Resource: clientArn,
            Condition: requireAttachedThing,
          },
          {
            Effect: "Allow",
            Action: "iot:Publish",
            Resource: [
              topicArn("telemetry"),
              topicArn("visual/anomaly"),
              topicArn("sensor/anomaly"),
              topicArn("status"),
              topicArn("command-acks"),
              topicArn("evidence"),
            ],
            Condition: requireAttachedThing,
          },
          {
            Effect: "Allow",
            Action: "iot:Subscribe",
            Resource: topicFilterArn("commands"),
            Condition: requireAttachedThing,
          },
          {
            Effect: "Allow",
            Action: "iot:Receive",
            Resource: topicArn("commands"),
            Condition: requireAttachedThing,
          },
        ],
      },
    });
  }
}
