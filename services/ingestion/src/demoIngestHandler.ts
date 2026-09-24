import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { validateTelemetry, validateSensorAnomaly } from "@sensecare/contracts";
import { sqs } from "./clients.js";
import { demoConfig } from "./demoConfig.js";

/**
 * Adaptador HTTPS del simulador de demo (Hito 5). A diferencia de los otros
 * 3 handlers (disparados por SQS desde una IoT Rule), este responde a
 * API Gateway: valida el schema y el deviceId AQUI MISMO (con respuesta
 * sincrona 4xx si algo esta mal, mejor experiencia para quien construye el
 * simulador que un fallo silencioso en una cola), y de ahi en adelante
 * empuja al MISMO SQS que usan los dispositivos MQTT reales, agregando
 * `mqttDeviceId` el mismo metadato de transporte que normalmente pone la
 * IoT Rule (`topic(4) AS mqttDeviceId`, ver envelope.ts) para que
 * telemetryIngestHandler/sensorAnomalyIngestHandler procesen el mensaje sin
 * ningun cambio de codigo ahi. Nunca escribe directo en DynamoDB.
 *
 * Nunca acepta VISUAL_ANOMALY: esa solo la puede producir la Pi tras ver la
 * camara real (ver docs/SIMULATOR_INTEGRATION_GUIDE.md).
 */
function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const pathDeviceId = event.pathParameters?.deviceId;
  if (!pathDeviceId) {
    return jsonResponse(400, { error: "Falta deviceId en la ruta" });
  }

  if (!demoConfig.deviceAllowlist.has(pathDeviceId)) {
    // Mismo codigo de error para "no esta en la allowlist" que mas abajo
    // para deviceId inconsistente: no revelamos cual de las dos causas fue,
    // para no ayudar a enumerar deviceId validos.
    return jsonResponse(403, { error: "deviceId no autorizado para el endpoint de demo" });
  }

  let payload: unknown;
  try {
    const rawBody = event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf-8")
        : event.body
      : undefined;
    payload = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    return jsonResponse(400, { error: "Cuerpo JSON invalido" });
  }

  if (typeof payload !== "object" || payload === null) {
    return jsonResponse(400, { error: "Cuerpo JSON invalido" });
  }

  const bodyDeviceId = (payload as { deviceId?: unknown }).deviceId;
  if (bodyDeviceId !== pathDeviceId) {
    return jsonResponse(403, { error: "deviceId no autorizado para el endpoint de demo" });
  }

  const eventType = (payload as { eventType?: unknown }).eventType;
  let queueUrl: string;

  if (eventType === undefined) {
    if (!validateTelemetry(payload)) {
      return jsonResponse(400, { error: "Telemetry invalida", details: validateTelemetry.errors });
    }
    queueUrl = demoConfig.telemetryQueueUrl;
  } else if (eventType === "SENSOR_ANOMALY") {
    if (!validateSensorAnomaly(payload)) {
      return jsonResponse(400, {
        error: "SensorAnomaly invalida",
        details: validateSensorAnomaly.errors,
      });
    }
    queueUrl = demoConfig.sensorAnomalyQueueUrl;
  } else {
    // Incluye "VISUAL_ANOMALY": el navegador nunca puede producirla.
    return jsonResponse(403, {
      error: `eventType "${String(eventType)}" no permitido en el endpoint de demo`,
    });
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ ...payload, mqttDeviceId: pathDeviceId }),
    }),
  );

  const eventId = (payload as { eventId: string }).eventId;
  return jsonResponse(202, { accepted: true, eventId });
}
