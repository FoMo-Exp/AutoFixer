import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  FIXTURE_CANDIDATE_STATEMENT,
  assertEvidenceRedacted,
  acceptedAsRealModelEvidence,
  openSourceCaptureDb,
  parseVerificationArgs,
  readTrustedCaptureSnapshot,
  realModeBlockers,
  runVerification,
  type VerificationEvidence,
} from "../scripts/real-model-distillation-verify.js";
import {
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb } from "../src/control-plane/index.js";
import { captureOutcome, createCaptureJobStore } from "../src/distill/index.js";
import { createMemoryRepositories } from "../src/memory/index.js";

/**
 * DAT-270: the isolated verification pack must run the real pipeline end to
 * end without egress, and must fail closed unless provenance and every
 * real-model precondition are proven. The fixture run below is explicitly
 * labelled `fixture_local_provider`; nothing here claims full acceptance.
 */

const CLEAN_ENV = {};

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dat270-provenance-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mergedEnvelope(runId = "run-dat270-source"): Record<string, unknown> {
  return {
    contract_version: "1.0.0",
    task_id: "task-dat270-source",
    run_id: runId,
    issue_id: "issue-dat270-source",
    terminal_state: "merged",
    delivery: {
      patch_status: "merged",
      head_sha: "head-dat270-source",
      pr_id: "pr-dat270-source",
      change_summary: "Captured merged outcome for provenance testing.",
      validation: [
        {
          tool: "npm test -- --run",
          exit_status: 0,
          event_reference: `evidence://events/${runId}/vitest`,
        },
      ],
    },
    evidence: [{ evidence_type: "reviewer_decision", reference: `evidence://review/${runId}/ok` }],
  };
}

interface CaptureFixture {
  dbPath: string;
  captureId: string;
  runId: string;
  enterpriseId: string;
  workspaceId: string;
  envelope: string;
}

/**
 * Create a control-plane database with one capture outbox row, then mutate it
 * to model the states the provenance gate must reject.
 */
