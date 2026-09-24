import * as pinpoint from "aws-cdk-lib/aws-pinpoint";
import { Construct } from "constructs";

export interface PushApplicationProps {
  /**
   * Contenido del JSON de cuenta de servicio que Firebase entrega al
   * registrar el proyecto (API HTTP v1 de FCM, no la server key legacy que
   * Google esta retirando). Nunca un valor por defecto ni un secreto en
   * Git: se pasa explicitamente desde bin/sensecare-demo.ts (variable de
   * entorno `FCM_SERVICE_ACCOUNT_JSON`).
   */
  fcmServiceAccountJson: string;
}

/**
 * Amazon Pinpoint (rebautizado por AWS como "AWS End User Messaging Push"
 * para canales de push, aunque el namespace de CloudFormation/IAM sigue
 * siendo `pinpoint`/`mobiletargeting`): una App de Pinpoint + un canal GCM
 * (FCM) para Android. Se eligio Pinpoint en vez de intentar "SNS Mobile
 * Push" (`AWS::SNS::PlatformApplication`): ese recurso ya NO existe en la
 * version de aws-cdk-lib de este repo (AWS lo esta retirando a favor de
 * este mismo servicio) -- se descubrio al escribir este construct, y se
 * corrigio en el momento en vez de dejarlo a medias. Ver
 * docs/IMPLEMENTATION_ROADMAP.md, "Hito de notificaciones push y
 * confirmacion de voz".
 *
 * Solo se instancia si hay credencial de Firebase real (ver
 * SenseCareDemoStack): sin `FCM_SERVICE_ACCOUNT_JSON`, este construct
 * entero se omite y el stack sigue desplegando exactamente igual que hoy.
 * Solo Android/GCM en este hito: iOS/APNs queda fuera de alcance.
 *
 * ADVERTENCIA DE VIGENCIA (verificado al escribir esto, 2026-09-24):
 * `cdk synth` emite una advertencia de CloudFormation Validate diciendo que
 * `AWS::Pinpoint::App` es un recurso de un servicio que AWS retirara el
 * 2026-10-30. Para el demo del hackathon esto es seguro (la fecha de
 * retiro es semanas despues), pero cualquier uso de este construct mas
 * alla del demo DEBE migrar a "AWS End User Messaging Push" (el servicio
 * dedicado que reemplaza tanto a esto como a SNS Mobile Push) antes de esa
 * fecha. Al momento de escribir esto no existe un SDK/CDK L1 publicado
 * para ese servicio bajo un nombre de paquete verificable; revisar de
 * nuevo antes de octubre de 2026.
 */
export class PushApplication extends Construct {
  public readonly applicationId: string;

  constructor(scope: Construct, id: string, props: PushApplicationProps) {
    super(scope, id);

    const app = new pinpoint.CfnApp(this, "PinpointApp", {
      name: "SenseCare-Push",
    });

    new pinpoint.CfnGCMChannel(this, "AndroidGcmChannel", {
      applicationId: app.ref,
      serviceJson: props.fcmServiceAccountJson,
      defaultAuthenticationMethod: "TOKEN",
      enabled: true,
    });

    this.applicationId = app.ref;
  }
}
