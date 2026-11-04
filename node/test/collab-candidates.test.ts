import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  CandidateContentStore,
  CandidateReviewService,
  CollabMachine,
  artifactEvidenceRef,
  assertCandidateCurrent,
  candidateFreshness,
  diffDigest,
  grantEvidenceRef,
  validationEvidenceDigest,
} from "../src/collab/index.js";
import type { CollabError } from "../src/collab/errors.js";
import {
  CANDIDATE_DIFF,
  DIGEST,
  OTHER_DIGEST,
  REPOSITORY,
  Clock,
  freezeCandidateInput,
  op,
  openRun,
  planningIssue,
  stoppedPreparation,
} from "./helpers/collab.js";
import type { PreparationContext } from "./helpers/collab.js";
import type { CandidateRecord, CandidateValidationResult } from "../src/collab/index.js";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as CollabError).code).toBe(code);
    return;
  }
  throw new Error(`expected denial ${code}`);
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autofixer-candidates-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function store(rootPath = root): CandidateContentStore {
  return new CandidateContentStore(rootPath);
}

function machineWithStore(rootPath = root, clock = new Clock()): CollabMachine {
  return new CollabMachine({ now: clock.now, candidateStore: store(rootPath) });
}

function frozen(machine: CollabMachine): {
  context: PreparationContext;
  candidateId: string;
  issueId: string;
} {
  const issue = planningIssue(machine);
  const context = stoppedPreparation(machine, issue.issue_id);
  const candidate = machine.freezeCandidate(freezeCandidateInput(context));
  return { context, candidateId: candidate.candidate_id, issueId: issue.issue_id };
}

function candidateOf(machine: CollabMachine, candidateId: string): CandidateRecord {
  const candidate = machine.getCandidate(candidateId);
  if (candidate === undefined) {
    throw new Error(`candidate ${candidateId} is missing`);
  }
  return candidate;
}

