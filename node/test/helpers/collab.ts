import { diffDigest } from "../../src/collab/candidate-store.js";
import {
  artifactEvidenceRef,
  grantEvidenceRef,
  planEvidenceRef,
} from "../../src/collab/evidence.js";
import { CollabMachine } from "../../src/collab/machine.js";
import type {
  ArtifactInput,
  CreateIssueInput,
  FreezeCandidateInput,
  GrantInput,
  OpenRunInput,
} from "../../src/collab/machine.js";
import type { ArtifactRef, IssueRecord, LeaseRecord, RunRecord } from "../../src/collab/types.js";

/** Controllable clock so lease/grant expiry is deterministic in tests. */
export class Clock {
  private time: number;

  constructor(start = "2026-11-03T00:00:00.000Z") {
    this.time = Date.parse(start);
  }

  now = (): Date => new Date(this.time);

  advance(seconds: number): void {
    this.time += seconds * 1000;
  }
}

let counter = 0;

/** Unique operation id per call; queue redelivery reuses the same value. */
export function op(): string {
  counter += 1;
  return `op_test_${counter}`;
}

export const WORKSPACE = { enterprise_id: "ent_test", workspace_id: "ws_test" };

export const REPOSITORY = {
  repository_id: "github:Luthiel/AutoFixer",
  url: "https://github.com/Luthiel/AutoFixer.git",
  base_ref: "main",
  base_sha: "52081eaddca099967fd8be13b3060337fde50d3f",
};

export const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
export const OTHER_DIGEST = "60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752";

export function makeMachine(clock?: Clock): CollabMachine {
  return new CollabMachine({ now: (clock ?? new Clock()).now });
}

export function createIssue(
  machine: CollabMachine,
  overrides: Partial<CreateIssueInput> = {},
): IssueRecord {
  return machine.createIssue({
    operation_id: op(),
    actor: "human:operator",
    workspace: WORKSPACE,
    repository: REPOSITORY,
    dedupe_key: "signal-1",
    summary: "reported failure in checkout",
    source_reference: "logs://event/1",
    ...overrides,
  });
}

export function toPlanning(machine: CollabMachine, issueId: string): void {
  machine.transitionIssue({
    operation_id: op(),
    actor: "human:operator",
    issue_id: issueId,
    to: "planning",
    reason: null,
  });
}

/** Create an issue already in `planning`, ready to open runs. */
export function planningIssue(machine: CollabMachine, overrides: Partial<CreateIssueInput> = {}) {
  const issue = createIssue(machine, overrides);
  toPlanning(machine, issue.issue_id);
  return machine.getIssue(issue.issue_id) as IssueRecord;
}

export function openRun(
  machine: CollabMachine,
  issueId: string,
  overrides: Partial<OpenRunInput> = {},
): RunRecord {
  counter += 1;
  return machine.openRun({
    operation_id: op(),
    actor: "worker:a",
    issue_id: issueId,
    task_id: null,
    role: "implementation",
    repository: REPOSITORY,
    worktree: { worktree_id: `wt_${counter}`, path: `/tmp/worktrees/wt_${counter}` },
    scope: { tools: ["read", "search", "edit", "test"], paths: ["src/**"], network: [] },
    limits: { max_wall_clock_seconds: 900, max_memory_mb: 512, max_tokens: 200_000 },
    ...overrides,
  });
}

export function acquireLease(
  machine: CollabMachine,
  runId: string,
  holder = "worker:a",
  ttlSeconds = 60,
): LeaseRecord {
  return machine.acquireLease({
    operation_id: op(),
    actor: holder,
    run_id: runId,
    holder,
    ttl_seconds: ttlSeconds,
  });
}

export function leaseRef(lease: LeaseRecord): { holder: string; fencing_token: number } {
  return { holder: lease.holder, fencing_token: lease.fencing_token };
}

