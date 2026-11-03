/**
 * One-time recovery authorization, complete-request rescan, and atomic
 * consumption (DAT-212, ADR-0005 §5).
 *
 * Acceptance under test: context/destination/policy/rule changes, expiry, and
 * revocation all invalidate an approval; concurrent recoveries let exactly one
 * dispatch through, and a restarted worker cannot reuse a consumed approval;
 * an unknown provider outcome is recorded as unknown and never replayed; the
 * audit distinguishes an approval from an actual send; the scan is bound to an
 * immutable final request so the adapter cannot add unchecked content.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Api, AssistantMessageEventStream, Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, test } from "vitest";

import {
  RecoveryApprovalInvalidError,
  RecoveryAuthorizationStore,
  RecoveryEgressDeniedError,
  RecoveryService,
  SecurityCaseStore,
  SecurityError,
  createMemoryRecoveryAuditSink,
} from "../src/security/index.js";
import type {
  ActiveRuleCorrection,
  RecoveryAuditRecord,
  RecoveryAuditSink,
  RecoveryRequestSource,
  SecurityActor,
  SecurityDuty,
  SecurityDutyDirectory,
} from "../src/security/index.js";
import {
  DATA_CLASSES,
  ModelEgressDeniedError,
  createPatternSecretScanner,
  createStaticCredentialStore,
} from "../src/gateway/index.js";
import type { GatewayPolicy, ProviderAdapter } from "../src/gateway/index.js";
import { TEST_MODEL } from "./helpers/scripted-stream.js";
import {
  TEST_CREDENTIAL,
  TEST_CREDENTIAL_REF,
  TEST_ENDPOINT_BASE_URL,
  testPolicyFor,
} from "./helpers/test-gateway.js";

const SCOPE = { enterpriseId: "ent_test", workspaceId: "ws_test" };
const CASE_SCOPE = { ...SCOPE, issueId: "issue_test", runId: "run_test" };
const REQUEST_IDENTITY = { ...CASE_SCOPE, traceId: "trace_recovery" };

const HANDLER: SecurityActor = { actorId: "human_handler", actorKind: "human" };
const REVIEWER: SecurityActor = { actorId: "human_reviewer", actorKind: "human" };
const ADMIN: SecurityActor = { actorId: "human_admin", actorKind: "human" };
const SERVICE: SecurityActor = { actorId: "model-gateway", actorKind: "service" };

const KEY = Buffer.alloc(32, 11);
const DESTINATION = { endpointId: "ep_test", modelId: TEST_MODEL.id };

// Assembled at runtime: repository secret scanners would flag literals.
const SECRET_VALUE = "sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123";

function cleanContext(): Context {
  return {
    systemPrompt: "you are a careful assistant",
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  };
}

function secretContext(): Context {
  return {
    messages: [{ role: "user", content: `process ${SECRET_VALUE}`, timestamp: 1 }],
  };
}

interface DutyLists {
  handlers?: string[];
  reviewers?: string[];
  admins?: string[];
  owners?: string[];
}

/** Mutable duty directory so a test can revoke a role mid-flight. */
function mutableDuties(lists: DutyLists = {}): SecurityDutyDirectory & {
  lists: Required<DutyLists>;
} {
  const state: Required<DutyLists> = {
    handlers: lists.handlers ?? ["human_handler"],
    reviewers: lists.reviewers ?? ["human_reviewer"],
    admins: lists.admins ?? ["human_admin"],
    owners: lists.owners ?? [],
  };
  return {
    lists: state,
    dutiesOf(principalId: string): readonly SecurityDuty[] {
      const held: SecurityDuty[] = [];
      if (state.owners.includes(principalId)) held.push("task_owner");
      if (state.handlers.includes(principalId)) held.push("security_handler");
      if (state.reviewers.includes(principalId)) held.push("independent_reviewer");
      if (state.admins.includes(principalId)) held.push("enterprise_security_admin");
      return held;
    },
    reviewersIn(): readonly string[] {
      return state.reviewers;
    },
  };
}

