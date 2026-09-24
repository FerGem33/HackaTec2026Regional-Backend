import { PublishCommand } from "@aws-sdk/client-iot-data-plane";
import { validateUploadEvidenceCommand } from "@sensecare/contracts";
import type { UploadEvidenceCommand } from "@sensecare/contracts";
import { iotData } from "./clients.js";

/**
 * Valida el propio comando saliente contra el schema antes de publicarlo
 * (misma disciplina que se exige a la entrada), para detectar un bug
 * propio antes de que llegue a la Pi.
 */
export async function publishUploadEvidenceCommand(
  deviceId: string,
  command: UploadEvidenceCommand,
): Promise<void> {
  if (!validateUploadEvidenceCommand(command)) {
    throw new Error(
      `UPLOAD_EVIDENCE invalido antes de publicar: ${JSON.stringify(validateUploadEvidenceCommand.errors)}`,
    );
  }

  await iotData.send(
    new PublishCommand({
      topic: `SenseCare/v1/devices/${deviceId}/commands`,
      payload: new TextEncoder().encode(JSON.stringify(command)),
      qos: 1,
    }),
  );
}
