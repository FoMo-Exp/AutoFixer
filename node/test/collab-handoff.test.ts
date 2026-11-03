import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { CollabError } from "../src/collab/errors.js";
import { CollabMachine } from "../src/collab/machine.js";
import type { RecordHandoffInput } from "../src/collab/machine.js";
import {
  DIGEST,
  OTHER_DIGEST,
  acquireLease,
  artifactInput,
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
  return path.join(mkdtempSync(path.join(tmpdir(), "collab-handoff-")), "state.json");
}

const HEAD_SHA = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const BASE_SHA = "52081eaddca099967fd8be13b3060337fde50d3f";

/** Issue + run with one candidate artifact and a held lease. */
function preparedRun(machine: CollabMachine) {
  const issue = planningIssue(machine);
  const run = openRun(machine, issue.issue_id);
  const lease = acquireLease(machine, run.run_id, "worker:a", 3600);
  const ref = leaseRef(lease);
  const artifact = machine.attachArtifact({
    operation_id: op(),
    actor: "worker:a",
    run_id: run.run_id,
    lease: ref,
    artifact: artifactInput(),
  });
  machine.recordRunState({
    operation_id: op(),
    actor: "worker:a",
    run_id: run.run_id,
    lease: ref,
    to: "approved",
    head_sha: HEAD_SHA,
  });
  return { issue_id: issue.issue_id, run_id: run.run_id, ref, artifact };
}

function handoffInput(fixture: ReturnType<typeof preparedRun>): RecordHandoffInput {
  return {
    operation_id: op(),
    actor: "worker:a",
    issue_id: fixture.issue_id,
    from_run_id: fixture.run_id,
    to_run_id: null,
    summary: "Candidate prepared; tests pass locally; see attached evidence.",
    artifact_refs: [
      {
        artifact_id: fixture.artifact.artifact_id,
        kind: "candidate",
        digest_algorithm: "sha256",
        digest: DIGEST,
        base_sha: BASE_SHA,
        head_sha: HEAD_SHA,
      },
    ],
    head_identity: { base_sha: BASE_SHA, head_sha: HEAD_SHA },
    lease: fixture.ref,
  };
}

