import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type {
  DshCandidateArtifact,
  DshPatchDiffArtifact,
  DshRunResponse,
  DshValidationEvidence,
  DshValidationSummaryArtifact,
} from "../src/dsh/types.js";
import type { DshClient } from "../src/dsh/client.js";
import type { GatewayScopeBinding } from "../src/gateway/index.js";
import { CandidateContentStore, diffDigest } from "../src/collab/candidate-store.js";
import { CollabError } from "../src/collab/errors.js";
import { CollabMachine } from "../src/collab/machine.js";
import { PreparationBridge } from "../src/collab/preparation.js";
import type { CandidateRecord } from "../src/collab/types.js";
import { TaskService } from "../src/api/task-service.js";
import { TaskStore, createTaskRecord } from "../src/api/task-store.js";
import type { OrchestratorConfig } from "../src/config.js";
import { REPOSITORY, WORKSPACE } from "./helpers/collab.js";

const RUN_ID = "run_dsh_prep_1";
const PREVIOUS_RUN_ID = "run_dsh_prep_0";
const TASK_ID = "tsk_prep_1";
const HEAD_SHA = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const HEAD2 = "1".repeat(40);
const TREE_SHA = "d4e5f60718293a4b5c6d7e8f9012345678a1b2c3";
const TREE2 = "2".repeat(40);
const TEST_OUTPUT = "cd".repeat(32);
const REPORT_DIGEST = "ef".repeat(32);
const CANDIDATE_ENVELOPE = "ab".repeat(32);
const CHECK = "go.test";

const DIFF = [
  "diff --git a/web/src/export.ts b/web/src/export.ts",
  "--- a/web/src/export.ts",
  "+++ b/web/src/export.ts",
  "@@ -1 +1 @@",
  "-export const button = 1;",
  "+export const button = 2;",
  "",
].join("\n");

const DIFF_DIGEST = diffDigest(DIFF);

const CONFIG = {
  dshSocketPath: "/tmp/unused.sock",
  apiHost: "127.0.0.1",
  apiPort: 0,
  apiTokenFile: "/tmp/unused-token",
  repositoryId: REPOSITORY.repository_id,
  repositoryUrl: REPOSITORY.url,
  baseRef: "main",
  baseSha: REPOSITORY.base_sha,
  actorId: "usr_operator",
  actorDisplayName: "Deployment Operator",
  approverIdentity: "github:local-operator",
  pathHints: [],
  toolCapabilities: [],
  maxWallClockSeconds: 60,
  enterpriseId: WORKSPACE.enterprise_id,
  workspaceId: WORKSPACE.workspace_id,
} as OrchestratorConfig;

const SCOPE: GatewayScopeBinding = {
  enterpriseId: WORKSPACE.enterprise_id,
  workspaceId: WORKSPACE.workspace_id,
  scopeAuthority: {
    resolve: () => ({
      enterpriseId: WORKSPACE.enterprise_id,
      workspaceId: WORKSPACE.workspace_id,
    }),
  },
} as GatewayScopeBinding;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autofixer-preparation-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function machine(clockAt = "2026-11-03T00:00:00.000Z"): CollabMachine {
  return new CollabMachine({
    now: () => new Date(clockAt),
    candidateStore: new CandidateContentStore(path.join(root, "candidates")),
  });
}

function grantRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_version: "task-evidence-contract-v1",
    task_id: TASK_ID,
    run_id: RUN_ID,
    issued_at: "2026-11-03T00:00:00Z",
    expires_at: "2026-11-03T01:00:00Z",
    policy_version: "dsh-policy-1",
    capability_grant_version: "grant-1",
    repository_url: REPOSITORY.url,
    base_sha: REPOSITORY.base_sha,
    permitted_paths: ["web/src"],
    permitted_tools: [
      { identity: "repo.read", allowed_arguments: [] },
      { identity: "workspace.patch", allowed_arguments: [] },
      { identity: "test.run", allowed_arguments: [] },
    ],
    network_destinations: [],
    max_wall_clock_seconds: 900,
    resource_limits: { max_memory_mb: 512, max_cpu_seconds: 60 },
    may_create_patch: true,
    may_create_or_update_pr: true,
    approval_reference: null,
    ...overrides,
  };
}

