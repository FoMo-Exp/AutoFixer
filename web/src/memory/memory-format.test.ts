import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import type { MemoryItem } from "../api/client";
import {
  describeMemoryGovernanceError,
  isMemoryRedacted,
  memoryActionOffers,
  memoryEventDetailRows,
  memoryStanding,
  quarantineSafeItem,
  workspaceRoleFromSession,
} from "./memory-format";

const item = {
  item_id: "mem_test",
  status: "candidate",
  current_version: 2,
  versions_count: 2,
  kind: "lesson",
  tier: "L2",
  statement: "Raise the share ceiling first",
  preconditions: ["bundle at budget"],
  applicability: { team_id: "tem_a" },
  trust: "human",
  sensitivity: "internal",
  approved: false,
  valid_from: "2026-10-01T00:00:00Z",
  valid_to: null,
  content_hash: "a".repeat(64),
  support_count: 1,
  contradiction_count: 0,
  evidence: [{ evidence_type: "run", reference: "run:1" }],
  updated_at: "2026-10-02T00:00:00Z",
} satisfies MemoryItem;

const session = {
  user: { id: "usr_1" },
  memberships: [
    { workspace_id: "ws_1", role: "member" as const },
    { workspace_id: "ws_1", role: "admin" as const },
    { workspace_id: "ws_2", role: "owner" as const },
  ],
};

describe("workspaceRoleFromSession", () => {
  it("takes the highest membership role for the selected workspace only", () => {
    expect(workspaceRoleFromSession(session, "ws_1")).toBe("admin");
    expect(workspaceRoleFromSession(session, "ws_2")).toBe("owner");
    expect(workspaceRoleFromSession(session, "ws_missing")).toBeUndefined();
    expect(workspaceRoleFromSession(undefined, "ws_1")).toBeUndefined();
  });
});

describe("quarantine redaction", () => {
  it("treats a quarantined status as redacted even without the flag", () => {
    expect(isMemoryRedacted({ status: "quarantined", statement_redacted: false })).toBe(true);
    expect(isMemoryRedacted({ status: "active", statement_redacted: true })).toBe(true);
    expect(isMemoryRedacted({ status: "active", statement_redacted: false })).toBe(false);
  });

  it("drops quarantine originals on ingest", () => {
    const safe = quarantineSafeItem({
      ...item,
      status: "quarantined",
      statement_redacted: false,
      preconditions: ["raw precondition"],
      evidence: [{ evidence_type: "incident", reference: "incident:raw" }],
    });
    expect(safe.statement).toBeNull();
    expect(safe.statement_redacted).toBe(true);
    expect(safe.preconditions).toEqual([]);
    expect(safe.evidence).toEqual([]);
  });

  it("leaves a readable item untouched", () => {
    expect(quarantineSafeItem(item)).toBe(item);
  });
});

describe("memoryStanding", () => {
  it("lets owner and admin govern every unrestricted item", () => {
    expect(memoryStanding("owner", new Set(), item).canGovern).toBe(true);
    expect(memoryStanding("admin", new Set(), item).scope).toBe("workspace");
  });

  it("scopes a team leader to items whose team they lead", () => {
    const led = new Set(["tem_a"]);
    expect(memoryStanding("member", led, item).canGovern).toBe(true);
    expect(memoryStanding("member", new Set(["tem_b"]), item).canGovern).toBe(false);
    expect(
      memoryStanding("member", led, { ...item, applicability: { task_family: "retrieval" } })
        .canGovern,
    ).toBe(false);
  });

  it("never grants governance on restricted items", () => {
    expect(
      memoryStanding("owner", new Set(), { ...item, sensitivity: "restricted" }).canGovern,
    ).toBe(false);
  });
});

describe("memoryActionOffers", () => {
  it("mirrors the contract state machine", () => {
    expect(memoryActionOffers("candidate", true, "internal").map((offer) => offer.action)).toEqual([
      "promote",
      "deprecate",
      "quarantine",
    ]);
    expect(memoryActionOffers("active", true, "internal").map((offer) => offer.action)).toEqual([
      "deprecate",
      "quarantine",
    ]);
    expect(memoryActionOffers("quarantined", true, "internal")).toEqual([
      { action: "restore", label: "Restore", target: "choose", needsReason: true },
    ]);
    expect(memoryActionOffers("retired", true, "internal")).toEqual([]);
    expect(memoryActionOffers("active", false, "internal")).toEqual([]);
    expect(memoryActionOffers("active", true, "restricted")).toEqual([]);
  });
});

describe("memoryEventDetailRows", () => {
  it("renders only fixed tokens, counts, and booleans", () => {
    expect(
      memoryEventDetailRows({
        outcome: "promoted",
        independent_support_runs: 2,
        applied: true,
        free_text: "this has spaces and words",
        "bad key": "value",
      }),
    ).toEqual([
      { key: "outcome", value: "promoted" },
      { key: "independent_support_runs", value: "2" },
      { key: "applied", value: "true" },
      { key: "free_text", value: "[withheld]" },
    ]);
  });
});

describe("describeMemoryGovernanceError", () => {
  it("marks a version conflict stale so the UI refreshes instead of retrying", () => {
    const failure = describeMemoryGovernanceError(
      new ApiError(
        409,
        {
          error: {
            envelope_version: 1,
            code: "VERSION_CONFLICT",
            stage: "policy",
            category: "stop",
            message: "changed",
            retryable: false,
            retry_after_seconds: null,
            request_id: "req_1",
            details: {},
            next_action: "refresh",
          },
        },
        "Conflict",
      ),
      "deprecate",
    );
    expect(failure.stale).toBe(true);
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("Refresh");
  });

  it("marks an authority denial terminal", () => {
    const failure = describeMemoryGovernanceError(
      new ApiError(
        403,
        {
          error: {
            envelope_version: 1,
            code: "FORBIDDEN",
            stage: "authorization",
            category: "stop",
            message: "denied",
            retryable: false,
            retry_after_seconds: null,
            request_id: "req_2",
            details: {},
            next_action: null,
          },
        },
        "Denied",
      ),
      "quarantine",
    );
    expect(failure.terminal).toBe(true);
    expect(failure.stale).toBe(false);
  });
});