function captureFixture(
  options: {
    state?: "captured" | "pending";
    digest?: "correct" | "tampered";
    binding?: "consistent" | "mismatched";
  } = {},
): CaptureFixture {
  const dir = tempDir();
  const dbPath = path.join(dir, "control-plane.sqlite");
  const db: ControlPlaneDb = openControlPlaneDb({ path: dbPath });
  try {
    const { enterprise, admin_scope } = seedEnterprise(db, {
      enterprise_name: "DAT-270 Source Enterprise",
      enterprise_slug: "dat270-source",
      admin_user_id: "usr_dat270_source",
    });
    const provider = seedProviderInstance(db, admin_scope, {
      provider_type: "github",
      origin_url: "https://github.com",
    });
    const workspace = seedWorkspace(db, admin_scope, {
      name: "DAT-270 Source Workspace",
      repository_id: "github:FoMo-Exp/AutoFixer",
      provider_instance_id: provider.id,
    });
    const scope = {
      enterprise_id: enterprise.id,
      workspace_id: workspace.id,
      actor_id: "usr_dat270_source",
    };
    const rowRunId = "run-dat270-source";
    // A structurally valid envelope. The mismatched case stores it under a
    // capture row for a different run, which is exactly what an attacker
    // supplying a bare file could not be stopped from doing before.
    const envelopeRunId = options.binding === "mismatched" ? "run-dat270-other" : rowRunId;
    const captured = captureOutcome(
      createMemoryRepositories(db),
      scope,
      mergedEnvelope(envelopeRunId),
    );
    const jobs = createCaptureJobStore(db);
    const job = jobs.enqueue({
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      task_id: captured.envelope.task_id,
      run_id: rowRunId,
      terminal_state: captured.envelope.terminal_state,
    });
    const serialized = JSON.stringify(captured.envelope);
    if (options.state !== "pending") {
      jobs.markCaptured(job.id, captured.episode.item.id, {
        envelope: serialized,
        outcome_class: captured.classification.class,
        envelope_digest:
          options.digest === "tampered" ? sha256("tampered-envelope") : sha256(serialized),
      });
    }
    return {
      dbPath,
      captureId: job.id,
      runId: rowRunId,
      enterpriseId: scope.enterprise_id,
      workspaceId: scope.workspace_id,
      envelope: serialized,
    };
  } finally {
    db.close();
  }
}

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
    expect(args.captureDb).toBeNull();
  });

  test("the bare envelope flag is gone", () => {
    expect(() =>
      parseVerificationArgs(["--evidence-out", "out.json", "--envelope-file", "env.json"]),
    ).toThrow(/unknown argument --envelope-file/);
  });

  test("real mode requires authorization, a trusted capture DB, one selector, and gateway configuration", () => {
    const blockers = realModeBlockers(
      { authorizationRef: null, captureDb: null, captureId: null, runId: null },
      { ANTHROPIC_API_KEY: "sk-ant-ambient" },
    );
    expect(blockers).toContain("AUTHORIZATION_REFERENCE_MISSING");
    expect(blockers).toContain("TRUSTED_CAPTURE_DB_MISSING");
    expect(blockers).toContain("CAPTURE_SELECTOR_INVALID");
    expect(blockers).toContain("AMBIENT_PROVIDER_CREDENTIALS:ANTHROPIC_API_KEY");
    expect(blockers).toContain("CONFIG_MISSING:FORGEPILOT_GATEWAY_POLICY_FILE");
    expect(blockers).toContain("CONFIG_MISSING:FORGEPILOT_GATEWAY_CREDENTIALS_FILE");
    expect(blockers).toContain("CONFIG_MISSING:FORGEPILOT_PI_PROVIDER");
    expect(blockers).toContain("CONFIG_MISSING:FORGEPILOT_PI_MODEL");
    expect(blockers).toContain("CONFIG_MISSING:FORGEPILOT_BUDGET_POLICY_FILE");
  });

  test("a complete real-mode configuration has no blockers", () => {
    const fixture = captureFixture({});
    const blockers = realModeBlockers(
      {
        authorizationRef: "DAT-270/approved-comment",
        captureDb: fixture.dbPath,
        captureId: fixture.captureId,
        runId: null,
      },
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

  test("both selectors or neither is invalid", () => {
    const base = {
      authorizationRef: "ref",
      captureDb: "db",
      captureId: "mcp_1",
      runId: "run-1",
    };
    expect(realModeBlockers(base, {})).toContain("CAPTURE_SELECTOR_INVALID");
    expect(realModeBlockers({ ...base, captureId: null, runId: null }, {})).toContain(
      "CAPTURE_SELECTOR_INVALID",
    );
  });
});

describe("trusted capture provenance", () => {
  test("a captured row with a matching digest and binding is accepted", () => {
    const fixture = captureFixture({});
    const db = openSourceCaptureDb(fixture.dbPath);
    try {
      const trusted = readTrustedCaptureSnapshot({
        db,
        captureId: fixture.captureId,
        runId: null,
      });
      expect(trusted.snapshot).toMatchObject({
        capture_job_id: fixture.captureId,
        run_id: fixture.runId,
        terminal_state: "merged",
        outcome_class: "accepted",
      });
      expect(trusted.snapshot.envelope_digest).toBe(sha256(trusted.snapshot.envelope));
      expect(trusted.classification).toMatchObject({ class: "accepted", known: true });
    } finally {
      db.close();
    }
  });

  test("a tampered snapshot is refused", () => {
    const fixture = captureFixture({ digest: "tampered" });
    const db = openSourceCaptureDb(fixture.dbPath);
    try {
      expect(() =>
        readTrustedCaptureSnapshot({ db, captureId: fixture.captureId, runId: null }),
      ).toThrowError(/digest/);
    } finally {
      db.close();
    }
  });

  test("a pending capture row is refused", () => {
    const fixture = captureFixture({ state: "pending" });
    const db = openSourceCaptureDb(fixture.dbPath);
    try {
      expect(() =>
        readTrustedCaptureSnapshot({ db, captureId: fixture.captureId, runId: null }),
      ).toThrowError(/not captured/);
    } finally {
      db.close();
    }
  });

  test("a structurally valid envelope bound to another run is refused", () => {
    const fixture = captureFixture({ binding: "mismatched" });
    const db = openSourceCaptureDb(fixture.dbPath);
    try {
      expect(() =>
        readTrustedCaptureSnapshot({ db, captureId: fixture.captureId, runId: null }),
      ).toThrowError(/identities disagree/);
    } finally {
      db.close();
    }
  });

  test("an unknown capture id is refused", () => {
    const fixture = captureFixture({});
    const db = openSourceCaptureDb(fixture.dbPath);
    try {
      expect(() =>
        readTrustedCaptureSnapshot({ db, captureId: "mcp_unknown", runId: null }),
      ).toThrowError(/no capture row/);
    } finally {
      db.close();
    }
  });
});

describe("real mode is blocked before dispatch", () => {
  test("missing configuration produces blocked evidence and no scenarios", async () => {
    const evidence = await runVerification(
      {
        mode: "real",
        authorizationRef: null,
        captureDb: null,
        captureId: null,
        runId: null,
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
        captureDb: null,
        captureId: null,
        runId: null,
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

  test("a forged but structurally valid envelope in a tampered outbox row blocks with zero dispatch", async () => {
    const fixture = captureFixture({ digest: "tampered" });
    const evidence = await runVerification(
      {
        mode: "real",
        authorizationRef: "DAT-270/approved-comment",
        captureDb: fixture.dbPath,
        captureId: fixture.captureId,
        runId: null,
        evidenceOut: "ignored.json",
        stateDir: null,
        keepState: false,
        policyScope: null,
        help: false,
      },
      {
        env: {
          FORGEPILOT_GATEWAY_POLICY_FILE: "policy.json",
          FORGEPILOT_GATEWAY_CREDENTIALS_FILE: "credentials.json",
          FORGEPILOT_PI_PROVIDER: "openai",
          FORGEPILOT_PI_MODEL: "gpt-x",
          FORGEPILOT_BUDGET_POLICY_FILE: "budget.json",
        },
      },
    );
    expect(evidence.status).toBe("blocked");
    expect(evidence.blockers).toContain("CAPTURE_ENVELOPE_DIGEST_MISMATCH");
    // No gateway attempt, model call, capture, or candidate happened.
    expect(evidence.scenarios).toEqual([]);
    expect(evidence.outcome).toBeNull();
    expect(evidence.distillation).toBeNull();
    expect(evidence.candidate).toBeNull();
    expect(evidence.accepted_as_real_model_evidence).toBe(false);
  });

  test("a forged envelope bound to another run blocks with zero dispatch", async () => {
    const fixture = captureFixture({ binding: "mismatched" });
    const evidence = await runVerification(
      {
        mode: "real",
        authorizationRef: "DAT-270/approved-comment",
        captureDb: fixture.dbPath,
        captureId: fixture.captureId,
        runId: null,
        evidenceOut: "ignored.json",
        stateDir: null,
        keepState: false,
        policyScope: null,
        help: false,
      },
      {
        env: {
          FORGEPILOT_GATEWAY_POLICY_FILE: "policy.json",
          FORGEPILOT_GATEWAY_CREDENTIALS_FILE: "credentials.json",
          FORGEPILOT_PI_PROVIDER: "openai",
          FORGEPILOT_PI_MODEL: "gpt-x",
          FORGEPILOT_BUDGET_POLICY_FILE: "budget.json",
        },
      },
    );
    expect(evidence.status).toBe("blocked");
    expect(evidence.blockers).toContain("CAPTURE_BINDING_MISMATCH");
    expect(evidence.scenarios).toEqual([]);
    expect(evidence.outcome).toBeNull();
  });
});

describe("real-model evidence semantics", () => {
  test("only a verified real-mode automated chain is real-model evidence", () => {
    expect(acceptedAsRealModelEvidence("real", "verified")).toBe(true);
    expect(acceptedAsRealModelEvidence("real", "failed")).toBe(false);
    expect(acceptedAsRealModelEvidence("real", "blocked")).toBe(false);
    expect(acceptedAsRealModelEvidence("fixture", "verified")).toBe(false);
  });
});

describe("fixture verification", () => {
  test("runs the trusted-outcome-to-candidate chain and every safety probe", async () => {
    const evidence = await runVerification(
      {
        mode: "fixture",
        authorizationRef: null,
        captureDb: null,
        captureId: null,
        runId: null,
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
      provenance: null,
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
        captureDb: null,
        captureId: null,
        runId: null,
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