function evidence(overrides: Partial<DshValidationEvidence> = {}): DshValidationEvidence {
  return {
    tool: CHECK,
    arguments: ["go.test", "focused"],
    exit_status: 0,
    output_digest: { algorithm: "sha256", value: TEST_OUTPUT },
    event_reference: `evidence://events/${RUN_ID}/3`,
    ...overrides,
  };
}

function dshRun(overrides: Partial<DshRunResponse> = {}): DshRunResponse {
  return {
    run_id: RUN_ID,
    task_id: TASK_ID,
    issue_id: "issue-1",
    state: "stopped",
    risk_assessment: {
      contract_version: "task-evidence-contract-v1",
      task_id: TASK_ID,
      run_id: RUN_ID,
      assessed_at: "2026-11-03T00:00:00.000Z",
      assessor_identity: "dsh",
      risk_class: "low",
      decision_code: "risk_low_approved",
      rationale_reference: "evidence://risk",
      policy_version: "dsh-policy-1",
      elevated_approval_reference: null,
    },
    grant_status: {
      state: "revoked",
      scope_digest: "sha256:scope-1",
      grant: grantRaw(),
    },
    execution_counts: { actions_total: 3, actions_allowed: 3, actions_denied: 0 },
    patch_report: {
      contract_version: "task-evidence-contract-v1",
      patch_status: "prepared_no_pr",
      base_sha: REPOSITORY.base_sha,
      branch: "autofixer/tsk_prep_1-c0ffee0",
      head_sha: HEAD_SHA,
      pr_id: null,
      change_summary: "Change the export button constant.",
      validation: [evidence()],
      evidence_references: [`evidence://events/${RUN_ID}/3`],
      report_digest: REPORT_DIGEST,
    },
    approval_snapshot: null,
    bundle_available: true,
    created_at: "2026-11-03T00:00:00.000Z",
    ...overrides,
  };
}

function patchDiffContent(overrides: Partial<DshPatchDiffArtifact> = {}): DshPatchDiffArtifact {
  return {
    base_sha: REPOSITORY.base_sha,
    head_sha: HEAD_SHA,
    tree_sha: TREE_SHA,
    diff_digest: DIFF_DIGEST,
    changed_paths: ["web/src/export.ts"],
    insertions: 1,
    deletions: 1,
    diff: DIFF,
    ...overrides,
  };
}

function candidateContent(overrides: Partial<DshCandidateArtifact> = {}): DshCandidateArtifact {
  return {
    run_id: RUN_ID,
    task_id: TASK_ID,
    issue_id: "issue-1",
    repository_url: REPOSITORY.url,
    base_sha: REPOSITORY.base_sha,
    tree_sha: TREE_SHA,
    head_sha: HEAD_SHA,
    branch: "autofixer/tsk_prep_1-c0ffee0",
    diff_digest: DIFF_DIGEST,
    changed_paths: ["web/src/export.ts"],
    insertions: 1,
    deletions: 1,
    summary: "Change the export button constant.",
    risk_class: "low",
    validation: [evidence()],
    evidence_references: [`evidence://events/${RUN_ID}/3`],
    ...overrides,
  };
}

function validationContent(
  overrides: Partial<DshValidationSummaryArtifact> = {},
): DshValidationSummaryArtifact {
  return {
    run_id: RUN_ID,
    state: "stopped",
    base_sha: REPOSITORY.base_sha,
    head_sha: HEAD_SHA,
    branch: "autofixer/tsk_prep_1-c0ffee0",
    validation: [evidence()],
    ...overrides,
  };
}

