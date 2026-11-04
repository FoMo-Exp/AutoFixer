/**
 * Separation of duties on case disposition (DAT-211, ADR-0005 §3).
 *
 * Acceptance: self-review, same-principal review, and a missing independent
 * reviewer are all rejected; a handler never approves their own disposition;
 * task ownership alone never dispositions a case or views quarantined values.
 */
import { describe, expect, test } from "vitest";

import {
  DependentWorkPauseLedger,
  EncryptedQuarantine,
  SecurityCaseService,
  SecurityCaseStore,
  SecurityError,
  SecurityNotifier,
  staticDutyDirectory,
  type NotificationSink,
  type QuarantineKeyProvider,
  type SecurityActor,
} from "../src/security/index.js";

const IDENTITY = {
  enterpriseId: "ent_test",
  workspaceId: "ws_test",
  issueId: "issue_test",
  runId: "run_test",
  invocationId: "inv_1",
  traceId: "trace_1",
};

const OWNER: SecurityActor = { actorId: "human_owner", actorKind: "human" };
const HANDLER: SecurityActor = { actorId: "human_handler", actorKind: "human" };
const HANDLER_2: SecurityActor = { actorId: "human_handler_2", actorKind: "human" };
const REVIEWER: SecurityActor = { actorId: "human_reviewer", actorKind: "human" };
const ADMIN: SecurityActor = { actorId: "human_admin", actorKind: "human" };
const RUN: SecurityActor = { actorId: IDENTITY.runId, actorKind: "run" };

const KEY = Buffer.alloc(32, 7);
const KEY_PROVIDER: QuarantineKeyProvider = { keyId: "key_1", currentKey: () => KEY };

// Assembled at runtime: repository secret scanners would flag literals.
const SECRET_VALUE = "sk-" + "live-abcdef1234567890";

function buildService(options: { noReviewers?: boolean; stackedReviewers?: boolean } = {}) {
  const sink: NotificationSink = { send: () => undefined };
  const notifier = new SecurityNotifier({
    directory: { resolve: () => ({ workspaceHandlers: [], enterpriseAdmins: [] }) },
    sink,
    referenceSecret: KEY,
  });
  const incidents: string[] = [];
  const caseStore = new SecurityCaseStore();
  const pauses = new DependentWorkPauseLedger();
  const service = new SecurityCaseService({
    caseStore,
    pauses,
    notifier,
    quarantine: new EncryptedQuarantine({
      keyProvider: KEY_PROVIDER,
      retentionSeconds: 3600,
      onIncident: (message: string) => void incidents.push(message),
    }),
    referenceSecret: KEY,
    onIncident: (message: string) => void incidents.push(message),
    duties: staticDutyDirectory({
      taskOwners: ["human_owner"],
      handlers: ["human_handler", "human_handler_2"],
      // Stacked roles exercise the "role combinations never permit
      // self-review" rule: the duty gate passes, independence does not.
      reviewers: options.noReviewers
        ? []
        : options.stackedReviewers
          ? ["human_reviewer", "human_handler", "human_handler_2"]
          : ["human_reviewer"],
      admins: ["human_admin"],
    }),
  });
  return { service, caseStore, pauses, incidents };
}

function expectDutyCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable("expected an authorization rejection");
  } catch (error) {
    if (!(error instanceof SecurityError)) throw error;
    expect(error.code).toBe(code);
  }
}

async function openCase(service: SecurityCaseService): Promise<string> {
  const result = await service.recordBlock({
    identity: IDENTITY,
    reason: "SENSITIVE_DATA_UNCERTAIN",
    safeDetail: "blocked",
    rawContent: `{"prompt":"token ${SECRET_VALUE}"}`,
  });
  return result.case.caseId;
}

