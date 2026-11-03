import { CollabMachine } from "../../src/collab/machine.js";
import type {
  ArtifactInput,
  CreateIssueInput,
  GrantInput,
  OpenRunInput,
} from "../../src/collab/machine.js";
import type { IssueRecord, LeaseRecord, RunRecord } from "../../src/collab/types.js";

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
