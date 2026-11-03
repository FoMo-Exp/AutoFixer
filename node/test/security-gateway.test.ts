/**
 * Gateway disposal-case integration (DAT-210, ADR-0005 §2).
 *
 * A secret-gate block opens (or idempotently associates) a security disposal
 * case through the case-intake seam: the denial stands, zero request bytes
 * are sent, and the error carries the case correlation identifiers. Policy
 * denials never open disposal cases, and a failing case intake never unblocks
 * the request.
 */
import type { Context, Model, Api } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, test } from "vitest";

import type {
  DependentWorkHold,
  GatewayCaseIntake,
  GatewayRequestIdentity,
  ModelEgressDeniedError,
} from "../src/index.js";
import {
  DependentWorkPauseLedger,
  EncryptedQuarantine,
  SecurityCaseService,
  SecurityCaseStore,
  SecurityNotifier,
  createModelGateway,
  createPatternSecretScanner,
  createStaticCredentialStore,
  createStaticPolicyResolver,
} from "../src/index.js";
import { TEST_MODEL } from "./helpers/scripted-stream.js";
import {
  TEST_BINDING,
  TEST_CREDENTIAL,
  TEST_CREDENTIAL_REF,
  TEST_SCOPE,
  memorySink,
  testPolicyFor,
} from "./helpers/test-gateway.js";

// Assembled at runtime: repository secret scanners would flag literals.
const SECRET_VALUE = "sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123";

const SECRET_CONTEXT: Context = {
  messages: [{ role: "user", content: `please process ${SECRET_VALUE}`, timestamp: 1 }],
};
const CLEAN_CONTEXT: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function okStream(): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        api: "openai-completions",
        provider: "openai",
        model: "scripted",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
      },
    });
  });
  return stream;
}

function spyAdapter(): {
  adapter: {
    stream: (model: Model<Api>, context: Context, options?: unknown) => ReturnType<typeof okStream>;
  };
  calls: Context[];
} {
  const calls: Context[] = [];
  return {
    adapter: {
      stream(_model: Model<Api>, context: Context) {
        calls.push(context);
        return okStream();
      },
    },
    calls,
  };
}

function intakeSpy(): {
  intake: GatewayCaseIntake;
  calls: {
    identity: GatewayRequestIdentity;
    reason: string;
    safeDetail: string;
    rawContent?: string;
  }[];
} {
  const calls: {
    identity: GatewayRequestIdentity;
    reason: string;
    safeDetail: string;
    rawContent?: string;
  }[] = [];
  return {
    intake: {
      async recordGatewayBlock(input) {
        calls.push(input);
        return { caseId: `case_${calls.length}`, caseReference: `cr1.ref_${calls.length}` };
      },
    },
    calls,
  };
}

/** Real disposal-case service wired as the gateway's case intake. */
function realIntake(): {
  intake: GatewayCaseIntake;
  service: SecurityCaseService;
  caseStore: SecurityCaseStore;
} {
  const caseStore = new SecurityCaseStore();
  const pauses = new DependentWorkPauseLedger();
  const notifier = new SecurityNotifier({
    directory: { resolve: () => ({ workspaceHandlers: [], enterpriseAdmins: [] }) },
    sink: { send: () => undefined },
    referenceSecret: Buffer.alloc(32, 1),
  });
  const quarantine = new EncryptedQuarantine({
    keyProvider: { keyId: "key_1", currentKey: () => Buffer.alloc(32, 2) },
    retentionSeconds: 3600,
    onIncident: () => undefined,
  });
  const service = new SecurityCaseService({
    caseStore,
    pauses,
    notifier,
    quarantine,
    referenceSecret: Buffer.alloc(32, 1),
    onIncident: () => undefined,
  });
  return { intake: service, service, caseStore };
}

function stubHold(): DependentWorkHold {
  return { heldCaseFor: () => undefined };
}