function envelope<T>(artifactType: string, content: T, digest = "12".repeat(32)) {
  return {
    run_id: RUN_ID,
    artifact_type: artifactType,
    digest: { algorithm: "sha256", value: digest },
    content,
  };
}

/** The three artifacts dsh retains for one stopped, validated preparation. */
function artifactSet(
  options: {
    patch?: DshPatchDiffArtifact;
    candidate?: DshCandidateArtifact;
    validation?: DshValidationSummaryArtifact;
  } = {},
): Map<string, Record<string, unknown>> {
  return new Map<string, Record<string, unknown>>([
    ["patch_diff", envelope("patch_diff", options.patch ?? patchDiffContent())],
    [
      "candidate",
      envelope("candidate", options.candidate ?? candidateContent(), CANDIDATE_ENVELOPE),
    ],
    [
      "validation_summary",
      envelope("validation_summary", options.validation ?? validationContent()),
    ],
  ]);
}

function reader(artifacts: Map<string, Record<string, unknown>>) {
  return {
    async getArtifact(runId: string, artifactId: string): Promise<Record<string, unknown>> {
      expect(runId).toBe(RUN_ID);
      const artifact = artifacts.get(artifactId);
      if (artifact === undefined) {
        throw new Error(`no artifact ${artifactId}`);
      }
      return structuredClone(artifact);
    },
  };
}

function bridge(
  collab: CollabMachine,
  artifacts: Map<string, Record<string, unknown>>,
  checks: string[] = [CHECK],
): PreparationBridge {
  return new PreparationBridge({
    machine: collab,
    dsh: reader(artifacts),
    actor: "orchestrator:local",
    policy: { checks, environment: "dsh-isolated-v1" },
  });
}

function observation(run: DshRunResponse, overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID,
    workspace: WORKSPACE,
    repository: {
      repository_id: REPOSITORY.repository_id,
      base_ref: "main",
      base_sha: REPOSITORY.base_sha,
    },
    summary: "Change the export button constant.",
    sourceReference: "https://github.com/FoMo-Exp/AutoFixer/issues/42",
    run,
    ...overrides,
  };
}

function issueOf(collab: CollabMachine) {
  const issue = collab.listIssues()[0];
  if (issue === undefined) {
    throw new Error("expected a collaboration issue");
  }
  return issue;
}

function onlyCandidate(collab: CollabMachine, issueId: string): CandidateRecord {
  const candidates = collab.listCandidates(issueId);
  expect(candidates).toHaveLength(1);
  return candidates[0] as CandidateRecord;
}

