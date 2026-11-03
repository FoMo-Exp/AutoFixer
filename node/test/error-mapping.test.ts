import { describe, expect, test } from "vitest";

import type { OrchestratorConfig } from "../src/config.js";
import { DshError } from "../src/dsh/client.js";
import type { DshClient } from "../src/dsh/client.js";
import {
  DiagnosticGrant,
  DiagnosticsAuthorizer,
  DiagnosticsVault,
  RetryGovernor,
  SensitiveDiagnosticsAccessDenied,
  mapDshError,
  mapForeignError,
  readSensitiveDiagnostics,
  sealDiagnostics,
} from "../src/errors/index.js";
import type { DiagnosticAccessPolicy, ErrorEnvelope } from "../src/errors/index.js";
import type { ModelGateway } from "../src/gateway/index.js";
import {
  createDshRequestActionTool,
  type ActionObservation,
  type DshRequestActionParams,
} from "../src/pi/dsh-request-action-tool.js";
import { TaskService } from "../src/api/task-service.js";
import { TaskStore } from "../src/api/task-store.js";

function dshError(status: number, code: string, message: string, retryable = false): DshError {
  return new DshError(status, code, message, {}, retryable, "req_test");
}

const policy: DiagnosticAccessPolicy = {
  mayReadDiagnostics: (subject) => subject === "security-case-reader",
};

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

describe("sensitive diagnostics behind a trusted authorizer (DAT-226)", () => {
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

  test("caller-constructed grants and plain objects are refused before any lookup", () => {
    const vault = new DiagnosticsVault(new DiagnosticsAuthorizer(policy));
    vault.record(sealDiagnostics({ caseRef: "case-1", detail: "raw detail" }));
    // The record exists — the refusal still happens before the lookup.
    for (const forged of [
      new DiagnosticGrant("security-case-reader"),
      { subject: "security-case-reader", mayReadSensitiveDiagnostics: true },
      null,
      undefined,
    ] as const) {
      expect(() => vault.read("case-1", forged as DiagnosticGrant)).toThrow(
        SensitiveDiagnosticsAccessDenied,
      );
    }
  });

  test("only an authorizer-minted grant passes, and the policy runs first", () => {
    const authorizer = new DiagnosticsAuthorizer(policy);
    expect(() => authorizer.authorize("")).toThrow(SensitiveDiagnosticsAccessDenied);
    expect(() => authorizer.authorize("intruder")).toThrow(/access policy/);
    const grant = authorizer.authorize("security-case-reader");
    const vault = new DiagnosticsVault(authorizer);
    vault.record(sealDiagnostics({ caseRef: "case-2", detail: "raw detail" }));
    expect(vault.read("case-2", grant).detail).toBe("raw detail");
    // A grant minted by a different authorizer is not this vault's currency.
    const foreign = new DiagnosticsAuthorizer(policy).authorize("security-case-reader");
    expect(() => vault.read("case-2", foreign)).toThrow(SensitiveDiagnosticsAccessDenied);
    // The check runs before the lookup: a missing case is not leaked either.
    expect(() => vault.read("case-missing", grant)).toThrow(/no diagnostics recorded/);
  });

  test("the low-level read accepts only issued grants", () => {
    const sealed = sealDiagnostics({ caseRef: "case-3", detail: "raw detail" });
    expect(() => readSensitiveDiagnostics(sealed, null)).toThrow(SensitiveDiagnosticsAccessDenied);
    expect(() =>
      readSensitiveDiagnostics(sealed, new DiagnosticGrant("security-case-reader")),
    ).toThrow(SensitiveDiagnosticsAccessDenied);
    const issued = new DiagnosticsAuthorizer(policy).authorize("security-case-reader");
    expect(readSensitiveDiagnostics(sealed, issued).detail).toBe("raw detail");
  });

  test("TaskService.readDiagnostics takes a subject, never a self-asserted permission", () => {
    const build = (diagnosticsPolicy?: DiagnosticAccessPolicy): TaskService =>
      new TaskService({
        config: {} as OrchestratorConfig,
        dsh: {} as DshClient,
        store: new TaskStore(),
        gateway: {} as ModelGateway,
        ...(diagnosticsPolicy === undefined ? {} : { diagnosticsPolicy }),
      });
    // Fail closed by default: the policy runs before any lookup.
    expect(() => build().readDiagnostics("anyone", "case-x")).toThrow(/access policy/);
    const service = build(policy);
    expect(() => service.readDiagnostics("intruder", "case-x")).toThrow(
      SensitiveDiagnosticsAccessDenied,
    );
    expect(() => service.readDiagnostics("security-case-reader", "case-x")).toThrow(
      /no diagnostics recorded/,
    );
  });
});

