/**
 * COMMAND_ACK y EvidenceResult (EVIDENCE_UPLOADED/EVIDENCE_FAILED) no
 * llevan `deviceId` en el payload (a diferencia de Telemetry/VisualAnomaly/
 * SensorAnomaly). La verificacion de identidad para estos dos contratos no
 * puede comparar mqttDeviceId contra un campo del payload; se hace contra
 * el `deviceId` guardado en EvidenceCallbacks al crear el comando (ver
 * callbackStore.ts). Este helper solo separa mqttDeviceId del payload.
 */
export interface MqttEnvelopeResult {
  mqttDeviceId: string;
  payload: unknown;
}

export function extractMqttDeviceId(rawBody: string): MqttEnvelopeResult {
  const envelope = JSON.parse(rawBody) as Record<string, unknown>;
  const { mqttDeviceId, ...payload } = envelope;

  if (typeof mqttDeviceId !== "string" || mqttDeviceId.length === 0) {
    throw new Error(
      `mqttDeviceId ausente o invalido en el envelope de transporte: ${JSON.stringify(mqttDeviceId)}`,
    );
  }

  return { mqttDeviceId, payload };
}
