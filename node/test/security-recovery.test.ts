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
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
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
  createFileRecoveryAuditSink,
  createMemoryRecoveryAuditSink,
  verifyRecoveryAuditLog,
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
/** The harness clock's starting instant, for stores created outside it. */
const AT_APPROVAL = (): Date => new Date("2026-11-03T12:00:00.000Z");
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
  makeService(
    store: RecoveryAuthorizationStore,
    overrides?: { audit?: RecoveryAuditSink; allowTestAuditSink?: boolean },
  ): RecoveryService;
  auditSink: RecoveryAuditSink;
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
    /** Runs inside the audit write, so a test can change bound facts mid-flight. */
    onAudit?: (record: RecoveryAuditRecord) => void;
    allowTestAuditSink?: boolean;
  } = {},
): Harness {
  const audit = createMemoryRecoveryAuditSink();
  if (options.onAudit) {
    const wrapped = audit.audit.record.bind(audit.audit);
    audit.audit.record = (record: RecoveryAuditRecord): void => {
      options.onAudit?.(record);
      wrapped(record);
    };
  }
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
  const makeService = (
    store: RecoveryAuthorizationStore,
    overrides: { audit?: RecoveryAuditSink; allowTestAuditSink?: boolean } = {},
  ): RecoveryService =>
    new RecoveryService({
      authorizations: store,
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
      audit: overrides.audit ?? options.audit ?? audit.audit,
      allowTestAuditSink: overrides.allowTestAuditSink ?? options.allowTestAuditSink ?? true,
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
  const service = makeService(authorizations);
  return {
    service,
    makeService,
    auditSink: audit.audit,
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
      durability: "test",
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
      durability: "test",
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

describe("cross-worker single use (DAT-212)", () => {
  test("two independent stores over one state file: exactly one consumption wins", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recovery-claim-"));
    const stateFile = path.join(directory, "recovery.json");
    const harness = buildHarness({ scanner: cleanScanner(), persistencePath: stateFile });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });

    const workerA = new RecoveryAuthorizationStore({
      persistencePath: stateFile,
      now: AT_APPROVAL,
    });
    const workerB = new RecoveryAuthorizationStore({
      persistencePath: stateFile,
      now: AT_APPROVAL,
    });
    const first = workerA.consume(authorization.authorizationId, "worker-a");
    const second = workerB.consume(authorization.authorizationId, "worker-b");
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "already_consumed" });
    // The loser sees the winner's decision, not its stale snapshot.
    expect(workerB.statusAt(authorization.authorizationId)).toBe("consumed");
  });

  test("a second service on the same state file cannot dispatch the same approval", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recovery-claim-svc-"));
    const stateFile = path.join(directory, "recovery.json");
    const harness = buildHarness({ scanner: cleanScanner(), persistencePath: stateFile });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const secondStore = new RecoveryAuthorizationStore({
      persistencePath: stateFile,
      now: AT_APPROVAL,
    });
    const secondService = harness.makeService(secondStore);

    const results = await Promise.allSettled([
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-a",
        model: TEST_MODEL,
      }),
      secondService.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-b",
        model: TEST_MODEL,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as RecoveryApprovalInvalidError).reason,
    ).toBe("already_consumed");
    expect(harness.calls).toHaveLength(1);
    const winner = (
      fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof harness.service.recover>>>
    ).value;
    expect((await winner.outcome).kind).toBe("dispatched");
    // Neither service will ever dispatch this approval again.
    for (const service of [harness.service, secondService]) {
      await expectApprovalInvalid(
        service.recover({
          authorizationId: authorization.authorizationId,
          identity: REQUEST_IDENTITY,
          workerId: "worker-again",
          model: TEST_MODEL,
        }),
        "already_consumed",
      );
    }
    expect(harness.calls).toHaveLength(1);
  });

  test("a worker that crashed after claiming cannot donate the approval back", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recovery-crash-"));
    const stateFile = path.join(directory, "recovery.json");
    const harness = buildHarness({ scanner: cleanScanner(), persistencePath: stateFile });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    // Model a crash between the claim and the state-file write: take the
    // pre-consume file, consume (which writes the claim), then restore it.
    const before = readFileSync(stateFile, "utf8");
    const consumed = harness.authorizations.consume(
      authorization.authorizationId,
      "worker-before-crash",
    );
    expect(consumed.ok).toBe(true);
    writeFileSync(stateFile, before, "utf8");

    // The stored record says `approved` again, but the claim ledger refuses.
    const restarted = new RecoveryAuthorizationStore({
      persistencePath: stateFile,
      now: AT_APPROVAL,
    });
    expect(restarted.consume(authorization.authorizationId, "worker-after-crash")).toEqual({
      ok: false,
      reason: "already_consumed",
    });
    expect(restarted.consume(authorization.authorizationId, "worker-after-crash").ok).toBe(false);
  });

  test("revocation arbitrates against consumption instead of racing it", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recovery-revoke-"));
    const stateFile = path.join(directory, "recovery.json");
    const harness = buildHarness({ scanner: cleanScanner(), persistencePath: stateFile });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    const worker = new RecoveryAuthorizationStore({ persistencePath: stateFile, now: AT_APPROVAL });
    expect(worker.consume(authorization.authorizationId, "worker-a").ok).toBe(true);
    // A revoke after the claim is refused outright: the claim decided.
    expect(() => harness.service.revoke(authorization.authorizationId, ADMIN, "too late")).toThrow(
      /only an unconsumed/,
    );
    expect(worker.statusAt(authorization.authorizationId)).toBe("consumed");
  });
});

