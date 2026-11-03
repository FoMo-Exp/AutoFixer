/**
 * Security case service orchestration (DAT-210, ADR-0005 §2).
 *
 * `recordBlock` is the post-block intake: it idempotently associates the
 * blocked invocation with a scoped case, pauses exactly the affected run's
 * dependent work, seals raw context in encrypted quarantine, and notifies the
 * designated handlers. It never retries or replays the quarantined request,
 * and a paused run is released only by human/service disposition.
 */
import { describe, expect, test } from "vitest";

import {
  DependentWorkPauseLedger,
  EncryptedQuarantine,
  SecurityCaseStore,
  SecurityCaseService,
  SecurityError,
  SecurityNotifier,
  type NotificationSink,
  type QuarantineKeyProvider,
  type SecurityActor,
  type SecurityNotification,
  type SecurityRecipient,
} from "../src/security/index.js";

const IDENTITY = {
  enterpriseId: "ent_test",
  workspaceId: "ws_test",
  issueId: "issue_test",
  runId: "run_test",
  invocationId: "inv_1",
  traceId: "trace_1",
};

const HANDLER: SecurityActor = { actorId: "human_handler", actorKind: "human" };
const REVIEWER: SecurityActor = { actorId: "human_reviewer", actorKind: "human" };

const KEY = Buffer.alloc(32, 5);
const KEY_PROVIDER: QuarantineKeyProvider = { keyId: "key_1", currentKey: () => KEY };

// Assembled at runtime: repository secret scanners would flag literals.
const SECRET_VALUE = "sk-" + "live-abcdef1234567890";

const HANDLER_RECIPIENT: SecurityRecipient = {
  recipientId: "handler_1",
  role: "workspace_security_handler",
};

function buildService(options: { rawContent?: string; noKey?: boolean } = {}) {
  const sent: SecurityNotification[] = [];
  const sink: NotificationSink = {
    send(notification: SecurityNotification) {
      sent.push(notification);
    },
  };
  const notifier = new SecurityNotifier({
    directory: {
      resolve: () => ({ workspaceHandlers: [HANDLER_RECIPIENT], enterpriseAdmins: [] }),
    },
    sink,
    referenceSecret: KEY,
  });
  const incidents: string[] = [];
  const quarantine = new EncryptedQuarantine({
    keyProvider: options.noKey ? { keyId: "key_1", currentKey: () => undefined } : KEY_PROVIDER,
    retentionSeconds: 3600,
    onIncident: (message: string) => void incidents.push(message),
  });
  const pauses = new DependentWorkPauseLedger();
  const caseStore = new SecurityCaseStore();
  const service = new SecurityCaseService({
    caseStore,
    pauses,
    notifier,
    quarantine,
    referenceSecret: KEY,
    onIncident: (message: string) => void incidents.push(message),
  });
  return { service, sent, caseStore, pauses, quarantine, incidents };
}