describe("immutable candidate freeze (DAT-219)", () => {
  test("freezing records candidate identity, diff digest, validation evidence, and provenance", () => {
    const machine = machineWithStore();
    const { context, candidateId } = frozen(machine);
    const candidate = machine.getCandidate(candidateId);

    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({
      issue_id: context.issue.issue_id,
      run_id: context.run.run_id,
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
      risk: { class: "low", requires_human_approval: false },
      invalidated_at: null,
      invalidated_reason: null,
    });
    expect(candidate?.validation.environment).toBe("node20-linux-x64-isolated");
    expect(candidate?.validation.results).toHaveLength(1);
    expect(candidate?.artifacts.map((artifact) => artifact.kind)).toEqual([
      "candidate",
      "patch",
      "report",
    ]);
    expect(candidate?.audit_refs).toHaveLength(3);
    for (const reference of candidate?.audit_refs ?? []) {
      expect(reference).toMatch(
        new RegExp(`^evidence://runs/${context.run.run_id}/(artifacts|grants)/`),
      );
    }
    // A frozen candidate carries no delivery surface: no branch, no PR.
    expect(Object.keys(candidate ?? {})).not.toContain("branch");
    expect(Object.keys(candidate ?? {})).not.toContain("pr_id");
  });

  test("the frozen diff digest is independently recomputable from retained content", () => {
    const machine = machineWithStore();
    const service = new CandidateReviewService(machine, store());
    const { candidateId } = frozen(machine);

    const diff = service.diff(machine.getCandidate(candidateId)?.issue_id as string, candidateId);
    expect(diff.content).toBe(CANDIDATE_DIFF);
    expect(diffDigest(diff.content)).toBe(diff.digest);
    expect(diff.digest).toBe(machine.getCandidate(candidateId)?.diff.digest);
  });

  test("a candidate survives deletion of the ephemeral worktree", () => {
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree, { recursive: true });
    const contentRoot = path.join(root, "retained");
    const machine = machineWithStore(contentRoot);
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id, { worktreePath: worktree });
    const candidate = machine.freezeCandidate(freezeCandidateInput(context));

    fs.rmSync(worktree, { recursive: true, force: true });
    const service = new CandidateReviewService(machine, store(contentRoot));
    expect(service.get(issue.issue_id, candidate.candidate_id).head_sha).toBe(context.head_sha);
    expect(service.diff(issue.issue_id, candidate.candidate_id).content).toBe(CANDIDATE_DIFF);
  });

  test("content retained inside the worktree is refused", () => {
    const worktree = path.join(root, "ephemeral");
    fs.mkdirSync(worktree, { recursive: true });
    const machine = machineWithStore(worktree);
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id, { worktreePath: worktree });

    expectCode(() => machine.freezeCandidate(freezeCandidateInput(context)), "CANDIDATE_INVALID");
    expect(machine.listCandidates(issue.issue_id)).toEqual([]);
  });

  test("diff content that does not hash to the declared digest is refused", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);

    expectCode(
      () =>
        machine.freezeCandidate(
          freezeCandidateInput(context, { diff_content: `${CANDIDATE_DIFF}+tampered\n` }),
        ),
      "CANDIDATE_INVALID",
    );
    expect(machine.listCandidates(issue.issue_id)).toEqual([]);
    expect(machine.auditLog().some((record) => record.command === "freeze_candidate")).toBe(false);
  });

  test("freezing against a base that already advanced is refused", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);

    machine.recordBaseAdvance({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      base_sha: "a".repeat(40),
    });
    expectCode(
      () =>
        machine.freezeCandidate(freezeCandidateInput(context, { base_sha: REPOSITORY.base_sha })),
      "BASE_ADVANCED",
    );
  });

  test("freezing before the preparation run stops is refused", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const run = openRun(machine, issue.issue_id);
    const input = {
      operation_id: op(),
      actor: "worker:a",
      issue_id: issue.issue_id,
      run_id: run.run_id,
      summary: "premature candidate",
      base_sha: REPOSITORY.base_sha,
      head_sha: "deadbeef",
      tree_sha: "deadbeef",
      diff: {
        digest_algorithm: "sha256",
        digest: diffDigest(CANDIDATE_DIFF),
        changed_paths: ["src/retry.ts"],
        insertions: 1,
        deletions: 0,
      },
      diff_content: CANDIDATE_DIFF,
      validation: {
        config_digest: `sha256:${OTHER_DIGEST}`,
        environment: "node20-linux-x64-isolated",
        required_checks: ["npm test"],
        results: [
          {
            tool: "npm test",
            exit_status: 0,
            output_digest: { algorithm: "sha256", value: DIGEST },
            event_reference: "evidence://events/run/1",
          },
        ],
      },
      risk: { class: "low" as const, decision_code: "risk_low", requires_human_approval: false },
      artifact_ids: [],
      audit_refs: ["evidence://events/run/1"],
    };
    expectCode(() => machine.freezeCandidate(input), "CANDIDATE_INVALID");
  });

  test("a candidate whose patch artifact is not bound is refused", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    const nonPatchArtifacts = context.artifacts
      .filter((artifact) => artifact.kind !== "patch")
      .map((artifact) => artifact.artifact_id);

    expectCode(
      () =>
        machine.freezeCandidate(freezeCandidateInput(context, { artifact_ids: nonPatchArtifacts })),
      "CANDIDATE_INVALID",
    );
  });

  test("evidence references must point at retained audit records", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    expectCode(
      () =>
        machine.freezeCandidate(
          freezeCandidateInput(context, { audit_refs: ["https://example.com/raw-diff"] }),
        ),
      "CANDIDATE_INVALID",
    );
  });

  test("a failed, unexecuted, or digest-less validation attempt cannot freeze", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    const report = context.artifacts.find((artifact) => artifact.kind === "report");
    const ref = artifactEvidenceRef(context.run.run_id, report?.artifact_id as string);

    const cases: CandidateValidationResult[] = [
      {
        tool: "npm test -- retry",
        exit_status: 1,
        output_digest: { algorithm: "sha256", value: DIGEST },
        event_reference: ref,
      },
      {
        tool: "npm test -- retry",
        exit_status: null,
        output_digest: { algorithm: "sha256", value: DIGEST },
        event_reference: ref,
      },
      { tool: "npm test -- retry", exit_status: 0, output_digest: null, event_reference: ref },
    ];
    for (const result of cases) {
      expectCode(
        () =>
          machine.freezeCandidate(
            freezeCandidateInput(context, {
              validation: {
                config_digest: `sha256:${OTHER_DIGEST}`,
                environment: "node20-linux-x64-isolated",
                required_checks: ["npm test -- retry"],
                results: [result],
              },
            }),
          ),
        "CANDIDATE_INVALID",
      );
    }
    expect(machine.listCandidates(issue.issue_id)).toEqual([]);
  });

  test("every required check needs a recorded passing attempt", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    const report = context.artifacts.find((artifact) => artifact.kind === "report");
    const ref = artifactEvidenceRef(context.run.run_id, report?.artifact_id as string);
    const results = [
      {
        tool: "npm test -- retry",
        exit_status: 0,
        output_digest: { algorithm: "sha256", value: DIGEST },
        event_reference: ref,
      },
    ];

    expectCode(
      () =>
        machine.freezeCandidate(
          freezeCandidateInput(context, {
            validation: {
              config_digest: `sha256:${OTHER_DIGEST}`,
              environment: "node20-linux-x64-isolated",
              required_checks: ["npm test -- retry", "go test ./..."],
              results,
            },
          }),
        ),
      "CANDIDATE_INVALID",
    );
    expectCode(
      () =>
        machine.freezeCandidate(
          freezeCandidateInput(context, {
            validation: {
              config_digest: `sha256:${OTHER_DIGEST}`,
              environment: "node20-linux-x64-isolated",
              required_checks: [],
              results,
            },
          }),
        ),
      "CANDIDATE_INVALID",
    );
  });

  test("fabricated evidence references cannot freeze a candidate", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    const report = context.artifacts.find((artifact) => artifact.kind === "report");
    const ref = artifactEvidenceRef(context.run.run_id, report?.artifact_id as string);

    for (const reference of [
      "evidence://events/run_does_not_exist/7",
      `evidence://runs/${context.run.run_id}/artifacts/art_does_not_exist`,
      `evidence://runs/${context.run.run_id}/grants/grt_does_not_exist`,
    ]) {
      expectCode(
        () => machine.freezeCandidate(freezeCandidateInput(context, { audit_refs: [reference] })),
        "CANDIDATE_INVALID",
      );
      expectCode(
        () =>
          machine.freezeCandidate(
            freezeCandidateInput(context, {
              validation: {
                config_digest: `sha256:${OTHER_DIGEST}`,
                environment: "node20-linux-x64-isolated",
                required_checks: ["npm test -- retry"],
                results: [
                  {
                    tool: "npm test -- retry",
                    exit_status: 0,
                    output_digest: { algorithm: "sha256", value: DIGEST },
                    event_reference: reference,
                  },
                ],
              },
            }),
          ),
        "CANDIDATE_INVALID",
      );
    }
    expect(machine.listCandidates(issue.issue_id)).toEqual([]);
    void ref;
  });

  test("another run's artifact or a non-revision record cannot stand in as evidence", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const first = stoppedPreparation(machine, issue.issue_id, {
      worktreeId: "wt_first",
      worktreePath: "/tmp/worktrees/wt_first",
    });
    const second = stoppedPreparation(machine, issue.issue_id, {
      worktreeId: "wt_second",
      worktreePath: "/tmp/worktrees/wt_second",
    });
    const foreignArtifact = second.artifacts.find((artifact) => artifact.kind === "report");
    const foreignRef = artifactEvidenceRef(
      second.run.run_id,
      foreignArtifact?.artifact_id as string,
    );
    const grantRef = grantEvidenceRef(first.run.run_id, first.run.grants[0]?.grant_id as string);
    const sameRunOtherRevision = artifactEvidenceRef(
      first.run.run_id,
      first.other_revision_artifact.artifact_id,
    );

    // Evidence of another run never freezes this run's candidate.
    expectCode(
      () => machine.freezeCandidate(freezeCandidateInput(first, { audit_refs: [foreignRef] })),
      "CANDIDATE_INVALID",
    );
    // Validation evidence must be an artifact of the exact revision, not a
    // grant record and not an artifact produced from another head.
    for (const reference of [grantRef, sameRunOtherRevision]) {
      expectCode(
        () =>
          machine.freezeCandidate(
            freezeCandidateInput(first, {
              validation: {
                config_digest: `sha256:${OTHER_DIGEST}`,
                environment: "node20-linux-x64-isolated",
                required_checks: ["npm test -- retry"],
                results: [
                  {
                    tool: "npm test -- retry",
                    exit_status: 0,
                    output_digest: { algorithm: "sha256", value: DIGEST },
                    event_reference: reference,
                  },
                ],
              },
            }),
          ),
        "CANDIDATE_INVALID",
      );
    }
    expect(machine.listCandidates(issue.issue_id)).toEqual([]);
  });

  test("prohibited risk never becomes a reviewable candidate", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    expectCode(
      () =>
        machine.freezeCandidate(
          freezeCandidateInput(context, {
            risk: {
              class: "prohibited",
              decision_code: "prohibited_secret_access",
              requires_human_approval: false,
            },
          }),
        ),
      "CANDIDATE_INVALID",
    );
  });

  test("elevated risk must require human approval and low risk must not", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    expectCode(
      () =>
        machine.freezeCandidate(
          freezeCandidateInput(context, {
            risk: { class: "elevated", decision_code: "elevated", requires_human_approval: false },
          }),
        ),
      "CANDIDATE_INVALID",
    );
  });

  test("one preparation run freezes exactly one candidate", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    const first = machine.freezeCandidate(freezeCandidateInput(context));
    expectCode(
      () =>
        machine.freezeCandidate(freezeCandidateInput(context, { summary: "a rewritten revision" })),
      "CANDIDATE_CONFLICT",
    );
    expect(machine.listCandidates(issue.issue_id).map((entry) => entry.candidate_id)).toEqual([
      first.candidate_id,
    ]);
  });

  test("idempotent redelivery returns the recorded candidate and appends nothing", () => {
    const machine = machineWithStore();
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    const input = freezeCandidateInput(context);
    const before = machine.auditLog().length;
    const first = machine.freezeCandidate(input);
    const after = machine.auditLog().length;
    // Queue redelivery reuses the same operation id and payload.
    const second = machine.freezeCandidate(input);
    expect(second).toEqual(first);
    expect(machine.auditLog().length).toBe(after);
    expect(after).toBe(before + 1);
  });
});

