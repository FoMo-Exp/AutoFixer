/**
 * Versioned rule corrections: disguised-exemption rejection and the
 * separated propose → review → activate → rollback lifecycle (DAT-211,
 * ADR-0005 §4).
 *
 * Acceptance: targeted exemption rules are identified and rejected, blanket
 * allows are rejected, activation without regression evidence is rejected,
 * and a rollback never restores a superseded approval. Every proposal,
 * review, activation, and rollback is audited.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  RuleCorrectionService,
  SecurityError,
  findDisguisedExemptions,
  staticDutyDirectory,
  validateRuleCorrection,
  type SecurityActor,
  type SecurityDutyDirectory,
} from "../src/security/index.js";

const SCOPE = { enterpriseId: "ent_test", workspaceId: "ws_test" };
const HANDLER: SecurityActor = { actorId: "human_handler", actorKind: "human" };
const REVIEWER: SecurityActor = { actorId: "human_reviewer", actorKind: "human" };
const ADMIN: SecurityActor = { actorId: "human_admin", actorKind: "human" };
const OWNER_ACTOR: SecurityActor = { actorId: "human_owner", actorKind: "human" };

const NOW = new Date("2026-11-03T00:00:00.000Z");
const IN_30_DAYS = "2026-12-03T00:00:00.000Z";
const IN_7_DAYS = "2026-11-10T00:00:00.000Z";
const YESTERDAY = "2026-11-02T00:00:00.000Z";

function buildService(options: { directory?: SecurityDutyDirectory } = {}) {
  const directory =
    options.directory ??
    staticDutyDirectory({
      handlers: ["human_handler"],
      reviewers: ["human_reviewer"],
      admins: ["human_admin"],
    });
  const service = new RuleCorrectionService({ directory, now: () => NOW });
  return { service, directory };
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    detectorId: "high-entropy-token",
    scope: SCOPE,
    constraints: { minShannonEntropy: 5.5 },
    reason: "fixture generator material is high-entropy but never a secret",
    expiresAt: IN_30_DAYS,
    reviewAt: IN_7_DAYS,
    regressionEvidence: [
      {
        testRef: "corpus/provider-keys",
        description: "provider-shaped keys still detected",
        detectorId: "high-entropy-token",
        result: "pass",
        at: YESTERDAY,
      },
    ],
    ...overrides,
  };
}

function expectRuleCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable("expected a rule-governance rejection");
  } catch (error) {
    if (!(error instanceof SecurityError)) throw error;
    expect(error.code).toBe(code);
  }
}

const LINEAGE = "high-entropy-token|ent_test|ws_test";

describe("disguised exemption identification (DAT-211)", () => {
  test("rules targeting an invocation, case, request digest, or secret value are identified and rejected", () => {
    const targeted: Record<string, unknown>[] = [
      proposal({ invocationId: "inv_1" }),
      proposal({ caseId: "case_1" }),
      proposal({ requestDigest: "a1b2c3d4e5f6a7b8c9d0" }),
      proposal({ secretValue: "sk-live-abcdef1234567890" }),
      proposal({ constraints: { minShannonEntropy: 5.5, case_id: "case_1" } }),
      proposal({
        regressionEvidence: [
          {
            testRef: "t",
            description: "d",
            detectorId: "high-entropy-token",
            result: "pass",
            at: YESTERDAY,
            matchedSecret: "value",
          },
        ],
      }),
    ];
    for (const raw of targeted) {
      expectRuleCode(() => validateRuleCorrection(raw, NOW), "RULE_TARGETED_EXEMPTION");
    }
    // The offending selector is named in the rejection.
    try {
      validateRuleCorrection(proposal({ caseId: "case_1" }), NOW);
      expect.unreachable("expected rejection");
    } catch (error) {
      if (!(error instanceof SecurityError)) throw error;
      expect(JSON.stringify(error.details)).toContain("caseId");
    }
  });

  test("digest- or value-shaped markers are identified as value selectors", () => {
    expectRuleCode(
      () =>
        validateRuleCorrection(
          proposal({ constraints: { requiredPrefix: "a1b2c3d4e5f6a7b8c9d0e1f2" } }),
          NOW,
        ),
      "RULE_TARGETED_EXEMPTION",
    );
    expectRuleCode(
      () =>
        validateRuleCorrection(
          proposal({ constraints: { requiredSuffix: "deadbeefdeadbeef1" } }),
          NOW,
        ),
      "RULE_TARGETED_EXEMPTION",
    );
  });

  test("blanket allows and whole-detector disables are rejected as disguised exemptions", () => {
    const blanket: Record<string, unknown>[] = [
      proposal({ constraints: { minShannonEntropy: 5.5, enabled: false } }),
      proposal({ constraints: { action: "allow" } }),
      proposal({ mode: "allow" }),
      proposal({ classification: "clean" }),
      proposal({ ignore: true }),
    ];
    for (const raw of blanket) {
      expectRuleCode(() => validateRuleCorrection(raw, NOW), "RULE_BLANKET_EXEMPTION");
    }
  });

  test("the exemption scan names every offending path at any depth", () => {
    const offenders = findDisguisedExemptions(
      proposal({ constraints: { minShannonEntropy: 5.5, secretValue: "x" }, request: {} }),
    );
    expect(offenders.some((path) => path.endsWith("secretValue"))).toBe(true);
    expect(offenders.some((path) => path.endsWith("request"))).toBe(true);
    expect(offenders).toContain("proposal.constraints.secretValue");
  });

  test("a proposal needs reason, bounded applicability, expiry, and regression evidence", () => {
    expectRuleCode(
      () => validateRuleCorrection(proposal({ reason: "  " }), NOW),
      "RULE_PROPOSAL_INVALID",
    );
    expectRuleCode(
      () => validateRuleCorrection(proposal({ constraints: {} }), NOW),
      "RULE_PROPOSAL_INVALID",
    );
    expectRuleCode(
      () => validateRuleCorrection(proposal({ expiresAt: undefined }), NOW),
      "RULE_PROPOSAL_INVALID",
    );
    expectRuleCode(
      () => validateRuleCorrection(proposal({ expiresAt: YESTERDAY }), NOW),
      "RULE_PROPOSAL_INVALID",
    );
    expectRuleCode(
      () => validateRuleCorrection(proposal({ regressionEvidence: [] }), NOW),
      "RULE_PROPOSAL_INVALID",
    );
    expectRuleCode(
      () => validateRuleCorrection(proposal({ reviewAt: IN_30_DAYS, expiresAt: IN_7_DAYS }), NOW),
      "RULE_PROPOSAL_INVALID",
    );
    // Evidence must cover the corrected detector and must pass.
    expectRuleCode(
      () =>
        validateRuleCorrection(
          proposal({
            regressionEvidence: [
              {
                testRef: "corpus/other",
                description: "other detector",
                detectorId: "aws-access-key-id",
                result: "pass",
                at: YESTERDAY,
              },
            ],
          }),
          NOW,
        ),
      "RULE_PROPOSAL_INVALID",
    );
    expectRuleCode(
      () =>
        validateRuleCorrection(
          proposal({
            regressionEvidence: [
              {
                testRef: "corpus/provider-keys",
                description: "missed a true secret",
                detectorId: "high-entropy-token",
                result: "fail",
                at: YESTERDAY,
              },
            ],
          }),
          NOW,
        ),
      "RULE_EVIDENCE_FAILED",
    );
  });
});

describe("versioned correction lifecycle (DAT-211)", () => {
  test("propose → independent review → administrator activation, fully audited", () => {
    const { service } = buildService();
    const proposed = service.propose(HANDLER, proposal());
    expect(proposed.version).toBe(1);
    expect(proposed.status).toBe("proposed");
    const approved = service.review(LINEAGE, 1, REVIEWER, true, "bounded and evidenced");
    expect(approved.status).toBe("approved");
    const activated = service.activate(LINEAGE, 1, ADMIN);
    expect(activated.status).toBe("activated");
    expect(service.activeCorrections()).toMatchObject([
      { detectorId: "high-entropy-token", version: 1, constraints: { minShannonEntropy: 5.5 } },
    ]);
    const types = service.history(LINEAGE).map((event) => event.type);
    expect(types).toEqual(["rule.proposed", "rule.review_approved", "rule.activated"]);
    const activatedEvent = service.history(LINEAGE)[2];
    expect(activatedEvent?.actor).toMatchObject({
      principalId: "human_admin",
      duty: "enterprise_security_admin",
    });
  });

  test("a rejected proposal is identified, rejected, and audited", () => {
    const { service } = buildService();
    expectRuleCode(
      () => service.propose(HANDLER, proposal({ caseId: "case_1" })),
      "RULE_TARGETED_EXEMPTION",
    );
    const event = service.history(LINEAGE).find((entry) => entry.type === "rule.proposal_rejected");
    expect(event?.detail["code"]).toBe("RULE_TARGETED_EXEMPTION");
    expect(event?.detail["paths"]).toContain("caseId");
  });

  test("self-review and same-principal review of a rule change are rejected", () => {
    const multiRole = staticDutyDirectory({
      handlers: ["human_handler"],
      reviewers: ["human_handler", "human_reviewer"],
      admins: ["human_admin"],
    });
    const { service } = buildService({ directory: multiRole });
    service.propose(HANDLER, proposal());
    // The author wearing a second role hat still reviews their own change.
    expectRuleCode(
      () => service.review(LINEAGE, 1, HANDLER, true, ""),
      "SOD_SELF_REVIEW_FORBIDDEN",
    );
    expectRuleCode(
      () => service.review(LINEAGE, 1, { actorId: "svc_bot", actorKind: "service" }, true, ""),
      "SOD_HUMAN_PRINCIPAL_REQUIRED",
    );
    expectRuleCode(
      () => service.review(LINEAGE, 1, { actorId: "human_owner", actorKind: "human" }, true, ""),
      "SOD_DUTY_REQUIRED",
    );
    expect(service.revision(LINEAGE, 1)?.status).toBe("proposed");
    // Every denied review attempt left its own audit entry.
    const denied = service.history(LINEAGE).filter((event) => event.type === "rule.review_denied");
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied[0]?.detail["code"]).toBe("SOD_SELF_REVIEW_FORBIDDEN");
  });

  test("activation without a live independent approval is rejected", () => {
    const { service } = buildService();
    service.propose(HANDLER, proposal());
    expectRuleCode(() => service.activate(LINEAGE, 1, ADMIN), "RULE_REVISION_NOT_REVIEWABLE");
    service.review(LINEAGE, 1, REVIEWER, false, "not a false positive");
    expectRuleCode(() => service.activate(LINEAGE, 1, ADMIN), "RULE_REVISION_NOT_REVIEWABLE");
    // Denials are part of the audit trail.
    expect(service.history(LINEAGE).map((event) => event.type)).toContain("rule.activation_denied");
  });

  test("handling, review, and policy administration are three separated principals", () => {
    const { service } = buildService();
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "fine");
    // The author is never the activator, even as an administrator…
    expectRuleCode(
      () => service.activate(LINEAGE, 1, { actorId: "human_handler", actorKind: "human" }),
      "SOD_DUTY_REQUIRED",
    );
    const adminByAuthor = staticDutyDirectory({
      handlers: ["human_handler"],
      reviewers: ["human_reviewer"],
      admins: ["human_handler"],
    });
    const { service: stacked } = buildService({ directory: adminByAuthor });
    stacked.propose(HANDLER, proposal());
    stacked.review(LINEAGE, 1, REVIEWER, true, "fine");
    expectRuleCode(() => stacked.activate(LINEAGE, 1, HANDLER), "SOD_SAME_PRINCIPAL_FORBIDDEN");
    // …and neither is the reviewer.
    const adminByReviewer = staticDutyDirectory({
      handlers: ["human_handler"],
      reviewers: ["human_reviewer"],
      admins: ["human_reviewer"],
    });
    const { service: reviewed } = buildService({ directory: adminByReviewer });
    reviewed.propose(HANDLER, proposal());
    reviewed.review(LINEAGE, 1, REVIEWER, true, "fine");
    expectRuleCode(() => reviewed.activate(LINEAGE, 1, REVIEWER), "SOD_SAME_PRINCIPAL_FORBIDDEN");
    // The handler cannot propose as somebody else either.
    expectRuleCode(() => reviewed.propose(OWNER_ACTOR, proposal()), "SOD_DUTY_REQUIRED");
  });

  test("activation without regression evidence cannot happen, even on tampered state", () => {
    // The evidence gate at activation time is the second line of defense
    // behind the proposal gate: a persisted revision without evidence never
    // activates.
    const directory = staticDutyDirectory({
      handlers: ["human_handler"],
      reviewers: ["human_reviewer"],
      admins: ["human_admin"],
    });
    const stateFile = path.join(
      mkdtempSync(path.join(tmpdir(), "rule-corrections-")),
      "state.json",
    );
    const service = new RuleCorrectionService({
      directory,
      now: () => NOW,
      persistencePath: stateFile,
    });
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "fine");
    // Simulate tampering: reopen over state whose revision carries no
    // evidence at all.
    const revision = service.revision(LINEAGE, 1);
    writeFileSync(
      stateFile,
      JSON.stringify({
        schema_version: 1,
        revisions: [{ ...revision, regressionEvidence: [] }],
        events: service.history(LINEAGE),
      }),
    );
    const reopened = new RuleCorrectionService({
      directory,
      now: () => NOW,
      persistencePath: stateFile,
    });
    expectRuleCode(() => reopened.activate(LINEAGE, 1, ADMIN), "RULE_EVIDENCE_MISSING");
  });

  test("a newer approval supersedes the older one; superseded approvals never come back", () => {
    const { service } = buildService();
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "v1 fine");
    const second = service.propose(HANDLER, proposal({ constraints: { minShannonEntropy: 6 } }));
    expect(second.version).toBe(2);
    service.review(LINEAGE, 2, REVIEWER, true, "v2 fine");
    // The earlier approval is superseded by the newer review line.
    expect(service.revision(LINEAGE, 1)?.status).toBe("superseded");
    expectRuleCode(() => service.activate(LINEAGE, 1, ADMIN), "RULE_APPROVAL_SUPERSEDED");
    const activated = service.activate(LINEAGE, 2, ADMIN);
    expect(activated.status).toBe("activated");
  });

  test("activation supersedes the previous activation and rollback restores nothing", () => {
    const { service } = buildService();
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "v1");
    service.activate(LINEAGE, 1, ADMIN);
    service.propose(HANDLER, proposal({ constraints: { minShannonEntropy: 6 } }));
    service.review(LINEAGE, 2, REVIEWER, true, "v2");
    service.activate(LINEAGE, 2, ADMIN);
    expect(service.revision(LINEAGE, 1)?.status).toBe("superseded");
    // Versioned rollback: it deactivates and records its own lineage entry.
    const entry = service.rollback(LINEAGE, ADMIN);
    expect(entry.kind).toBe("rollback");
    expect(entry.version).toBe(3);
    expect(entry.rollsBackVersion).toBe(2);
    expect(service.revision(LINEAGE, 2)?.status).toBe("rolled_back");
    expect(service.activeCorrections()).toEqual([]);
    // The rollback restored no approval: the superseded v1 approval is gone
    // for good, and the rolled-back v2 cannot be re-activated either.
    expectRuleCode(() => service.activate(LINEAGE, 1, ADMIN), "RULE_APPROVAL_SUPERSEDED");
    expectRuleCode(() => service.activate(LINEAGE, 2, ADMIN), "RULE_APPROVAL_SUPERSEDED");
    expectRuleCode(() => service.rollback(LINEAGE, ADMIN), "RULE_NOTHING_TO_ROLL_BACK");
    // Re-establishing the correction needs a fresh proposal and review.
    service.propose(HANDLER, proposal({ constraints: { minShannonEntropy: 6 } }));
    service.review(LINEAGE, 4, REVIEWER, true, "fresh");
    expect(service.activate(LINEAGE, 4, ADMIN).status).toBe("activated");
    const types = service.history(LINEAGE).map((event) => event.type);
    // Exactly one supersession happened: activating v2 superseded v1 for
    // good; nothing else was ever restored.
    expect(types.filter((type) => type === "rule.superseded").length).toBe(1);
    expect(types).toContain("rule.rolled_back");
    expect(types).toContain("rule.rollback_denied");
  });

  test("a rollback is administrator work, separated from author and reviewer", () => {
    const { service } = buildService();
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "fine");
    service.activate(LINEAGE, 1, ADMIN);
    expectRuleCode(() => service.rollback(LINEAGE, HANDLER), "SOD_DUTY_REQUIRED");
    expectRuleCode(() => service.rollback(LINEAGE, REVIEWER), "SOD_DUTY_REQUIRED");
    expect(service.revision(LINEAGE, 1)?.status).toBe("activated");
  });

  test("a correction is bounded in time; expiry returns the detector to stock and is audited", () => {
    let clock = NOW.getTime();
    const directory = staticDutyDirectory({
      handlers: ["human_handler"],
      reviewers: ["human_reviewer"],
      admins: ["human_admin"],
    });
    const service = new RuleCorrectionService({ directory, now: () => new Date(clock) });
    service.propose(HANDLER, proposal({ expiresAt: IN_7_DAYS, reviewAt: undefined }));
    service.review(LINEAGE, 1, REVIEWER, true, "fine");
    service.activate(LINEAGE, 1, ADMIN);
    expect(service.activeCorrections()).toHaveLength(1);
    clock = Date.parse(IN_7_DAYS) + 1000;
    expect(service.activeCorrections()).toEqual([]);
    const expired = service.expireOverdue();
    expect(expired.map((revision) => revision.version)).toEqual([1]);
    expect(service.revision(LINEAGE, 1)?.status).toBe("expired");
    expect(service.history(LINEAGE).map((event) => event.type)).toContain("rule.expired");
    // An expired approval is also never restored.
    expectRuleCode(() => service.activate(LINEAGE, 1, ADMIN), "RULE_REVISION_EXPIRED");
  });
});
