/**
 * Security duty matrix and separation-of-duties primitives (DAT-211,
 * ADR-0005 §3).
 *
 * These expectations are written out against the ADR's responsibility table
 * directly — not derived from the implementation's matrix — so a matrix edit
 * that quietly widens authority fails here.
 */
import { describe, expect, test } from "vitest";

import {
  SECURITY_DUTY_MATRIX,
  assertIndependentReview,
  assertSeparateAdministrator,
  requireDuty,
  staticDutyDirectory,
  type SecurityAction,
  type SecurityActor,
  type SecurityDuty,
  type SecurityDutyDirectory,
  type SecurityDutyScope,
} from "../src/security/index.js";
import { SecurityError } from "../src/security/index.js";

const SCOPE: SecurityDutyScope = { enterpriseId: "ent_test", workspaceId: "ws_test" };

const OWNER: SecurityActor = { actorId: "human_owner", actorKind: "human" };
const HANDLER: SecurityActor = { actorId: "human_handler", actorKind: "human" };
const REVIEWER: SecurityActor = { actorId: "human_reviewer", actorKind: "human" };
const ADMIN: SecurityActor = { actorId: "human_admin", actorKind: "human" };
const AGENT: SecurityActor = { actorId: "run_1", actorKind: "run" };
const SERVICE: SecurityActor = { actorId: "svc_1", actorKind: "service" };

const DIRECTORY: SecurityDutyDirectory = staticDutyDirectory({
  taskOwners: ["human_owner"],
  handlers: ["human_handler"],
  reviewers: ["human_reviewer"],
  admins: ["human_admin"],
});

function expectDutyCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable("expected an authorization rejection");
  } catch (error) {
    if (!(error instanceof SecurityError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** The ADR-0005 §3 permission table, spelled out independently. */
const EXPECTED: Record<SecurityAction, Record<SecurityDuty, boolean>> = {
  "case.read_redacted_status": {
    task_owner: true,
    security_handler: true,
    independent_reviewer: true,
    enterprise_security_admin: true,
  },
  "case.request_termination": {
    task_owner: true,
    security_handler: false,
    independent_reviewer: false,
    enterprise_security_admin: false,
  },
  "case.request_reassignment": {
    task_owner: true,
    security_handler: false,
    independent_reviewer: false,
    enterprise_security_admin: false,
  },
  "case.handle": {
    task_owner: false,
    security_handler: true,
    independent_reviewer: false,
    enterprise_security_admin: false,
  },
  "case.submit_for_review": {
    task_owner: false,
    security_handler: true,
    independent_reviewer: false,
    enterprise_security_admin: false,
  },
  "case.review_decide": {
    task_owner: false,
    security_handler: false,
    independent_reviewer: true,
    enterprise_security_admin: false,
  },
  "case.terminate": {
    task_owner: false,
    security_handler: true,
    independent_reviewer: false,
    enterprise_security_admin: true,
  },
  "quarantine.grant_access": {
    task_owner: false,
    security_handler: false,
    independent_reviewer: false,
    enterprise_security_admin: true,
  },
  "quarantine.view": {
    task_owner: false,
    security_handler: true,
    independent_reviewer: true,
    enterprise_security_admin: false,
  },
  "rule.propose": {
    task_owner: false,
    security_handler: true,
    independent_reviewer: false,
    enterprise_security_admin: false,
  },
  "rule.review": {
    task_owner: false,
    security_handler: false,
    independent_reviewer: true,
    enterprise_security_admin: false,
  },
  "rule.activate": {
    task_owner: false,
    security_handler: false,
    independent_reviewer: false,
    enterprise_security_admin: true,
  },
  "rule.rollback": {
    task_owner: false,
    security_handler: false,
    independent_reviewer: false,
    enterprise_security_admin: true,
  },
  "role.grant": {
    task_owner: false,
    security_handler: false,
    independent_reviewer: false,
    enterprise_security_admin: true,
  },
  "endpoint.configure": {
    task_owner: false,
    security_handler: false,
    independent_reviewer: false,
    enterprise_security_admin: true,
  },
};

const PRINCIPALS: Record<SecurityDuty, SecurityActor> = {
  task_owner: OWNER,
  security_handler: HANDLER,
  independent_reviewer: REVIEWER,
  enterprise_security_admin: ADMIN,
};

describe("permission matrix (DAT-211, ADR-0005 §3)", () => {
  test("every action allows exactly the duties the responsibility table names", () => {
    for (const [action, duties] of Object.entries(EXPECTED) as [
      SecurityAction,
      Record<SecurityDuty, boolean>,
    ][]) {
      expect(SECURITY_DUTY_MATRIX[action]).toBeDefined();
      for (const [duty, allowed] of Object.entries(duties) as [SecurityDuty, boolean][]) {
        const actor = PRINCIPALS[duty];
        if (allowed) {
          expect(
            () => requireDuty(action, actor, DIRECTORY, SCOPE),
            `${duty} ${action}`,
          ).not.toThrow();
          expect(SECURITY_DUTY_MATRIX[action], `${duty} ${action}`).toContain(duty);
        } else {
          expectDutyCode(() => requireDuty(action, actor, DIRECTORY, SCOPE), "SOD_DUTY_REQUIRED");
          expect(SECURITY_DUTY_MATRIX[action], `${duty} ${action}`).not.toContain(duty);
        }
      }
    }
  });

  test("an agent, a service, and an unknown principal hold no duty at all", () => {
    for (const action of Object.keys(EXPECTED) as SecurityAction[]) {
      expectDutyCode(
        () => requireDuty(action, AGENT, DIRECTORY, SCOPE),
        "SOD_HUMAN_PRINCIPAL_REQUIRED",
      );
      expectDutyCode(
        () => requireDuty(action, SERVICE, DIRECTORY, SCOPE),
        "SOD_HUMAN_PRINCIPAL_REQUIRED",
      );
      expectDutyCode(
        () => requireDuty(action, { actorId: "stranger", actorKind: "human" }, DIRECTORY, SCOPE),
        "SOD_DUTY_REQUIRED",
      );
    }
  });

  test("administrative status never grants review authority", () => {
    expectDutyCode(
      () => requireDuty("case.review_decide", ADMIN, DIRECTORY, SCOPE),
      "SOD_DUTY_REQUIRED",
    );
    expectDutyCode(() => requireDuty("rule.review", ADMIN, DIRECTORY, SCOPE), "SOD_DUTY_REQUIRED");
    // …and task ownership never grants handling or viewing authority.
    expectDutyCode(() => requireDuty("case.handle", OWNER, DIRECTORY, SCOPE), "SOD_DUTY_REQUIRED");
    expectDutyCode(
      () => requireDuty("quarantine.view", OWNER, DIRECTORY, SCOPE),
      "SOD_DUTY_REQUIRED",
    );
  });
});

describe("independent review gate (DAT-211)", () => {
  const independence = (overrides: Partial<Parameters<typeof assertIndependentReview>[1]>) => ({
    authorId: "human_handler",
    subjectIds: ["human_handler"],
    reviewer: REVIEWER,
    action: "rule.review" as const,
    scope: SCOPE,
    ...overrides,
  });

  test("a missing reviewer is rejected, never waived", () => {
    expectDutyCode(
      () =>
        assertIndependentReview(
          DIRECTORY,
          independence({ reviewer: { actorId: "", actorKind: "human" } }),
        ),
      "SOD_INDEPENDENT_REVIEWER_REQUIRED",
    );
    expectDutyCode(
      () => assertIndependentReview(DIRECTORY, independence({ subjectIds: [] })),
      "SOD_INDEPENDENT_REVIEWER_REQUIRED",
    );
  });

  test("a non-human reviewer is never an independent human principal", () => {
    expectDutyCode(
      () => assertIndependentReview(DIRECTORY, independence({ reviewer: SERVICE })),
      "SOD_HUMAN_PRINCIPAL_REQUIRED",
    );
    expectDutyCode(
      () => assertIndependentReview(DIRECTORY, independence({ reviewer: AGENT })),
      "SOD_HUMAN_PRINCIPAL_REQUIRED",
    );
  });

  test("self-review is rejected even when the author also holds the reviewer duty", () => {
    const multiRole = staticDutyDirectory({
      handlers: ["human_handler"],
      reviewers: ["human_handler"],
    });
    const authorReviewsOwn = independence({
      reviewer: { actorId: "human_handler", actorKind: "human" },
    });
    expectDutyCode(
      () => assertIndependentReview(DIRECTORY, authorReviewsOwn),
      "SOD_SELF_REVIEW_FORBIDDEN",
    );
    // Role combinations never permit self-review on the same change.
    expectDutyCode(
      () => assertIndependentReview(multiRole, authorReviewsOwn),
      "SOD_SELF_REVIEW_FORBIDDEN",
    );
  });

  test("a same-principal review is rejected for co-handlers of the change", () => {
    expectDutyCode(
      () =>
        assertIndependentReview(
          DIRECTORY,
          independence({
            authorId: "human_handler",
            subjectIds: ["human_handler", "human_handler_2"],
            reviewer: { actorId: "human_handler_2", actorKind: "human" },
          }),
        ),
      "SOD_SAME_PRINCIPAL_FORBIDDEN",
    );
  });

  test("a reviewer without the reviewer duty is rejected", () => {
    expectDutyCode(
      () =>
        assertIndependentReview(
          DIRECTORY,
          independence({ reviewer: { actorId: "human_owner", actorKind: "human" } }),
        ),
      "SOD_DUTY_REQUIRED",
    );
  });

  test("a distinct human reviewer with the reviewer duty passes", () => {
    expect(() => assertIndependentReview(DIRECTORY, independence({}))).not.toThrow();
  });
});

describe("administrator separation (DAT-211)", () => {
  test("the activating administrator is a principal separate from author and reviewer", () => {
    const base = {
      subjectIds: ["human_handler", "human_reviewer"],
      action: "rule.activate" as const,
      scope: SCOPE,
    };
    expect(() =>
      assertSeparateAdministrator(DIRECTORY, { ...base, administrator: ADMIN }),
    ).not.toThrow();
    // Even wearing the administrator hat, the author or reviewer of the
    // change is never its activator.
    const stacked = staticDutyDirectory({
      handlers: ["human_handler"],
      reviewers: ["human_reviewer"],
      admins: ["human_handler", "human_reviewer"],
    });
    expectDutyCode(
      () =>
        assertSeparateAdministrator(stacked, {
          ...base,
          administrator: { actorId: "human_handler", actorKind: "human" },
        }),
      "SOD_SAME_PRINCIPAL_FORBIDDEN",
    );
    expectDutyCode(
      () =>
        assertSeparateAdministrator(stacked, {
          ...base,
          administrator: { actorId: "human_reviewer", actorKind: "human" },
        }),
      "SOD_SAME_PRINCIPAL_FORBIDDEN",
    );
    expectDutyCode(
      () =>
        assertSeparateAdministrator(DIRECTORY, {
          ...base,
          administrator: { actorId: "human_owner", actorKind: "human" },
        }),
      "SOD_DUTY_REQUIRED",
    );
    expectDutyCode(
      () => assertSeparateAdministrator(DIRECTORY, { ...base, administrator: AGENT }),
      "SOD_HUMAN_PRINCIPAL_REQUIRED",
    );
  });
});