describe("candidate invalidation and base advancement", () => {
  test("a later base invalidates the frozen candidate and blocks reuse", () => {
    const machine = machineWithStore();
    const { candidateId, issueId } = frozen(machine);

    const result = machine.recordBaseAdvance({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issueId,
      base_sha: "b".repeat(40),
      base_ref: "main",
    });
    expect(result.invalidated_candidate_ids).toEqual([candidateId]);
    expect(result.issue.repository.base_sha).toBe("b".repeat(40));

    const candidate = candidateOf(machine, candidateId);
    expect(candidate.invalidated_at).not.toBeNull();
    expect(candidate.invalidated_reason).toBe("base_advanced");
    expect(candidateFreshness(candidate)).toEqual({
      current: false,
      reason: "base_advanced",
    });
    expectCode(() => assertCandidateCurrent(candidate), "BASE_ADVANCED");
  });

  test("an observed base that moved makes the candidate stale even without a recorded advance", () => {
    const machine = machineWithStore();
    const { candidateId } = frozen(machine);
    expect(machine.candidateFreshness(candidateId, "c".repeat(40))).toEqual({
      current: false,
      reason: "base_advanced",
    });
    expect(machine.candidateFreshness(candidateId, REPOSITORY.base_sha)).toEqual({
      current: true,
      reason: null,
    });
  });

  test("invalidation is permanent, closed-vocabulary, and idempotent", () => {
    const machine = machineWithStore();
    const { candidateId } = frozen(machine);

    const invalidated = machine.invalidateCandidate({
      operation_id: op(),
      actor: "human:operator",
      candidate_id: candidateId,
      reason: "target_changed",
    });
    expect(invalidated.invalidated_reason).toBe("target_changed");
    const again = machine.invalidateCandidate({
      operation_id: op(),
      actor: "human:operator",
      candidate_id: candidateId,
      reason: "content_changed",
    });
    expect(again.invalidated_reason).toBe("target_changed");
    expectCode(
      () => assertCandidateCurrent(candidateOf(machine, candidateId)),
      "CANDIDATE_INVALID",
    );
    expectCode(
      () =>
        machine.invalidateCandidate({
          operation_id: op(),
          actor: "human:operator",
          candidate_id: candidateId,
          reason: "made_up_reason" as never,
        }),
      "INVALID_INPUT",
    );
  });

  test("the test-evidence digest changes when validation evidence changes", () => {
    const machine = machineWithStore();
    const { candidateId } = frozen(machine);
    const candidate = candidateOf(machine, candidateId);
    const baseline = validationEvidenceDigest(candidate.validation);
    const changed = validationEvidenceDigest({
      ...candidate.validation,
      results: candidate.validation.results.map((result) => ({ ...result, exit_status: 1 })),
    });
    expect(changed).not.toBe(baseline);
  });
});