describe("SecurityCaseService.recordBlock", () => {
  test("a block opens a case, pauses the run, quarantines context, and notifies", async () => {
    const { service, sent, pauses } = buildService();
    const result = await service.recordBlock({
      identity: IDENTITY,
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: "suspected secret in request",
      rawContent: `{"prompt":"token ${SECRET_VALUE}"}`,
    });
    expect(result.created).toBe(true);
    expect(result.case.state).toBe("pending");
    expect(result.case.quarantineIds).toHaveLength(1);
    expect(pauses.isHeld(IDENTITY.runId)).toBe(true);
    expect(pauses.isHeld("run_other")).toBe(false);
    expect(sent).toHaveLength(1);
    expect(result.notifications.undeliverable).toBe(false);
    // The run gets an authenticated, non-transferable reference.
    expect(result.runCaseReference).toContain("cr1.");
  });

  test("duplicate blocking stays one case, one notification, one pause", async () => {
    const { service, sent } = buildService();
    const first = await service.recordBlock({
      identity: IDENTITY,
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: "blocked",
      rawContent: "ctx",
    });
    const second = await service.recordBlock({
      identity: { ...IDENTITY, invocationId: "inv_1", traceId: "trace_1" },
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: "blocked again",
    });
    expect(second.created).toBe(false);
    expect(second.case.caseId).toBe(first.case.caseId);
    expect(sent).toHaveLength(1);
    expect(second.pause.pauseId).toBe(first.pause.pauseId);
    // A new blocked invocation of the same run also joins without re-notifying.
    const third = await service.recordBlock({
      identity: { ...IDENTITY, invocationId: "inv_2", traceId: "trace_2" },
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: "blocked",
    });
    expect(third.created).toBe(false);
    expect(third.case.caseId).toBe(first.case.caseId);
    expect(third.case.blocks).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  test("notifications and case history never carry the raw quarantined content", async () => {
    const { service, sent, caseStore } = buildService();
    const result = await service.recordBlock({
      identity: IDENTITY,
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: `value ${SECRET_VALUE} suspected`,
      rawContent: `{"prompt":"token ${SECRET_VALUE}"}`,
    });
    expect(JSON.stringify(sent)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(caseStore.events(result.case.caseId))).not.toContain(SECRET_VALUE);
  });

  test("an unavailable quarantine key fails closed but the case and pause stand", async () => {
    const { service, pauses, incidents } = buildService({ noKey: true });
    const result = await service.recordBlock({
      identity: IDENTITY,
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: "blocked",
      rawContent: "ctx",
    });
    expect(result.case.state).toBe("pending");
    expect(result.case.quarantineIds).toHaveLength(0);
    expect(pauses.isHeld(IDENTITY.runId)).toBe(true);
    expect(incidents.length).toBeGreaterThan(0);
  });
});

describe("SecurityCaseService disposition", () => {
  test("resolving the case releases the run's dependent work", async () => {
    const { service, pauses, caseStore } = buildService();
    const { case: opened } = await service.recordBlock({
      identity: IDENTITY,
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: "blocked",
    });
    service.transition(opened.caseId, "handling", HANDLER);
    service.transition(opened.caseId, "awaiting_review", HANDLER);
    service.transition(opened.caseId, "resolved", REVIEWER);
    expect(pauses.isHeld(IDENTITY.runId)).toBe(false);
    expect(caseStore.get(opened.caseId)?.state).toBe("resolved");
  });

  test("termination also releases the hold", async () => {
    const { service, pauses } = buildService();
    const { case: opened } = await service.recordBlock({
      identity: IDENTITY,
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: "blocked",
    });
    service.transition(opened.caseId, "terminated", HANDLER);
    expect(pauses.isHeld(IDENTITY.runId)).toBe(false);
  });

  test("the paused run never dispositions its own case to resume", async () => {
    const { service, pauses } = buildService();
    const { case: opened } = await service.recordBlock({
      identity: IDENTITY,
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: "blocked",
    });
    const runActor: SecurityActor = { actorId: IDENTITY.runId, actorKind: "run" };
    expect(() => service.transition(opened.caseId, "terminated", runActor)).toThrow(SecurityError);
    expect(pauses.isHeld(IDENTITY.runId)).toBe(true);
    expect(service.isRunHeld(IDENTITY.runId)).toBe(true);
    expect(service.isRunHeld("run_other")).toBe(false);
  });
});

describe("SecurityCaseService quarantine inspection", () => {
  test("inspection needs a separate grant and audits onto the case", async () => {
    const { service, caseStore } = buildService();
    const result = await service.recordBlock({
      identity: IDENTITY,
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: "blocked",
      rawContent: `{"prompt":"token ${SECRET_VALUE}"}`,
    });
    const quarantineId = result.case.quarantineIds[0] as string;
    expect(() => service.inspectQuarantine(quarantineId, HANDLER)).toThrow(SecurityError);
    const grant = service.grantQuarantineAccess(quarantineId, "human_handler", HANDLER);
    const content = service.inspectQuarantine(quarantineId, HANDLER, grant);
    expect(content).toContain(SECRET_VALUE);
    const types = caseStore.events(result.case.caseId).map((event) => event.type);
    expect(types).toContain("quarantine.access_granted");
    expect(types).toContain("quarantine.accessed");
    expect(types).toContain("quarantine.access_denied");
  });
});

describe("SecurityCaseService gateway seam", () => {
  test("recordGatewayBlock maps gateway identity onto one disposal case", async () => {
    const { service, sent } = buildService();
    const first = await service.recordGatewayBlock({
      identity: IDENTITY,
      reason: "CLASSIFICATION_UNKNOWN",
      safeDetail: "unknown classification",
    });
    expect(first.caseId).toBeTruthy();
    expect(first.caseReference).toContain("cr1.");
    const second = await service.recordGatewayBlock({
      identity: IDENTITY,
      reason: "CLASSIFICATION_UNKNOWN",
      safeDetail: "unknown classification",
    });
    expect(second.caseId).toBe(first.caseId);
    expect(sent).toHaveLength(1);
  });

  test("the sealed raw context is readable only through quarantine grants", async () => {
    const { service, quarantine } = buildService();
    const result = await service.recordBlock({
      identity: IDENTITY,
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: "blocked",
      rawContent: `{"prompt":"token ${SECRET_VALUE}"}`,
    });
    const quarantineId = result.case.quarantineIds[0] as string;
    const meta = quarantine.get(quarantineId);
    expect(JSON.stringify(meta)).not.toContain(SECRET_VALUE);
    expect(service.isRunHeld(IDENTITY.runId)).toBe(true);
  });
});
