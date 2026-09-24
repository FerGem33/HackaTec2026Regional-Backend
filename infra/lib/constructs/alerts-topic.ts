import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";

export interface AlertsTopicProps {
  /**
   * Emails de familiares de demo para SenseCare-Alerts. Nunca un valor por
   * defecto ni un email real hardcodeado: se pasa explicitamente desde
   * bin/sensecare-demo.ts (variable de entorno opcional), o se deja vacio y
   * se suscribe manualmente por consola/CLI tras el deploy (ver runbook).
   * SNS exige que cada direccion confirme la suscripcion por correo antes
   * de recibir mensajes; eso no se puede automatizar.
   */
  alertSubscriptionEmails?: string[];
  /** Emails del equipo tecnico para SenseCare-OperationalAlarms (DLQ). */
  operationalSubscriptionEmails?: string[];
}

/**
 * Dos topics separados a proposito (Hito de alertas):
 * - `SenseCare-Alerts`: mensajes dirigidos a familiares (anomalia/caso).
 * - `SenseCare-OperationalAlarms`: alarmas de CloudWatch sobre DLQ,
 *   dirigidas al equipo tecnico.
 * Reutilizar un solo topic mandaria ruido de infraestructura (una DLQ con
 * mensajes atascados) a la bandeja de un familiar de demo -- son audiencias
 * y contenidos distintos aunque ambos sean "notificaciones por SNS".
 *
 * Solo email (`subscriptions.EmailSubscription`): nunca SMS ni telefonia
 * para este hito (ver limites del hito de alertas).
 */
export class AlertsTopic extends Construct {
  public readonly alertsTopic: sns.Topic;
  public readonly operationalAlarmsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlertsTopicProps = {}) {
    super(scope, id);

    this.alertsTopic = new sns.Topic(this, "AlertsTopic", {
      topicName: "SenseCare-Alerts",
      displayName: "SenseCare - Alertas de caso",
    });
    for (const email of props.alertSubscriptionEmails ?? []) {
      this.alertsTopic.addSubscription(new subscriptions.EmailSubscription(email));
    }

    this.operationalAlarmsTopic = new sns.Topic(this, "OperationalAlarmsTopic", {
      topicName: "SenseCare-OperationalAlarms",
      displayName: "SenseCare - Alarmas operativas (DLQ)",
    });
    for (const email of props.operationalSubscriptionEmails ?? []) {
      this.operationalAlarmsTopic.addSubscription(new subscriptions.EmailSubscription(email));
    }
  }
}
