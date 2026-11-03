import { describe, expect, test } from "vitest";

import type { CollabError } from "../src/collab/errors.js";
import {
  Clock,
  acquireLease,
  artifactInput,
  createIssue,
  grantInput,
  leaseRef,
  makeMachine,
  openRun,
  op,
  planningIssue,
} from "./helpers/collab.js";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as CollabError).code).toBe(code);
    return;
  }
  throw new Error(`expected denial ${code}`);
}

describe("issue/task/run domain records", () => {
  test("a run records repository/base revision, worktree, scope, limits, and grants", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine);
    const run = openRun(machine, issue.issue_id);
    expect(run.repository).toMatchObject({ base_ref: "main" });
    expect(run.repository.base_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(run.worktree.worktree_id).toBeTruthy();
    expect(run.worktree.path).toBeTruthy();
    expect(run.scope).toEqual({
      tools: ["read", "search", "edit", "test"],
      paths: ["src/**"],
      network: [],
    });
    expect(run.limits).toEqual({
      max_wall_clock_seconds: 900,
      max_memory_mb: 512,
      max_tokens: 200_000,
    });
    expect(run.grants).toEqual([]);
    expect(run.workspace).toEqual(issue.workspace);

    const lease = acquireLease(machine, run.run_id);
    const grant = machine.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: leaseRef(lease),
      grant: grantInput(),
    });
    expect(grant.permitted_tools).toEqual([{ identity: "edit", allowed_arguments: ["src/**"] }]);
    expect(machine.getRun(run.run_id)?.grants).toHaveLength(1);
    expect(machine.grantStates(run.run_id)).toEqual([
      { grant_id: grant.grant_id, state: "active" },
    ]);
  });

  test("one issue may carry several bounded runs", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine);
    const first = openRun(machine, issue.issue_id);
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: first.run_id,
      lease: leaseRef(acquireLease(machine, first.run_id)),
      to: "approved",
    });
    const second = openRun(machine, issue.issue_id);
    expect(machine.listRuns(issue.issue_id).map((run) => run.run_id)).toEqual([
      first.run_id,
      second.run_id,
    ]);
  });

  test("child tasks carry roles, assignees, and dependencies", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine);
    const diagnosis = machine.addTask({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      role: "analysis",
      assignee_agent_id: "agent:planner",
      depends_on: [],
    });
    const implementation = machine.addTask({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      role: "implementation",
      assignee_agent_id: "agent:builder",
      depends_on: [diagnosis.task_id],
    });
    expect(machine.listTasks(issue.issue_id)).toHaveLength(2);
    expect(implementation.depends_on).toEqual([diagnosis.task_id]);

    expectCode(
      () =>
        machine.setTaskState({
          operation_id: op(),
          actor: "agent:builder",
          task_id: implementation.task_id,
          to: "active",
        }),
      "TASK_BLOCKED",
    );
    machine.setTaskState({
      operation_id: op(),
      actor: "agent:planner",
      task_id: diagnosis.task_id,
      to: "active",
    });
    machine.setTaskState({
      operation_id: op(),
      actor: "agent:planner",
      task_id: diagnosis.task_id,
      to: "done",
    });
    machine.setTaskState({
      operation_id: op(),
      actor: "agent:builder",
      task_id: implementation.task_id,
      to: "active",
    });
    expect(machine.getTask(implementation.task_id)?.state).toBe("active");
  });

  test("task dependencies must be sibling tasks and terminal tasks stay terminal", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine);
    expectCode(
      () =>
        machine.addTask({
          operation_id: op(),
          actor: "human:operator",
          issue_id: issue.issue_id,
          role: "verification",
          depends_on: ["tsk_unknown"],
        }),
      "TASK_DEPENDENCY_INVALID",
    );
    const task = machine.addTask({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      role: "verification",
      depends_on: [],
    });
    machine.setTaskState({
      operation_id: op(),
      actor: "agent:v",
      task_id: task.task_id,
      to: "cancelled",
    });
    expectCode(
      () =>
        machine.setTaskState({
          operation_id: op(),
          actor: "agent:v",
          task_id: task.task_id,
          to: "active",
        }),
      "TRANSITION_FORBIDDEN",
    );
  });
});