describe("handoffs carry bounded summaries and immutable references", () => {
  test("a handoff records summary, artifact references, and head identity", () => {
    const machine = makeMachine();
    const fixture = preparedRun(machine);
    const handoff = machine.recordHandoff(handoffInput(fixture));
    expect(handoff.summary.length).toBeGreaterThan(0);
    expect(handoff.artifact_refs[0]?.digest).toBe(DIGEST);
    expect(handoff.head_identity).toEqual({ base_sha: BASE_SHA, head_sha: HEAD_SHA });
    expect(machine.listHandoffs(fixture.issue_id)).toHaveLength(1);
  });

  test("a redelivered handoff is recorded once", () => {
    const machine = makeMachine();
    const fixture = preparedRun(machine);
    const input = handoffInput(fixture);
    const first = machine.recordHandoff(input);
    const second = machine.recordHandoff(input);
    expect(second).toEqual(first);
    expect(machine.listHandoffs(fixture.issue_id)).toHaveLength(1);
    expect(machine.auditLog().filter((record) => record.command === "record_handoff")).toHaveLength(
      1,
    );
  });

  test("unbounded or empty summaries are rejected", () => {
    const machine = makeMachine();
    const fixture = preparedRun(machine);
    expectCode(
      () => machine.recordHandoff({ ...handoffInput(fixture), summary: "" }),
      "INVALID_INPUT",
    );
    expectCode(
      () => machine.recordHandoff({ ...handoffInput(fixture), summary: "x".repeat(2001) }),
      "INVALID_INPUT",
    );
    expect(machine.listHandoffs(fixture.issue_id)).toHaveLength(0);
  });

  test("raw memory and transcripts are not handoff fields", () => {
    const machine = makeMachine();
    const fixture = preparedRun(machine);
    for (const forbidden of ["raw_memory", "session_transcript", "messages", "chat_history"]) {
      expectCode(
        () =>
          machine.recordHandoff({
            ...handoffInput(fixture),
            [forbidden]: "everything the agent ever saw",
          } as RecordHandoffInput),
        "INVALID_INPUT",
      );
    }
    // Nested shapes are strict too: a smuggled field inside head_identity fails.
    expectCode(
      () =>
        machine.recordHandoff({
          ...handoffInput(fixture),
          head_identity: { base_sha: BASE_SHA, head_sha: HEAD_SHA, note: "unbounded context" },
        } as RecordHandoffInput),
      "INVALID_INPUT",
    );
    expect(machine.listHandoffs(fixture.issue_id)).toHaveLength(0);
  });

  test("references must resolve to the source run's immutable artifacts", () => {
    const machine = makeMachine();
    const fixture = preparedRun(machine);
    expectCode(
      () =>
        machine.recordHandoff({
          ...handoffInput(fixture),
          artifact_refs: [
            {
              artifact_id: "art_unknown",
              kind: "candidate",
              digest_algorithm: "sha256",
              digest: OTHER_DIGEST,
              base_sha: BASE_SHA,
              head_sha: HEAD_SHA,
            },
          ],
        }),
      "ARTIFACT_NOT_FOUND",
    );
    // Same artifact id with a rewritten digest is refused, not silently accepted.
    expectCode(
      () =>
        machine.recordHandoff({
          ...handoffInput(fixture),
          artifact_refs: [
            {
              artifact_id: fixture.artifact.artifact_id,
              kind: "candidate",
              digest_algorithm: "sha256",
              digest: OTHER_DIGEST,
              base_sha: BASE_SHA,
              head_sha: HEAD_SHA,
            },
          ],
        }),
      "ARTIFACT_NOT_FOUND",
    );
  });

  test("head identity must match the source run", () => {
    const machine = makeMachine();
    const fixture = preparedRun(machine);
    expectCode(
      () =>
        machine.recordHandoff({
          ...handoffInput(fixture),
          head_identity: {
            base_sha: BASE_SHA,
            head_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          },
        }),
      "INVALID_INPUT",
    );
  });

  test("only the lease holder may record a handoff", () => {
    const machine = makeMachine();
    const fixture = preparedRun(machine);
    expectCode(
      () =>
        machine.recordHandoff({
          ...handoffInput(fixture),
          lease: { holder: "worker:intruder", fencing_token: fixture.ref.fencing_token },
        }),
      "LEASE_STALE",
    );
  });

  test("a recorded handoff is immutable and survives restarts", () => {
    const clock = { now: () => new Date("2026-11-03T00:00:00.000Z") };
    const stateFile = tempState();
    const machine = new CollabMachine({ persistencePath: stateFile, now: clock.now });
    const fixture = preparedRun(machine);
    const handoff = machine.recordHandoff(handoffInput(fixture));

    // Callers only ever see copies; mutating one cannot rewrite history.
    handoff.summary = "rewritten";
    const reread = machine.listHandoffs(fixture.issue_id)[0];
    expect(reread?.summary).toBe("Candidate prepared; tests pass locally; see attached evidence.");
    const restarted = new CollabMachine({ persistencePath: stateFile, now: clock.now });
    expect(restarted.listHandoffs(fixture.issue_id)).toEqual([reread]);
    expect(restarted.snapshotDigest()).toBe(machine.snapshotDigest());
  });

  test("handoff artifacts stay bound to the run's base revision", () => {
    const machine = makeMachine();
    const fixture = preparedRun(machine);
    expectCode(
      () =>
        machine.recordHandoff({
          ...handoffInput(fixture),
          head_identity: { base_sha: "0000000000000000000000000000000000000000", head_sha: null },
        }),
      "INVALID_INPUT",
    );
  });
});
