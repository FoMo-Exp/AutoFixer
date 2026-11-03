import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { CollabError } from "../src/collab/errors.js";
import { CollabMachine } from "../src/collab/machine.js";
import {
  Clock,
  acquireLease,
  artifactInput,
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

function tempState(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "collab-lease-")), "state.json");
}

describe("lease and fencing token", () => {
  test("one holder at a time, with monotonic fencing tokens", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine);
    const run = openRun(machine, issue.issue_id);
    const first = acquireLease(machine, run.run_id, "worker:a", 60);
    expect(first.fencing_token).toBe(1);

    expectCode(() => acquireLease(machine, run.run_id, "worker:b", 60), "LEASE_HELD");
    expectCode(
      () =>
        machine.renewLease({
          operation_id: op(),
          actor: "worker:b",
          run_id: run.run_id,
          holder: "worker:b",
          fencing_token: 1,
          ttl_seconds: 60,
        }),
      "LEASE_STALE",
    );
    expectCode(
      () =>
        machine.renewLease({
          operation_id: op(),
          actor: "worker:a",
          run_id: run.run_id,
          holder: "worker:a",
          fencing_token: 99,
          ttl_seconds: 60,
        }),
      "LEASE_STALE",
    );

    const released = machine.releaseLease({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      holder: "worker:a",
      fencing_token: 1,
    });
    expect(released.fencing_token).toBe(1);
    const second = acquireLease(machine, run.run_id, "worker:b", 60);
    expect(second.fencing_token).toBe(2);
  });

  test("an expired lease frees the run and the fencing token keeps counting", () => {
    const clock = new Clock();
    const machine = makeMachine(clock);
    const issue = planningIssue(machine);
    const run = openRun(machine, issue.issue_id);
    acquireLease(machine, run.run_id, "worker:a", 60);
    clock.advance(61);
    const takeover = acquireLease(machine, run.run_id, "worker:b", 60);
    expect(takeover.fencing_token).toBe(2);
    expect(takeover.holder).toBe("worker:b");
  });

  test("a stale worker cannot mutate the run its lease lost", () => {
    const clock = new Clock();
    const machine = makeMachine(clock);
    const issue = planningIssue(machine);
    const run = openRun(machine, issue.issue_id);
    const stale = leaseRef(acquireLease(machine, run.run_id, "worker:a", 60));
    clock.advance(61);
    const fresh = leaseRef(acquireLease(machine, run.run_id, "worker:b", 60));

    // worker:a still believes it owns the run; its fencing token is stale.
    expectCode(
      () =>
        machine.recordRunState({
          operation_id: op(),
          actor: "worker:a",
          run_id: run.run_id,
          lease: stale,
          to: "approved",
        }),
      "LEASE_STALE",
    );
    expectCode(
      () =>
        machine.attachArtifact({
          operation_id: op(),
          actor: "worker:a",
          run_id: run.run_id,
          lease: stale,
          artifact: artifactInput(),
        }),
      "LEASE_STALE",
    );
    expect(machine.getRun(run.run_id)?.state).toBe("requested");

    machine.recordRunState({
      operation_id: op(),
      actor: "worker:b",
      run_id: run.run_id,
      lease: fresh,
      to: "approved",
    });
    expect(machine.getRun(run.run_id)?.state).toBe("approved");
  });

  test("run mutations need a lease at all", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine);
    const run = openRun(machine, issue.issue_id);
    expectCode(
      () =>
        machine.recordGrant({
          operation_id: op(),
          actor: "worker:a",
          run_id: run.run_id,
          lease: { holder: "worker:a", fencing_token: 1 },
          grant: grantInput(),
        }),
      "LEASE_REQUIRED",
    );
  });

  test("renewing extends the lease window for the same holder", () => {
    const clock = new Clock();
    const machine = makeMachine(clock);
    const issue = planningIssue(machine);
    const run = openRun(machine, issue.issue_id);
    const lease = acquireLease(machine, run.run_id, "worker:a", 30);
    clock.advance(20);
    machine.renewLease({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      holder: "worker:a",
      fencing_token: lease.fencing_token,
      ttl_seconds: 30,
    });
    clock.advance(20);
    expectCode(() => acquireLease(machine, run.run_id, "worker:b", 60), "LEASE_HELD");
    expect(machine.getRun(run.run_id)?.lease?.fencing_token).toBe(1);
  });

  test("fencing tokens survive a restart and never regress", () => {
    const clock = new Clock();
    const stateFile = tempState();
    const machine = new CollabMachine({ persistencePath: stateFile, now: clock.now });
    const issue = planningIssue(machine);
    const run = openRun(machine, issue.issue_id);
    acquireLease(machine, run.run_id, "worker:a", 60);
    machine.flushSync();

    const restarted = new CollabMachine({ persistencePath: stateFile, now: clock.now });
    expect(restarted.getRun(run.run_id)?.lease).toMatchObject({
      holder: "worker:a",
      fencing_token: 1,
    });
    expectCode(() => acquireLease(restarted, run.run_id, "worker:b", 60), "LEASE_HELD");
    clock.advance(61);
    expect(acquireLease(restarted, run.run_id, "worker:b", 60).fencing_token).toBe(2);
  });
});

describe("worktree exclusivity", () => {
  test("one worktree is bound to one active run", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine);
    const run = openRun(machine, issue.issue_id, {
      worktree: { worktree_id: "wt_shared", path: "/tmp/worktrees/shared" },
    });
    expectCode(
      () =>
        openRun(machine, issue.issue_id, {
          worktree: { worktree_id: "wt_shared", path: "/tmp/worktrees/other" },
        }),
      "WORKTREE_CONFLICT",
    );
    expectCode(
      () =>
        openRun(machine, issue.issue_id, {
          worktree: { worktree_id: "wt_other", path: "/tmp/worktrees/shared" },
        }),
      "WORKTREE_CONFLICT",
    );
    expect(machine.listRuns(issue.issue_id)).toHaveLength(1);

    // A terminal run releases its worktree; a stopped run still holds it.
    const lease = acquireLease(machine, run.run_id);
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: leaseRef(lease),
      to: "cancelled",
      stop_reason: "operator cancelled",
    });
    const replacement = openRun(machine, issue.issue_id, {
      worktree: { worktree_id: "wt_shared", path: "/tmp/worktrees/shared" },
    });
    expect(replacement.run_id).not.toBe(run.run_id);
    expect(machine.listRuns(issue.issue_id)).toHaveLength(2);
  });

  test("a stopped run keeps its worktree binding", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine);
    const run = openRun(machine, issue.issue_id, {
      worktree: { worktree_id: "wt_stopped", path: "/tmp/worktrees/stopped" },
    });
    const lease = acquireLease(machine, run.run_id);
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: leaseRef(lease),
      to: "approved",
    });
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: leaseRef(lease),
      to: "running",
    });
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: leaseRef(lease),
      to: "stopped",
      stop_reason: "preparation complete",
    });
    expectCode(
      () =>
        openRun(machine, issue.issue_id, {
          worktree: { worktree_id: "wt_stopped", path: "/tmp/worktrees/stopped" },
        }),
      "WORKTREE_CONFLICT",
    );
  });
});
