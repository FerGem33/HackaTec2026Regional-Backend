import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ConnectClient, StartOutboundVoiceContactCommand } from "@aws-sdk/client-connect";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { handler } from "../src/emergencyDialerFn.js";
import { config } from "../src/emergencyDialerConfig.js";

const connectMock = mockClient(ConnectClient);
const ssmMock = mockClient(SSMClient);

const FAKE_DESTINATION = "+528442737679"; // valor ficticio de prueba, nunca el real

beforeEach(() => {
  connectMock.reset();
  ssmMock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emergencyDialerFn", () => {
  it("reads the destination exclusively from the configured SSM parameter, with decryption", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: FAKE_DESTINATION } });
    connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "contact-1" });

    await handler({ caseId: "case-1" });

    const ssmCall = ssmMock.commandCalls(GetParameterCommand)[0]?.args[0].input;
    expect(ssmCall?.Name).toBe(config.fallbackCallDestinationParameterName);
    expect(ssmCall?.WithDecryption).toBe(true);
  });

  it("calls StartOutboundVoiceContact with ClientToken=caseId and the configured instance/flow/source, never a caller-supplied destination", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: FAKE_DESTINATION } });
    connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "contact-1" });

    // El input SOLO tiene caseId; TypeScript ya lo garantiza en compilacion,
    // pero ademas verificamos en runtime que un campo extra (si alguien lo
    // colara) jamas se usa como destino.
    await handler({ caseId: "case-1", destinationPhoneNumber: "+19999999999" } as never);

    const connectCall = connectMock.commandCalls(StartOutboundVoiceContactCommand)[0]?.args[0].input;
    expect(connectCall?.ClientToken).toBe("case-1");
    expect(connectCall?.InstanceId).toBe(config.connectInstanceId);
    expect(connectCall?.ContactFlowId).toBe(config.connectContactFlowId);
    expect(connectCall?.SourcePhoneNumber).toBe(config.connectSourcePhoneNumber);
    expect(connectCall?.DestinationPhoneNumber).toBe(FAKE_DESTINATION); // solo el de SSM, nunca "+19999999999"
  });

  it("never includes the destination number in its own output", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: FAKE_DESTINATION } });
    connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "contact-1" });

    const result = await handler({ caseId: "case-1" });

    expect(JSON.stringify(result)).not.toContain(FAKE_DESTINATION);
    expect(result).toEqual({ outcome: "CALLED", contactId: "contact-1" });
  });

  it("never logs the destination number, even on failure", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: FAKE_DESTINATION } });
    connectMock.on(StartOutboundVoiceContactCommand).rejects(new Error(`boom for ${FAKE_DESTINATION}`));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handler({ caseId: "case-1" });

    expect(result).toEqual({ outcome: "FAILED", errorCode: "DIAL_FAILED" });
    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(FAKE_DESTINATION);
    }
  });

  it("returns FAILED with a closed error code (never throws) when SSM has no value", async () => {
    ssmMock.on(GetParameterCommand).resolves({});

    const result = await handler({ caseId: "case-1" });

    expect(result).toEqual({ outcome: "FAILED", errorCode: "DIAL_FAILED" });
    expect(connectMock.commandCalls(StartOutboundVoiceContactCommand)).toHaveLength(0);
  });
});