describe("candidate list pagination", () => {
  test("the list pages with a stable cursor and rejects an unknown one", () => {
    const clock = new Clock();
    const machine = machineWithStore(root, clock);
    const service = new CandidateReviewService(machine, store(), { pageSize: 2 });
    const issue = planningIssue(machine);
    const frozenIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const context = stoppedPreparation(machine, issue.issue_id, {
        worktreeId: `wt_page_${index}`,
        worktreePath: `/tmp/worktrees/wt_page_${index}`,
      });
      frozenIds.push(
        machine.freezeCandidate(freezeCandidateInput(context, { summary: `candidate ${index}` }))
          .candidate_id,
      );
      clock.advance(1);
    }

    const first = service.page(issue.issue_id);
    expect(first.items.map((card) => card.candidate_id)).toEqual(frozenIds.slice(0, 2));
    expect(first.next_cursor).toBe(frozenIds[1]);

    const second = service.page(issue.issue_id, first.next_cursor);
    expect(second.items.map((card) => card.candidate_id)).toEqual([frozenIds[2]]);
    expect(second.next_cursor).toBeNull();

    // A re-read of the same cursor yields the same page (no duplicate/loss).
    expect(service.page(issue.issue_id, first.next_cursor)).toEqual(second);
    expectCode(() => service.page(issue.issue_id, "cand_unknown"), "INVALID_CURSOR");
  });

  test("one page sizes the whole list when it fits", () => {
    const machine = machineWithStore();
    const service = new CandidateReviewService(machine, store());
    const { issueId } = frozen(machine);
    const page = service.page(issueId);
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
  });
});