export function grantInput(overrides: Partial<GrantInput> = {}): GrantInput {
  return {
    capability_grant_version: "1",
    policy_version: "governance-1",
    issued_at: "2026-11-03T00:00:00.000Z",
    expires_at: "2026-11-03T01:00:00.000Z",
    permitted_paths: ["src/**"],
    permitted_tools: [{ identity: "edit", allowed_arguments: ["src/**"] }],
    network_destinations: [],
    max_wall_clock_seconds: 900,
    resource_limits: { max_memory_mb: 512, max_tokens: 200_000 },
    may_create_patch: true,
    may_create_or_update_pr: false,
    scope_digest: "sha256:scope-1",
    ...overrides,
  };
}

/** The exact diff content one frozen candidate retains. */
export const CANDIDATE_DIFF = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -10,4 +10,6 @@ export function retryHeader(value: string | null): string {",
  "-  return value.trim();",
  "+  if (value === null) {",
  '+    return "";',
  "+  }",
  "+  return value.trim();",
  "",
].join("\n");

export const CANDIDATE_HEAD = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
/** Content digest of the retained test-report artifact. */
export const TEST_REPORT_DIGEST = "cd".repeat(32);
export const TEST_PLAN_CHECKS = ["npm test -- retry"];
export const TEST_PLAN_CONFIG_DIGEST = "sha256:" + "ef".repeat(32);
export const TEST_PLAN_ENVIRONMENT = "node20-linux-x64-isolated";
export const CANDIDATE_TREE = "d4e5f60718293a4b5c6d7e8f9012345678a1b2c3";

export interface PreparationContext {
  issue: IssueRecord;
  run: RunRecord;
  lease: { holder: string; fencing_token: number };
  artifacts: ArtifactRef[];
  /** An artifact retained by the run but produced from another revision. */
  other_revision_artifact: ArtifactRef;
  plan: { plan_id: string } | undefined;
  head_sha: string;
  tree_sha: string;
  diff_content: string;
  diff_digest: string;
}

/**
 * Drive one implementation run to a stopped preparation run that preserves
 * candidate, patch, and report artifacts, then move the issue into
 * `implementing` so a candidate may freeze.
 */
export function stoppedPreparation(
  machine: CollabMachine,
  issueId: string,
  overrides: { worktreePath?: string; worktreeId?: string; recordPlan?: boolean } = {},
): PreparationContext {
  const worktreeId = overrides.worktreeId ?? "wt_candidate";
  const run = openRun(machine, issueId, {
    worktree: {
      worktree_id: worktreeId,
      path: overrides.worktreePath ?? `/tmp/worktrees/${worktreeId}`,
    },
  });
  const lease = leaseRef(acquireLease(machine, run.run_id));
  machine.recordRunState({
    operation_id: op(),
    actor: "worker:a",
    run_id: run.run_id,
    lease,
    to: "approved",
  });
  machine.recordRunState({
    operation_id: op(),
    actor: "worker:a",
    run_id: run.run_id,
    lease,
    to: "running",
  });
  machine.recordGrant({
    operation_id: op(),
    actor: "worker:a",
    run_id: run.run_id,
    lease,
    grant: grantInput(),
  });
  if (overrides.recordPlan !== false) {
    machine.recordTestPlan({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease,
      config_digest: TEST_PLAN_CONFIG_DIGEST,
      environment: TEST_PLAN_ENVIRONMENT,
      checks: TEST_PLAN_CHECKS,
    });
  }
  const digest = diffDigest(CANDIDATE_DIFF);
  const artifacts = [
    machine.attachArtifact({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease,
      artifact: artifactInput({ kind: "candidate", digest, head_sha: CANDIDATE_HEAD }),
    }),
    machine.attachArtifact({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease,
      artifact: artifactInput({ kind: "patch", digest, head_sha: CANDIDATE_HEAD }),
    }),
    machine.attachArtifact({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease,
      artifact: artifactInput({
        kind: "report",
        digest: OTHER_DIGEST,
        head_sha: CANDIDATE_HEAD,
      }),
    }),
    machine.attachArtifact({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease,
      artifact: artifactInput({
        kind: "test_report",
        digest: TEST_REPORT_DIGEST,
        head_sha: CANDIDATE_HEAD,
      }),
    }),
  ];
  const otherRevisionArtifact = machine.attachArtifact({
    operation_id: op(),
    actor: "worker:a",
    run_id: run.run_id,
    lease,
    artifact: artifactInput({
      kind: "evidence_bundle",
      digest: "ab".repeat(32),
      head_sha: "e".repeat(40),
    }),
  });
  machine.recordRunState({
    operation_id: op(),
    actor: "worker:a",
    run_id: run.run_id,
    lease,
    to: "stopped",
    stop_reason: "local preparation complete; validation evidence recorded",
    head_sha: CANDIDATE_HEAD,
  });
  const issue = machine.getIssue(issueId) as IssueRecord;
  if (issue.product_state === "planning") {
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issueId,
      to: "implementing",
      reason: null,
    });
  }
  return {
    issue: machine.getIssue(issueId) as IssueRecord,
    run: machine.getRun(run.run_id) as RunRecord,
    lease,
    artifacts,
    other_revision_artifact: otherRevisionArtifact,
    plan: machine.getTestPlan(run.run_id),
    head_sha: CANDIDATE_HEAD,
    tree_sha: CANDIDATE_TREE,
    diff_content: CANDIDATE_DIFF,
    diff_digest: digest,
  };
}