describe("bound facts revalidated before consumption (DAT-212)", () => {
  test("a policy change during the pre-dispatch audit blocks the send", async () => {
    const harness = buildHarness({
      scanner: cleanScanner(),
      onAudit: (record) => {
        if (record.event === "recovery.pre_dispatch") {
          harness.setPolicy(testPolicyFor(TEST_MODEL, { revision: "policy-changed-mid-audit" }));
        }
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
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

  test("a revoked reviewer role during the pre-dispatch audit blocks the send", async () => {
    const harness = buildHarness({
      scanner: cleanScanner(),
      onAudit: (record) => {
        if (record.event === "recovery.pre_dispatch") {
          harness.duties.lists.reviewers = [];
        }
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "approval_principal_no_longer_authorized",
    );
    expect(harness.calls).toHaveLength(0);
  });

  test("a case that reverts to handling during the pre-dispatch audit blocks the send", async () => {
    const harness = buildHarness({
      scanner: cleanScanner(),
      onAudit: (record) => {
        if (record.event === "recovery.pre_dispatch") {
          harness.cases.transition(harness.caseId, "handling", REVIEWER);
        }
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
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

  test("a changed rule revision during the pre-dispatch audit blocks the send", async () => {
    const harness = buildHarness({
      scanner: cleanScanner(),
      onAudit: (record) => {
        if (record.event === "recovery.pre_dispatch") {
          harness.setCorrections([
            {
              lineage: `detector-mid|${SCOPE.enterpriseId}|${SCOPE.workspaceId}`,
              version: 1,
              detectorId: "detector-mid",
              scope: SCOPE,
              constraints: { minLength: 40 },
            },
          ]);
        }
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
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

  test("a revoked identity during the pre-dispatch audit blocks the send", async () => {
    const harness = buildHarness({
      scanner: cleanScanner(),
      onAudit: (record) => {
        if (record.event === "recovery.pre_dispatch") harness.setIdentityActive(false);
      },
    });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    await expectApprovalInvalid(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
      "identity_revoked",
    );
    expect(harness.calls).toHaveLength(0);
  });
});

describe("durable audit sink integrity (DAT-212)", () => {
  function sampleRecord(overrides: Partial<RecoveryAuditRecord> = {}): RecoveryAuditRecord {
    return {
      event: "recovery.approval_recorded",
      at: "2026-11-03T12:00:00.000Z",
      authorizationId: "auth_1",
      caseId: "case_1",
      invocationId: null,
      traceId: null,
      scope: CASE_SCOPE,
      actor: REVIEWER,
      approval: {
        contextRevision: "k1.request-context.x",
        policyRevision: "policy-1",
        rulesRevision: "k1.rule-revisions.y",
        scanPolicyRevision: "k1.scan-policy.z",
        approvedBy: REVIEWER.actorId,
        approvedAt: "2026-11-03T12:00:00.000Z",
        expiresAt: "2026-11-03T12:15:00.000Z",
      },
      destination: {
        endpointId: "ep_test",
        provider: "openai",
        api: "openai-completions",
        modelId: TEST_MODEL.id,
        internal: false,
      },
      requestDigest: null,
      scan: null,
      outcome: "approved",
      reason: "approved",
      detail: {},
      ...overrides,
    };
  }

  function auditFile(): { directory: string; file: string } {
    const directory = mkdtempSync(path.join(tmpdir(), "recovery-audit-"));
    return { directory, file: path.join(directory, "audit.jsonl") };
  }

  test("records are hash-chained, anchored, and verify cleanly", () => {
    const { file } = auditFile();
    const sink = createFileRecoveryAuditSink(file);
    sink.record(sampleRecord());
    sink.record(sampleRecord({ event: "recovery.pre_dispatch", outcome: null }));
    const verified = verifyRecoveryAuditLog(file);
    expect(verified.records).toHaveLength(2);
    expect(verified.seq).toBe(2);
    expect(verified.records[1]?.event).toBe("recovery.pre_dispatch");
  });

  test("an edited record is detected", () => {
    const { file } = auditFile();
    const sink = createFileRecoveryAuditSink(file);
    sink.record(sampleRecord());
    sink.record(sampleRecord({ event: "recovery.dispatch_outcome", outcome: "dispatched" }));
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const first = JSON.parse(lines[0] as string);
    first.record.outcome = "unknown";
    lines[0] = JSON.stringify(first);
    writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
    expect(() => verifyRecoveryAuditLog(file)).toThrow(/modified after it was written/);
    expect(() => createFileRecoveryAuditSink(file)).toThrow(/integrity/);
  });

  test("deleting an anchored record is detected", () => {
    const { file } = auditFile();
    const sink = createFileRecoveryAuditSink(file);
    sink.record(sampleRecord());
    sink.record(sampleRecord({ event: "recovery.dispatch_outcome" }));
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, `${lines[0] as string}\n`, { mode: 0o600 });
    expect(() => verifyRecoveryAuditLog(file)).toThrow(/removed from the end/);
  });

  test("emptying an anchored log is detected", () => {
    const { file } = auditFile();
    const sink = createFileRecoveryAuditSink(file);
    sink.record(sampleRecord());
    writeFileSync(file, "", { mode: 0o600 });
    expect(() => verifyRecoveryAuditLog(file)).toThrow(/every anchored audit record was removed/);
  });

  test("a group- or world-readable log and a symlink are refused", () => {
    const { file } = auditFile();
    createFileRecoveryAuditSink(file).record(sampleRecord());
    chmodSync(file, 0o644);
    expect(() => createFileRecoveryAuditSink(file)).toThrow(/beyond its owner/);

    const target = path.join(path.dirname(file), "target.jsonl");
    createFileRecoveryAuditSink(target).record(sampleRecord());
    const link = path.join(path.dirname(file), "link.jsonl");
    symlinkSync(target, link);
    expect(() => createFileRecoveryAuditSink(link)).toThrow(/regular file/);
  });

  test("a keyed chain cannot be re-forged without the key", () => {
    const { file } = auditFile();
    const key = Buffer.alloc(32, 3);
    const sink = createFileRecoveryAuditSink(file, { key });
    sink.record(sampleRecord());
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const first = JSON.parse(lines[0] as string);
    first.record.outcome = "unknown";
    lines[0] = JSON.stringify(first);
    writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
    expect(() => verifyRecoveryAuditLog(file, { key })).toThrow(/modified/);
    expect(() => verifyRecoveryAuditLog(file)).toThrow(/modified/);
  });

  test("a deployment cannot silently audit into memory", () => {
    const harness = buildHarness({ scanner: cleanScanner() });
    expect(() =>
      harness.makeService(harness.authorizations, { allowTestAuditSink: false }),
    ).toThrow(/durable audit sink/);
  });
});

describe("audit log concurrent append (DAT-212 QA round 2)", () => {
  function recordFor(index: number): RecoveryAuditRecord {
    return {
      event: "recovery.approval_recorded",
      at: "2026-11-03T12:00:00.000Z",
      authorizationId: `auth_${index}`,
      caseId: "case_1",
      invocationId: null,
      traceId: null,
      scope: CASE_SCOPE,
      actor: REVIEWER,
      approval: {
        contextRevision: "k1.request-context.x",
        policyRevision: "policy-1",
        rulesRevision: "k1.rule-revisions.y",
        scanPolicyRevision: "k1.scan-policy.z",
        approvedBy: REVIEWER.actorId,
        approvedAt: "2026-11-03T12:00:00.000Z",
        expiresAt: "2026-11-03T12:15:00.000Z",
      },
      destination: {
        endpointId: "ep_test",
        provider: "openai",
        api: "openai-completions",
        modelId: TEST_MODEL.id,
        internal: false,
      },
      requestDigest: null,
      scan: null,
      outcome: "approved",
      reason: "approved",
      detail: {},
    };
  }

  test("two independent sink instances cannot fork the chain", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recovery-audit-race-"));
    const file = path.join(directory, "audit.jsonl");
    const workerA = createFileRecoveryAuditSink(file);
    const workerB = createFileRecoveryAuditSink(file);

    // Each instance was opened on the same empty log; a staler in-memory head
    // would make B repeat seq 1 and break the chain.
    workerA.record(recordFor(1));
    workerB.record(recordFor(2));
    workerA.record(recordFor(3));
    workerB.record(recordFor(4));

    const verified = verifyRecoveryAuditLog(file);
    expect(verified.seq).toBe(4);
    expect(verified.records.map((record) => record.authorizationId)).toEqual([
      "auth_1",
      "auth_2",
      "auth_3",
      "auth_4",
    ]);
    // The chain is one line of descent, so a second instance can keep appending.
    workerA.record(recordFor(5));
    expect(verifyRecoveryAuditLog(file).seq).toBe(5);
  });

  test("two OS processes appending concurrently produce one verifiable chain", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recovery-audit-proc-"));
    const file = path.join(directory, "audit.jsonl");
    const script = path.join(directory, "append.ts");
    const sinkModule = path.resolve(import.meta.dirname, "../src/security/recovery-audit.ts");
    const viteNode = path.resolve(import.meta.dirname, "../node_modules/.bin/vite-node");
    writeFileSync(
      script,
      `import { createFileRecoveryAuditSink } from ${JSON.stringify(sinkModule)};\n` +
        `const [file, worker, countRaw] = process.argv.slice(2);\n` +
        `const sink = createFileRecoveryAuditSink(file);\n` +
        `const base = ${JSON.stringify(recordFor(0))};\n` +
        `for (let index = 0; index < Number(countRaw); index += 1) {\n` +
        `  sink.record({ ...base, authorizationId: worker + "-" + index });\n` +
        `}\n`,
      "utf8",
    );
    const run = (worker: string): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(viteNode, [script, file, worker, "4"], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stderr }));
      });
    const results = await Promise.all([run("worker_a"), run("worker_b")]);
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
    }
    const verified = verifyRecoveryAuditLog(file);
    expect(verified.seq).toBe(8);
    const ids = verified.records.map((record) => record.authorizationId);
    expect(new Set(ids).size).toBe(8);
    expect(ids.filter((id) => id.startsWith("worker_a-"))).toHaveLength(4);
    expect(ids.filter((id) => id.startsWith("worker_b-"))).toHaveLength(4);
  });

  test("a held lock fails closed: no record, and no dispatch", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recovery-audit-lock-"));
    const file = path.join(directory, "audit.jsonl");
    const sink = createFileRecoveryAuditSink(file, { lockTimeoutMs: 30, lockStaleMs: 60_000 });
    const harness = buildHarness({ scanner: cleanScanner(), audit: sink });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    // A live writer holds the log open: the required pre-dispatch record can
    // never be appended, so the dispatch must not happen.
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }),
      { mode: 0o600 },
    );
    expect(() => sink.record({ ...recordFor(99) })).toThrow(/another writer holds/);
    await expect(
      harness.service.recover({
        authorizationId: authorization.authorizationId,
        identity: REQUEST_IDENTITY,
        workerId: "worker-1",
        model: TEST_MODEL,
      }),
    ).rejects.toMatchObject({ code: "MODEL_EGRESS_DENIED", reason: "AUDIT_UNAVAILABLE" });
    expect(harness.calls).toHaveLength(0);
    // Nothing was sent, so the approval was not spent on a broken audit.
    expect(harness.authorizations.statusAt(authorization.authorizationId)).toBe("approved");
    fs.unlinkSync(`${file}.lock`);
  });

  test("a tampered log blocks pre-dispatch instead of sending", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recovery-audit-tamper-"));
    const file = path.join(directory, "audit.jsonl");
    const fileSink = createFileRecoveryAuditSink(file);
    let tampered = false;
    const audit: RecoveryAuditSink = {
      durability: "durable",
      record(record) {
        fileSink.record(record);
        if (record.event === "recovery.approval_recorded" && !tampered) {
          tampered = true;
          const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
          const first = JSON.parse(lines[0] as string);
          first.record.outcome = "unknown";
          lines[0] = JSON.stringify(first);
          writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
        }
      },
    };
    const harness = buildHarness({ scanner: cleanScanner(), audit });
    const authorization = await harness.service.approve({
      caseId: harness.caseId,
      reviewer: REVIEWER,
      destination: DESTINATION,
    });
    expect(tampered).toBe(true);
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
});
