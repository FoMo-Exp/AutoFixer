/**
 * Precise dependent-work pause (DAT-210, ADR-0005 §2, aligned with ADR-0007
 * run semantics).
 *
 * A block pauses exactly the affected run's dependent work — never an
 * unrelated run — and the paused run cannot resume itself: release happens
 * only through human/service disposition. The pause is an overlay for
 * dependent work; it never redefines harness stop-condition or terminal
 * semantics and carries no harness run state.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  DependentWorkPauseLedger,
  SecurityError,
  type CaseScope,
  type SecurityActor,
} from "../src/security/index.js";

const SCOPE: CaseScope = {
  enterpriseId: "ent_test",
  workspaceId: "ws_test",
  issueId: "issue_test",
  runId: "run_test",
};

const HANDLER: SecurityActor = { actorId: "human_handler", actorKind: "human" };

// Assembled at runtime: repository secret scanners would flag literals.
const SECRET_VALUE = "sk-" + "live-abcdef1234567890";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected SecurityError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SecurityError);
    expect((error as SecurityError).code).toBe(code);
  }
}

describe("DependentWorkPauseLedger precision", () => {
  test("a block pauses only the affected run's dependent work", () => {
    const ledger = new DependentWorkPauseLedger();
    const pause = ledger.pauseDependentWork("case_1", SCOPE, "SENSITIVE_DATA_UNCERTAIN");
    expect(pause.caseId).toBe("case_1");
    expect(pause.state).toBe("active");
    expect(ledger.isHeld(SCOPE.runId)).toBe(true);
    // Unrelated runs are never affected.
    expect(ledger.isHeld("run_other")).toBe(false);
    expect(ledger.pauseFor("run_other")).toBeUndefined();
  });

  test("pausing the same run twice keeps one active pause", () => {
    const ledger = new DependentWorkPauseLedger();
    const first = ledger.pauseDependentWork("case_1", SCOPE, "SENSITIVE_DATA_UNCERTAIN");
    const second = ledger.pauseDependentWork("case_1", SCOPE, "SENSITIVE_DATA_UNCERTAIN");
    expect(second.pauseId).toBe(first.pauseId);
    expect(ledger.isHeld(SCOPE.runId)).toBe(true);
  });
});

describe("DependentWorkPauseLedger release", () => {
  test("a paused run cannot release itself", () => {
    const ledger = new DependentWorkPauseLedger();
    const pause = ledger.pauseDependentWork("case_1", SCOPE, "SENSITIVE_DATA_UNCERTAIN");
    const runActor: SecurityActor = { actorId: SCOPE.runId, actorKind: "run" };
    expectCode(() => ledger.release(pause.pauseId, runActor, "resume"), "PAUSE_RELEASE_FORBIDDEN");
    // Even a human-shaped actor named like the run is the run itself.
    const impersonator: SecurityActor = { actorId: SCOPE.runId, actorKind: "human" };
    expectCode(
      () => ledger.release(pause.pauseId, impersonator, "resume"),
      "PAUSE_RELEASE_FORBIDDEN",
    );
    expect(ledger.isHeld(SCOPE.runId)).toBe(true);
  });

  test("an unknown actorKind never releases a hold", () => {
    const ledger = new DependentWorkPauseLedger();
    const pause = ledger.pauseDependentWork("case_1", SCOPE, "SENSITIVE_DATA_UNCERTAIN");
    // Release requires exactly a human or service actor: a runtime kind
    // outside the vocabulary is never a disposition principal.
    const unknown = { actorId: "other", actorKind: "unknown" } as unknown as SecurityActor;
    expectCode(() => ledger.release(pause.pauseId, unknown, "resume"), "PAUSE_RELEASE_FORBIDDEN");
    expectCode(
      () => ledger.release(pause.pauseId, {} as unknown as SecurityActor, "resume"),
      "PAUSE_RELEASE_FORBIDDEN",
    );
    expect(ledger.isHeld(SCOPE.runId)).toBe(true);
  });

  test("human or service disposition releases the hold exactly once", () => {
    const ledger = new DependentWorkPauseLedger();
    const pause = ledger.pauseDependentWork("case_1", SCOPE, "SENSITIVE_DATA_UNCERTAIN");
    const released = ledger.release(pause.pauseId, HANDLER, "case resolved");
    expect(released.state).toBe("released");
    expect(released.releasedBy).toBe("human_handler");
    expect(ledger.isHeld(SCOPE.runId)).toBe(false);
    expectCode(() => ledger.release(pause.pauseId, HANDLER, "again"), "PAUSE_NOT_ACTIVE");
  });

  test("release reason and actor are recorded without secrets", () => {
    const ledger = new DependentWorkPauseLedger();
    const pause = ledger.pauseDependentWork("case_1", SCOPE, `suspected ${SECRET_VALUE} material`);
    expect(pause.reason).not.toContain(SECRET_VALUE);
    const released = ledger.release(pause.pauseId, HANDLER, `handled ${SECRET_VALUE} rotated`);
    expect(released.releaseReason).not.toContain(SECRET_VALUE);
  });
});

describe("DependentWorkPauseLedger durability", () => {
  test("a hold survives a reload and still refuses self-release", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "security-pause-"));
    const persistencePath = path.join(directory, "pauses.json");
    const ledger = new DependentWorkPauseLedger({ persistencePath });
    const pause = ledger.pauseDependentWork("case_1", SCOPE, "SENSITIVE_DATA_UNCERTAIN");
    // A restart must not forget the hold: the admission boundary is only a
    // boundary if it survives the process that recorded it.
    const reopened = new DependentWorkPauseLedger({ persistencePath });
    expect(reopened.isHeld(SCOPE.runId)).toBe(true);
    expect(reopened.pauseFor(SCOPE.runId)?.pauseId).toBe(pause.pauseId);
    expectCode(
      () => reopened.release(pause.pauseId, { actorId: SCOPE.runId, actorKind: "run" }, "resume"),
      "PAUSE_RELEASE_FORBIDDEN",
    );
  });
});
