import { ConnectClient, StartOutboundVoiceContactCommand } from "@aws-sdk/client-connect";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { config } from "./emergencyDialerConfig.js";

// Clientes propios de este modulo, nunca en services/escalation/src/
// clients.ts (compartido con escalationPolicyFn.ts/recordCallOutcomeFn.ts,
// que jamas deben necesitar Connect ni SSM). Instanciarlos aqui no otorga
// ningun permiso por si mismo -- el aislamiento real es el rol IAM de esta
// Lambda (ver infra/lib/constructs/case-orchestration.ts) -- pero mantiene
// el codigo mismo honesto sobre quien toca que.
const connect = new ConnectClient({});
const ssm = new SSMClient({});

export interface EmergencyDialerInput {
  caseId: string;
}

export type EmergencyDialerOutput =
  | { outcome: "CALLED"; contactId: string }
  | { outcome: "FAILED"; errorCode: string };

/**
 * UNICA Lambda de todo SenseCare con `connect:StartOutboundVoiceContact`.
 * Recibe EXCLUSIVAMENTE `caseId` -- nunca deviceId/recipientId/anomalyType
 * ni ningun dato que pudiera sugerir de donde sale el destino. El numero
 * real se lee de un solo parametro SSM SecureString (nunca se loguea, nunca
 * se incluye en el output de esta funcion: solo el `contactId` opaco que
 * genera Connect). `ClientToken: caseId` es la idempotencia nativa de
 * Connect (segunda capa, ademas del `dialStatus` que ya reclamo
 * escalationPolicyFn.ts antes de invocar esta Lambda).
 *
 * Nunca 911 ni un numero fuera de este unico parametro: no existe ningun
 * camino de codigo que acepte un destino por argumento, evento, variable de
 * entorno alternativa, ni respuesta de Bedrock/HTTP/MQTT.
 */
export async function handler(input: EmergencyDialerInput): Promise<EmergencyDialerOutput> {
  try {
    const destinationPhoneNumber = await getDestinationPhoneNumber();

    const result = await connect.send(
      new StartOutboundVoiceContactCommand({
        DestinationPhoneNumber: destinationPhoneNumber,
        ContactFlowId: config.connectContactFlowId,
        InstanceId: config.connectInstanceId,
        SourcePhoneNumber: config.connectSourcePhoneNumber,
        ClientToken: input.caseId,
      }),
    );

    if (!result.ContactId) {
      return { outcome: "FAILED", errorCode: "NO_CONTACT_ID" };
    }
    return { outcome: "CALLED", contactId: result.ContactId };
  } catch (error) {
    // Nunca incluir el mensaje de error crudo (podria filtrar el numero en
    // algunos casos de error del SDK): solo un codigo cerrado.
    console.error(
      JSON.stringify({
        event: "emergency_dialer_failed",
        caseId: input.caseId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return { outcome: "FAILED", errorCode: "DIAL_FAILED" };
  }
}

async function getDestinationPhoneNumber(): Promise<string> {
  const result = await ssm.send(
    new GetParameterCommand({
      Name: config.fallbackCallDestinationParameterName,
      WithDecryption: true,
    }),
  );
  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error("Parametro SSM de destino de fallback sin valor");
  }
  return value;
}
