import { describe, expect, test } from "vitest";

import type { CollabError } from "../src/collab/errors.js";
import {
  PRODUCT_STATES,
  PRODUCT_RUN_RELATION,
  PRODUCT_TRANSITIONS,
  RUN_STATE_TRANSITIONS,
  canTransitionProduct,
  canTransitionRun,
  isTerminalProductState,
  isTerminalRunState,
  productRunConflict,
  runTransitionIssueConflict,
} from "../src/collab/states.js";
import type { CollabMachine } from "../src/collab/machine.js";
import type { LeaseRecord, RunRecord } from "../src/collab/types.js";
import { DSH_STATES } from "../src/dsh/types.js";
import {
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

/** Product table as ADR-0007 defines it; also guards accidental edge edits. */
const ADR0007_PRODUCT_TABLE: Record<string, string[]> = {
  triage: ["planning", "needs_human", "cancelled"],
  planning: ["implementing", "needs_human", "cancelled"],
  implementing: ["validating", "needs_human", "cancelled"],
  validating: ["awaiting_change_approval", "needs_human", "cancelled"],
  awaiting_change_approval: ["delivering", "implementing", "needs_human", "cancelled"],
  delivering: ["pr_review", "needs_human", "cancelled"],
  pr_review: ["completed", "needs_human", "cancelled"],
  completed: [],
  needs_human: ["triage", "planning", "implementing", "cancelled"],
  cancelled: [],
};

/** FP-01 run-state table as `harness/state.go` implements it. */
const FP01_RUN_TABLE: Record<string, string[]> = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["running", "cancelled", "expired"],
  running: ["awaiting_review", "stopped", "timed_out", "cancelled"],
  awaiting_review: ["approved_for_merge", "stopped", "cancelled"],
  approved_for_merge: ["merged", "stopped"],
  stopped: ["cancelled", "approved"],
  timed_out: [],
  expired: [],
  rejected: [],
  cancelled: [],
  merged: [],
};

function expectTable(
  actual: Record<string, readonly string[]>,
  expected: Record<string, string[]>,
): void {
  for (const [from, edges] of Object.entries(expected)) {
    expect([...(actual[from] ?? [])].sort(), `edges of ${from}`).toEqual([...edges].sort());
  }
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as CollabError).code).toBe(code);
    return;
  }
  throw new Error(`expected denial ${code}`);
}

describe("product state machine (DAT-215)", () => {
  test("the product table matches ADR-0007's lifecycle", () => {
    expectTable(PRODUCT_TRANSITIONS, ADR0007_PRODUCT_TABLE);
  });

  test("completed and cancelled are terminal product states", () => {
    expect(isTerminalProductState("completed")).toBe(true);
    expect(isTerminalProductState("cancelled")).toBe(true);
    expect(isTerminalProductState("needs_human")).toBe(false);
    expect(canTransitionProduct("completed", "triage")).toBe(false);
    expect(canTransitionProduct("cancelled", "planning")).toBe(false);
  });

  test("self transitions are not edges in either vocabulary", () => {
    for (const state of PRODUCT_STATES) {
      expect(canTransitionProduct(state, state)).toBe(false);
    }
    for (const state of DSH_STATES) {
      expect(canTransitionRun(state, state)).toBe(false);
    }
  });
});

describe("harness run-state mirror (FP-01)", () => {
  test("mirrors harness/state.go exactly", () => {
    expectTable(RUN_STATE_TRANSITIONS, FP01_RUN_TABLE);
  });

  test("terminal run states have no outgoing edge", () => {
    for (const state of ["timed_out", "expired", "rejected", "cancelled", "merged"] as const) {
      expect(isTerminalRunState(state)).toBe(true);
    }
    expect(isTerminalRunState("stopped")).toBe(false);
    expect(isTerminalRunState("running")).toBe(false);
  });
});