interface FailingToolHarness {
  tool: ReturnType<typeof createDshRequestActionTool>;
  calls: () => number;
  seen: ActionObservation[];
  setNow: (ms: number) => void;
}

const toolParams: DshRequestActionParams = {
  tool_id: "echo",
  arguments: { message: "hello" },
  path_scope: ["node/x.txt"],
  rationale: "test",
};

/** A tool whose every dispatch fails with `error`, under a controlled clock. */
function failingTool(
  error: unknown,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    deadlineMs?: number;
    nowMs?: number;
    diagnostics?: DiagnosticsVault;
  } = {},
): FailingToolHarness {
  const seen: ActionObservation[] = [];
  let calls = 0;
  let now = options.nowMs ?? 10_000;
  const client = {
    submitAction: async () => {
      calls += 1;
      return Promise.reject(error);
    },
  } as unknown as DshClient;
  const tool = createDshRequestActionTool({
    client,
    runId: "run_1",
    sessionId: "pis_1",
    getTurnId: () => "turn_1",
    observe: (observation) => seen.push(observation),
    retryGovernor: new RetryGovernor({
      maxAttempts: options.maxAttempts ?? 3,
      clock: () => now,
    }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  return {
    tool,
    calls: () => calls,
    seen,
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

function firstObservation(seen: ActionObservation[]): ActionObservation {
  const observation = seen[0];
  if (observation === undefined) {
    throw new Error("no observation was recorded");
  }
  return observation;
}

function envelopeOf(seen: ActionObservation[], index: number): ErrorEnvelope {
  const envelope = seen[index]?.errorEnvelope;
  if (envelope === undefined) {
    throw new Error(`no envelope recorded at index ${index}`);
  }
  return envelope;
}

async function failing(
  harness: FailingToolHarness,
  id: string,
  params: DshRequestActionParams = toolParams,
): Promise<Error> {
  return (await harness.tool.execute(id, params).catch((error: Error) => error)) as Error;
}

describe("agent-facing tool errors use the shared envelope (DAT-226)", () => {
  test("a dsh denial reaches the model as safe guidance, not raw diagnostics", async () => {
    const harness = failingTool(
      dshError(403, "DSH_POLICY_DENIED", "policy revision 42 denies this"),
    );
    const thrown = await failing(harness, "tc_1");
    expect(thrown.message).toMatch(/^\[TOOL_SCOPE_DENIED\]/);
    expect(thrown.message).toContain("Next action: request_review.");
    expect(thrown.message).toContain("origin: DSH_POLICY_DENIED");
    expect(thrown.message).not.toContain("policy revision 42");
    const observation = firstObservation(harness.seen);
    expect(observation.outcome).toBe("denied");
    expect(observation.errorCode).toBe("DSH_POLICY_DENIED");
    expect(observation.errorMessage ?? "").not.toContain("policy revision 42");
    const envelope = observation.errorEnvelope as ErrorEnvelope;
    expect(envelope.code).toBe("TOOL_SCOPE_DENIED");
    expect(envelope.retryable).toBe(false);
    expect(envelope.next_action).toBe("request_review");
  });

  test("denial observations carry the envelope and the raw detail is vaulted", async () => {
    const authorizer = new DiagnosticsAuthorizer(policy);
    const vault = new DiagnosticsVault(authorizer);
    const harness = failingTool(
      dshError(403, "DSH_SCOPE_DENIED", "Action is outside the approved grant."),
      { diagnostics: vault },
    );
    await expect(harness.tool.execute("tc_2", toolParams)).rejects.toThrow();
    const envelope = envelopeOf(harness.seen, 0);
    expect(envelope.denied_capability).toBe("path_scope");
    expect(vault.size).toBe(1);
    expect(() => vault.read("unknown-case", new DiagnosticGrant("x"))).toThrow(
      SensitiveDiagnosticsAccessDenied,
    );
    expect(
      vault.read(
        envelope.trace_ref.case_ref as string,
        authorizer.authorize("security-case-reader"),
      ).detail,
    ).toContain("outside the approved grant");
  });

  test("unexpected failures are envelope-shaped too, with the cause preserved", async () => {
    const harness = failingTool(new Error("socket exploded"));
    const thrown = (await failing(harness, "tc_3")) as Error & { cause?: unknown };
    expect(thrown.message).toContain("[INTERNAL_ERROR]");
    expect(thrown.message).toContain("Next action: report_error.");
    expect(thrown.message).not.toContain("socket exploded");
    expect((thrown.cause as Error).message).toBe("socket exploded");
    expect(firstObservation(harness.seen).errorCode).toBe("INTERNAL_ERROR");
  });
});

describe("the tool is a controlled retry entry (DAT-226)", () => {
  test("retryability reflects the governor's decision and counts attempts", async () => {
    const harness = failingTool(dshError(503, "DSH_UNAVAILABLE", "unreachable", true), {
      maxAttempts: 1,
    });
    const first = await failing(harness, "tc_a");
    expect(first.message).toContain("Next action: retry_bounded.");
    expect(envelopeOf(harness.seen, 0).retryable).toBe(true);
    // The authorized retry is due immediately (no service-imposed delay).
    expect(harness.calls()).toBe(1);
    await failing(harness, "tc_b");
    expect(harness.calls()).toBe(2);
    // The second failure exhausted the attempt budget: the envelope now
    // reflects the service's refusal instead of claiming retryable.
    expect(envelopeOf(harness.seen, 1).retryable).toBe(false);
    expect(envelopeOf(harness.seen, 1).next_action).toBe("report_error");
    // A third re-issue is blocked before dispatch at all.
    const blocked = await failing(harness, "tc_c");
    expect(harness.calls()).toBe(2);
    expect(blocked.message).toContain("Next action: report_error.");
    expect(envelopeOf(harness.seen, 2).retryable).toBe(false);
  });

  test("a re-issue before retry_after_ms is blocked and told how long to wait", async () => {
    const harness = failingTool(dshError(503, "DSH_UNAVAILABLE", "unreachable", true), {
      retryDelayMs: 5_000,
    });
    const first = await failing(harness, "tc_d");
    expect(envelopeOf(harness.seen, 0).retry_after_ms).toBe(5_000);
    expect(first.message).toContain("Next action: retry_bounded.");
    // Too early: blocked without dispatch, but the authorization is still
    // visible together with the remaining delay.
    const early = await failing(harness, "tc_e");
    expect(harness.calls()).toBe(1);
    expect(envelopeOf(harness.seen, 1).retryable).toBe(true);
    expect(envelopeOf(harness.seen, 1).retry_after_ms).toBe(5_000);
    expect(early.message).toContain("retry_bounded");
    // Once the delay has passed, the authorized retry actually dispatches.
    harness.setNow(15_000);
    await failing(harness, "tc_f");
    expect(harness.calls()).toBe(2);
  });

  test("a denied intent is final: an identical re-issue is blocked before dispatch", async () => {
    const harness = failingTool(dshError(403, "DSH_SCOPE_DENIED", "outside the grant"));
    await failing(harness, "tc_g");
    expect(harness.calls()).toBe(1);
    const blocked = await failing(harness, "tc_h");
    expect(harness.calls()).toBe(1);
    const envelope = envelopeOf(harness.seen, 1);
    expect(envelope.code).toBe("TOOL_SCOPE_DENIED");
    expect(envelope.retryable).toBe(false);
    expect(envelope.next_action).toBe("request_review");
    expect(blocked.message).not.toContain("outside the grant");
  });

  test("a different intent is a different case and still dispatches", async () => {
    const harness = failingTool(dshError(503, "DSH_UNAVAILABLE", "unreachable", true), {
      maxAttempts: 1,
    });
    await failing(harness, "tc_i");
    await failing(harness, "tc_j");
    expect(harness.calls()).toBe(2);
    await failing(harness, "tc_k", { ...toolParams, arguments: { message: "different" } });
    expect(harness.calls()).toBe(3);
  });

  test("the run deadline turns an authorized retry into a refusal", async () => {
    const harness = failingTool(dshError(503, "DSH_UNAVAILABLE", "unreachable", true), {
      deadlineMs: 20_000,
    });
    await failing(harness, "tc_l");
    expect(envelopeOf(harness.seen, 0).retryable).toBe(true);
    harness.setNow(20_000);
    const blocked = await failing(harness, "tc_m");
    expect(harness.calls()).toBe(1);
    expect(envelopeOf(harness.seen, 1).retryable).toBe(false);
    expect(blocked.message).toContain("Next action: report_error.");
  });
});
