import { mkdtempSync, writeFileSync } from "node:fs";
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
  return path.join(mkdtempSync(path.join(tmpdir(), "collab-restart-")), "state.json");
}

describe("restart rebuilds only persisted state", () => {
  test("a restart reproduces the same machine from the audit log", () => {
    const clock = new Clock();
    const stateFile = tempState();
    const machine = new CollabMachine({ persistencePath: stateFile, now: clock.now });
    const issue = planningIssue(machine, { dedupe_key: "signal-restart" });
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
    machine.attachArtifact({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      artifact: artifactInput(),
    });

    const restarted = new CollabMachine({ persistencePath: stateFile, now: clock.now });
    expect(restarted.snapshotDigest()).toBe(machine.snapshotDigest());
    expect(restarted.getRun(run.run_id)).toEqual(machine.getRun(run.run_id));
    expect(restarted.listIssues()).toHaveLength(1);
  });

  test("grants that expired or were revoked while the process was down never revive", () => {
    const clock = new Clock();
    const stateFile = tempState();
    const machine = new CollabMachine({ persistencePath: stateFile, now: clock.now });
    const issue = planningIssue(machine, { dedupe_key: "signal-grants" });
    const run = openRun(machine, issue.issue_id);
    const ref = leaseRef(acquireLease(machine, run.run_id));
    const expiring = machine.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      grant: grantInput({ expires_at: "2026-11-03T00:30:00.000Z" }),
    });
    machine.flushSync();

    clock.advance(31 * 60);
    const restarted = new CollabMachine({ persistencePath: stateFile, now: clock.now });
    expect(restarted.grantStates(run.run_id)).toEqual([
      { grant_id: expiring.grant_id, state: "expired" },
    ]);

    const revokedIssue = planningIssue(restarted, { dedupe_key: "signal-revoked" });
    const revokedRun = openRun(restarted, revokedIssue.issue_id);
    const revokedRef = leaseRef(acquireLease(restarted, revokedRun.run_id));
    const revoked = restarted.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: revokedRun.run_id,
      lease: revokedRef,
      grant: grantInput({ expires_at: "2026-11-03T06:00:00.000Z" }),
    });
    restarted.revokeGrant({
      operation_id: op(),
      actor: "human:operator",
      run_id: revokedRun.run_id,
      grant_id: revoked.grant_id,
      reason: "security review",
    });
    restarted.flushSync();
    const again = new CollabMachine({ persistencePath: stateFile, now: clock.now });
    expect(again.grantStates(revokedRun.run_id)).toEqual([
      { grant_id: revoked.grant_id, state: "revoked" },
    ]);
  });
});

