import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  SECURITY_AUDIT_EVENT_CLASSES,
  SECURITY_AUDIT_EVENT_TYPES,
  SecurityError,
  auditEventFromCaseEvent,
  auditEventFromGatewayAttempt,
  auditEventFromRecoveryRecord,
  auditEventFromRuleEvent,
  createFileSecurityAuditTrail,
  createMemorySecurityAuditTrail,
  inspectSecurityAuditTrailForTests as inspect,
  protectedAuditIdentifier,
  staticDutyDirectory,
} from "../src/security/index.js";
import type {
  CaseEvent,
  RecoveryAuditRecord,
  RuleEvent,
  SecurityActor,
  SecurityCase,
} from "../src/security/index.js";
import type { GatewayAttemptEvent } from "../src/gateway/types.js";

/**
 * DAT-213 acceptance: the unified audit trail covers every ADR-0005 §6 event
 * class, chains them tamper-evidently, keeps secrets out, and audits its own
 * reads and exports.
 */

const KEY = Buffer.alloc(32, 11);
const SCOPE = {
  enterpriseId: "ent_test",
  workspaceId: "ws_test",
  issueId: "issue_1",
  runId: "run_1",
};
const NOW = () => new Date("2026-11-04T00:00:00.000Z");

const CASE: SecurityCase = {
  caseId: "case_1",
  scope: { ...SCOPE },
  state: "awaiting_review",
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
  blocks: [],
  quarantineIds: [],
};

const HANDLER: SecurityActor = { actorId: "human_handler", actorKind: "human" };
const REVIEWER: SecurityActor = { actorId: "human_reviewer", actorKind: "human" };
const ADMIN: SecurityActor = { actorId: "human_admin", actorKind: "human" };
const OUTSIDER: SecurityActor = { actorId: "human_owner", actorKind: "human" };

const DUTIES = staticDutyDirectory({
  handlers: ["human_handler"],
  reviewers: ["human_reviewer"],
  admins: ["human_admin"],
});

function access(actor: SecurityActor, purpose = "incident review") {
  return { actor, duties: DUTIES, purpose };
}

function caseEvent(
  type: CaseEvent["type"],
  detail: Record<string, string | number | boolean> = {},
  actor: SecurityActor | null = HANDLER,
): CaseEvent {
  return { seq: 1, caseId: CASE.caseId, type, at: "2026-11-04T00:00:00.000Z", actor, detail };
}

const CASE_EVENTS: CaseEvent[] = [
  caseEvent("case.opened", { reason: "SENSITIVE_DATA_UNCERTAIN" }),
  caseEvent("block.recorded", {
    invocationId: "inv_1",
    traceId: "trace_1",
    reason: "SENSITIVE_DATA_UNCERTAIN",
  }),
  caseEvent("run.dependent_work_paused", { pauseId: "pause_1", runId: "run_1" }),
  caseEvent("notification.dispatched", { notificationId: "n_1", recipientId: "human_handler" }),
  caseEvent("quarantine.sealed", { quarantineId: "q_1", expiresAt: "2026-12-04T00:00:00.000Z" }),
  caseEvent("quarantine.access_granted", { quarantineId: "q_1", grantId: "g_1", subject: "h" }),
  caseEvent("quarantine.accessed", { quarantineId: "q_1", grantId: "g_1" }, REVIEWER),
  caseEvent("case.state_changed", { from: "pending", to: "handling" }),
  caseEvent("case.state_changed", { from: "handling", to: "awaiting_review" }),
  caseEvent(
    "case.review_approved",
    { reviewer: "human_reviewer", subjects: "human_handler" },
    REVIEWER,
  ),
  caseEvent("case.state_changed", { from: "awaiting_review", to: "resolved" }, REVIEWER),
];