describe("stopped preparation → frozen candidate (DAT-258)", () => {
  test("freezes the prepared revision with diff, validation, digest, and evidence", async () => {
    const collab = machine();
    const run = dshRun();
    const candidate = await bridge(collab, artifactSet()).observe(observation(run));

    expect(candidate).not.toBeNull();
    const frozen = candidate as CandidateRecord;
    expect(frozen).toMatchObject({
      base_sha: REPOSITORY.base_sha,
      head_sha: HEAD_SHA,
      tree_sha: TREE_SHA,
      summary: "Change the export button constant.",
      diff: {
        digest_algorithm: "sha256",
        digest: DIFF_DIGEST,
        changed_paths: ["web/src/export.ts"],
        insertions: 1,
        deletions: 1,
      },
      risk: { class: "low", requires_human_approval: false },
      invalidated_at: null,
    });
    expect(frozen.validation.required_checks).toEqual([CHECK]);
    expect(frozen.validation.environment).toBe("dsh-isolated-v1");
    expect(frozen.validation.results).toHaveLength(1);
    expect(frozen.validation.results[0]).toMatchObject({
      tool: CHECK,
      exit_status: 0,
      output_digest: { algorithm: "sha256", value: TEST_OUTPUT },
    });
    expect(frozen.validation.results[0]?.event_reference).toMatch(
      new RegExp(`^evidence://runs/${frozen.run_id}/artifacts/art_`),
    );
    expect(frozen.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      "candidate",
      "patch",
      "report",
      "test_report",
    ]);
    // Every audit reference resolves against the run's retained records.
    expect(frozen.audit_refs.length).toBeGreaterThan(0);
    for (const reference of frozen.audit_refs) {
      expect(reference).toMatch(
        new RegExp(`^evidence://runs/${frozen.run_id}/(artifacts|grants|plans)/`),
      );
    }
    expect(frozen.audit_refs).toContainEqual(
      expect.stringMatching(new RegExp(`^evidence://runs/${frozen.run_id}/grants/`)),
    );
    expect(frozen.audit_refs).toContainEqual(
      expect.stringMatching(new RegExp(`^evidence://runs/${frozen.run_id}/plans/`)),
    );

    // The collaboration record mirrors the whole preparation.
    const issue = issueOf(collab);
    expect(issue.dedupe_key).toBe(`autofixer-task:${TASK_ID}`);
    expect(issue.product_state).toBe("awaiting_change_approval");
    const recorded = collab.listRuns(issue.issue_id)[0];
    expect(frozen.run_id).toBe(recorded?.run_id);
    expect(recorded?.worktree.worktree_id).toBe(`dsh-${RUN_ID}`);
    expect(recorded?.state).toBe("stopped");
    expect(recorded?.head_sha).toBe(HEAD_SHA);
    expect(recorded?.lease).toBeNull();
    expect(recorded?.grants.every((grant) => grant.revoked_at !== null)).toBe(true);
    expect(recorded?.artifact_refs.every((ref) => ref.base_sha === REPOSITORY.base_sha)).toBe(true);
    expect(recorded?.artifact_refs.every((ref) => ref.head_sha === HEAD_SHA)).toBe(true);

    // Local only: no delivery operation (and therefore no provider write)
    // appears anywhere in the append-only record.
    const commands = collab.auditLog().map((record) => record.command);
    expect(commands).toContain("freeze_candidate");
    for (const command of commands) {
      expect(command).not.toBe("request_delivery");
      expect(command).not.toBe("record_delivery_state");
    }
  });

  test("re-observing the same run returns the recorded candidate without a second freeze", async () => {
    const collab = machine();
    const run = dshRun();
    const first = await bridge(collab, artifactSet()).observe(observation(run));
    const second = await bridge(collab, artifactSet()).observe(observation(run));

    expect(first).not.toBeNull();
    expect(second?.candidate_id).toBe(first?.candidate_id);
    expect(
      collab
        .auditLog()
        .filter((record) => record.command === "freeze_candidate" && record.outcome === "applied"),
    ).toHaveLength(1);
    expect(collab.listCandidates(issueOf(collab).issue_id)).toHaveLength(1);
  });

  test("a restarted machine still returns the frozen candidate", async () => {
    const collab = machine();
    const run = dshRun();
    const first = await bridge(collab, artifactSet()).observe(observation(run));

    const restarted = CollabMachine.fromAudit(collab.auditLog(), {
      now: () => new Date("2026-11-03T00:05:00.000Z"),
      candidateStore: new CandidateContentStore(path.join(root, "candidates")),
    });
    const replay = await bridge(restarted, artifactSet()).observe(observation(run));
    expect(replay?.candidate_id).toBe(first?.candidate_id);
  });

  test("a later run for the same task reuses the issue and freezes its own candidate", async () => {
    const collab = machine();
    const first = await bridge(collab, artifactSet()).observe(observation(dshRun()));
    expect(first).not.toBeNull();

    const run2 = dshRun({
      run_id: PREVIOUS_RUN_ID,
      patch_report: {
        contract_version: "task-evidence-contract-v1",
        patch_status: "prepared_no_pr",
        base_sha: REPOSITORY.base_sha,
        branch: "autofixer/tsk_prep_1-badc0de",
        head_sha: HEAD2,
        pr_id: null,
        change_summary: "Second revision.",
        validation: [evidence()],
        evidence_references: [`evidence://events/${PREVIOUS_RUN_ID}/3`],
        report_digest: REPORT_DIGEST,
      },
    });
    const diff2 = `${DIFF}-export const other = 3;\n`;
    const digest2 = diffDigest(diff2);
    const set2 = artifactSet({
      patch: patchDiffContent({
        diff: diff2,
        diff_digest: digest2,
        head_sha: HEAD2,
        tree_sha: TREE2,
      }),
      candidate: candidateContent({
        run_id: PREVIOUS_RUN_ID,
        head_sha: HEAD2,
        tree_sha: TREE2,
        diff_digest: digest2,
        summary: "Second revision.",
      }),
      validation: validationContent({
        run_id: PREVIOUS_RUN_ID,
        head_sha: HEAD2,
      }),
    });
    const bridge2 = new PreparationBridge({
      machine: collab,
      dsh: {
        async getArtifact(_runId: string, artifactId: string) {
          return structuredClone(set2.get(artifactId) as Record<string, unknown>);
        },
      },
      actor: "orchestrator:local",
      policy: { checks: [CHECK], environment: "dsh-isolated-v1" },
    });
    const second = await bridge2.observe(observation(run2));

    expect(second).not.toBeNull();
    expect(second?.issue_id).toBe(first?.issue_id);
    expect(second?.head_sha).not.toBe(first?.head_sha);
    expect(collab.listCandidates(first?.issue_id as string)).toHaveLength(2);
    expect(collab.listIssues()).toHaveLength(1);
  });

  test("a nonzero validation attempt produces no candidate and needs human disposition", async () => {
    const collab = machine();
    const failed = evidence({ exit_status: 1 });
    const run = dshRun();
    const set = artifactSet({
      candidate: candidateContent({ validation: [failed] }),
      validation: validationContent({ validation: [failed] }),
    });
    const candidate = await bridge(collab, set).observe(observation(run));

    expect(candidate).toBeNull();
    const issue = issueOf(collab);
    expect(issue.product_state).toBe("needs_human");
    expect(issue.state_reason).toContain(`preparation_failed:${RUN_ID}:`);
    expect(collab.listCandidates(issue.issue_id)).toEqual([]);
    // The preparation was dispositioned before any run record was opened.
    expect(collab.listRuns(issue.issue_id)).toEqual([]);
  });

  test("a required check with no recorded attempt produces no candidate", async () => {
    const collab = machine();
    const candidate = await bridge(collab, artifactSet(), [CHECK, "node.test"]).observe(
      observation(dshRun()),
    );

    expect(candidate).toBeNull();
    expect(issueOf(collab).product_state).toBe("needs_human");
    expect(collab.listCandidates(issueOf(collab).issue_id)).toEqual([]);
  });

  test("a stopped preparation without evidence is not a candidate and records no issue", async () => {
    const collab = machine();
    const run = dshRun({
      patch_report: {
        patch_status: "not_created",
        base_sha: REPOSITORY.base_sha,
        branch: null,
        head_sha: null,
        pr_id: null,
      },
    });
    const candidate = await bridge(collab, artifactSet()).observe(observation(run));

    expect(candidate).toBeNull();
    expect(collab.listIssues()).toEqual([]);
    expect(collab.auditLog()).toEqual([]);
  });

  test("an artifact set that disagrees about the revision is refused", async () => {
    const collab = machine();
    const set = artifactSet({
      candidate: candidateContent({ head_sha: "f".repeat(40) }),
    });
    await expect(bridge(collab, set).observe(observation(dshRun()))).rejects.toBeInstanceOf(
      CollabError,
    );
    expect(issueOf(collab).product_state).toBe("needs_human");
    expect(collab.listCandidates(issueOf(collab).issue_id)).toEqual([]);
  });

  test("a diff whose content does not hash to its digest is refused", async () => {
    const collab = machine();
    const set = artifactSet({
      patch: patchDiffContent({ diff: `${DIFF}+tampered\n` }),
    });
    await expect(bridge(collab, set).observe(observation(dshRun()))).rejects.toBeInstanceOf(
      CollabError,
    );
    expect(issueOf(collab).product_state).toBe("needs_human");
    expect(collab.listCandidates(issueOf(collab).issue_id)).toEqual([]);
  });

  test("a failed preparation is dispositioned once, not re-transitioned on every observation", async () => {
    const collab = machine();
    const run = dshRun();
    const set = artifactSet({
      candidate: candidateContent({ validation: [] }),
    });
    expect(await bridge(collab, set).observe(observation(run))).toBeNull();
    expect(await bridge(collab, set).observe(observation(run))).toBeNull();

    const transitions = collab
      .auditLog()
      .filter((record) => record.command === "transition_issue" && record.outcome === "applied");
    expect(transitions).toHaveLength(1);
    expect(issueOf(collab).product_state).toBe("needs_human");
  });
});