describe("awaiting_change_approval is not harness awaiting_review", () => {
  test("the two vocabularies are separate kinds with no approval/review overlap", () => {
    expect(PRODUCT_STATES).toContain("awaiting_change_approval");
    expect(PRODUCT_STATES).not.toContain("awaiting_review");
    expect(DSH_STATES).toContain("awaiting_review");
    expect(DSH_STATES).not.toContain("awaiting_change_approval");
    // The only shared word is `cancelled`, which means an issue cancellation
    // on the product side and a run cancellation on the harness side.
    const overlap = PRODUCT_STATES.filter((state) =>
      (DSH_STATES as readonly string[]).includes(state),
    );
    expect(overlap).toEqual(["cancelled"]);
  });

  test("awaiting_change_approval rejects any PR-bearing harness run", () => {
    for (const state of ["awaiting_review", "approved_for_merge", "merged"] as const) {
      expect(
        productRunConflict("awaiting_change_approval", [{ state, artifact_refs: [] }]),
      ).not.toBeNull();
    }
  });

  test("awaiting_change_approval needs a stopped run that preserved a candidate", () => {
    expect(
      productRunConflict("awaiting_change_approval", [
        { state: "stopped", artifact_refs: [{ kind: "test_evidence" }] },
      ]),
    ).not.toBeNull();
    expect(
      productRunConflict("awaiting_change_approval", [
        { state: "stopped", artifact_refs: [{ kind: "candidate" }] },
      ]),
    ).toBeNull();
  });

  test("pr_review requires a run that actually has a PR", () => {
    expect(
      productRunConflict("pr_review", [{ state: "running", artifact_refs: [] }]),
    ).not.toBeNull();
    expect(
      productRunConflict("pr_review", [{ state: "awaiting_review", artifact_refs: [] }]),
    ).toBeNull();
    expect(
      productRunConflict("pr_review", [{ state: "approved_for_merge", artifact_refs: [] }]),
    ).toBeNull();
  });

  test("completed requires a provider-confirmed merge", () => {
    expect(
      productRunConflict("completed", [{ state: "awaiting_review", artifact_refs: [] }]),
    ).not.toBeNull();
    expect(productRunConflict("completed", [{ state: "merged", artifact_refs: [] }])).toBeNull();
  });

  test("triage holds no runs at all", () => {
    expect(productRunConflict("triage", [])).toBeNull();
    expect(
      productRunConflict("triage", [{ state: "requested", artifact_refs: [] }]),
    ).not.toBeNull();
  });

  test("harness awaiting_review may only appear under delivering or pr_review", () => {
    expect(runTransitionIssueConflict("awaiting_review", "delivering")).toBeNull();
    expect(runTransitionIssueConflict("awaiting_review", "pr_review")).toBeNull();
    for (const state of [
      "awaiting_change_approval",
      "implementing",
      "validating",
      "planning",
    ] as const) {
      expect(runTransitionIssueConflict("awaiting_review", state), state).not.toBeNull();
    }
    expect(runTransitionIssueConflict("merged", "delivering")).not.toBeNull();
    expect(runTransitionIssueConflict("merged", "pr_review")).toBeNull();
    expect(runTransitionIssueConflict("stopped", "awaiting_change_approval")).toBeNull();
  });

  test("PR-bearing harness states are forbidden before delivery and after stops", () => {
    for (const state of [
      "planning",
      "implementing",
      "validating",
      "delivering",
      "needs_human",
      "cancelled",
    ] as const) {
      expect(PRODUCT_RUN_RELATION[state].forbid).toEqual([
        "awaiting_review",
        "approved_for_merge",
        "merged",
      ]);
    }
  });
});

/** Walk an issue to awaiting_change_approval: run stopped, candidate preserved. */
function preparedCandidate(machine: CollabMachine): {
  issue_id: string;
  run: RunRecord;
  lease: LeaseRecord;
} {
  const issue = planningIssue(machine);
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
    to: "running",
    head_sha: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
  });
  machine.attachArtifact({
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
    to: "stopped",
    stop_reason: "local preparation complete; candidate preserved",
  });
  for (const to of ["implementing", "validating", "awaiting_change_approval"] as const) {
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to,
      reason: null,
    });
  }
  return { issue_id: issue.issue_id, run: machine.getRun(run.run_id) as RunRecord, lease };
}