const RULE_EVENTS: RuleEvent[] = [
  {
    seq: 1,
    lineage: "openai_key|ent_test|ws_test",
    type: "rule.proposed",
    at: "2026-11-04T00:00:00.000Z",
    actor: { principalId: "human_handler", duty: "security_handler" },
    detail: { version: 1, detectorId: "openai_key", reason: "false positive" },
  },
  {
    seq: 2,
    lineage: "openai_key|ent_test|ws_test",
    type: "rule.review_approved",
    at: "2026-11-04T00:00:00.000Z",
    actor: { principalId: "human_reviewer", duty: "independent_reviewer" },
    detail: { version: 1, reviewerId: "human_reviewer", authorId: "human_handler" },
  },
  {
    seq: 3,
    lineage: "openai_key|ent_test|ws_test",
    type: "rule.activated",
    at: "2026-11-04T00:00:00.000Z",
    actor: { principalId: "human_admin", duty: "enterprise_security_admin" },
    detail: { version: 1 },
  },
  {
    seq: 4,
    lineage: "openai_key|ent_test|ws_test",
    type: "rule.rolled_back",
    at: "2026-11-04T00:00:00.000Z",
    actor: { principalId: "human_admin", duty: "enterprise_security_admin" },
    detail: { version: 2, rollsBackVersion: 1 },
  },
];

function recoveryRecord(event: RecoveryAuditRecord["event"]): RecoveryAuditRecord {
  return {
    event,
    at: "2026-11-04T00:00:00.000Z",
    authorizationId: "auth_1",
    caseId: "case_1",
    invocationId: event.startsWith("recovery.dispatch") ? "inv_2" : null,
    traceId: event.startsWith("recovery.dispatch") ? "trace_2" : null,
    scope: { ...SCOPE },
    actor: REVIEWER,
    approval: {
      contextRevision: "k1.request-context.abc",
      policyRevision: "policy_7",
      rulesRevision: "rules_3",
      scanPolicyRevision: "scan_2",
      approvedBy: "human_reviewer",
      approvedAt: "2026-11-04T00:00:00.000Z",
      expiresAt: "2026-11-04T00:10:00.000Z",
    },
    destination: {
      endpointId: "ep_1",
      provider: "anthropic",
      api: "anthropic",
      modelId: "claude-sonnet-5-5",
      internal: false,
    },
    requestDigest: "k1.request-digest.def",
    scan: {
      scanner: "pattern",
      ruleVersion: "rules_3",
      classification: "clean",
      segments: 4,
      dataClasses: ["code"],
      findingCounts: { suspected: 0, confirmed: 0, unknown: 0 },
      detectors: ["openai_key"],
      derivedSegments: 0,
      classificationChanges: [],
    },
    outcome: event === "recovery.dispatch_outcome" ? "dispatched" : null,
    reason: null,
    detail: { attempt: 1 },
  };
}

const GATEWAY_DENIED: GatewayAttemptEvent = {
  phase: "outcome",
  identity: {
    enterpriseId: SCOPE.enterpriseId,
    workspaceId: SCOPE.workspaceId,
    issueId: SCOPE.issueId,
    runId: SCOPE.runId,
    invocationId: "inv_3",
    traceId: "trace_3",
  },
  attempt: 1,
  policyRevision: "policy_7",
  destination: null,
  outcome: "denied",
  denyReason: "SENSITIVE_DATA_UNCERTAIN",
  timestamp: "2026-11-04T00:00:00.000Z",
};