describe("stopped and terminal runs are never auto-restarted", () => {
  function stoppedRun(machine: CollabMachine) {
    const issue = planningIssue(machine, { dedupe_key: "signal-stop-restart" });
    const run = openRun(machine, issue.issue_id);
    const ref = leaseRef(acquireLease(machine, run.run_id, "worker:a", 3600));
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
    return { issue_id: issue.issue_id, run_id: run.run_id };
  }

  test("queue retries and model messages cannot restart a stopped run", () => {
    const machine = makeMachine();
    const fixture = stoppedRun(machine);
    for (const trigger of ["queue_retry", "model_message"] as const) {
      expectCode(
        () =>
          machine.requestRunRestart({
            operation_id: op(),
            actor: "queue:dispatcher",
            run_id: fixture.run_id,
            trigger,
          }),
        "RUN_RESTART_FORBIDDEN",
      );
    }
    expect(machine.getRun(fixture.run_id)?.state).toBe("stopped");
    expect(machine.listRuns(fixture.issue_id)).toHaveLength(1);
    expect(machine.grantStates(fixture.run_id)[0]?.state).toBe("revoked");
  });

  test("a terminal run absorbs restart attempts and state observations", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "signal-terminal-restart" });
    const run = openRun(machine, issue.issue_id);
    const ref = leaseRef(acquireLease(machine, run.run_id));
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: run.run_id,
      lease: ref,
      to: "cancelled",
      stop_reason: "operator cancelled",
    });
    expectCode(
      () =>
        machine.requestRunRestart({
          operation_id: op(),
          actor: "queue:dispatcher",
          run_id: run.run_id,
          trigger: "queue_retry",
        }),
      "RUN_RESTART_FORBIDDEN",
    );
    expectCode(
      () =>
        machine.recordRunState({
          operation_id: op(),
          actor: "worker:a",
          run_id: run.run_id,
          lease: ref,
          to: "approved",
        }),
      "RUN_TERMINAL",
    );
    expect(machine.getRun(run.run_id)?.state).toBe("cancelled");
    expect(machine.listRuns(issue.issue_id)).toHaveLength(1);
  });

  test("continuing after a stop needs a new grant and human disposition", () => {
    const clock = new Clock();
    const machine = makeMachine(clock);
    const fixture = stoppedRun(machine);
    const ref = { holder: "worker:a", fencing_token: 1 };
    clock.advance(10 * 60);

    // No grant at all: the stopped -> approved edge is closed.
    expectCode(
      () =>
        machine.recordRunState({
          operation_id: op(),
          actor: "worker:a",
          run_id: fixture.run_id,
          lease: ref,
          to: "approved",
        }),
      "GRANT_REQUIRED",
    );

    // The pre-stop grant is not a new grant, even with disposition.
    const preStopGrant = machine.getRun(fixture.run_id)?.grants[0];
    if (!preStopGrant) {
      throw new Error("missing pre-stop grant");
    }
    expectCode(
      () =>
        machine.recordRunState({
          operation_id: op(),
          actor: "worker:a",
          run_id: fixture.run_id,
          lease: ref,
          to: "approved",
          new_grant_id: preStopGrant.grant_id,
          disposition: { actor: "human:ludwig", reference: "disposition://1" },
        }),
      "GRANT_REQUIRED",
    );

    // A new grant that was revoked again never revives.
    const fresh = machine.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: fixture.run_id,
      lease: ref,
      grant: grantInput({
        issued_at: "2026-11-03T00:05:00.000Z",
        expires_at: "2026-11-03T05:00:00.000Z",
      }),
    });
    machine.revokeGrant({
      operation_id: op(),
      actor: "human:operator",
      run_id: fixture.run_id,
      grant_id: fresh.grant_id,
      reason: "scope changed",
    });
    expectCode(
      () =>
        machine.recordRunState({
          operation_id: op(),
          actor: "worker:a",
          run_id: fixture.run_id,
          lease: ref,
          to: "approved",
          new_grant_id: fresh.grant_id,
          disposition: { actor: "human:ludwig", reference: "disposition://1" },
        }),
      "GRANT_REVOKED",
    );

    // A new grant that expired in the meantime never revives.
    const expiring = machine.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: fixture.run_id,
      lease: ref,
      grant: grantInput({
        issued_at: "2026-11-03T00:05:00.000Z",
        expires_at: "2026-11-03T00:12:00.000Z",
      }),
    });
    clock.advance(10 * 60);
    expectCode(
      () =>
        machine.recordRunState({
          operation_id: op(),
          actor: "worker:a",
          run_id: fixture.run_id,
          lease: ref,
          to: "approved",
          new_grant_id: expiring.grant_id,
          disposition: { actor: "human:ludwig", reference: "disposition://1" },
        }),
      "GRANT_EXPIRED",
    );

    // A live new grant still requires the human disposition itself.
    const good = machine.recordGrant({
      operation_id: op(),
      actor: "worker:a",
      run_id: fixture.run_id,
      lease: ref,
      grant: grantInput({
        issued_at: "2026-11-03T00:15:00.000Z",
        expires_at: "2026-11-03T05:00:00.000Z",
      }),
    });
    expectCode(
      () =>
        machine.recordRunState({
          operation_id: op(),
          actor: "worker:a",
          run_id: fixture.run_id,
          lease: ref,
          to: "approved",
          new_grant_id: good.grant_id,
        }),
      "DISPOSITION_REQUIRED",
    );
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:a",
      run_id: fixture.run_id,
      lease: ref,
      to: "approved",
      new_grant_id: good.grant_id,
      disposition: { actor: "human:ludwig", reference: "disposition://2" },
    });
    expect(machine.getRun(fixture.run_id)?.state).toBe("approved");
  });
});

describe("corrupt or unknown state fails closed", () => {
  test("unparseable state files do not start a machine", () => {
    const stateFile = tempState();
    writeFileSync(stateFile, "{not json", "utf8");
    expect(() => new CollabMachine({ persistencePath: stateFile })).toThrow();
  });

  test("a newer schema is refused instead of misread", () => {
    const stateFile = tempState();
    writeFileSync(stateFile, JSON.stringify({ schema_version: 2, audit: [] }), "utf8");
    expect(() => new CollabMachine({ persistencePath: stateFile })).toThrow(/schema/);
  });

  test("a tampered audit log is refused instead of trusted", () => {
    const machine = makeMachine();
    const issue = planningIssue(machine, { dedupe_key: "signal-tamper" });
    const log = machine.auditLog();
    const record = log.find((entry) => entry.command === "create_issue");
    if (!record) {
      throw new Error("missing create_issue record");
    }
    record.payload = { ...record.payload, issue_id: "iss_someone_elses" };
    expect(() => CollabMachine.fromAudit(log)).toThrow(/not intact/);
    expect(machine.getIssue(issue.issue_id)).toBeDefined();
  });
});
