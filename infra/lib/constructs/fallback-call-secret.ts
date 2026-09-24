import * as cdk from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

export interface FallbackCallSecretProps {
  /**
   * Nombre del parametro SSM SecureString (p. ej.
   * "/sensecare/demo/fallback-call-destination"), NUNCA su valor. El valor
   * real del numero de destino se fija a mano despues del deploy con
   * `aws ssm put-parameter --type SecureString --key-id <CMK>` (ver
   * docs/EMERGENCY_CALL_RUNBOOK.md) -- exactamente el mismo patron que los
   * certificados X.509 de la Pi: nunca pasa por CDK, Git ni el estado del
   * stack.
   */
  parameterName: string;
}

/**
 * CMK dedicada exclusivamente a cifrar el parametro SSM del numero de
 * fallback de demo (hito de escalamiento). No crea el recurso
 * `AWS::SSM::Parameter` en si -- un SecureString con un valor real
 * requeriria pasar el numero por CDK, lo que lo dejaria en el estado de
 * CloudFormation y en el historial de despliegues. Este construct solo
 * construye el ARN del parametro (para conceder `ssm:GetParameter` exacto)
 * y la CMK (para `kms:Decrypt` exacto); el parametro mismo se crea a mano.
 */
export class FallbackCallSecret extends Construct {
  public readonly cmk: kms.Key;
  public readonly parameterName: string;
  public readonly parameterArn: string;

  constructor(scope: Construct, id: string, props: FallbackCallSecretProps) {
    super(scope, id);

    this.cmk = new kms.Key(this, "FallbackCallDestinationKey", {
      description:
        "CMK exclusiva del parametro SSM del numero de fallback de demo (hito de escalamiento). No se reutiliza para nada mas.",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.parameterName = props.parameterName;
    // Formato documentado de ARN de SSM Parameter:
    // arn:{partition}:ssm:{region}:{account}:parameter{name} -- `name` ya
    // trae su propio "/" inicial, sin separador adicional entre
    // "parameter" y el nombre.
    this.parameterArn = `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${props.parameterName}`;
  }
}