describe("case disposition separation of duties (DAT-211)", () => {
  test("the handler who submitted the case never approves their own disposition", async () => {
    // Even wearing the reviewer hat, the submitter never reviews own handling.
    const { service, pauses, caseStore } = buildService({ stackedReviewers: true });
    const caseId = await openCase(service);
    service.transition(caseId, "handling", HANDLER);
    service.transition(caseId, "awaiting_review", HANDLER);
    expectDutyCode(
      () => service.transition(caseId, "resolved", HANDLER),
      "SOD_SELF_REVIEW_FORBIDDEN",
    );
    expect(service.redactedStatus(caseId, OWNER).state).toBe("awaiting_review");
    expect(pauses.isHeld(IDENTITY.runId)).toBe(true);
    // The denied attempt is itself audited with its rejection code.
    const denied = caseStore.events(caseId).filter((event) => event.type === "case.review_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.detail["code"]).toBe("SOD_SELF_REVIEW_FORBIDDEN");
  });

  test("a co-handler deciding over the case is a same-principal review and is rejected", async () => {
    const { service } = buildService({ stackedReviewers: true });
    const caseId = await openCase(service);
    service.transition(caseId, "handling", HANDLER);
    service.transition(caseId, "awaiting_review", HANDLER_2);
    expectDutyCode(
      () => service.transition(caseId, "resolved", HANDLER),
      "SOD_SAME_PRINCIPAL_FORBIDDEN",
    );
  });

  test("a review without an independent human reviewer is rejected", async () => {
    const { service, caseStore } = buildService();
    const caseId = await openCase(service);
    service.transition(caseId, "handling", HANDLER);
    service.transition(caseId, "awaiting_review", HANDLER);
    // A service actor is never an independent human principal.
    expectDutyCode(
      () => service.transition(caseId, "resolved", { actorId: "svc_bot", actorKind: "service" }),
      "SOD_HUMAN_PRINCIPAL_REQUIRED",
    );
    // …and neither the task owner nor the administrator holds review authority.
    expectDutyCode(() => service.transition(caseId, "resolved", OWNER), "SOD_DUTY_REQUIRED");
    expectDutyCode(() => service.transition(caseId, "resolved", ADMIN), "SOD_DUTY_REQUIRED");
    // A human without the reviewer duty is rejected as well.
    expectDutyCode(
      () =>
        service.transition(caseId, "resolved", { actorId: "human_stranger", actorKind: "human" }),
      "SOD_DUTY_REQUIRED",
    );
    // Every denied review attempt left its own audit entry.
    const denied = caseStore.events(caseId).filter((event) => event.type === "case.review_denied");
    expect(denied.length).toBeGreaterThanOrEqual(3);
  });

  test("an independent reviewer resolves and the review relationship is audited", async () => {
    const { service, pauses, caseStore } = buildService();
    const caseId = await openCase(service);
    service.transition(caseId, "handling", HANDLER);
    service.transition(caseId, "awaiting_review", HANDLER);
    const resolved = service.transition(caseId, "resolved", REVIEWER);
    expect(resolved.state).toBe("resolved");
    expect(pauses.isHeld(IDENTITY.runId)).toBe(false);
    const review = caseStore.events(caseId).find((event) => event.type === "case.review_approved");
    expect(review?.actor).toMatchObject({ actorId: "human_reviewer" });
    expect(review?.detail["subjects"]).toBe("human_handler");
  });

  test("a failed independent review returns the case to handling", async () => {
    const { service, pauses, caseStore } = buildService();
    const caseId = await openCase(service);
    service.transition(caseId, "handling", HANDLER);
    service.transition(caseId, "awaiting_review", HANDLER);
    const back = service.transition(caseId, "handling", REVIEWER);
    expect(back.state).toBe("handling");
    expect(pauses.isHeld(IDENTITY.runId)).toBe(true);
    expect(caseStore.events(caseId).map((event) => event.type)).toContain("case.review_rejected");
    // Re-submission and a fresh independent decision still work.
    service.transition(caseId, "awaiting_review", HANDLER);
    expect(service.transition(caseId, "resolved", REVIEWER).state).toBe("resolved");
  });

  test("submitting with no independent reviewer available stays blocked and escalates", async () => {
    const { service, incidents, caseStore } = buildService({ noReviewers: true });
    const caseId = await openCase(service);
    service.transition(caseId, "handling", HANDLER);
    const submitted = service.transition(caseId, "awaiting_review", HANDLER);
    expect(submitted.state).toBe("awaiting_review");
    expect(incidents.some((message) => message.includes("no independent reviewer"))).toBe(true);
    expect(caseStore.events(caseId).map((event) => event.type)).toContain(
      "case.reviewer_unavailable",
    );
  });

  test("a paused run never dispositions its own case", async () => {
    const { service, pauses } = buildService();
    const caseId = await openCase(service);
    service.transition(caseId, "handling", HANDLER);
    service.transition(caseId, "awaiting_review", HANDLER);
    expectDutyCode(
      () => service.transition(caseId, "resolved", RUN),
      "SOD_HUMAN_PRINCIPAL_REQUIRED",
    );
    expect(pauses.isHeld(IDENTITY.runId)).toBe(true);
  });
});

describe("task-owner authority boundary (DAT-211)", () => {
  test("a task owner requests termination but never executes the disposition", async () => {
    const { service, caseStore } = buildService();
    const caseId = await openCase(service);
    service.requestTermination(caseId, OWNER);
    expect(service.redactedStatus(caseId, OWNER).state).toBe("pending");
    expect(caseStore.events(caseId).map((event) => event.type)).toContain(
      "case.termination_requested",
    );
    // Ownership alone never terminates; handler work does.
    expectDutyCode(() => service.transition(caseId, "terminated", OWNER), "SOD_DUTY_REQUIRED");
    expect(() => service.transition(caseId, "terminated", HANDLER)).not.toThrow();
    expect(caseStore.get(caseId)?.state).toBe("terminated");
  });

  test("a task owner requests reassignment; only handlers may handle", async () => {
    const { service, caseStore } = buildService();
    const caseId = await openCase(service);
    service.requestReassignment(caseId, OWNER);
    expect(caseStore.events(caseId).map((event) => event.type)).toContain(
      "case.reassignment_requested",
    );
    expectDutyCode(() => service.transition(caseId, "handling", OWNER), "SOD_DUTY_REQUIRED");
  });

  test("task ownership never views quarantined values", async () => {
    const { service } = buildService();
    const caseId = await openCase(service);
    const quarantineId = service.redactedStatus(caseId, OWNER).quarantineIds[0] as string;
    expectDutyCode(
      () => service.grantQuarantineAccess(quarantineId, "human_owner", ADMIN),
      "SOD_DUTY_REQUIRED",
    );
    expectDutyCode(() => service.inspectQuarantine(quarantineId, OWNER), "SOD_DUTY_REQUIRED");
  });

  test("quarantine grants are administrator work and views are handler/reviewer work", async () => {
    const { service, caseStore } = buildService();
    const caseId = await openCase(service);
    const quarantineId = service.redactedStatus(caseId, OWNER).quarantineIds[0] as string;
    // A handler cannot mint their own access…
    expectDutyCode(
      () => service.grantQuarantineAccess(quarantineId, "human_handler", HANDLER),
      "SOD_DUTY_REQUIRED",
    );
    // …the administrator grants, the handler views under the grant.
    const grant = service.grantQuarantineAccess(quarantineId, "human_handler", ADMIN);
    expect(service.inspectQuarantine(quarantineId, HANDLER, grant.grantId)).toContain(SECRET_VALUE);
    // The reviewer reviews evidence under their own grant.
    const reviewerGrant = service.grantQuarantineAccess(quarantineId, "human_reviewer", ADMIN);
    expect(service.inspectQuarantine(quarantineId, REVIEWER, reviewerGrant.grantId)).toContain(
      SECRET_VALUE,
    );
    // The administrator themselves does not view without a handler/reviewer duty.
    expectDutyCode(
      () => service.inspectQuarantine(quarantineId, ADMIN, grant.grantId),
      "SOD_DUTY_REQUIRED",
    );
    const types = caseStore.events(caseId).map((event) => event.type);
    expect(types).toContain("quarantine.access_granted");
    expect(types).toContain("quarantine.accessed");
    expect(types).toContain("quarantine.access_denied");
  });
});
