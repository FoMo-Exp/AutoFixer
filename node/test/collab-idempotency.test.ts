import { describe, expect, test } from "vitest";

import { auditChainProblem } from "../src/collab/audit.js";
import type { CollabError } from "../src/collab/errors.js";
import { CollabMachine } from "../src/collab/machine.js";
import type { CreateIssueInput, OpenRunInput } from "../src/collab/machine.js";
import {
  acquireLease,
  createIssue,
  leaseRef,
  makeMachine,
  openRun,
  op,
  planningIssue,
  REPOSITORY,
  WORKSPACE,
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

describe("operation-id idempotency under at-least-once delivery", () => {
  test("a redelivered create_issue returns the recorded issue and appends nothing", () => {
    const machine = makeMachine();
    const input: CreateIssueInput = {
      operation_id: op(),
      actor: "connector:logs",
      workspace: WORKSPACE,
      repository: REPOSITORY,
      dedupe_key: "provider-event-1",
      summary: "repeated alert",
      source_reference: "logs://event/1",
    };
    const first = machine.createIssue(input);
    const auditAfterFirst = machine.auditLog().length;
    const second = machine.createIssue(input);
    expect(second).toEqual(first);
    expect(machine.auditLog().length).toBe(auditAfterFirst);
    expect(machine.listIssues()).toHaveLength(1);
  });

  test("a replayed signal reuses the deduplicated issue even with a new operation id", () => {
    const machine = makeMachine();
    const first = createIssue(machine, { dedupe_key: "provider-event-2" });
    const second = createIssue(machine, { dedupe_key: "provider-event-2" });
    expect(second.issue_id).toBe(first.issue_id);
    expect(machine.listIssues()).toHaveLength(1);
  });

  test("the same dedupe key with a different payload is a recorded conflict", () => {
    const machine = makeMachine();
    createIssue(machine, { dedupe_key: "provider-event-3", summary: "original report" });
    expectCode(
      () => createIssue(machine, { dedupe_key: "provider-event-3", summary: "different report" }),
      "ISSUE_DEDUPE_CONFLICT",
    );
    expect(machine.listIssues()).toHaveLength(1);
    expect(machine.auditLog().at(-1)?.denial_code).toBe("ISSUE_DEDUPE_CONFLICT");
  });

  test("a replayed open_run yields exactly one run", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "provider-event-4" });
    const input: OpenRunInput = {
      operation_id: op(),
      actor: "worker:a",
      issue_id: issue.issue_id,
      task_id: null,
      role: "implementation",
      repository: REPOSITORY,
      worktree: { worktree_id: "wt_fixed", path: "/tmp/worktrees/wt_fixed" },
      scope: { tools: ["read"], paths: ["src/**"], network: [] },
      limits: { max_wall_clock_seconds: 900, max_memory_mb: 512, max_tokens: 200_000 },
    };
    const first = machine.openRun(input);
    const second = machine.openRun(input);
    expect(second).toEqual(first);
    expect(machine.listRuns(issue.issue_id)).toHaveLength(1);
  });

  test("one operation id never covers two different payloads", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "provider-event-5" });
    const auditBefore = machine.auditLog().length;
    expectCode(
      () =>
        machine.transitionIssue({
          operation_id: "op_shared",
          actor: "human:operator",
          issue_id: issue.issue_id,
          to: "completed",
          reason: null,
        }),
      "TRANSITION_FORBIDDEN",
    );
    const auditAfterDenial = machine.auditLog().length;
    expect(auditAfterDenial).toBe(auditBefore + 1);
    expectCode(
      () =>
        machine.transitionIssue({
          operation_id: "op_shared",
          actor: "human:operator",
          issue_id: issue.issue_id,
          to: "needs_human",
          reason: "confused",
        }),
      "OPERATION_CONFLICT",
    );
    // The protocol violation is not a domain event: nothing is appended and
    // the issue keeps the state it had.
    expect(machine.auditLog().length).toBe(auditAfterDenial);
    expect(machine.getIssue(issue.issue_id)?.product_state).toBe("planning");
  });

  test("a denied operation applies once its precondition lands", () => {
    const machine = makeMachine();
    const issue = createIssue(machine, { dedupe_key: "provider-event-6" });
    const input: OpenRunInput = {
      operation_id: op(),
      actor: "worker:a",
      issue_id: issue.issue_id,
      task_id: null,
      role: "analysis",
      repository: REPOSITORY,
      worktree: { worktree_id: "wt_retry", path: "/tmp/worktrees/wt_retry" },
      scope: { tools: ["read"], paths: [], network: [] },
      limits: { max_wall_clock_seconds: 600, max_memory_mb: 256, max_tokens: 50_000 },
    };
    expectCode(() => machine.openRun(input), "RUN_OPEN_FORBIDDEN");
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to: "planning",
      reason: null,
    });
    // Same operation id, same payload: the retry now applies exactly once.
    const run = machine.openRun(input);
    expect(run.state).toBe("requested");
    expect(machine.listRuns(issue.issue_id)).toHaveLength(1);
  });
});

