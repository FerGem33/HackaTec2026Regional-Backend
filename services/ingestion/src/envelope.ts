export class DeviceIdMismatchError extends Error {
  constructor(
    public readonly mqttDeviceId: unknown,
    public readonly payloadDeviceId: unknown,
  ) {
    super(
      `mqttDeviceId no coincide con payload.deviceId: mqttDeviceId=${JSON.stringify(
        mqttDeviceId,
      )} payload.deviceId=${JSON.stringify(payloadDeviceId)}`,
    );
    this.name = "DeviceIdMismatchError";
  }
}

interface Envelope {
  mqttDeviceId?: unknown;
  [key: string]: unknown;
}

/**
 * `mqttDeviceId` es metadato de TRANSPORTE agregado por la IoT Rule
 * (`topic(4) AS mqttDeviceId`); nunca forma parte de los contratos de
 * @sensecare/contracts (que son additionalProperties:false). Este helper
 * separa mqttDeviceId del payload y verifica que coincide exactamente con
 * el `deviceId` declarado dentro del JSON, ANTES de que el payload limpio
 * llegue al validador de schema.
 *
 * Sin esta verificacion, una Raspberry Pi autenticada y autorizada a
 * publicar unicamente en su propio topic MQTT podria falsificar dentro
 * del cuerpo JSON el deviceId de otro dispositivo, y el backend
 * resolveria recipientId para el destinatario equivocado.
 *
 * El futuro adaptador HTTPS del simulador de demo (demoIngestHandler,
 * Hito 5) NO pasa por AWS IoT Core y por lo tanto nunca produce
 * mqttDeviceId; su autorizacion es una allowlist explicita de deviceId
 * validada dentro de ese propio handler, no esta verificacion de
 * transporte.
 */
export function extractVerifiedPayload(rawBody: string): unknown {
  const envelope = JSON.parse(rawBody) as Envelope;
  const { mqttDeviceId, ...payload } = envelope;

  if (typeof mqttDeviceId !== "string" || mqttDeviceId.length === 0) {
    throw new Error(
      `mqttDeviceId ausente o invalido en el envelope de transporte: ${JSON.stringify(mqttDeviceId)}`,
    );
  }

  const payloadDeviceId = (payload as { deviceId?: unknown }).deviceId;
  if (payloadDeviceId !== mqttDeviceId) {
    throw new DeviceIdMismatchError(mqttDeviceId, payloadDeviceId);
  }

  return payload;
}