describe("candidate retention boundary", () => {
  test("a store root that is a symlink into the worktree is refused", () => {
    const worktree = path.join(root, "wt_symlink");
    fs.mkdirSync(worktree, { recursive: true });
    const alias = path.join(root, "alias");
    fs.symlinkSync(worktree, alias, "dir");

    const machine = machineWithStore(alias);
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id, {
      worktreeId: "wt_symlink",
      worktreePath: worktree,
    });
    expectCode(() => machine.freezeCandidate(freezeCandidateInput(context)), "CANDIDATE_INVALID");
  });

  test("a store root below a symlinked parent inside the worktree is refused", () => {
    const worktree = path.join(root, "wt_parent");
    fs.mkdirSync(worktree, { recursive: true });
    const alias = path.join(root, "alias_parent");
    fs.symlinkSync(worktree, alias, "dir");
    const storeRoot = path.join(alias, "retained");

    const machine = machineWithStore(storeRoot);
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id, {
      worktreeId: "wt_parent",
      worktreePath: worktree,
    });
    expectCode(() => machine.freezeCandidate(freezeCandidateInput(context)), "CANDIDATE_INVALID");
  });

  test("a store reached through a symlink to a real outside directory is accepted", () => {
    const worktree = path.join(root, "wt_real");
    const retained = path.join(root, "retained_real");
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(retained, { recursive: true });
    const alias = path.join(root, "alias_outside");
    fs.symlinkSync(retained, alias, "dir");

    const machine = machineWithStore(alias);
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id, {
      worktreeId: "wt_real",
      worktreePath: worktree,
    });
    const candidate = machine.freezeCandidate(freezeCandidateInput(context));
    expect(candidate.issue_id).toBe(issue.issue_id);
  });
});

