/**
 * Versioned rule corrections: disguised-exemption rejection and the
 * separated propose → review → activate → rollback lifecycle (DAT-211,
 * ADR-0005 §4).
 *
 * Acceptance: targeted exemption rules are identified and rejected, blanket
 * allows are rejected, activation without trusted regression evidence is
 * rejected, and a rollback never restores a superseded approval. Every
 * proposal, review, activation, and rollback is audited, and evidence is
 * computed server-side from a trusted corpus — never taken from a proposal.
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
  type TrueSecretSample,
} from "../src/security/index.js";
import type { SecretDetector } from "../src/gateway/index.js";

const SCOPE = { enterpriseId: "ent_test", workspaceId: "ws_test" };
const HANDLER: SecurityActor = { actorId: "human_handler", actorKind: "human" };
const REVIEWER: SecurityActor = { actorId: "human_reviewer", actorKind: "human" };
const ADMIN: SecurityActor = { actorId: "human_admin", actorKind: "human" };
const OWNER_ACTOR: SecurityActor = { actorId: "human_owner", actorKind: "human" };

const NOW = new Date("2026-11-03T00:00:00.000Z");
const IN_30_DAYS = "2026-12-03T00:00:00.000Z";
const IN_7_DAYS = "2026-11-10T00:00:00.000Z";
const YESTERDAY = "2026-11-02T00:00:00.000Z";

/**
 * Deterministic trusted regression inputs for the suite: one test detector
 * and one 64-distinct-character sample (Shannon entropy exactly 6 bits/char),
 * so evidence computation is pinned rather than dependent on the built-in
 * corpus.
 */
const TEST_DETECTOR: SecretDetector = {
  id: "high-entropy-token",
  version: "1",
  classification: "secret_suspected",
  pattern: /[A-Za-z0-9+/=]{28,}/g,
  minShannonEntropy: 4,
};
const TRUE_SECRET_SAMPLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const TEST_SAMPLES: readonly TrueSecretSample[] = [
  {
    testRef: "corpus/true-secret-class",
    description: "true-secret class still detected",
    detectorId: "high-entropy-token",
    material: TRUE_SECRET_SAMPLE,
  },
];

const LINEAGE = "high-entropy-token|ent_test|ws_test";

function buildService(
  options: {
    directory?: SecurityDutyDirectory;
    samples?: readonly TrueSecretSample[];
    persistencePath?: string;
  } = {},
) {
  const directory =
    options.directory ??
    staticDutyDirectory({
      handlers: ["human_handler"],
      reviewers: ["human_reviewer"],
      admins: ["human_admin"],
    });
  const service = new RuleCorrectionService({
    directory,
    now: () => NOW,
    regression: {
      samples: options.samples ?? TEST_SAMPLES,
      detectors: [TEST_DETECTOR],
    },
    ...(options.persistencePath !== undefined ? { persistencePath: options.persistencePath } : {}),
  });
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

/** One temporary persisted-state file for tampering scenarios. */
function stateFilePath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "dat211-rules-")), "state.json");
}