function gatewayWith(
  security: { caseIntake: GatewayCaseIntake; dependentWorkHold: DependentWorkHold },
  onIncident?: (m: string) => void,
) {
  const adapter = spyAdapter();
  const gateway = createModelGateway({
    policyResolver: createStaticPolicyResolver(testPolicyFor(TEST_MODEL), TEST_SCOPE),
    credentials: createStaticCredentialStore({ [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL }),
    adapter: adapter.adapter,
    scanner: createPatternSecretScanner(),
    sink: memorySink().sink,
    ...security,
    ...(onIncident ? { onIncident } : {}),
  });
  return { gateway, adapter };
}

describe("gateway disposal cases (DAT-210)", () => {
  test("a secret-gate block opens a disposal case and still sends zero bytes", async () => {
    const spy = intakeSpy();
    const { gateway, adapter } = gatewayWith({
      caseIntake: spy.intake,
      dependentWorkHold: stubHold(),
    });
    let thrown: ModelEgressDeniedError | undefined;
    try {
      await gateway.dispatch(TEST_MODEL, SECRET_CONTEXT, undefined, TEST_BINDING);
    } catch (error) {
      thrown = error as ModelEgressDeniedError;
    }
    expect(thrown?.reason).toBe("SENSITIVE_DATA_UNCERTAIN");
    expect(thrown?.caseId).toBe("case_1");
    expect(thrown?.caseReference).toBe("cr1.ref_1");
    expect(adapter.calls).toHaveLength(0);
    expect(spy.calls).toHaveLength(1);
    const call = spy.calls[0];
    expect(call?.identity).toMatchObject({
      enterpriseId: TEST_BINDING.enterpriseId,
      workspaceId: TEST_BINDING.workspaceId,
      issueId: TEST_BINDING.issueId,
      runId: TEST_BINDING.runId,
      traceId: TEST_BINDING.traceId,
    });
    expect(call?.identity.invocationId).toBeTruthy();
    expect(call?.reason).toBe("SENSITIVE_DATA_UNCERTAIN");
    // The raw blocked request is handed to quarantine, not to errors.
    expect(call?.rawContent).toContain(SECRET_VALUE);
    expect(thrown?.message ?? "").not.toContain(SECRET_VALUE);
  });

  test("a held run's later invocations are rejected at admission and carry their case", async () => {
    const { service, caseStore } = realIntake();
    const { gateway, adapter } = gatewayWith({
      caseIntake: service,
      dependentWorkHold: service,
    });
    const first = await gateway
      .dispatch(TEST_MODEL, SECRET_CONTEXT, undefined, TEST_BINDING)
      .catch((error: ModelEgressDeniedError) => error);
    expect((first as ModelEgressDeniedError).reason).toBe("SENSITIVE_DATA_UNCERTAIN");
    const caseId = (first as ModelEgressDeniedError).caseId as string;
    expect(caseId).toBeTruthy();
    // The run is now held: its dependent work never re-enters the gateway —
    // the rejection happens before policy, scan, or any dispatch.
    const second = await gateway
      .dispatch(TEST_MODEL, SECRET_CONTEXT, undefined, TEST_BINDING)
      .catch((error: ModelEgressDeniedError) => error);
    expect((second as ModelEgressDeniedError).reason).toBe("DEPENDENT_WORK_HELD");
    expect((second as ModelEgressDeniedError).code).toBe("SECURITY_REVIEW_REQUIRED");
    // The rejection points at the same case; it opens none of its own.
    expect((second as ModelEgressDeniedError).caseId).toBe(caseId);
    expect(adapter.calls).toHaveLength(0);
    const events = [...caseStore.events(caseId)];
    expect(events.filter((event) => event.type === "case.opened")).toHaveLength(1);
    expect(events.filter((event) => event.type === "block.recorded")).toHaveLength(1);
  });

  test("only the affected run is held; unrelated runs keep working", async () => {
    const { service } = realIntake();
    const { gateway, adapter } = gatewayWith({
      caseIntake: service,
      dependentWorkHold: service,
    });
    await gateway
      .dispatch(TEST_MODEL, SECRET_CONTEXT, undefined, TEST_BINDING)
      .catch((error: ModelEgressDeniedError) => error);
    const otherRun = await gateway.dispatch(TEST_MODEL, CLEAN_CONTEXT, undefined, {
      ...TEST_BINDING,
      runId: "run_other",
    });
    expect(otherRun).toBeTruthy();
    expect(adapter.calls).toHaveLength(1);
  });

  test("a failing case intake never unblocks the request", async () => {
    const incidents: string[] = [];
    const failing: GatewayCaseIntake = {
      recordGatewayBlock: () => Promise.reject(new Error("case store down")),
    };
    const { gateway, adapter } = gatewayWith(
      { caseIntake: failing, dependentWorkHold: stubHold() },
      (message) => incidents.push(message),
    );
    let thrown: ModelEgressDeniedError | undefined;
    try {
      await gateway.dispatch(TEST_MODEL, SECRET_CONTEXT, undefined, TEST_BINDING);
    } catch (error) {
      thrown = error as ModelEgressDeniedError;
    }
    expect(thrown?.reason).toBe("SENSITIVE_DATA_UNCERTAIN");
    expect(thrown?.caseId).toBeUndefined();
    expect(adapter.calls).toHaveLength(0);
    expect(incidents.length).toBeGreaterThan(0);
  });

  test("an unconfigured case intake records an incident and the block still stands", async () => {
    const incidents: string[] = [];
    // Untyped callers can omit the required intake; the gateway must still
    // fail closed — the denial stands and the gap is loudly recorded.
    const { gateway, adapter } = gatewayWith(
      {
        caseIntake: undefined as unknown as GatewayCaseIntake,
        dependentWorkHold: stubHold(),
      },
      (message) => incidents.push(message),
    );
    let thrown: ModelEgressDeniedError | undefined;
    try {
      await gateway.dispatch(TEST_MODEL, SECRET_CONTEXT, undefined, TEST_BINDING);
    } catch (error) {
      thrown = error as ModelEgressDeniedError;
    }
    expect(thrown?.reason).toBe("SENSITIVE_DATA_UNCERTAIN");
    expect(thrown?.caseId).toBeUndefined();
    expect(adapter.calls).toHaveLength(0);
    expect(incidents.length).toBeGreaterThan(0);
  });

  test("clean dispatches never open a case", async () => {
    const spy = intakeSpy();
    const { gateway, adapter } = gatewayWith({
      caseIntake: spy.intake,
      dependentWorkHold: stubHold(),
    });
    const stream = await gateway.dispatch(TEST_MODEL, CLEAN_CONTEXT, undefined, TEST_BINDING);
    expect(stream).toBeTruthy();
    expect(adapter.calls).toHaveLength(1);
    expect(spy.calls).toHaveLength(0);
  });

  test("policy denials never open disposal cases", async () => {
    const spy = intakeSpy();
    const adapter = spyAdapter();
    // A model the policy does not approve: a policy denial, not a secret block.
    const gateway = createModelGateway({
      policyResolver: createStaticPolicyResolver(testPolicyFor(TEST_MODEL), TEST_SCOPE),
      credentials: createStaticCredentialStore({ [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL }),
      adapter: adapter.adapter,
      scanner: createPatternSecretScanner(),
      sink: memorySink().sink,
      caseIntake: spy.intake,
      dependentWorkHold: stubHold(),
    });
    await expect(
      gateway.dispatch(
        { ...TEST_MODEL, id: "unapproved-model" },
        SECRET_CONTEXT,
        undefined,
        TEST_BINDING,
      ),
    ).rejects.toMatchObject({ reason: "MODEL_NOT_APPROVED" });
    expect(spy.calls).toHaveLength(0);
    expect(adapter.calls).toHaveLength(0);
  });
});
