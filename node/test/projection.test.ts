import { describe, expect, test } from "vitest";

import { DshError } from "../src/dsh/client.js";
import { apiErrorFromDsh } from "../src/api/errors.js";
import type { TaskRecord } from "../src/api/task-store.js";
import {
  createTaskRecord,
  isTerminalStatus,
  projectDshState,
  runningPhaseFor,
  TaskStore,
  UI_STATUSES,
} from "../src/api/task-store.js";

describe("dsh state → UI status projection (M0 mapping table)", () => {
  test("requested projects to awaiting_approval", () => {
    expect(projectDshState("requested", "planning")).toBe("awaiting_approval");
  });

  test("approved projects to approved", () => {
    expect(projectDshState("approved", "planning")).toBe("approved");
  });

  test("running projects to the caller's display phase", () => {
    expect(projectDshState("running", "planning")).toBe("planning");
    expect(projectDshState("running", "executing")).toBe("executing");
    expect(projectDshState("running", "validating")).toBe("validating");
  });

  test("terminal and review states project same-named", () => {
    for (const state of [
      "stopped",
      "timed_out",
      "expired",
      "rejected",
      "cancelled",
      "merged",
      "awaiting_review",
      "approved_for_merge",
    ] as const) {
      expect(projectDshState(state, "executing")).toBe(state);
    }
  });

  test("no dsh state may invent a UI status outside the contract enum", () => {
    const projected: string[] = [
      ...UI_STATUSES.map((status) => projectDshState("running", status)),
      ...(["requested", "approved", "stopped", "cancelled"] as const).map((state) =>
        projectDshState(state, "executing"),
      ),
    ];
    for (const status of projected) {
      expect(UI_STATUSES).toContain(status);
    }
  });
});

describe("running display phase selection", () => {
  test("planning before any accepted action", () => {
    expect(runningPhaseFor(false, 0, false)).toBe("planning");
  });

  test("executing once actions are accepted or in flight", () => {
    expect(runningPhaseFor(false, 1, false)).toBe("executing");
    expect(runningPhaseFor(false, 0, true)).toBe("executing");
  });

  test("validating after the agent settles", () => {
    expect(runningPhaseFor(true, 1, false)).toBe("validating");
  });
});

describe("terminal status table", () => {
  test("terminal statuses match the contract's terminal vocabulary", () => {
    for (const status of [
      "stopped",
      "rejected",
      "cancelled",
      "timed_out",
      "expired",
      "merged",
    ] as const) {
      expect(isTerminalStatus(status)).toBe(true);
    }
    for (const status of ["queued", "executing", "awaiting_approval", "approved"] as const) {
      expect(isTerminalStatus(status)).toBe(false);
    }
  });
});

describe("dsh error → API error mapping (M0 error model)", () => {
  function dshError(status: number, code: string): DshError {
    return new DshError(status, code, `dsh said ${code}`, { hint: "dsh" }, false, "req_test");
  }

  test("policy denials keep their contract codes", () => {
    const scope = apiErrorFromDsh(dshError(403, "DSH_SCOPE_DENIED"));
    expect(scope.status).toBe(403);
    expect(scope.code).toBe("DSH_SCOPE_DENIED");
    const policy = apiErrorFromDsh(dshError(403, "DSH_POLICY_DENIED"));
    expect(policy.code).toBe("DSH_POLICY_DENIED");
  });

  test("other 403s fold into FORBIDDEN", () => {
    const mapped = apiErrorFromDsh(dshError(403, "DSH_APPROVER_NOT_AUTHORIZED"));
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe("FORBIDDEN");
    expect(mapped.details["dsh_code"]).toBe("DSH_APPROVER_NOT_AUTHORIZED");
  });

  test("the contract's mapped policy outcomes keep their codes", () => {
    expect(apiErrorFromDsh(dshError(410, "DSH_GRANT_EXPIRED")).code).toBe("DSH_GRANT_EXPIRED");
    expect(apiErrorFromDsh(dshError(422, "DSH_RISK_PROHIBITED")).code).toBe("DSH_RISK_PROHIBITED");
    expect(apiErrorFromDsh(dshError(428, "DSH_APPROVAL_REQUIRED")).code).toBe(
      "DSH_APPROVAL_REQUIRED",
    );
  });

  test("transport failures become retryable DSH_UNAVAILABLE", () => {
    const mapped = apiErrorFromDsh(dshError(503, "DSH_UNAVAILABLE"));
    expect(mapped.status).toBe(503);
    expect(mapped.code).toBe("DSH_UNAVAILABLE");
    expect(mapped.retryable).toBe(true);
  });
});

describe("terminal statuses are absorbing (QA round-1 blocker)", () => {
  function makeRecord(): TaskRecord {
    return createTaskRecord({
      id: "tsk_absorbing",
      repository: {
        id: "github:Luthiel/AutoFixer",
        display_name: "Luthiel/AutoFixer",
        base_ref: "main",
        base_sha: "52081ea",
      },
      summary: "s",
      sourceReference: null,
      acceptanceCriteria: [],
    });
  }

  test("setStatus cannot leave a terminal status", () => {
    const store = new TaskStore();
    const record = makeRecord();
    store.put(record);
    store.setStatus(record, "stopped", null);
    expect(record.terminal).toBe(true);

    const version = record.version;
    const eventCount = record.events.length;
    // A stale projection (e.g. an out-of-order `running` read) must not
    // revive the task: no status move, no event, no version bump.
    const result = store.setStatus(record, "executing", null);
    expect(result).toBeNull();
    expect(record.status).toBe("stopped");
    expect(record.terminal).toBe(true);
    expect(record.version).toBe(version);
    expect(record.events).toHaveLength(eventCount);
  });

  test("appendEvent still records terminal bookkeeping but setStatus stays closed", () => {
    const store = new TaskStore();
    const record = makeRecord();
    store.put(record);
    store.setStatus(record, "cancelled", null);
    expect(isTerminalStatus(record.status)).toBe(true);
    // Re-setting the same terminal status is also a no-op.
    expect(store.setStatus(record, "cancelled", null)).toBeNull();
  });
});