describe("disguised exemption identification (DAT-211)", () => {
  test("rules targeting an invocation, case, request digest, or secret value are identified and rejected", () => {
    const targeted: Record<string, unknown>[] = [
      proposal({ invocationId: "inv_1" }),
      proposal({ caseId: "case_1" }),
      proposal({ requestDigest: "a1b2c3d4e5f6a7b8c9d0" }),
      proposal({ secretValue: "sk-live-abcdef1234567890" }),
      proposal({ constraints: { minShannonEntropy: 5.5, case_id: "case_1" } }),
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

  test("a proposal may not carry regression-evidence results of its own", () => {
    // Evidence is service-computed; client-supplied results are rejected as
    // fields outside the closed schema.
    expectRuleCode(
      () =>
        validateRuleCorrection(
          proposal({
            regressionEvidence: [
              {
                testRef: "corpus/provider-keys",
                description: "forged pass",
                detectorId: "high-entropy-token",
                result: "pass",
                at: YESTERDAY,
              },
            ],
          }),
          NOW,
        ),
      "RULE_PROPOSAL_INVALID",
    );
  });

  test("a proposal needs reason, bounded applicability, and a bounded expiry", () => {
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
      () => validateRuleCorrection(proposal({ reviewAt: IN_30_DAYS, expiresAt: IN_7_DAYS }), NOW),
      "RULE_PROPOSAL_INVALID",
    );
  });
});

describe("trusted regression evidence (DAT-211)", () => {
  test("the service computes evidence and binds it to the rule content and corpus", () => {
    const { service } = buildService();
    const proposed = service.propose(HANDLER, proposal());
    expect(proposed.regressionEvidence).toMatchObject([
      { testRef: "corpus/true-secret-class", result: "pass" },
    ]);
    expect(proposed.regressionBinding?.ruleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(proposed.regressionBinding?.corpusDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("a correction that would suppress a true-secret sample cannot be proposed", () => {
    const { service } = buildService();
    // minLength 100 excludes the 64-character true-secret sample class.
    expectRuleCode(
      () => service.propose(HANDLER, proposal({ constraints: { minLength: 100 } })),
      "RULE_EVIDENCE_FAILED",
    );
    const rejected = service
      .history(LINEAGE)
      .find((entry) => entry.type === "rule.proposal_rejected");
    expect(rejected?.detail["code"]).toBe("RULE_EVIDENCE_FAILED");
    expect(service.lineage(LINEAGE)).toHaveLength(0);
  });

  test("a detector without trusted samples cannot be proposed", () => {
    const { service } = buildService();
    expectRuleCode(
      () => service.propose(HANDLER, proposal({ detectorId: "unknown-detector" })),
      "RULE_EVIDENCE_MISSING",
    );
  });

  test("activation re-verifies evidence: forged stored results are not authority", () => {
    const stateFile = stateFilePath();
    const { service } = buildService({ persistencePath: stateFile });
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "fine");
    // Tamper only the recorded evidence entries: the service recomputes from
    // the trusted corpus, so activation still succeeds and ignores them.
    const revision = service.revision(LINEAGE, 1);
    writeFileSync(
      stateFile,
      JSON.stringify({
        schema_version: 1,
        revisions: [
          {
            ...revision,
            regressionEvidence: [
              {
                testRef: "forged/pass",
                description: "forged",
                detectorId: "high-entropy-token",
                result: "fail",
                at: YESTERDAY,
              },
            ],
          },
        ],
        events: service.history(LINEAGE),
      }),
    );
    const reopened = buildService({ persistencePath: stateFile }).service;
    expect(reopened.activate(LINEAGE, 1, ADMIN).status).toBe("activated");
  });

  test("activation rejects a correction whose content changed after its evidence", () => {
    const stateFile = stateFilePath();
    const { service } = buildService({ persistencePath: stateFile });
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "fine");
    const revision = service.revision(LINEAGE, 1);
    // Widening/narrowing the stored constraints invalidates the commitment:
    // the reviewed content is no longer what the evidence covered.
    writeFileSync(
      stateFile,
      JSON.stringify({
        schema_version: 1,
        revisions: [{ ...revision, constraints: { minShannonEntropy: 4.5 } }],
        events: service.history(LINEAGE),
      }),
    );
    const reopened = buildService({ persistencePath: stateFile }).service;
    expectRuleCode(() => reopened.activate(LINEAGE, 1, ADMIN), "RULE_EVIDENCE_INVALID");
  });

  test("activation rejects evidence computed against a different trusted corpus", () => {
    const stateFile = stateFilePath();
    const { service } = buildService({ persistencePath: stateFile });
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "fine");
    // A changed corpus invalidates the commitment: the evidence is stale and
    // the correction needs re-proposal and re-review.
    const changedCorpus: TrueSecretSample[] = [
      {
        testRef: "corpus/true-secret-class",
        description: "true-secret class still detected",
        detectorId: "high-entropy-token",
        material: "QWERTYUIOPASDFGHJKLZXCVBNMqwertyuiopasdfghjklzxcvbnm1234567890+/",
      },
    ];
    const reopened = buildService({ persistencePath: stateFile, samples: changedCorpus }).service;
    expectRuleCode(() => reopened.activate(LINEAGE, 1, ADMIN), "RULE_EVIDENCE_STALE");
  });

  test("activation without a committed evidence binding is rejected", () => {
    const stateFile = stateFilePath();
    const { service } = buildService({ persistencePath: stateFile });
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "fine");
    const revision = service.revision(LINEAGE, 1);
    const { regressionBinding: _binding, ...unbound } = revision ?? {};
    writeFileSync(
      stateFile,
      JSON.stringify({
        schema_version: 1,
        revisions: [unbound],
        events: service.history(LINEAGE),
      }),
    );
    const reopened = buildService({ persistencePath: stateFile }).service;
    expectRuleCode(() => reopened.activate(LINEAGE, 1, ADMIN), "RULE_EVIDENCE_MISSING");
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
      {
        detectorId: "high-entropy-token",
        version: 1,
        scope: SCOPE,
        constraints: { minShannonEntropy: 5.5 },
      },
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

  test("a newer approval supersedes the older one; superseded approvals never come back", () => {
    const { service } = buildService();
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "v1 fine");
    const second = service.propose(HANDLER, proposal({ constraints: { minShannonEntropy: 5.2 } }));
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
    service.propose(HANDLER, proposal({ constraints: { minShannonEntropy: 5.2 } }));
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
    service.propose(HANDLER, proposal({ constraints: { minShannonEntropy: 5.2 } }));
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
    const service = new RuleCorrectionService({
      directory,
      now: () => new Date(clock),
      regression: { samples: TEST_SAMPLES, detectors: [TEST_DETECTOR] },
    });
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

describe("query snapshots (DAT-211)", () => {
  test("callers cannot rewrite activated policy or the audit trail through query results", () => {
    const { service } = buildService();
    service.propose(HANDLER, proposal());
    service.review(LINEAGE, 1, REVIEWER, true, "fine");
    service.activate(LINEAGE, 1, ADMIN);
    // Mutating the active view must not change what the scanner consumes.
    const active = service.activeCorrections()[0];
    expect(active).toBeDefined();
    if (active) {
      active.constraints.minShannonEntropy = 0.1;
      active.constraints.minLength = 1;
      active.scope.workspaceId = "ws_other";
    }
    const again = service.activeCorrections()[0];
    expect(again?.constraints).toEqual({ minShannonEntropy: 5.5 });
    expect(again?.scope).toEqual(SCOPE);
    // Mutating a returned revision must not rewrite internal state…
    const revision = service.revision(LINEAGE, 1);
    expect(revision).toBeDefined();
    if (revision) {
      revision.status = "superseded";
      revision.constraints.minLength = 99;
      if (revision.review) revision.review.approved = false;
    }
    expect(service.revision(LINEAGE, 1)?.status).toBe("activated");
    expect(service.revision(LINEAGE, 1)?.constraints).toEqual({ minShannonEntropy: 5.5 });
    expect(service.revision(LINEAGE, 1)?.review?.approved).toBe(true);
    // …nor must mutating history or lineage snapshots.
    const history = service.history(LINEAGE);
    const firstEvent = history[0];
    if (firstEvent) {
      firstEvent.type = "rule.rolled_back";
      if (firstEvent.actor) firstEvent.actor.principalId = "stranger";
    }
    expect(service.history(LINEAGE)[0]?.type).toBe("rule.proposed");
    expect(service.history(LINEAGE)[0]?.actor).toMatchObject({ principalId: "human_handler" });
    const lineage = service.lineage(LINEAGE);
    const firstRevision = lineage[0];
    if (firstRevision) firstRevision.status = "rejected";
    expect(service.lineage(LINEAGE)[0]?.status).toBe("activated");
  });
});