describe("task service completion integration (DAT-258)", () => {
  test("a recovered stopped preparation freezes the candidate before the terminal projection", async () => {
    const collab = machine();
    const artifacts = artifactSet();
    const client = {
      async getRun() {
        return structuredClone(dshRun());
      },
      async getArtifact(runId: string, artifactId: string) {
        expect(runId).toBe(RUN_ID);
        return structuredClone(artifacts.get(artifactId) as Record<string, unknown>);
      },
    };
    const preparation = new PreparationBridge({
      machine: collab,
      dsh: client,
      actor: "orchestrator:local",
      policy: { checks: [CHECK], environment: "dsh-isolated-v1" },
    });

    const store = new TaskStore();
    const record = createTaskRecord({
      id: TASK_ID,
      workspaceId: WORKSPACE.workspace_id,
      enterpriseId: WORKSPACE.enterprise_id,
      repository: {
        id: REPOSITORY.repository_id,
        display_name: "FoMo-Exp/AutoFixer",
        base_ref: "main",
        base_sha: REPOSITORY.base_sha,
      },
      summary: "Change the export button constant.",
      sourceReference: "https://github.com/FoMo-Exp/AutoFixer/issues/42",
      acceptanceCriteria: [],
    });
    record.runId = RUN_ID;
    record.runs.push({
      run_id: RUN_ID,
      state: "running",
      created_at: record.createdAt,
    });
    record.status = "validating";
    store.put(record);

    const service = new TaskService({
      config: CONFIG,
      dsh: client as unknown as DshClient,
      store,
      gateway: {} as never,
      workspaceBindings: {
        resolve() {
          throw new Error("not used");
        },
      },
      runScope: () => SCOPE,
      preparation,
    });

    await service.recoverFromDsh();

    expect(record.status).toBe("stopped");
    expect(record.terminal).toBe(true);
    expect(record.artifactIndex.map((artifact) => artifact.artifact_id)).toContain("candidate");
    expect(
      record.artifactIndex.find((artifact) => artifact.artifact_id === "candidate"),
    ).toMatchObject({
      available: true,
      digest: DIFF_DIGEST,
      head_sha: HEAD_SHA,
    });
    const types = record.events.map((event) => event.type);
    expect(types).toContain("validation.completed");
    expect(types).toContain("artifact.available");

    const issue = issueOf(collab);
    expect(issue.product_state).toBe("awaiting_change_approval");
    const candidate = onlyCandidate(collab, issue.issue_id);
    expect(candidate.run_id).toBe(collab.listRuns(issue.issue_id)[0]?.run_id);
    expect(candidate).toMatchObject({
      head_sha: HEAD_SHA,
      diff: { digest: DIFF_DIGEST },
    });
  });
});