describe("product transitions and grant lifecycle", () => {
  test("illegal product jumps are denied and stop states need a reason", () => {
    const machine = makeMachine();
    const issue = createIssue(machine, { dedupe_key: "signal-jump" });
    expectCode(
      () =>
        machine.transitionIssue({
          operation_id: op(),
          actor: "human:operator",
          issue_id: issue.issue_id,
          to: "delivering",
          reason: null,
        }),
      "TRANSITION_FORBIDDEN",
    );
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to: "planning",
      reason: null,
    });
    expectCode(
      () =>
        machine.transitionIssue({
          operation_id: op(),
          actor: "human:operator",
          issue_id: issue.issue_id,
          to: "needs_human",
          reason: null,
        }),
      "INVALID_INPUT",
    );
  });

  test("needs_human and cancelled revoke every active grant of the issue", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "signal-revoke" });
    const run = openRun(machine, issue.issue_id);
    const lease = acquireLease(machine, run.run_id);
    const grant = machine.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: leaseRef(lease),
      grant: grantInput({ expires_at: "2026-11-03T05:00:00.000Z" }),
    });
    expect(machine.grantStates(run.run_id)).toEqual([
      { grant_id: grant.grant_id, state: "active" },
    ]);

    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to: "needs_human",
      reason: "routing produced no eligible owner",
    });
    expect(machine.grantStates(run.run_id)).toEqual([
      { grant_id: grant.grant_id, state: "revoked" },
    ]);
    expect(machine.getIssue(issue.issue_id)?.product_state).toBe("needs_human");
    // A revoked grant stays revoked even though its clock window is still open.
    expect(machine.grantStates(run.run_id, "2026-11-03T00:30:00.000Z")).toEqual([
      { grant_id: grant.grant_id, state: "revoked" },
    ]);
  });

  test("stopping a run revokes its grant", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "signal-stop" });
    const run = openRun(machine, issue.issue_id);
    const lease = acquireLease(machine, run.run_id);
    const ref = leaseRef(lease);
    machine.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      grant: grantInput(),
    });
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      to: "approved",
    });
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      to: "running",
    });
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      to: "stopped",
      stop_reason: "validation failed",
    });
    expect(machine.getRun(run.run_id)?.grants[0]?.revoked_reason).toBe("run_state:stopped");
    expect(machine.getRun(run.run_id)?.stop_reason).toBe("validation failed");
  });

  test("grant expiry is derived from the clock and never returns active", () => {
    const clock = new Clock();
    const machine = makeMachine(clock);
    const issue = planningIssue(machine, { dedupe_key: "signal-expiry" });
    const run = openRun(machine, issue.issue_id);
    const lease = acquireLease(machine, run.run_id);
    const grant = machine.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: leaseRef(lease),
      grant: grantInput({ expires_at: "2026-11-03T00:30:00.000Z" }),
    });
    expect(machine.grantStates(run.run_id)).toEqual([
      { grant_id: grant.grant_id, state: "active" },
    ]);
    clock.advance(31 * 60);
    expect(machine.grantStates(run.run_id)).toEqual([
      { grant_id: grant.grant_id, state: "expired" },
    ]);
    // Expiry is derived, not recorded: no revocation marker appears.
    expect(machine.getRun(run.run_id)?.grants[0]?.revoked_at).toBeNull();
  });

  test("a run cannot hold two active grants at once", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "signal-grants" });
    const run = openRun(machine, issue.issue_id);
    const lease = acquireLease(machine, run.run_id);
    const ref = leaseRef(lease);
    machine.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      grant: grantInput(),
    });
    expectCode(
      () =>
        machine.recordGrant({
          operation_id: op(),
          actor: "worker:a",
          run_id: run.run_id,
          lease: ref,
          grant: grantInput({ scope_digest: "sha256:scope-2" }),
        }),
      "ACTIVE_GRANT_EXISTS",
    );
    const first = machine.getRun(run.run_id)?.grants[0];
    if (!first) {
      throw new Error("missing first grant");
    }
    machine.revokeGrant({
      operation_id: op(),
      actor: "human:operator",
      run_id: run.run_id,
      grant_id: first.grant_id,
      reason: "superseded by a narrowed grant",
    });
    const second = machine.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      grant: grantInput({ scope_digest: "sha256:scope-2" }),
    });
    expect(second.scope_digest).toBe("sha256:scope-2");
    expect(machine.grantStates(run.run_id)).toEqual([
      { grant_id: first.grant_id, state: "revoked" },
      { grant_id: second.grant_id, state: "active" },
    ]);
  });

  test("grants bind artifacts to the run's exact base revision", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "signal-artifact" });
    const run = openRun(machine, issue.issue_id);
    const lease = acquireLease(machine, run.run_id);
    const ref = leaseRef(lease);
    expectCode(
      () =>
        machine.attachArtifact({
          operation_id: op(),
          actor: "worker:a",
          run_id: run.run_id,
          lease: ref,
          artifact: artifactInput({ base_sha: "0000000000000000000000000000000000000000" }),
        }),
      "INVALID_INPUT",
    );
    const artifact = machine.attachArtifact({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      artifact: artifactInput(),
    });
    expect(artifact.base_sha).toBe(run.repository.base_sha);
    expect(machine.getRun(run.run_id)?.artifact_refs).toHaveLength(1);
  });
});