/** A well-formed freeze command for a stopped preparation run. */
export function freezeCandidateInput(
  context: PreparationContext,
  overrides: Partial<FreezeCandidateInput> = {},
): FreezeCandidateInput {
  const patch = context.artifacts.find((artifact) => artifact.kind === "patch");
  const report = context.artifacts.find((artifact) => artifact.kind === "report");
  const testReport = context.artifacts.find((artifact) => artifact.kind === "test_report");
  if (patch === undefined || report === undefined || testReport === undefined) {
    throw new Error("preparation context has no patch/report/test_report artifact");
  }
  const patchRef = artifactEvidenceRef(context.run.run_id, patch.artifact_id);
  const reportRef = artifactEvidenceRef(context.run.run_id, report.artifact_id);
  const testReportRef = artifactEvidenceRef(context.run.run_id, testReport.artifact_id);
  const grant = context.run.grants[0];
  const plan = context.plan;
  if (grant === undefined) {
    throw new Error("preparation context has no recorded grant");
  }
  return {
    operation_id: op(),
    actor: "worker:a",
    issue_id: context.issue.issue_id,
    run_id: context.run.run_id,
    summary: "Guard the retry header against null and add a regression test.",
    base_sha: REPOSITORY.base_sha,
    head_sha: context.head_sha,
    tree_sha: context.tree_sha,
    diff: {
      digest_algorithm: "sha256",
      digest: context.diff_digest,
      changed_paths: ["src/retry.ts", "test/retry.test.ts"],
      insertions: 6,
      deletions: 1,
    },
    diff_content: context.diff_content,
    validation: {
      config_digest: TEST_PLAN_CONFIG_DIGEST,
      environment: TEST_PLAN_ENVIRONMENT,
      required_checks: [...TEST_PLAN_CHECKS],
      results: [
        {
          tool: TEST_PLAN_CHECKS[0] as string,
          exit_status: 0,
          output_digest: { algorithm: "sha256", value: TEST_REPORT_DIGEST },
          event_reference: testReportRef,
        },
      ],
    },
    risk: {
      class: "low",
      decision_code: "risk_low_approved",
      requires_human_approval: false,
    },
    artifact_ids: context.artifacts.map((artifact) => artifact.artifact_id),
    audit_refs: [
      patchRef,
      reportRef,
      testReportRef,
      ...(plan === undefined ? [] : [planEvidenceRef(context.run.run_id, plan.plan_id)]),
      grantEvidenceRef(context.run.run_id, grant.grant_id),
    ],
    ...overrides,
  };
}

export function artifactInput(overrides: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    kind: "candidate",
    digest_algorithm: "sha256",
    digest: DIGEST,
    base_sha: REPOSITORY.base_sha,
    head_sha: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
    ...overrides,
  };
}
