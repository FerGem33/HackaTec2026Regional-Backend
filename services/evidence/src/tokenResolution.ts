import { InvalidToken, SendTaskFailureCommand, SendTaskSuccessCommand, TaskDoesNotExist, TaskTimedOut } from "@aws-sdk/client-sfn";
import { sfn } from "./clients.js";
import {
  acquireResolutionLease,
  finalizeResolved,
  releaseLeaseAsUnconfirmed,
  type ResolvedOutcomeType,
} from "./callbackStore.js";

const SUCCESS_OUTCOME: ResolvedOutcomeType = "UPLOADED";

/**
 * Resolucion de UN token conocido, sin lease ni tabla: usada solo por
 * requestEvidenceUploadFn cuando un reintento encuentra el registro ya
 * RESOLVED y necesita satisfacer el token de ESTA invocacion con el
 * resultado ya decidido. Best-effort: si falla, se loguea y no se relanza
 * (el timeout de Step Functions absorbe el caso de forma segura).
 */
export async function resolveTaskToken(
  taskToken: string,
  outcomeType: ResolvedOutcomeType,
  reason?: string,
  successOutput?: Record<string, unknown>,
): Promise<void> {
  try {
    if (outcomeType === SUCCESS_OUTCOME) {
      await sfn.send(
        new SendTaskSuccessCommand({
          taskToken,
          output: JSON.stringify(successOutput ?? { outcome: outcomeType }),
        }),
      );
    } else {
      await sfn.send(
        new SendTaskFailureCommand({ taskToken, error: outcomeType, cause: reason ?? outcomeType }),
      );
    }
  } catch (error) {
    console.warn("resolveTaskToken: no se pudo resolver el token (best-effort)", {
      outcomeType,
      error: error instanceof Error ? error.message : error,
    });
  }
}

export type LeaseResolutionOutcome = "RESOLVED" | "NOOP_CONTENDED" | "UNCONFIRMED";

/**
 * Resolucion con lease de propietario unico, para los callback handlers.
 *
 * `InvalidToken`/`TaskDoesNotExist`/`TaskTimedOut` NO se tratan como exito:
 * tambien pueden significar que Step Functions ya tomo el timeout, o que
 * se uso un token vencido/incorrecto. En ese caso el registro queda
 * `UNCONFIRMED` (no `RESOLVED`) y esta funcion NO toca ningun otro dato
 * (no se asume AVAILABLE ni ningun otro resultado); el camino de timeout
 * de la propia State Machine, o recordEvidenceOutcomeFn, determinan el
 * resultado final.
 *
 * Cualquier otro error se relanza: la Lambda debe fallar para que SQS
 * reintente (el lease expira solo y permite un nuevo intento).
 */
export async function resolveWithLease(
  tableName: string,
  caseId: string,
  commandId: string,
  leaseSeconds: number,
  outcomeType: ResolvedOutcomeType,
  successOutput: Record<string, unknown> | undefined,
  reason: string | undefined,
): Promise<LeaseResolutionOutcome> {
  const lease = await acquireResolutionLease(tableName, caseId, commandId, leaseSeconds);
  if (!lease) {
    return "NOOP_CONTENDED";
  }

  try {
    if (outcomeType === SUCCESS_OUTCOME) {
      await sfn.send(
        new SendTaskSuccessCommand({
          taskToken: lease.taskToken,
          output: JSON.stringify(successOutput ?? { outcome: outcomeType }),
        }),
      );
    } else {
      await sfn.send(
        new SendTaskFailureCommand({
          taskToken: lease.taskToken,
          error: outcomeType,
          cause: reason ?? outcomeType,
        }),
      );
    }
  } catch (error) {
    if (error instanceof InvalidToken || error instanceof TaskDoesNotExist || error instanceof TaskTimedOut) {
      await releaseLeaseAsUnconfirmed(tableName, caseId, lease);
      return "UNCONFIRMED";
    }
    throw error;
  }

  await finalizeResolved(tableName, caseId, lease, outcomeType, reason);
  return "RESOLVED";
}
