import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "./clients.js";
import { config } from "./escalationConfig.js";
import { writeEscalationEventLog } from "./eventLog.js";

export type BlockReason =
  | "CASE_NOT_FOUND"
  | "CASE_CANCELLED"
  | "NO_ACTIVE_HUMAN_NOTIFICATION_CHANNEL"
  | "NOTIFICATION_NOT_PUBLISHED"
  | "RISK_NOT_ELIGIBLE"
  | "CONSENT_MISSING"
  | "DEVICE_NOT_ALLOWED"
  | "ALREADY_DIALED";

export interface EscalationPolicyInput {
  caseDetail: {
    caseId: string;
    deviceId: string;
    eventType: "VISUAL_ANOMALY" | "SENSOR_ANOMALY";
    anomalyType: string;
    severity?: string;
  };
}

export type EscalationDecision = { allowed: true } | { allowed: false; reason: BlockReason };

interface AnomalyCaseState {
  humanDecision?: string;
  notificationStatus?: string;
  dialStatus?: string;
}

interface DeviceState {
  fallbackCallConsent?: unknown;
}

const RISK_ELIGIBLE_VISUAL_ANOMALY_TYPES = ["POSSIBLE_FALL", "PERSON_PRONE_INACTIVE"];

/**
 * Determinista, sin permisos Connect (ver services/escalation/src/
 * emergencyDialerFn.ts, la UNICA Lambda con connect:StartOutboundVoiceContact).
 * Cada condicion produce un codigo cerrado propio si bloquea; nunca texto
 * libre ni una excepcion tecnica sin controlar hacia EventLog.
 *
 * Orden de verificacion (todas deben pasar):
 * 1. El caso existe y humanDecision !== "CANCELLED" (releido en caliente).
 * 2. Canal humano de notificacion confirmado por el operador (gate global,
 *    ver escalationConfig.ts -- un sns:Publish exitoso NO es suficiente).
 * 3. notificationStatus === "PUBLISHED" para ESTE caso especificamente.
 * 4. Riesgo elegible: sensor critical, o visual POSSIBLE_FALL/
 *    PERSON_PRONE_INACTIVE. UNEXPECTED_PERSON/CAMERA_TAMPERED/sensor no
 *    critico quedan excluidos por defecto.
 * 5. Devices.fallbackCallConsent === true (booleano estricto, mismo patron
 *    que cameraConsentFn.ts).
 * 6. deviceId en la allowlist propia de escalamiento (nunca el numero real).
 * 7. Idempotencia: reclamar dialStatus=DIALING de forma atomica, con la
 *    MISMA guardia cruzada que alertDecision.ts usa en sentido inverso --
 *    ni humanDecision=CANCELLED puede ganar despues de DIALING, ni DIALING
 *    puede reclamarse despues de CANCELLED (ver docstring de
 *    tryClaimDialing).
 */
export async function handler(input: EscalationPolicyInput): Promise<EscalationDecision> {
  const { caseId, deviceId, eventType, anomalyType, severity } = input.caseDetail;

  const caseState = await getAnomalyCase(caseId);
  if (!caseState) {
    return blockEscalation(caseId, "CASE_NOT_FOUND");
  }
  if (caseState.humanDecision === "CANCELLED") {
    return blockEscalation(caseId, "CASE_CANCELLED");
  }

  if (!config.humanNotificationChannelConfirmed) {
    return blockEscalation(caseId, "NO_ACTIVE_HUMAN_NOTIFICATION_CHANNEL");
  }
  if (caseState.notificationStatus !== "PUBLISHED") {
    return blockEscalation(caseId, "NOTIFICATION_NOT_PUBLISHED");
  }

  if (!isRiskEligible(eventType, anomalyType, severity)) {
    return blockEscalation(caseId, "RISK_NOT_ELIGIBLE");
  }

  const device = await getDevice(deviceId);
  if (device?.fallbackCallConsent !== true) {
    return blockEscalation(caseId, "CONSENT_MISSING");
  }

  if (!config.allowedDeviceIds.includes(deviceId)) {
    return blockEscalation(caseId, "DEVICE_NOT_ALLOWED");
  }

  const claimed = await tryClaimDialing(caseId);
  if (!claimed) {
    const fresh = await getAnomalyCase(caseId);
    if (fresh?.humanDecision === "CANCELLED") {
      return blockEscalation(caseId, "CASE_CANCELLED");
    }
    return blockEscalation(caseId, "ALREADY_DIALED");
  }

  return { allowed: true };
}

function isRiskEligible(
  eventType: "VISUAL_ANOMALY" | "SENSOR_ANOMALY",
  anomalyType: string,
  severity: string | undefined,
): boolean {
  if (eventType === "SENSOR_ANOMALY") {
    return severity === "critical";
  }
  return RISK_ELIGIBLE_VISUAL_ANOMALY_TYPES.includes(anomalyType);
}

async function getAnomalyCase(caseId: string): Promise<AnomalyCaseState | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: config.anomalyCasesTableName,
      Key: { caseId },
      ProjectionExpression: "humanDecision, notificationStatus, dialStatus",
      ConsistentRead: true,
    }),
  );
  return result.Item as AnomalyCaseState | undefined;
}

async function getDevice(deviceId: string): Promise<DeviceState | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: config.devicesTableName,
      Key: { deviceId },
      ProjectionExpression: "fallbackCallConsent",
    }),
  );
  return result.Item as DeviceState | undefined;
}

/**
 * Carrera critica (item 4 del hito de escalamiento): reclama
 * `dialStatus = DIALING` solo si NINGUN CANCEL_ALERT ya escribio
 * `humanDecision = CANCELLED`. Simetrico a la guardia que
 * services/cases/src/alertDecision.ts aplica en sentido inverso (una
 * decision humana nueva nunca puede escribirse si dialStatus ya es
 * DIALING/CALLED). Ambas transiciones son condicionales sobre el MISMO
 * item de AnomalyCases; solo una de las dos partes puede ganar.
 */
async function tryClaimDialing(caseId: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: config.anomalyCasesTableName,
        Key: { caseId },
        UpdateExpression: "SET dialStatus = :dialing, dialingClaimedAt = :now",
        ConditionExpression:
          "attribute_not_exists(dialStatus) AND (attribute_not_exists(humanDecision) OR humanDecision <> :cancelled)",
        ExpressionAttributeValues: {
          ":dialing": "DIALING",
          ":now": new Date().toISOString(),
          ":cancelled": "CANCELLED",
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw error;
  }
}

async function blockEscalation(caseId: string, reason: BlockReason): Promise<EscalationDecision> {
  // BLOCKED solo si dialStatus todavia no existe: CASE_CANCELLED/ALREADY_DIALED
  // pueden llegar cuando dialStatus ya es DIALING/CALLED (o cuando la
  // decision vive solo en humanDecision) -- nunca se pisa ese estado real.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: config.anomalyCasesTableName,
        Key: { caseId },
        UpdateExpression: "SET dialStatus = :blocked, dialBlockedReason = :reason",
        ConditionExpression: "attribute_not_exists(dialStatus)",
        ExpressionAttributeValues: { ":blocked": "BLOCKED", ":reason": reason },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
  }

  await writeEscalationEventLog(config.eventLogTableName, {
    caseId,
    eventType: "ESCALATED_BLOCKED",
    reason,
  });

  return { allowed: false, reason };
}