describe("out-of-order events cannot jump run states", () => {
  test("a premature observation is denied and the ordered ones apply", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "signal-order" });
    const run = openRun(machine, issue.issue_id);
    const lease = acquireLease(machine, run.run_id);
    const ref = leaseRef(lease);

    expectCode(
      () =>
        machine.recordRunState({
          operation_id: op(),
          actor: "worker:a",
          run_id: run.run_id,
          lease: ref,
          to: "running",
        }),
      "TRANSITION_FORBIDDEN",
    );
    expect(machine.getRun(run.run_id)?.state).toBe("requested");

    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      to: "approved",
    });
    // A duplicate observation of an already-recorded state is not a self edge.
    expectCode(
      () =>
        machine.recordRunState({
          operation_id: op(),
          actor: "worker:a",
          run_id: run.run_id,
          lease: ref,
          to: "approved",
        }),
      "TRANSITION_FORBIDDEN",
    );
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      to: "running",
    });
    expect(machine.getRun(run.run_id)?.state).toBe("running");
  });

  test("terminal runs absorb every later observation", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "signal-terminal" });
    const run = openRun(machine, issue.issue_id);
    const lease = acquireLease(machine, run.run_id);
    const ref = leaseRef(lease);
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      to: "cancelled",
      stop_reason: "operator cancelled",
    });
    for (const to of ["approved", "running", "stopped"] as const) {
      expectCode(
        () =>
          machine.recordRunState({
            operation_id: op(),
            actor: "worker:a",
            run_id: run.run_id,
            lease: ref,
            to,
          }),
        "RUN_TERMINAL",
      );
    }
    expect(machine.getRun(run.run_id)?.state).toBe("cancelled");
  });
});

describe("the audit log reproduces the state machine history", () => {
  function busyMachine(): CollabMachine {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "signal-replay" });
    const run = openRun(machine, issue.issue_id);
    const lease = acquireLease(machine, run.run_id);
    const ref = leaseRef(lease);
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      to: "approved",
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
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to: "implementing",
      reason: null,
    });
    return machine;
  }

  test("replaying the log rebuilds an identical machine", () => {
    const machine = busyMachine();
    const log = machine.auditLog();
    expect(auditChainProblem(log)).toBeNull();

    const replayed = CollabMachine.fromAudit(log);
    expect(replayed.snapshotDigest()).toBe(machine.snapshotDigest());
    expect(replayed.auditLog().map((record) => record.digest)).toEqual(
      log.map((record) => record.digest),
    );
    // Denials replay as denials; applied attempts replay as the same results.
    expect(log.some((record) => record.outcome === "denied")).toBe(true);
  });

  test("a replayed machine still answers redeliveries idempotently", () => {
    const machine = busyMachine();
    const replayed = CollabMachine.fromAudit(machine.auditLog());
    const issueId = machine.listIssues()[0]?.issue_id;
    const record = machine
      .auditLog()
      .find((entry) => entry.command === "create_issue" && entry.outcome === "applied");
    const payload = record?.payload as Record<string, unknown>;
    const input = {
      operation_id: record?.operation_id ?? "",
      actor: record?.actor ?? "",
      workspace: payload["workspace"],
      repository: payload["repository"],
      dedupe_key: payload["dedupe_key"],
      summary: payload["summary"],
      source_reference: payload["source_reference"],
    };
    const auditBefore = replayed.auditLog().length;
    const again = replayed.createIssue(input as never);
    expect(again.issue_id).toBe(issueId);
    expect(replayed.auditLog().length).toBe(auditBefore);
  });

  test("tampering with a recorded payload breaks the chain", () => {
    const machine = busyMachine();
    const log = machine.auditLog();
    const target = log.find((record) => record.command === "create_issue");
    if (!target) {
      throw new Error("missing create_issue record");
    }
    target.payload = { ...target.payload, summary: "rewritten history" };
    expect(auditChainProblem(log)).toMatch(/payload digest mismatch/);
    expect(() => CollabMachine.fromAudit(log)).toThrow(/not intact/);
  });

  test("tampering with an audit field breaks the chain", () => {
    const machine = busyMachine();
    const log = machine.auditLog();
    const target = log[2];
    if (!target) {
      throw new Error("missing record");
    }
    target.at = "2030-01-01T00:00:00.000Z";
    expect(auditChainProblem(log)).not.toBeNull();
  });

  test("the snapshot digest is stable and moves with the state", () => {
    const machine = busyMachine();
    const digest = machine.snapshotDigest();
    expect(machine.snapshotDigest()).toBe(digest);
    const issueId = machine.listIssues()[0]?.issue_id;
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issueId ?? "",
      to: "validating",
      reason: null,
    });
    expect(machine.snapshotDigest()).not.toBe(digest);
  });
});