/** Open a delivery run and walk it up to one harness state. */
function deliveryRun(machine: CollabMachine, issueId: string, upTo: "running" | "awaiting_review") {
  const run = openRun(machine, issueId, { role: "delivery" });
  const lease = acquireLease(machine, run.run_id);
  const ref = leaseRef(lease);
  machine.recordRunState({
    operation_id: op(),
    actor: "worker:c",
    run_id: run.run_id,
    lease: ref,
    to: "approved",
  });
  machine.recordGrant({
    operation_id: op(),
    actor: "worker:c",
    run_id: run.run_id,
    lease: ref,
    grant: grantInput({ may_create_or_update_pr: true }),
  });
  machine.recordRunState({
    operation_id: op(),
    actor: "worker:c",
    run_id: run.run_id,
    lease: ref,
    to: "running",
  });
  if (upTo === "awaiting_review") {
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:c",
      run_id: run.run_id,
      lease: ref,
      to: "awaiting_review",
    });
  }
  return { run_id: run.run_id, ref };
}

describe("product/harness distinction enforced by the machine", () => {
  test("harness awaiting_review is refused while the product awaits change approval", () => {
    const machine = makeMachine();
    const fixture = preparedCandidate(machine);
    // A second bounded run may run while a candidate waits for change approval.
    const second = openRun(machine, fixture.issue_id);
    const lease = acquireLease(machine, second.run_id);
    const ref = leaseRef(lease);
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:b",
      run_id: second.run_id,
      lease: ref,
      to: "approved",
    });
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:b",
      run_id: second.run_id,
      lease: ref,
      to: "running",
    });
    expectCode(
      () =>
        machine.recordRunState({
          operation_id: op(),
          actor: "worker:b",
          run_id: second.run_id,
          lease: ref,
          to: "awaiting_review",
        }),
      "PRODUCT_HARNESS_CONFLICT",
    );
  });

  test("pr_review opens only once a run really holds a provider PR", () => {
    const machine = makeMachine();
    const fixture = preparedCandidate(machine);
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: fixture.issue_id,
      to: "delivering",
      reason: null,
    });
    expectCode(
      () =>
        machine.transitionIssue({
          operation_id: op(),
          actor: "human:operator",
          issue_id: fixture.issue_id,
          to: "pr_review",
          reason: null,
        }),
      "PRODUCT_HARNESS_CONFLICT",
    );

    deliveryRun(machine, fixture.issue_id, "awaiting_review");
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: fixture.issue_id,
      to: "pr_review",
      reason: null,
    });
    expect(machine.getIssue(fixture.issue_id)?.product_state).toBe("pr_review");
  });

  test("a published PR alone is never completion; merged is required", () => {
    const machine = makeMachine();
    const fixture = preparedCandidate(machine);
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: fixture.issue_id,
      to: "delivering",
      reason: null,
    });
    const delivery = deliveryRun(machine, fixture.issue_id, "awaiting_review");
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: fixture.issue_id,
      to: "pr_review",
      reason: null,
    });
    expectCode(
      () =>
        machine.transitionIssue({
          operation_id: op(),
          actor: "human:operator",
          issue_id: fixture.issue_id,
          to: "completed",
          reason: null,
        }),
      "PRODUCT_HARNESS_CONFLICT",
    );

    machine.recordRunState({
      operation_id: op(),
      actor: "worker:c",
      run_id: delivery.run_id,
      lease: delivery.ref,
      to: "approved_for_merge",
    });
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:c",
      run_id: delivery.run_id,
      lease: delivery.ref,
      to: "merged",
      stop_reason: "provider confirmed merge",
    });
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: fixture.issue_id,
      to: "completed",
      reason: null,
    });
    expect(machine.getIssue(fixture.issue_id)?.product_state).toBe("completed");
    expect(machine.listRuns(fixture.issue_id).map((run) => run.state)).toContain("merged");
  });

  test("a triage issue cannot open runs", () => {
    const machine = makeMachine();
    const issue = createIssue(machine, { dedupe_key: "signal-triage" });
    expect(issue.product_state).toBe("triage");
    expectCode(() => openRun(machine, issue.issue_id), "RUN_OPEN_FORBIDDEN");
    expect(machine.listRuns(issue.issue_id)).toEqual([]);
    expect(canTransitionProduct("triage", "implementing")).toBe(false);
  });
});
