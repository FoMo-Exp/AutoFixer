import { describe, expect, test } from "vitest";

import {
  FIXTURE_CANDIDATE_STATEMENT,
  assertEvidenceRedacted,
  parseVerificationArgs,
  realModeBlockers,
  runVerification,
  type VerificationEvidence,
} from "../scripts/real-model-distillation-verify.js";

/**
 * DAT-270: the isolated verification pack must run the real pipeline end to
 * end without egress, and must fail closed on any real-model precondition it
 * cannot prove. The fixture run below is explicitly labelled
 * `fixture_local_provider`; nothing here claims real-model acceptance.
 */

const CLEAN_ENV = {};

function baseEvidence(): VerificationEvidence {
  return {
    schema_version: 1,
    issue: "DAT-270",
    verification_mode: "fixture_local_provider",
    accepted_as_real_model_evidence: false,
    status: "verified",
    created_at: "2026-01-01T00:00:00.000Z",
    baseline: { commit: null, node_version: "v22" },
    authorization: { present: false, reference: null },
    configuration: {
      model_provider: "openai",
      model_id: "fixture",
      endpoint_base_url: "http://127.0.0.1:1",
      gateway_policy_revision: "p1",
      gateway_endpoint_id: "ep",
      credential_ref: "fixture-credential",
      budget: { configured: true, revision: "b1" },
      policy_binding: "fixture_policy",
    },
    outcome: null,
    distillation: null,
    candidate: null,
    human_review: {
      status: "required",
      item_id: null,
      item_version: null,
      action: "human promotion",
    },
    next_run_reference: {
      verified: false,
      purpose: "run_plan",
      bundle_id: null,
      item_status: null,
      approved: false,
      candidate: false,
      tier: null,
    },
    usage: {
      records: [],
      cost_semantics: "provider_reported_estimate_or_unknown_never_zero_filled",
    },
    scenarios: [],
    blockers: [],
  };
}

describe("verification arguments", () => {
  test("defaults to fixture mode and requires an evidence path", () => {
    expect(() => parseVerificationArgs([])).toThrow(/--evidence-out is required/);
    const args = parseVerificationArgs(["--evidence-out", "out.json"]);
    expect(args.mode).toBe("fixture");
    expect(args.authorizationRef).toBeNull();
  });

  test("real mode requires authorization, a trusted envelope, and gateway configuration", () => {
    const blockers = realModeBlockers(
      { authorizationRef: null, envelopeFile: null },
      { ANTHROPIC_API_KEY: "sk-ant-ambient" },
    );
    expect(blockers).toContain("AUTHORIZATION_REFERENCE_MISSING");
    expect(blockers).toContain("TRUSTED_OUTCOME_ENVELOPE_MISSING");
    expect(blockers).toContain("AMBIENT_PROVIDER_CREDENTIALS:ANTHROPIC_API_KEY");
    expect(blockers).toContain("CONFIG_MISSING:FORGEPILOT_GATEWAY_POLICY_FILE");
    expect(blockers).toContain("CONFIG_MISSING:FORGEPILOT_GATEWAY_CREDENTIALS_FILE");
    expect(blockers).toContain("CONFIG_MISSING:FORGEPILOT_PI_PROVIDER");
    expect(blockers).toContain("CONFIG_MISSING:FORGEPILOT_PI_MODEL");
    expect(blockers).toContain("CONFIG_MISSING:FORGEPILOT_BUDGET_POLICY_FILE");
  });

  test("a complete real-mode configuration has no blockers", () => {
    const blockers = realModeBlockers(
      { authorizationRef: "DAT-270/approved-comment", envelopeFile: "README.md" },
      {
        FORGEPILOT_GATEWAY_POLICY_FILE: "policy.json",
        FORGEPILOT_GATEWAY_CREDENTIALS_FILE: "credentials.json",
        FORGEPILOT_PI_PROVIDER: "anthropic",
        FORGEPILOT_PI_MODEL: "claude-x",
        FORGEPILOT_BUDGET_POLICY_FILE: "budget.json",
      },
    );
    expect(blockers).toEqual([]);
  });
});