function okStream(): AssistantMessageEventStream {
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

function silentlyUnfinishedStream(): AssistantMessageEventStream {
  return createAssistantMessageEventStream();
}

interface Harness {
  service: RecoveryService;
  cases: SecurityCaseStore;
  caseId: string;
  audit: ReturnType<typeof createMemoryRecoveryAuditSink>;
  calls: Context[];
  setContext(context: Context): void;
  setPolicy(policy: GatewayPolicy | undefined): void;
  setCorrections(corrections: ActiveRuleCorrection[]): void;
  setIdentityActive(active: boolean): void;
  advance(ms: number): void;
  duties: ReturnType<typeof mutableDuties>;
  authorizations: RecoveryAuthorizationStore;
}

function buildHarness(
  options: {
    adapter?: ProviderAdapter;
    audit?: RecoveryAuditSink;
    context?: Context;
    scanner?: RecoveryServiceDepsScanner;
    persistencePath?: string;
    dispatchTimeoutMs?: number;
    authorizations?: RecoveryAuthorizationStore;
    identityStatus?: boolean;
  } = {},
): Harness {
  const audit = createMemoryRecoveryAuditSink();
  let context = options.context ?? cleanContext();
  let policy: GatewayPolicy | undefined = testPolicyFor(TEST_MODEL);
  let corrections: ActiveRuleCorrection[] = [];
  let identityActive = options.identityStatus ?? true;
  let clock = new Date("2026-11-03T12:00:00.000Z");
  const duties = mutableDuties();
  const cases = new SecurityCaseStore();
  const { case: opened } = cases.openForBlock({
    identity: { ...CASE_SCOPE, invocationId: "inv_block", traceId: "trace_block" },
    reason: "SENSITIVE_DATA_UNCERTAIN",
    actor: SERVICE,
  });
  cases.transition(opened.caseId, "handling", HANDLER);
  cases.transition(opened.caseId, "awaiting_review", HANDLER);

  const calls: Context[] = [];
  const baseAdapter: ProviderAdapter =
    options.adapter ??
    ({
      stream(_model: Model<Api>, request: Context) {
        calls.push(request);
        return okStream();
      },
    } satisfies ProviderAdapter);

  const source: RecoveryRequestSource = {
    rebuild: () => ({ context, sourceIds: ["task-history:run_test", "repository-snapshot:sha"] }),
  };
  const authorizations =
    options.authorizations ??
    new RecoveryAuthorizationStore({
      ...(options.persistencePath !== undefined
        ? { persistencePath: options.persistencePath }
        : {}),
      now: () => clock,
    });
  const service = new RecoveryService({
    authorizations,
    cases,
    duties,
    source,
    policyResolver: { resolve: () => policy },
    credentials: createStaticCredentialStore({ [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL }),
    adapter: {
      stream(model, request, streamOptions) {
        return baseAdapter.stream(model, request, streamOptions);
      },
    },
    audit: options.audit ?? audit.audit,
    correlationKey: KEY,
    rules: { activeCorrections: () => corrections },
    ...(options.scanner !== undefined
      ? { scanner: options.scanner }
      : { scanner: createPatternSecretScanner() }),
    ...(options.dispatchTimeoutMs !== undefined
      ? { dispatchTimeoutMs: options.dispatchTimeoutMs }
      : {}),
    identityStatus: { isActive: () => identityActive },
    now: () => clock,
  });
  return {
    service,
    cases,
    caseId: opened.caseId,
    audit,
    calls,
    duties,
    authorizations,
    setContext: (next) => {
      context = next;
    },
    setPolicy: (next) => {
      policy = next;
    },
    setCorrections: (next) => {
      corrections = next;
    },
    setIdentityActive: (next) => {
      identityActive = next;
    },
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

type RecoveryServiceDepsScanner = NonNullable<
  ConstructorParameters<typeof RecoveryService>[0]["scanner"]
>;

function cleanScanner(): RecoveryServiceDepsScanner {
  return {
    id: "clean-test-scanner",
    ruleVersion: "test",
    scan: () => ({
      scanner: "clean-test-scanner",
      ruleVersion: "test",
      classification: "clean",
      findings: [],
    }),
  };
}

async function expectApprovalInvalid(
  promise: Promise<unknown>,
  reason: string,
): Promise<RecoveryApprovalInvalidError> {
  try {
    await promise;
    expect.unreachable(`expected RECOVERY_APPROVAL_INVALID ${reason}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryApprovalInvalidError);
    const invalid = error as RecoveryApprovalInvalidError;
    expect(invalid.reason).toBe(reason);
    expect(invalid.code).toBe("RECOVERY_APPROVAL_INVALID");
    expect(invalid.retryable).toBe(false);
    return invalid;
  }
}

function eventsOf(records: readonly RecoveryAuditRecord[]): string[] {
  return records.map((record) => record.event);
}

describe("recovery approval (DAT-212)", () => {
  test("only an independent reviewer approves rechecking, and only during review", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });

    await expect(
      harness.service.approve({
        caseId: harness.caseId,
        reviewer: HANDLER,
        destination: DESTINATION,
      }),
    ).rejects.toMatchObject({ code: "SOD_DUTY_REQUIRED" });
    await expect(
      harness.service.approve({
        caseId: harness.caseId,
        reviewer: ADMIN,
        destination: DESTINATION,
      }),
    ).rejects.toMatchObject({ code: "SOD_DUTY_REQUIRED" });
    // A second reviewer who also handled the case may not review it.
    harness.duties.lists.reviewers.push("human_handler");
    await expect(
      harness.service.approve({
        caseId: harness.caseId,
        reviewer: HANDLER,
        destination: DESTINATION,
      }),
    ).rejects.toMatchObject({ code: "SOD_SELF_REVIEW_FORBIDDEN" });

    harness.duties.lists.reviewers.pop();
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    expect(authorization.state).toBe("approved");
    expect(authorization.approval.approvedBy).toBe(REVIEWER.actorId);
    expect(authorization.approval.destination.endpointId).toBe("ep_test");
    expect(authorization.approval.contextRevision).toMatch(/^k1\.request-context\./);
    expect(authorization.expiresAt).toBe("2026-11-03T12:15:00.000Z");
  });

  test("a case that is not awaiting review cannot have rechecking approved", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const { case: pending } = harness.cases.openForBlock({
      identity: {
        ...CASE_SCOPE,
        runId: "run_other",
        invocationId: "inv_other",
        traceId: "trace_other",
      },
      reason: "SENSITIVE_DATA_UNCERTAIN",
      actor: SERVICE,
    });
    await expect(
      harness.service.approve({
        caseId: pending.caseId,
        reviewer: REVIEWER,
        destination: DESTINATION,
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_CASE_NOT_REVIEWABLE" });
  });

  test("an audit failure leaves no usable approval", async () => {
    const failingAudit: RecoveryAuditSink = {
      record(record) {
        if (record.event === "recovery.approval_recorded") throw new Error("audit down");
        return undefined;
      },
    };
    const harness = buildHarness({ scanner: cleanScanner(), audit: failingAudit });
    await expect(
      harness.service.approve({
        caseId: harness.caseId,
        reviewer: REVIEWER,
        destination: DESTINATION,
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_AUDIT_UNAVAILABLE" });
    const [issued] = harness.authorizations.list();
    expect(issued).toBeDefined();
    expect(harness.authorizations.statusOf(issued!)).toBe("invalidated");
  });

  test("the approval lifetime is bounded", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    await expect(
      harness.service.approve({
        caseId: harness.caseId,
        reviewer: REVIEWER,
        destination: DESTINATION,
        ttlSeconds: 24 * 60 * 60,
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_TTL_INVALID" });
  });
});

describe("recovery dispatch (DAT-212)", () => {
  test("dispatches once, freezes the scanned request, and audits approval separately from sending", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    expect(eventsOf(harness.audit.records)).toEqual(["recovery.approval_recorded"]);

    const handle = await harness.service.recover({
      authorizationId: authorization.authorizationId,
      identity: REQUEST_IDENTITY,
      workerId: "worker-1",
      model: TEST_MODEL,
    });
    const outcome = await handle.outcome;
    expect(outcome.kind).toBe("dispatched");
    expect(harness.calls).toHaveLength(1);

    const dispatched = harness.calls[0]!;
    expect(Object.isFrozen(dispatched)).toBe(true);
    expect(Object.isFrozen(dispatched.messages)).toBe(true);
    expect(handle.requestDigest).toMatch(/^k1\.provider-request\./);
    expect(outcome.requestDigest).toBe(handle.requestDigest);
    expect(harness.authorizations.statusAt(authorization.authorizationId)).toBe("consumed");

    const events = eventsOf(harness.audit.records);
    expect(events).toEqual([
      "recovery.approval_recorded",
      "recovery.pre_dispatch",
      "recovery.dispatch_attempted",
      "recovery.dispatch_outcome",
    ]);
    const approval = harness.audit.records.find((r) => r.event === "recovery.approval_recorded")!;
    expect(approval.outcome).toBe("approved");
    const outcomeRecord = harness.audit.records.find(
      (r) => r.event === "recovery.dispatch_outcome",
    )!;
    expect(outcomeRecord.outcome).toBe("dispatched");
    expect(outcomeRecord.requestDigest).toBe(handle.requestDigest);
    expect(outcomeRecord.approval.contextRevision).toBe(authorization.approval.contextRevision);
    // The pre-dispatch record carries the same frozen-request digest.
    const pre = harness.audit.records.find((r) => r.event === "recovery.pre_dispatch")!;
    expect(pre.requestDigest).toBe(handle.requestDigest);
    expect(pre.scan?.classification).toBe("clean");
  });

  test("a second attempt cannot reuse the consumed approval", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const first = await harness.service.recover({
      authorizationId: authorization.authorizationId,
      identity: REQUEST_IDENTITY,
      workerId: "worker-1",
      model: TEST_MODEL,
    });
    expect((await first.outcome).kind).toBe("dispatched");

    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-2",
        model: TEST_MODEL,
      }),
      "already_consumed",
    );
    expect(harness.calls).toHaveLength(1);
  });

  test("concurrent workers: exactly one dispatch wins", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const attempt = (workerId: string) =>
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId,
        model: TEST_MODEL,
      });
    const results = await Promise.allSettled([attempt("worker-1"), attempt("worker-2")]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RecoveryApprovalInvalidError,
    );
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as RecoveryApprovalInvalidError).reason,
    ).toBe("already_consumed");
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof attempt>>>)
      .value;
    expect((await winner.outcome).kind).toBe("dispatched");
    expect(harness.calls).toHaveLength(1);
    // Exactly one consumption outcome, one winner.
    expect(harness.authorizations.outcomes()).toHaveLength(1);
    expect(harness.authorizations.outcomeOf(authorization.authorizationId)?.kind).toBe(
      "dispatched",
    );
  });

  test("a restarted worker cannot reuse an approval consumed before the crash", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recovery-store-"));
    const stateFile = path.join(directory, "recovery.json");
    const first = buildHarness({
      scanner: cleanScanner(),
      persistencePath: stateFile,
    });
    const authorization = await first.service.approve({
      caseId: first.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const handle = await first.service.recover({
      authorizationId: authorization.authorizationId,
      identity: REQUEST_IDENTITY,
      workerId: "worker-before-crash",
      model: TEST_MODEL,
    });
    expect((await handle.outcome).kind).toBe("dispatched");

    // A fresh process loads the same durable state: the approval is spent.
    const restartedStore = new RecoveryAuthorizationStore({ persistencePath: stateFile });
    expect(restartedStore.statusAt(authorization.authorizationId)).toBe("consumed");
    expect(restartedStore.consume(authorization.authorizationId, "worker-after-crash")).toEqual({
      ok: false,
      reason: "already_consumed",
    });
  });

  test("a changed context invalidates the approval and sends nothing", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    harness.setContext({
      systemPrompt: "you are a careful assistant",
      messages: [{ role: "user", content: "hello, plus something new", timestamp: 2 }],
    });
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "context_changed",
    );
    expect(harness.calls).toHaveLength(0);
    expect(harness.authorizations.statusAt(authorization.authorizationId)).toBe("invalidated");
    expect(eventsOf(harness.audit.records)).toContain("recovery.authorization_invalidated");
  });

  test("a changed policy revision invalidates the approval", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    harness.setPolicy(testPolicyFor(TEST_MODEL, { revision: "policy-2" }));
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "policy_changed",
    );
    expect(harness.calls).toHaveLength(0);
  });

  test("a changed destination invalidates the approval", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const moved: GatewayPolicy = testPolicyFor(TEST_MODEL);
    moved.endpoints = moved.endpoints.map((endpoint) => ({
      ...endpoint,
      baseUrl: "https://moved.example.test/v1",
    }));
    harness.setPolicy(moved);
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "destination_changed",
    );
    expect(harness.calls).toHaveLength(0);
  });

  test("a changed rule revision invalidates the approval", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    harness.setCorrections([
      {
        lineage: `detector-x|${SCOPE.enterpriseId}|${SCOPE.workspaceId}`,
        version: 1,
        detectorId: "detector-x",
        scope: SCOPE,
        constraints: { minLength: 40 },
      },
    ]);
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "rules_changed",
    );
    expect(harness.calls).toHaveLength(0);
  });

  test("an expired approval cannot dispatch", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
      ttlSeconds: 60,
    });
    harness.advance(61_000);
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "expired",
    );
    expect(harness.calls).toHaveLength(0);
  });

  test("a revoked reviewer role and a revoked identity both invalidate", async () => {
    const roleHarness = buildHarness({ scanner: cleanScanner() });
    const roleAuth = await roleHarness.service.approve({
      caseId: roleHarness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    roleHarness.duties.lists.reviewers = [];
    await expectApprovalInvalid(
      roleHarness.service.recover({
        authorizationId: roleAuth.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "approval_principal_no_longer_authorized",
    );

    const identityHarness = buildHarness({ scanner: cleanScanner() });
    const identityAuth = await identityHarness.service.approve({
      caseId: identityHarness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    identityHarness.setIdentityActive(false);
    await expectApprovalInvalid(
      identityHarness.service.recover({
        authorizationId: identityAuth.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "identity_revoked",
    );
  });

  test("an explicitly revoked approval is refused", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const revoked = harness.service.revoke(
      authorization.authorizationId,
      ADMIN,
      "scope reconsidered",
    );
    expect(revoked.state).toBe("revoked");
    expect(eventsOf(harness.audit.records)).toContain("recovery.approval_revoked");
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "revoked",
    );
    expect(harness.calls).toHaveLength(0);
  });

  test("a consumed approval cannot be withdrawn", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const handle = await harness.service.recover({
      authorizationId: authorization.authorizationId,
      identity: REQUEST_IDENTITY,
      workerId: "worker-1",
      model: TEST_MODEL,
    });
    await handle.outcome;
    expect(() => harness.service.revoke(authorization.authorizationId, ADMIN, "too late")).toThrow(
      /only an unconsumed/,
    );
    expect(harness.authorizations.statusAt(authorization.authorizationId)).toBe("consumed");
  });

  test("a case that fell back into handling invalidates the approval", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    harness.cases.transition(harness.caseId, "handling", REVIEWER);
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "case_changed",
    );
    expect(harness.calls).toHaveLength(0);
  });

  test("an invocation outside the approved scope is refused", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: { ...REQUEST_IDENTITY, runId: "run_elsewhere" },
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "scope_mismatch",
    );
    expect(harness.calls).toHaveLength(0);
  });
});

describe("complete request rescan (DAT-212)", () => {
  test("a secret that survives handling keeps the request blocked at zero bytes", async () => {
    const harness = buildHarness({
      context: secretContext(),
      scanner: createPatternSecretScanner(),
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    try {
      await harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      });
      expect.unreachable("expected the recheck to block");
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryEgressDeniedError);
      const denied = error as RecoveryEgressDeniedError;
      expect(denied).toBeInstanceOf(ModelEgressDeniedError);
      expect(denied.code).toBe("SENSITIVE_DATA_UNCERTAIN");
      expect(denied.stage).toBe("recovery_recheck");
      expect(denied.caseId).toBe(harness.caseId);
      expect(denied.message).not.toContain(SECRET_VALUE);
    }
    expect(harness.calls).toHaveLength(0);
    expect(harness.authorizations.statusAt(authorization.authorizationId)).toBe("invalidated");
    const failed = harness.audit.records.find((r) => r.event === "recovery.recheck_failed")!;
    expect(failed.scan?.classification).not.toBe("clean");
    expect(JSON.stringify(harness.audit.records)).not.toContain(SECRET_VALUE);
    // The approval audit trail carries no detected value either.
    expect(harness.cases.events(harness.caseId).map((event) => event.type)).toContain(
      "recovery.invalidated",
    );
  });

  test("an unavailable scanner fails closed without sending", async () => {
    const harness = buildHarness({
      scanner: {
        id: "broken-scanner",
        ruleVersion: "test",
        scan() {
          throw new Error("scanner offline");
        },
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    await expect(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_DATA_UNCERTAIN" });
    expect(harness.calls).toHaveLength(0);
  });

  test("a failing pre-dispatch audit write blocks the send and keeps the approval", async () => {
    const failingAudit: RecoveryAuditSink = {
      record(record) {
        if (record.event === "recovery.pre_dispatch") throw new Error("audit sink down");
        return undefined;
      },
    };
    const harness = buildHarness({ scanner: cleanScanner(), audit: failingAudit });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    await expect(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
    ).rejects.toMatchObject({ code: "MODEL_EGRESS_DENIED", reason: "AUDIT_UNAVAILABLE" });
    expect(harness.calls).toHaveLength(0);
    expect(harness.authorizations.statusAt(authorization.authorizationId)).toBe("approved");
  });

  test("a data class the destination is not authorized for blocks the send", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const restricted = testPolicyFor(TEST_MODEL);
    restricted.endpoints = restricted.endpoints.map((endpoint) => ({
      ...endpoint,
      permittedDataClasses: DATA_CLASSES.filter((dataClass) => dataClass !== "user_input"),
    }));
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    // Approve under the permissive policy, then narrow the permitted data
    // classes before dispatch: the recheck refuses and nothing is sent.
    harness.setPolicy(restricted);
    try {
      await harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      });
      expect.unreachable("expected the data-class check to block the send");
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryEgressDeniedError);
      expect((error as RecoveryEgressDeniedError).code).toBe("MODEL_EGRESS_DENIED");
      expect((error as RecoveryEgressDeniedError).reason).toBe("DATA_CLASS_NOT_AUTHORIZED");
    }
    expect(harness.calls).toHaveLength(0);
    expect(harness.authorizations.statusAt(authorization.authorizationId)).toBe("invalidated");
  });
});

describe("unknown provider outcome (DAT-212)", () => {
  test("silence is recorded as unknown, never as not-sent, and never replayed", async () => {
    const harness = buildHarness({
      scanner: cleanScanner(),
      dispatchTimeoutMs: 25,
      adapter: {
        stream() {
          return silentlyUnfinishedStream();
        },
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const handle = await harness.service.recover({
      authorizationId: authorization.authorizationId,
      identity: REQUEST_IDENTITY,
      workerId: "worker-1",
      model: TEST_MODEL,
    });
    const outcome = await handle.outcome;
    expect(outcome.kind).toBe("unknown");
    expect(outcome.detail).toContain("may have received the request");
    expect(outcome.reconciliation?.state).toBe("pending");
    expect(harness.authorizations.statusAt(authorization.authorizationId)).toBe("consumed");
    expect(harness.service.pendingReconciliation().map((entry) => entry.authorizationId)).toEqual([
      authorization.authorizationId,
    ]);
    const audited = harness.audit.records.find((r) => r.event === "recovery.dispatch_outcome")!;
    expect(audited.outcome).toBe("unknown");
    expect(audited.reason).toContain("reconciliation required");

    // Never replayed under the consumed authorization.
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-2",
        model: TEST_MODEL,
      }),
      "already_consumed",
    );

    // Reconciliation is recorded and still authorizes nothing.
    const reconciled = harness.service.reconcile(
      authorization.authorizationId,
      HANDLER,
      "confirmed_not_sent",
      "provider had no record of the request",
    );
    expect(reconciled.reconciliation?.state).toBe("confirmed_not_sent");
    expect(harness.authorizations.statusAt(authorization.authorizationId)).toBe("consumed");
    expect(harness.service.pendingReconciliation()).toHaveLength(0);
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-3",
        model: TEST_MODEL,
      }),
      "already_consumed",
    );
  });

  test("a definite connection failure is failed, not unknown", async () => {
    const harness = buildHarness({
      scanner: cleanScanner(),
      adapter: {
        stream() {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        },
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const handle = await harness.service.recover({
      authorizationId: authorization.authorizationId,
      identity: REQUEST_IDENTITY,
      workerId: "worker-1",
      model: TEST_MODEL,
    });
    const outcome = await handle.outcome;
    expect(outcome.kind).toBe("failed");
    expect(outcome.reconciliation).toBeNull();
    expect(harness.authorizations.statusAt(authorization.authorizationId)).toBe("consumed");
  });

  test("a transport failure after dispatch starts is unknown", async () => {
    const harness = buildHarness({
      scanner: cleanScanner(),
      dispatchTimeoutMs: 5_000,
      adapter: {
        stream() {
          return {
            [Symbol.asyncIterator]() {
              return {
                async next(): Promise<IteratorResult<never>> {
                  throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
                },
              };
            },
          } as unknown as AssistantMessageEventStream;
        },
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const handle = await harness.service.recover({
      authorizationId: authorization.authorizationId,
      identity: REQUEST_IDENTITY,
      workerId: "worker-1",
      model: TEST_MODEL,
    });
    const outcome = await handle.outcome;
    expect(outcome.kind).toBe("unknown");
    expect(outcome.detail).toContain("socket hang up");
  });

  test("reconciliation requires a duty and only applies to unknown outcomes", async () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const handle = await harness.service.recover({
      authorizationId: authorization.authorizationId,
      identity: REQUEST_IDENTITY,
      workerId: "worker-1",
      model: TEST_MODEL,
    });
    await handle.outcome;
    expect(() =>
      harness.service.reconcile(
        authorization.authorizationId,
        { actorId: "human_stranger", actorKind: "human" },
        "unresolved",
      ),
    ).toThrow(SecurityError);
    // A known outcome needs no reconciliation and cannot be given one.
    expect(() =>
      harness.service.reconcile(authorization.authorizationId, HANDLER, "unresolved"),
    ).toThrow(/only an unknown provider outcome/);
  });

  test("an unknown outcome is not silently swallowed by a dispatch error", async () => {
    const harness = buildHarness({
      scanner: cleanScanner(),
      dispatchTimeoutMs: 25,
      adapter: {
        stream() {
          return silentlyUnfinishedStream();
        },
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const handle = await harness.service.recover({
      authorizationId: authorization.authorizationId,
      identity: REQUEST_IDENTITY,
      workerId: "worker-1",
      model: TEST_MODEL,
    });
    const events: string[] = [];
    for await (const event of handle.stream) events.push(event.type);
    expect(events.at(-1)).toBe("error");
    expect(await handle.outcome).toMatchObject({ kind: "unknown" });
  });
});

describe("recovery audit boundary (DAT-212)", () => {
  test("no audit record or error carries the blocked content", async () => {
    const harness = buildHarness({
      context: secretContext(),
      scanner: createPatternSecretScanner(),
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    await expect(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
    ).rejects.toBeInstanceOf(RecoveryEgressDeniedError);
    const auditJson = JSON.stringify(harness.audit.records);
    const caseJson = JSON.stringify(harness.cases.events(harness.caseId));
    expect(auditJson).not.toContain(SECRET_VALUE);
    expect(caseJson).not.toContain(SECRET_VALUE);
    expect(auditJson).not.toContain("process ");
  });

  test("a dispatch error never reports an unknown outcome as success", async () => {
    const harness = buildHarness({
      scanner: cleanScanner(),
      adapter: {
        stream() {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        },
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const handle = await harness.service.recover({
      authorizationId: authorization.authorizationId,
      identity: REQUEST_IDENTITY,
      workerId: "worker-1",
      model: TEST_MODEL,
    });
    expect(handle.requestDigest).toMatch(/^k1\.provider-request\./);
    const dispatched = harness.audit.records.filter(
      (record) => record.event === "recovery.dispatch_outcome",
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.outcome).toBe("failed");
    expect((await handle.outcome).kind).toBe("failed");
    expect(TEST_ENDPOINT_BASE_URL).toBe("https://gateway.test/v1");
  });
});
