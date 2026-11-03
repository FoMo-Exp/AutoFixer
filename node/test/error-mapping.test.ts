import { describe, expect, test } from "vitest";

import { DshError } from "../src/dsh/client.js";
import type { DshClient } from "../src/dsh/client.js";
import {
  DiagnosticsVault,
  SensitiveDiagnosticsAccessDenied,
  mapDshError,
  mapForeignError,
  readSensitiveDiagnostics,
  sealDiagnostics,
} from "../src/errors/index.js";
import type { ErrorEnvelope } from "../src/errors/index.js";
import {
  createDshRequestActionTool,
  type ActionObservation,
} from "../src/pi/dsh-request-action-tool.js";

function dshError(status: number, code: string, message: string, retryable = false): DshError {
  return new DshError(status, code, message, {}, retryable, "req_test");
}

describe("dsh code mapping into the shared vocabulary (DAT-226)", () => {
  test("a policy denial stays a denial and is never rewritten as an internal error", () => {
    for (const code of ["DSH_POLICY_DENIED", "DSH_SCOPE_DENIED"] as const) {
      const mapped = mapDshError(dshError(403, code, "Action is outside the approved grant."));
      expect(mapped.envelope.category).toBe("denial");
      expect(mapped.envelope.code).toBe("TOOL_SCOPE_DENIED");
      expect(mapped.envelope.retryable).toBe(false);
      expect(mapped.envelope.next_action).toBe("request_review");
      expect(mapped.envelope.code).not.toBe("INTERNAL_ERROR");
    }
  });

  test("an unknown 403 code still maps to a denial, never to INTERNAL_ERROR", () => {
    const mapped = mapDshError(dshError(403, "DSH_SOMETHING_NEW", "denied"));
    expect(mapped.envelope.code).toBe("FORBIDDEN");
    expect(mapped.envelope.category).toBe("denial");
    // The origin code survives as correlation, not as display text.
    expect(mapped.diagnostics.origin_code).toBe("DSH_SOMETHING_NEW");
    expect(JSON.stringify(mapped.envelope)).not.toContain("DSH_SOMETHING_NEW");
  });

  test("only a genuine unclassifiable failure becomes INTERNAL_ERROR", () => {
    expect(mapDshError(dshError(500, "DSH_INTERNAL", "boom")).envelope.code).toBe("INTERNAL_ERROR");
    expect(mapForeignError(null).envelope.code).toBe("INTERNAL_ERROR");
    expect(mapForeignError(new Error("unexpected")).envelope.code).toBe("INTERNAL_ERROR");
  });

  test("recoverable transport errors and harness stop conditions map apart", () => {
    const transport = mapDshError(
      dshError(503, "DSH_UNAVAILABLE", "control plane unreachable", true),
    );
    expect(transport.envelope.code).toBe("TRANSPORT_ERROR");
    expect(transport.envelope.category).toBe("retry");
    expect(transport.envelope.retryable).toBe(true);
    const stop = mapDshError(dshError(410, "DSH_GRANT_EXPIRED", "Capability grant has expired."));
    expect(stop.envelope.code).toBe("HARNESS_STOP_CONDITION");
    expect(stop.envelope.category).toBe("stop");
    expect(stop.envelope.retryable).toBe(false);
    expect(stop.envelope.denied_capability).toBe("grant");
  });

  test("denied capability categories are surfaced without policy internals", () => {
    const tool = mapDshError(dshError(404, "TOOL_NOT_REGISTERED", 'Tool "sh" is not registered.'));
    expect(tool.envelope.denied_capability).toBe("tool");
    const arguments_ = mapDshError(
      dshError(400, "INVALID_TOOL_ARGUMENTS", "argument message is not allowed"),
    );
    expect(arguments_.envelope.code).toBe("INVALID_REQUEST");
    expect(arguments_.envelope.denied_capability).toBe("arguments");
    expect(JSON.stringify(arguments_.envelope)).not.toContain("not allowed");
  });

  test("the service's own retry verdict narrows a bounded retry", () => {
    const vetoed = mapDshError(dshError(503, "DSH_UNAVAILABLE", "unreachable", false));
    expect(vetoed.envelope.retryable).toBe(false);
  });

  test("shared and trace codes pass through the mapping untouched or translated", () => {
    const egress = mapForeignError(
      Object.assign(new Error("denied"), { code: "MODEL_EGRESS_DENIED", retryable: false }),
    );
    expect(egress.envelope.code).toBe("MODEL_EGRESS_DENIED");
    expect(egress.envelope.category).toBe("denial");
    const trace = mapForeignError(
      Object.assign(new Error("bad event"), { code: "TRACE_VALIDATION_FAILED" }),
    );
    expect(trace.envelope.code).toBe("VALIDATION_FAILED");
  });
});