describe("real mode is blocked before dispatch", () => {
  test("missing configuration produces blocked evidence and no scenarios", async () => {
    const evidence = await runVerification(
      {
        mode: "real",
        authorizationRef: null,
        envelopeFile: null,
        evidenceOut: "ignored.json",
        stateDir: null,
        keepState: false,
        policyScope: null,
        help: false,
      },
      { env: CLEAN_ENV },
    );
    expect(evidence.status).toBe("blocked");
    expect(evidence.verification_mode).toBe("real_model");
    expect(evidence.accepted_as_real_model_evidence).toBe(false);
    expect(evidence.scenarios).toEqual([]);
    expect(evidence.outcome).toBeNull();
    expect(evidence.blockers.length).toBeGreaterThan(0);
  });

  test("an ambient provider credential blocks real mode", async () => {
    const evidence = await runVerification(
      {
        mode: "real",
        authorizationRef: "DAT-270/approved-comment",
        envelopeFile: null,
        evidenceOut: "ignored.json",
        stateDir: null,
        keepState: false,
        policyScope: null,
        help: false,
      },
      { env: { OPENAI_API_KEY: "sk-ambient-value" } },
    );
    expect(evidence.status).toBe("blocked");
    expect(evidence.blockers).toContain("AMBIENT_PROVIDER_CREDENTIALS:OPENAI_API_KEY");
    expect(JSON.stringify(evidence)).not.toContain("sk-ambient-value");
  });
});

describe("fixture verification", () => {
  test("runs the trusted-outcome-to-candidate chain and every safety probe", async () => {
    const evidence = await runVerification(
      {
        mode: "fixture",
        authorizationRef: null,
        envelopeFile: null,
        evidenceOut: "ignored.json",
        stateDir: null,
        keepState: false,
        policyScope: null,
        help: false,
      },
      { env: CLEAN_ENV },
    );

    expect(evidence.status).toBe("verified");
    expect(evidence.verification_mode).toBe("fixture_local_provider");
    // A fixture run is never real-model evidence, whatever it proves.
    expect(evidence.accepted_as_real_model_evidence).toBe(false);

    expect(evidence.outcome).toMatchObject({
      source: "synthetic_fixture",
      terminal_state: "merged",
      outcome_class: "accepted",
    });
    expect(evidence.distillation).toMatchObject({
      state: "distilled",
      accepted: 1,
      dropped: 0,
    });
    expect(evidence.candidate).toMatchObject({
      status: "candidate",
      kind: "lesson",
      admission_disposition: "admitted",
    });
    expect(evidence.candidate?.evidence_references.length).toBeGreaterThan(0);
    // The harness never performs the named-human promotion.
    expect(evidence.human_review.status).toBe("required");
    expect(evidence.next_run_reference.verified).toBe(true);
    expect(evidence.next_run_reference.approved).toBe(false);

    const scenarios = new Map(evidence.scenarios.map((entry) => [entry.id, entry.status]));
    for (const id of [
      "request_scan_block",
      "redaction",
      "insufficient_evidence",
      "timeout_unknown_episode_only",
      "cross_workspace_isolation",
      "duplicate_content_merges",
      "known_outcome_to_candidate",
    ]) {
      expect(scenarios.get(id), id).toBe("passed");
    }

    // Usage is metered with honest completeness; cost is never zero-filled.
    expect(evidence.usage.records.length).toBeGreaterThan(0);
    for (const record of evidence.usage.records) {
      expect(["known", "estimated", "unknown"]).toContain(record.completeness);
    }
    expect(evidence.usage.cost_semantics).toContain("never_zero_filled");
  });

  test("the evidence document carries no candidate text, credential, or personal data", async () => {
    const evidence = await runVerification(
      {
        mode: "fixture",
        authorizationRef: null,
        envelopeFile: null,
        evidenceOut: "ignored.json",
        stateDir: null,
        keepState: false,
        policyScope: null,
        help: false,
      },
      { env: CLEAN_ENV },
    );
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(FIXTURE_CANDIDATE_STATEMENT);
    expect(serialized).not.toContain("fixture-only-credential");
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain("@example.com");
    expect(serialized).not.toContain("/Users/");
    // The final self-check accepts the document it just produced.
    expect(() => assertEvidenceRedacted(evidence)).not.toThrow();
  });
});

describe("evidence redaction gate", () => {
  test("refuses to write an evidence document carrying secret-shaped material", () => {
    const evidence = baseEvidence();
    evidence.blockers = ["token=ghp_DAT270EvidenceLeakNeverReal0123456789"];
    expect(() => assertEvidenceRedacted(evidence)).toThrow(/secret or personal material/);
  });

  test("refuses to write an evidence document carrying personal data", () => {
    const evidence = baseEvidence();
    evidence.authorization = { present: true, reference: "ada@example.com" };
    expect(() => assertEvidenceRedacted(evidence)).toThrow(/secret or personal material/);
  });
});