function seededTrail() {
  const trail = createMemorySecurityAuditTrail({ key: KEY, now: NOW });
  for (const event of CASE_EVENTS) trail.record(auditEventFromCaseEvent(CASE, event));
  for (const event of RULE_EVENTS) trail.record(auditEventFromRuleEvent(event));
  for (const type of [
    "recovery.approval_recorded",
    "recovery.approval_revoked",
    "recovery.authorization_invalidated",
    "recovery.recheck_failed",
    "recovery.pre_dispatch",
    "recovery.dispatch_attempted",
    "recovery.dispatch_outcome",
  ] as const) {
    trail.record(auditEventFromRecoveryRecord(recoveryRecord(type)));
  }
  trail.record(auditEventFromGatewayAttempt(GATEWAY_DENIED));
  trail.record(
    auditEventFromGatewayAttempt({
      phase: "pre_dispatch",
      identity: GATEWAY_DENIED.identity,
      attempt: 1,
      policyRevision: "policy_7",
      destination: {
        endpointId: "ep_1",
        provider: "anthropic",
        modelId: "claude-sonnet-5-5",
        internal: false,
      },
      scan: {
        scanner: "pattern",
        ruleVersion: "rules_3",
        classification: "clean",
        segments: 2,
        dataClasses: ["code"],
        findingCounts: { suspected: 0, confirmed: 0, unknown: 0 },
        detectors: [],
        derivedSegments: 0,
        classificationChanges: [],
      },
      timestamp: "2026-11-04T00:00:00.000Z",
    }),
  );
  trail.record(
    auditEventFromGatewayAttempt({
      phase: "outcome",
      identity: GATEWAY_DENIED.identity,
      attempt: 1,
      policyRevision: "policy_7",
      destination: {
        endpointId: "ep_1",
        provider: "anthropic",
        modelId: "claude-sonnet-5-5",
        internal: false,
      },
      outcome: "dispatched",
      timestamp: "2026-11-04T00:00:00.000Z",
    }),
  );
  trail.record(
    auditEventFromCaseEvent(
      { ...CASE, state: "terminated" },
      caseEvent("case.state_changed", { from: "awaiting_review", to: "terminated" }, ADMIN),
    ),
  );
  return trail;
}

describe("ADR-0005 §6 audit coverage", () => {
  test("every event class appears in one unified trail", () => {
    const trail = seededTrail();
    // Audit-access events are produced by the trail itself.
    trail.read(
      { enterpriseId: "ent_test", workspaceId: "ws_test" },
      access(HANDLER, "coverage check"),
    );
    const events = new Set(inspect(trail).map((entry) => entry.event.event));
    for (const [className, expected] of Object.entries(SECURITY_AUDIT_EVENT_CLASSES)) {
      const present = expected.filter((type) => events.has(type));
      expect(present.length, `no ${className} event recorded`).toBeGreaterThan(0);
    }
    // The vocabulary is closed and the class map covers all of it.
    const classified = new Set(Object.values(SECURITY_AUDIT_EVENT_CLASSES).flat());
    expect([...classified].sort()).toEqual([...SECURITY_AUDIT_EVENT_TYPES].sort());
  });

  test("detection, approval, recheck, dispatch, and termination stay distinct events", () => {
    const trail = seededTrail();
    trail.record(
      auditEventFromCaseEvent(
        { ...CASE, state: "terminated" },
        caseEvent("case.state_changed", { from: "awaiting_review", to: "terminated" }, ADMIN),
      ),
    );
    const types = inspect(trail).map((entry) => entry.event.event);
    expect(types).toContain("block.detected");
    expect(types).toContain("block.enforced");
    expect(types).toContain("recovery.approval_recorded");
    expect(types).toContain("recovery.recheck_failed");
    expect(types).toContain("recovery.dispatch_attempted");
    expect(types).toContain("recovery.dispatch_outcome");
    expect(types).toContain("case.terminated");
    // An approval never masquerades as a dispatch.
    const approval = inspect(trail).find(
      (entry) => entry.event.event === "recovery.approval_recorded",
    );
    expect(approval?.event.invocationId).toBeNull();
  });

  test("every event carries the full correlation identity it knows", () => {
    const trail = seededTrail();
    for (const entry of inspect(trail)) {
      expect(entry.event.scope.enterpriseId).toBe(SCOPE.enterpriseId);
      expect(entry.event.scope.workspaceId).toBe(SCOPE.workspaceId);
      expect(entry.event.eventId).toBeTruthy();
      expect(entry.event.at).toBeTruthy();
    }
    const block = inspect(trail).find((entry) => entry.event.event === "block.detected");
    expect(block?.event.caseId).toBe("case_1");
    expect(block?.event.invocationId).toBe("inv_1");
    expect(block?.event.traceId).toBe("trace_1");
    const dispatch = inspect(trail).find(
      (entry) => entry.event.event === "recovery.dispatch_attempted",
    );
    expect(dispatch?.event.authorization?.authorizationId).toBe("auth_1");
    expect(dispatch?.event.destination?.modelId).toBe("claude-sonnet-5-5");
  });
});

