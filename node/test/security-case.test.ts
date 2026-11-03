/**
 * Security disposal case lifecycle (DAT-210, ADR-0005 §2).
 *
 * The case vocabulary is its own kind — it never redefines harness
 * stop-condition or terminal semantics — and every state transition is
 * append-only history. Duplicate blocking associates idempotently with the
 * same open case for the affected run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  CASE_STATES,
  CASE_TRANSITIONS,
  SecurityCaseStore,
  SecurityError,
  isTerminalCaseState,
  type CaseScope,
  type OpenBlockInput,
  type SecurityActor,
} from "../src/security/index.js";

const SCOPE: CaseScope = {
  enterpriseId: "ent_test",
  workspaceId: "ws_test",
  issueId: "issue_test",
  runId: "run_test",
};

const SERVICE: SecurityActor = { actorId: "model-gateway", actorKind: "service" };
const HANDLER: SecurityActor = { actorId: "human_handler", actorKind: "human" };
const REVIEWER: SecurityActor = { actorId: "human_reviewer", actorKind: "human" };
const RUN: SecurityActor = { actorId: "run_test", actorKind: "run" };

// Assembled at runtime: repository secret scanners would flag literals.
const SECRET_VALUE = "sk-" + "live-abcdef1234567890";

function blockInput(overrides: Partial<OpenBlockInput> = {}): OpenBlockInput {
  return {
    identity: { ...SCOPE, invocationId: "inv_1", traceId: "trace_1" },
    reason: "SENSITIVE_DATA_UNCERTAIN",
    actor: SERVICE,
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected SecurityError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SecurityError);
    expect((error as SecurityError).code).toBe(code);
  }
}

describe("SecurityCaseStore case association", () => {
  test("first block opens a pending case scoped to enterprise/workspace/issue/run", () => {
    const store = new SecurityCaseStore();
    const { case: opened, created } = store.openForBlock(blockInput());
    expect(created).toBe(true);
    expect(opened.state).toBe("pending");
    expect(opened.scope).toEqual(SCOPE);
    expect(opened.blocks).toHaveLength(1);
    expect(opened.blocks[0]).toMatchObject({
      invocationId: "inv_1",
      traceId: "trace_1",
      reason: "SENSITIVE_DATA_UNCERTAIN",
    });
  });

  test("duplicate blocking of the same invocation associates the same case idempotently", () => {
    const store = new SecurityCaseStore();
    const first = store.openForBlock(blockInput());
    const second = store.openForBlock(blockInput());
    expect(second.created).toBe(false);
    expect(second.case.caseId).toBe(first.case.caseId);
    expect(second.case.blocks).toHaveLength(1);
    // Only one block.recorded event despite two calls.
    const events = store.events(first.case.caseId);
    expect(events.filter((event) => event.type === "block.recorded")).toHaveLength(1);
    expect(events.filter((event) => event.type === "case.opened")).toHaveLength(1);
  });

  test("a different blocked invocation of the same run joins the same open case", () => {
    const store = new SecurityCaseStore();
    const first = store.openForBlock(blockInput());
    const second = store.openForBlock(
      blockInput({ identity: { ...SCOPE, invocationId: "inv_2", traceId: "trace_2" } }),
    );
    expect(second.created).toBe(false);
    expect(second.case.caseId).toBe(first.case.caseId);
    expect(second.case.blocks).toHaveLength(2);
  });

  test("blocking on another run opens a separate case", () => {
    const store = new SecurityCaseStore();
    const first = store.openForBlock(blockInput());
    const other = store.openForBlock(
      blockInput({
        identity: { ...SCOPE, runId: "run_other", invocationId: "inv_2", traceId: "trace_2" },
      }),
    );
    expect(other.created).toBe(true);
    expect(other.case.caseId).not.toBe(first.case.caseId);
  });

  test("a terminal case is never reopened; a later block opens a new case", () => {
    const store = new SecurityCaseStore();
    const first = store.openForBlock(blockInput());
    store.transition(first.case.caseId, "handling", HANDLER);
    store.transition(first.case.caseId, "awaiting_review", HANDLER);
    store.transition(first.case.caseId, "resolved", REVIEWER);
    const later = store.openForBlock(
      blockInput({ identity: { ...SCOPE, invocationId: "inv_9", traceId: "trace_9" } }),
    );
    expect(later.created).toBe(true);
    expect(later.case.caseId).not.toBe(first.case.caseId);
    expect(later.case.state).toBe("pending");
  });
});

describe("SecurityCaseStore append-only transitions", () => {
  test("the documented lifecycle walks pending → handling → awaiting_review → resolved", () => {
    const store = new SecurityCaseStore();
    const { case: opened } = store.openForBlock(blockInput());
    store.transition(opened.caseId, "handling", HANDLER);
    store.transition(opened.caseId, "awaiting_review", HANDLER);
    const resolved = store.transition(opened.caseId, "resolved", REVIEWER);
    expect(resolved.state).toBe("resolved");
  });

  test("a failed review returns awaiting_review to handling", () => {
    const store = new SecurityCaseStore();
    const { case: opened } = store.openForBlock(blockInput());
    store.transition(opened.caseId, "handling", HANDLER);
    store.transition(opened.caseId, "awaiting_review", HANDLER);
    const back = store.transition(opened.caseId, "handling", REVIEWER);
    expect(back.state).toBe("handling");
  });

  test("terminated is reachable from every non-terminal state", () => {
    for (const start of ["pending", "handling", "awaiting_review"] as const) {
      const store = new SecurityCaseStore();
      const { case: opened } = store.openForBlock(blockInput());
      let current = opened.caseId;
      if (start !== "pending") {
        store.transition(current, "handling", HANDLER);
        if (start === "awaiting_review") store.transition(current, "awaiting_review", HANDLER);
      }
      current = store.transition(current, "terminated", HANDLER).caseId;
      expect(store.get(current)?.state).toBe("terminated");
    }
  });

  test("skipping review and terminal states are final", () => {
    const store = new SecurityCaseStore();
    const { case: opened } = store.openForBlock(blockInput());
    expectCode(
      () => store.transition(opened.caseId, "resolved", HANDLER),
      "CASE_TRANSITION_FORBIDDEN",
    );
    expectCode(
      () => store.transition(opened.caseId, "awaiting_review", HANDLER),
      "CASE_TRANSITION_FORBIDDEN",
    );
    const resolvedCase = new SecurityCaseStore();
    const { case: created } = resolvedCase.openForBlock(blockInput());
    resolvedCase.transition(created.caseId, "handling", HANDLER);
    resolvedCase.transition(created.caseId, "awaiting_review", HANDLER);
    resolvedCase.transition(created.caseId, "resolved", REVIEWER);
    expectCode(
      () => resolvedCase.transition(created.caseId, "handling", HANDLER),
      "CASE_TRANSITION_FORBIDDEN",
    );
    expectCode(
      () => resolvedCase.transition(created.caseId, "terminated", HANDLER),
      "CASE_TRANSITION_FORBIDDEN",
    );
  });

  test("every transition appends history; the log never rewrites past entries", () => {
    const store = new SecurityCaseStore();
    const { case: opened } = store.openForBlock(blockInput());
    store.transition(opened.caseId, "handling", HANDLER);
    store.transition(opened.caseId, "awaiting_review", HANDLER);
    const events = store.events(opened.caseId);
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const transitions = events.filter((event) => event.type === "case.state_changed");
    expect(transitions.map((event) => event.detail["to"])).toEqual(["handling", "awaiting_review"]);
    expect(transitions[0]?.actor).toMatchObject({ actorId: "human_handler", actorKind: "human" });
    // Failed review then re-review is still visible as its own appended events.
    store.transition(opened.caseId, "handling", REVIEWER);
    expect(store.events(opened.caseId).length).toBe(events.length + 1);
    expect(events.every((event) => store.events(opened.caseId).includes(event))).toBe(true);
  });

  test("a run actor never dispositions a case", () => {
    const store = new SecurityCaseStore();
    const { case: opened } = store.openForBlock(blockInput());
    expectCode(() => store.transition(opened.caseId, "handling", RUN), "CASE_ACTOR_FORBIDDEN");
    expectCode(
      () =>
        store.transition(opened.caseId, "handling", { actorId: "run_test", actorKind: "human" }),
      "CASE_ACTOR_FORBIDDEN",
    );
    expect(store.get(opened.caseId)?.state).toBe("pending");
  });
});

describe("SecurityCaseStore durability", () => {
  test("cases and their append-only history survive a reload", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "security-case-"));
    const persistencePath = path.join(directory, "cases.json");
    const store = new SecurityCaseStore({ persistencePath });
    const { case: opened } = store.openForBlock(blockInput());
    store.transition(opened.caseId, "handling", HANDLER);
    const reopened = new SecurityCaseStore({ persistencePath });
    const reloaded = reopened.get(opened.caseId);
    expect(reloaded?.state).toBe("handling");
    expect(reopened.events(opened.caseId)).toEqual(store.events(opened.caseId));
    // The reopened store keeps appending to the same history.
    reopened.transition(opened.caseId, "awaiting_review", HANDLER);
    expect(new SecurityCaseStore({ persistencePath }).events(opened.caseId).length).toBe(
      store.events(opened.caseId).length + 1,
    );
    // A persisted duplicate block still associates the same case.
    const again = reopened.openForBlock(
      blockInput({ identity: { ...SCOPE, invocationId: "inv_2", traceId: "trace_2" } }),
    );
    expect(again.created).toBe(false);
    expect(again.case.caseId).toBe(opened.caseId);
  });
});

describe("SecurityCaseStore event redaction", () => {
  test("secret-shaped material never reaches case events or block records", () => {
    const store = new SecurityCaseStore();
    const { case: opened } = store.openForBlock(
      blockInput({
        reason: `${SECRET_VALUE} detected`,
        safeDetail: `the value ${SECRET_VALUE} must never appear`,
      }),
    );
    const serialized = JSON.stringify(store.events(opened.caseId));
    const blocks = JSON.stringify(store.get(opened.caseId)?.blocks);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(blocks).not.toContain(SECRET_VALUE);
  });
});

describe("case states never redefine harness semantics (DAT-210 acceptance)", () => {
  test("the case vocabulary is its own kind with its own terminal states", () => {
    // Exactly the ADR-0005 §2 vocabulary — no harness run state is added or
    // removed, and case-terminal is not harness-terminal: `resolved`/
    // `terminated` say nothing about a run reaching `merged`, `stopped`,
    // `timed_out`, or any other dsh state (those live in ../dsh/types.ts and
    // are never referenced here).
    expect([...CASE_STATES]).toEqual([
      "pending",
      "handling",
      "awaiting_review",
      "resolved",
      "terminated",
    ]);
    const terminal = CASE_STATES.filter((state) => isTerminalCaseState(state));
    expect(terminal).toEqual(["resolved", "terminated"]);
    // Every non-terminal state keeps at least one edge and no edge leaves a
    // terminal one; the machine is closed over the case vocabulary alone.
    for (const state of CASE_STATES) {
      for (const target of CASE_TRANSITIONS[state]) {
        expect(CASE_STATES).toContain(target);
      }
    }
    expect(CASE_TRANSITIONS.resolved).toEqual([]);
    expect(CASE_TRANSITIONS.terminated).toEqual([]);
  });
});