describe("candidate durability and audit replay", () => {
  test("replaying the audit log reproduces the frozen candidate", () => {
    const machine = machineWithStore();
    const { candidateId } = frozen(machine);
    const before = machine.getCandidate(candidateId);

    const replayed = CollabMachine.fromAudit(machine.auditLog(), {
      candidateStore: store(),
      now: new Clock().now,
    });
    expect(replayed.getCandidate(candidateId)).toEqual(before);
    expect(replayed.snapshotDigest()).toBe(machine.snapshotDigest());
  });

  test("a persisted machine retains the candidate across a restart", () => {
    const persistencePath = path.join(root, "collab.json");
    const clock = new Clock();
    const machine = new CollabMachine({
      persistencePath,
      candidateStore: store(),
      now: clock.now,
    });
    const { candidateId } = frozen(machine);

    const restarted = new CollabMachine({
      persistencePath,
      candidateStore: store(),
      now: clock.now,
    });
    expect(restarted.getCandidate(candidateId)?.candidate_id).toBe(candidateId);
    const issueId = candidateOf(restarted, candidateId).issue_id;
    const service = new CandidateReviewService(restarted, store());
    expect(service.diff(issueId, candidateId).content).toBe(CANDIDATE_DIFF);
  });

  test("a missing content blob fails closed instead of serving an unverified diff", () => {
    const machine = machineWithStore();
    const { candidateId, issueId } = frozen(machine);
    fs.rmSync(root, { recursive: true, force: true });
    const service = new CandidateReviewService(machine, store());
    expectCode(() => service.diff(issueId, candidateId), "CANDIDATE_NOT_FOUND");
  });

  test("no preparation capability survives the freeze", () => {
    const machine = machineWithStore();
    const { context, candidateId } = frozen(machine);
    const states = machine.grantStates(context.run.run_id);
    expect(states.length).toBeGreaterThan(0);
    expect(states.map((state) => state.state)).toEqual(["revoked"]);
    expect(candidateOf(machine, candidateId).run_id).toBe(context.run.run_id);
  });

  test("freezing records no delivery operation and no provider write", () => {
    const machine = machineWithStore();
    const { candidateId } = frozen(machine);
    const commands = machine.auditLog().map((record) => record.command);
    expect(commands).toContain("freeze_candidate");
    expect(commands.some((command) => command.startsWith("deliver"))).toBe(false);
    expect(machine.getCandidate(candidateId)?.diff.digest).toBe(diffDigest(CANDIDATE_DIFF));
    expect(OTHER_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    expect(DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });
});