describe("tamper evidence", () => {
  function fileTrail() {
    const dir = mkdtempSync(path.join(tmpdir(), "security-audit-"));
    const file = path.join(dir, "audit.jsonl");
    const trail = createFileSecurityAuditTrail(file, { key: KEY, now: NOW });
    trail.record(auditEventFromCaseEvent(CASE, CASE_EVENTS[0]!));
    trail.record(auditEventFromCaseEvent(CASE, CASE_EVENTS[1]!));
    return { dir, file, trail };
  }

  test("a deployment trail exposes no unscoped read port", () => {
    const { trail } = fileTrail();
    expect("entries" in trail).toBe(false);
    // No reflection port is attached to a durable trail: there is no symbol
    // key to enumerate, so `Reflect.ownKeys` cannot find one to call.
    expect(Reflect.ownKeys(trail).filter((key) => typeof key === "symbol")).toEqual([]);
    // `durability` is a readable marker, not an authority: flipping it on the
    // object does not register the trail in the private test registry.
    (trail as { durability: "durable" | "test" }).durability = "test";
    expect(() => inspect(trail)).toThrowError(/test trail/);
  });

  test("a modified record is detected", () => {
    const { file, trail } = fileTrail();
    writeFileSync(file, readFileSync(file, "utf8").replace('"recorded"', '"denied"'));
    expect(() => trail.verify()).toThrowError(/integrity verification/);
  });

  test("a deleted anchored record is detected", () => {
    const { file, trail } = fileTrail();
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, `${lines[0]}\n`);
    expect(() => trail.verify()).toThrowError(/removed from the end/);
  });

  test("tampering blocks new appends instead of extending a broken chain", () => {
    const { file, trail } = fileTrail();
    writeFileSync(file, readFileSync(file, "utf8").replace('"recorded"', '"denied"'));
    expect(() => trail.record(auditEventFromCaseEvent(CASE, CASE_EVENTS[2]!))).toThrow(
      SecurityError,
    );
  });

  test("a missing anchor refuses to trust the log", () => {
    const { file, trail } = fileTrail();
    writeFileSync(`${file}.anchor`, "");
    expect(() => trail.verify()).toThrowError(/anchor/);
  });
});