describe("sensitive diagnostics behind a separate access check (DAT-226)", () => {
  test("raw detail is sealed and never enters the envelope", () => {
    const mapped = mapDshError(
      dshError(
        403,
        "DSH_POLICY_DENIED",
        `policy revision 42 denies this Bearer ${"abcdef" + "123456"}`,
      ),
    );
    expect(mapped.diagnostics.detail).not.toContain("abcdef123456");
    expect(mapped.diagnostics.detail).toContain("policy revision 42");
    expect(JSON.stringify(mapped.envelope)).not.toContain("policy revision 42");
  });

  test("reading diagnostics needs an explicit grant, and the check runs first", () => {
    const sealed = sealDiagnostics({ caseRef: "case-1", detail: "raw detail" });
    expect(() => readSensitiveDiagnostics(sealed, null)).toThrow(SensitiveDiagnosticsAccessDenied);
    expect(() =>
      readSensitiveDiagnostics(sealed, { subject: "op", mayReadSensitiveDiagnostics: false }),
    ).toThrow(SensitiveDiagnosticsAccessDenied);
    expect(() =>
      readSensitiveDiagnostics(sealed, { subject: "", mayReadSensitiveDiagnostics: true }),
    ).toThrow(SensitiveDiagnosticsAccessDenied);
    // An unauthorized caller cannot probe which cases exist either.
    expect(() =>
      readSensitiveDiagnostics(undefined, { subject: "op", mayReadSensitiveDiagnostics: false }),
    ).toThrow(SensitiveDiagnosticsAccessDenied);
    const granted = readSensitiveDiagnostics(sealed, {
      subject: "security-case-reader",
      mayReadSensitiveDiagnostics: true,
    });
    expect(granted.detail).toBe("raw detail");
  });

  test("the vault releases records only through the access check", () => {
    const vault = new DiagnosticsVault();
    vault.record(sealDiagnostics({ caseRef: "case-7", detail: "raw" }));
    expect(vault.has("case-7")).toBe(true);
    expect(() => vault.read("case-7", undefined)).toThrow(SensitiveDiagnosticsAccessDenied);
    expect(vault.read("case-7", { subject: "sec", mayReadSensitiveDiagnostics: true }).detail).toBe(
      "raw",
    );
  });
});

describe("agent-facing tool errors use the shared envelope (DAT-226)", () => {
  function toolWithFailingClient(
    error: unknown,
    observe: (observation: ActionObservation) => void,
    diagnostics?: DiagnosticsVault,
  ) {
    const client = {
      submitAction: async () => Promise.reject(error),
    } as unknown as DshClient;
    return createDshRequestActionTool({
      client,
      runId: "run_1",
      sessionId: "pis_1",
      getTurnId: () => "turn_1",
      observe,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    });
  }

  const params = {
    tool_id: "echo",
    arguments: { message: "hello" },
    path_scope: ["node/x.txt"],
    rationale: "test",
  };

  function firstObservation(seen: ActionObservation[]): ActionObservation {
    const observation = seen[0];
    if (observation === undefined) {
      throw new Error("no observation was recorded");
    }
    return observation;
  }

  test("a dsh denial reaches the model as safe guidance, not raw diagnostics", async () => {
    const seen: ActionObservation[] = [];
    const tool = toolWithFailingClient(
      dshError(403, "DSH_POLICY_DENIED", "policy revision 42 denies this"),
      (observation) => seen.push(observation),
    );
    const thrown = (await tool.execute("tc_1", params).catch((error: Error) => error)) as Error;
    expect(thrown.message).toMatch(/^\[TOOL_SCOPE_DENIED\]/);
    expect(thrown.message).toContain("Next action: request_review.");
    expect(thrown.message).toContain("origin: DSH_POLICY_DENIED");
    expect(thrown.message).not.toContain("policy revision 42");
    expect(firstObservation(seen).outcome).toBe("denied");
    expect(firstObservation(seen).errorCode).toBe("DSH_POLICY_DENIED");
    expect(firstObservation(seen).errorMessage ?? "").not.toContain("policy revision 42");
    const envelope = firstObservation(seen).errorEnvelope as ErrorEnvelope;
    expect(envelope.code).toBe("TOOL_SCOPE_DENIED");
    expect(envelope.retryable).toBe(false);
  });

  test("denial observations carry the envelope and the raw detail is vaulted", async () => {
    const seen: ActionObservation[] = [];
    const vault = new DiagnosticsVault();
    const tool = toolWithFailingClient(
      dshError(403, "DSH_SCOPE_DENIED", "Action is outside the approved grant."),
      (observation) => seen.push(observation),
      vault,
    );
    await expect(tool.execute("tc_2", params)).rejects.toThrow();
    const envelope = firstObservation(seen).errorEnvelope as ErrorEnvelope;
    expect(envelope.denied_capability).toBe("path_scope");
    expect(vault.size).toBe(1);
    expect(() => vault.read("unknown-case", undefined)).toThrow(SensitiveDiagnosticsAccessDenied);
    expect(
      vault.read(envelope.trace_ref.case_ref as string, {
        subject: "sec",
        mayReadSensitiveDiagnostics: true,
      }).detail,
    ).toContain("outside the approved grant");
  });

  test("unexpected failures are envelope-shaped too, with the cause preserved", async () => {
    const seen: ActionObservation[] = [];
    const tool = toolWithFailingClient(new Error("socket exploded"), (observation) =>
      seen.push(observation),
    );
    const thrown = (await tool.execute("tc_3", params).catch((error: Error) => error)) as Error & {
      cause?: unknown;
    };
    expect(thrown.message).toContain("[INTERNAL_ERROR]");
    expect(thrown.message).toContain("Next action: report_error.");
    expect(thrown.message).not.toContain("socket exploded");
    expect((thrown.cause as Error).message).toBe("socket exploded");
    expect(firstObservation(seen).errorCode).toBe("INTERNAL_ERROR");
  });
});