describe("restricted audit access", () => {
  test("a read appends its own audit event and returns only its scope", () => {
    const trail = seededTrail();
    const before = inspect(trail).length;
    const entries = trail.read(
      { enterpriseId: "ent_test", workspaceId: "ws_test", caseId: "case_1" },
      access(HANDLER),
    );
    expect(entries.length).toBeGreaterThan(0);
    const recorded = inspect(trail);
    expect(recorded.length).toBe(before + 1);
    const readEvent = recorded[recorded.length - 1]!.event;
    expect(readEvent.event).toBe("audit.trail_read");
    expect(readEvent.actor?.actorId).toBe("human_handler");
    expect(readEvent.detail["purpose"]).toBe("incident review");
    // A scope mismatch never leaks another workspace's events.
    expect(
      trail.read({ enterpriseId: "ent_other", workspaceId: "ws_other" }, access(ADMIN)),
    ).toEqual([]);
  });

  test("an unauthorized read is denied and the denial is itself audited", () => {
    const trail = seededTrail();
    expect(() =>
      trail.read({ enterpriseId: "ent_test", workspaceId: "ws_test" }, access(OUTSIDER)),
    ).toThrow(SecurityError);
    const denied = inspect(trail).filter((entry) => entry.event.event === "audit.access_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.event.actor?.actorId).toBe("human_owner");
    expect(denied[0]!.event.result).toBe("denied");
  });

  test("only the administrator may export, and the export is audited", () => {
    const trail = seededTrail();
    expect(() =>
      trail.export({ enterpriseId: "ent_test", workspaceId: "ws_test" }, access(HANDLER)),
    ).toThrow(SecurityError);
    const exported = trail.export(
      { enterpriseId: "ent_test", workspaceId: "ws_test" },
      access(ADMIN, "quarterly review"),
    );
    expect(exported.eventCount).toBeGreaterThan(0);
    expect(exported.entries[0]?.event.eventId).toBeTruthy();
    const last = inspect(trail).at(-1)!.event;
    expect(last.event).toBe("audit.trail_exported");
    expect(last.actor?.actorId).toBe("human_admin");
    expect(last.detail["purpose"]).toBe("quarterly review");
  });

  test("a query without a scope is refused", () => {
    const trail = seededTrail();
    expect(() => trail.read({ enterpriseId: "", workspaceId: "ws_test" }, access(ADMIN))).toThrow(
      SecurityError,
    );
  });
});

describe("non-secret by construction", () => {
  // Assembled at runtime so the repository's own scanner does not flag it.
  const SECRET = ["sk", "live", "abcdef1234567890"].join("-");

  test("credential-shaped strings are scrubbed from every field", () => {
    const trail = createMemorySecurityAuditTrail({ key: KEY, now: NOW });
    trail.record({
      event: "block.detected",
      scope: { ...SCOPE },
      caseId: "case_1",
      invocationId: "inv_1",
      traceId: "trace_1",
      actor: { actorId: "human_handler", actorKind: "human", role: null, independentOf: null },
      action: "block.detected",
      reason: `Authorization: Bearer ${SECRET}`,
      result: "denied",
      review: null,
      destination: null,
      dataClasses: [],
      protectedRefs: [],
      policyRevision: null,
      rulesRevision: null,
      detectorVersion: null,
      redactionVersion: null,
      scan: null,
      authorization: null,
      link: null,
      detail: { note: `token ${SECRET}` },
    });
    const serialized = JSON.stringify(inspect(trail));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[redacted]");
  });

  test("content correlation uses a keyed identifier, not a plain digest", () => {
    const lowEntropy = "123456";
    const identifier = protectedAuditIdentifier(KEY, "request-context", lowEntropy);
    expect(identifier.startsWith("k1.audit:request-context.")).toBe(true);
    // A plain SHA-256 of the low-entropy value would be re-identifiable; the
    // keyed identifier must not equal it.
    const plain = createHash("sha256").update(lowEntropy).digest("base64url");
    expect(identifier).not.toContain(plain);
    expect(identifier).not.toContain(lowEntropy);
    // Different keys produce different identifiers for the same value.
    expect(protectedAuditIdentifier(Buffer.alloc(32, 12), "request-context", lowEntropy)).not.toBe(
      identifier,
    );
  });

  test("an event with an unknown vocabulary word is refused", () => {
    const trail = createMemorySecurityAuditTrail({ key: KEY, now: NOW });
    expect(() =>
      trail.record({
        event: "made.up" as never,
        scope: { ...SCOPE },
        caseId: null,
        invocationId: null,
        traceId: null,
        actor: null,
        action: "made.up",
        reason: null,
        result: "recorded",
        review: null,
        destination: null,
        dataClasses: [],
        protectedRefs: [],
        policyRevision: null,
        rulesRevision: null,
        detectorVersion: null,
        redactionVersion: null,
        scan: null,
        authorization: null,
        link: null,
        detail: {},
      }),
    ).toThrow(SecurityError);
  });
});

describe("gateway attempt mapping", () => {
  test("a denied attempt is an enforced block, a pre-dispatch is distinct", () => {
    const pre: GatewayAttemptEvent = {
      phase: "pre_dispatch",
      identity: GATEWAY_DENIED.identity,
      attempt: 1,
      policyRevision: "policy_7",
      destination: {
        endpointId: "ep_1",
        provider: "anthropic",
        modelId: "claude-sonnet-5-5",
        internal: false,
      },
      scan: {
        scanner: "pattern",
        ruleVersion: "rules_3",
        classification: "clean",
        segments: 2,
        dataClasses: ["code"],
        findingCounts: { suspected: 0, confirmed: 0, unknown: 0 },
        detectors: [],
        derivedSegments: 0,
        classificationChanges: [],
      },
      timestamp: "2026-11-04T00:00:00.000Z",
    };
    expect(auditEventFromGatewayAttempt(pre).event).toBe("gateway.pre_dispatch");
    expect(auditEventFromGatewayAttempt(GATEWAY_DENIED).event).toBe("block.enforced");
    expect(auditEventFromGatewayAttempt(GATEWAY_DENIED).result).toBe("denied");
  });
});
