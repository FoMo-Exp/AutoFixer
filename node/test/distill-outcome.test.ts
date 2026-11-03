import { describe, expect, test, beforeEach } from "vitest";

import {
  ValidationError,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import { createMemoryRepositories } from "../src/memory/index.js";
import type { MemoryRepositories } from "../src/memory/index.js";
import {
  captureEvidence,
  captureOutcome,
  classifyOutcome,
  parseOutcomeEnvelope,
} from "../src/distill/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: ControlPlaneDb;
let memory: MemoryRepositories;
let scope: WorkspaceScope;

const ACTOR = "usr_admin";

function bootstrap(): WorkspaceScope {
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: "test-ent",
    admin_user_id: ACTOR,
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "Repo Workspace",
    repository_id: "repo-1",
    provider_instance_id: provider.id,
  });
  return { enterprise_id: enterprise.id, workspace_id: workspace.id, actor_id: ACTOR };
}

beforeEach(() => {
  db = openControlPlaneDb();
  memory = createMemoryRepositories(db);
  scope = bootstrap();
});

/** Field-complete merged envelope (task-evidence-contract-v1 §6.1 shape). */
function mergedEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_version: "1.0.0",
    task_id: "task-1",
    run_id: "run-1",
    issue_id: "issue-1",
    terminal_state: "merged",
    delivery: {
      patch_status: "merged",
      head_sha: "head-1",
      pr_id: "pr-42",
      change_summary: "Localized source and test correction.",
      validation: [
        {
          tool: "test-runner --focused",
          exit_status: 0,
          event_reference: "evidence://events/run-1/7",
        },
      ],
    },
    evidence: [
      { evidence_type: "reviewer_decision", reference: "evidence://review/run-1/approval" },
      { evidence_type: "incident", reference: "evidence://incidents/inc-9" },
    ],
    ...overrides,
  };
}

function rejectedEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_version: "1.0.0",
    task_id: "task-2",
    run_id: "run-2",
    issue_id: "issue-2",
    terminal_state: "rejected",
    reason: "Reviewer rejected the approach: insufficient test coverage.",
    delivery: {
      patch_status: "not_created",
      head_sha: null,
      pr_id: null,
      change_summary: "No patch was prepared.",
      validation: [],
    },
    evidence: [{ evidence_type: "reviewer_decision", reference: "evidence://review/run-2/reject" }],
    ...overrides,
  };
}

function stoppedEnvelope(
  disposition: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contract_version: "1.0.0",
    task_id: "task-3",
    run_id: "run-3",
    issue_id: "issue-3",
    terminal_state: "stopped",
    stop_disposition: disposition,
    delivery: {
      patch_status: "prepared_no_pr",
      head_sha: "head-3",
      pr_id: null,
      change_summary: "Change prepared but not proposed.",
      validation: [],
    },
    evidence: [],
    ...extras,
  };
}

function timeoutEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_version: "1.0.0",
    task_id: "task-4",
    run_id: "run-timeout",
    issue_id: "issue-4",
    terminal_state: "timed_out",
    delivery: {
      patch_status: "not_created",
      head_sha: null,
      pr_id: null,
      change_summary: "Run hit its wall clock before a patch existed.",
      validation: [],
    },
    evidence: [{ evidence_type: "run", reference: "evidence://events/run-timeout/3" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Strict parsing
// ---------------------------------------------------------------------------

describe("outcome envelope parsing", () => {
  test("accepts a field-complete merged envelope", () => {
    const envelope = parseOutcomeEnvelope(mergedEnvelope());
    expect(envelope.terminal_state).toBe("merged");
    expect(envelope.delivery.patch_status).toBe("merged");
    expect(envelope.evidence).toHaveLength(2);
  });

  test("rejects unknown fields at every level", () => {
    expect(() => parseOutcomeEnvelope(mergedEnvelope({ outcome_class: "accepted" }))).toThrow(
      ValidationError,
    );
    expect(() =>
      parseOutcomeEnvelope(
        mergedEnvelope({
          delivery: {
            patch_status: "merged",
            head_sha: "head-1",
            pr_id: "pr-42",
            change_summary: "ok",
            validation: [],
            merge_claim: true,
          },
        }),
      ),
    ).toThrow(ValidationError);
  });

  test("rejects an unknown contract version", () => {
    expect(() => parseOutcomeEnvelope(mergedEnvelope({ contract_version: "9.9.9" }))).toThrow(
      ValidationError,
    );
  });

  test("rejects a merged outcome without a merged delivery record", () => {
    expect(() =>
      parseOutcomeEnvelope(
        mergedEnvelope({
          delivery: {
            patch_status: "proposed",
            head_sha: "head-1",
            pr_id: "pr-42",
            change_summary: "not actually merged",
            validation: [],
          },
        }),
      ),
    ).toThrow(ValidationError);
  });

  test("rejects a merged delivery record smuggled onto a rejected outcome", () => {
    expect(() =>
      parseOutcomeEnvelope(
        rejectedEnvelope({
          delivery: {
            patch_status: "merged",
            head_sha: "head-9",
            pr_id: "pr-9",
            change_summary: "fabricated merge",
            validation: [],
          },
        }),
      ),
    ).toThrow(ValidationError);
  });

  test("rejected and cancelled outcomes require a recorded reason", () => {
    const { reason: _reason, ...withoutReason } = rejectedEnvelope();
    expect(() => parseOutcomeEnvelope(withoutReason)).toThrow(ValidationError);
    const { reason: _cancelledReason, ...cancelledWithout } = rejectedEnvelope({
      terminal_state: "cancelled",
    });
    expect(() => parseOutcomeEnvelope(cancelledWithout)).toThrow(ValidationError);
  });

  test("a stopped outcome requires a disposition and a failed one a classified cause", () => {
    const { stop_disposition: _drop, ...withoutDisposition } = stoppedEnvelope("failed", {
      failure_cause: "test_failure",
    });
    expect(() => parseOutcomeEnvelope(withoutDisposition)).toThrow(ValidationError);
    expect(() => parseOutcomeEnvelope(stoppedEnvelope("failed"))).toThrow(ValidationError);
    expect(() =>
      parseOutcomeEnvelope(stoppedEnvelope("failed", { failure_cause: "gremlins" })),
    ).toThrow(ValidationError);
  });

  test("non-stopped outcomes cannot carry a stop disposition or failure cause", () => {
    expect(() => parseOutcomeEnvelope(mergedEnvelope({ stop_disposition: "failed" }))).toThrow(
      ValidationError,
    );
    expect(() => parseOutcomeEnvelope(mergedEnvelope({ failure_cause: "test_failure" }))).toThrow(
      ValidationError,
    );
  });

  test("patch identity nullability follows the evidence contract", () => {
    expect(() =>
      parseOutcomeEnvelope(
        rejectedEnvelope({
          delivery: {
            patch_status: "not_created",
            head_sha: "head-x",
            pr_id: null,
            change_summary: "no patch",
            validation: [],
          },
        }),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      parseOutcomeEnvelope(
        stoppedEnvelope("failed", {
          failure_cause: "tool_failure",
          delivery: {
            patch_status: "proposed",
            head_sha: null,
            pr_id: "pr-x",
            change_summary: "missing head",
            validation: [],
          },
        }),
      ),
    ).toThrow(ValidationError);
  });

  test("rejects oversized free text and duplicate evidence references", () => {
    expect(() => parseOutcomeEnvelope(rejectedEnvelope({ reason: "x".repeat(401) }))).toThrow(
      ValidationError,
    );
    expect(() =>
      parseOutcomeEnvelope(
        mergedEnvelope({
          evidence: [
            { evidence_type: "incident", reference: "evidence://incidents/inc-9" },
            { evidence_type: "incident", reference: "evidence://incidents/inc-9" },
          ],
        }),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      parseOutcomeEnvelope(
        mergedEnvelope({
          evidence: [{ evidence_type: "telepathy", reference: "evidence://x" }],
        }),
      ),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Classification: known outcomes only
// ---------------------------------------------------------------------------

describe("outcome classification", () => {
  const cases: Array<[Record<string, unknown>, string, boolean, boolean]> = [
    [mergedEnvelope(), "accepted", true, true],
    [rejectedEnvelope(), "rejected", true, false],
    [
      rejectedEnvelope({ terminal_state: "cancelled", reason: "Cancelled by requester." }),
      "cancelled",
      true,
      false,
    ],
    [stoppedEnvelope("failed", { failure_cause: "test_failure" }), "failed", true, false],
    [stoppedEnvelope("unknown"), "unknown", false, false],
    [stoppedEnvelope("infra_failure"), "infra_failure", false, false],
    [timeoutEnvelope(), "timeout", false, false],
    [timeoutEnvelope({ terminal_state: "expired" }), "timeout", false, false],
  ];

  test.each(cases)("classifies %s as %s", (raw, expectedClass, known, positive) => {
    const classification = classifyOutcome(parseOutcomeEnvelope(raw));
    expect(classification.class).toBe(expectedClass);
    expect(classification.known).toBe(known);
    expect(classification.positive).toBe(positive);
    expect(classification.episode_only).toBe(!known);
  });

  test("timeout, unknown, and infra failures are never positive or known", () => {
    for (const raw of [
      timeoutEnvelope(),
      timeoutEnvelope({ terminal_state: "expired" }),
      stoppedEnvelope("unknown"),
      stoppedEnvelope("infra_failure"),
    ]) {
      const classification = classifyOutcome(parseOutcomeEnvelope(raw));
      expect(classification.positive).toBe(false);
      expect(classification.known).toBe(false);
      expect(classification.episode_only).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

describe("outcome capture", () => {
  test("captures a merged outcome as an episode with attributed evidence", () => {
    const captured = captureOutcome(memory, scope, mergedEnvelope());
    expect(captured.episode.item.status).toBe("proposed");
    expect(captured.episode.current.kind).toBe("episode");
    expect(captured.episode.current.trust).toBe("system");
    expect(captured.episode.current.source_run_id).toBe("run-1");
    expect(captured.episode.current.statement).toContain("terminal outcome accepted");
    expect(captured.episode.current.statement).toContain("run run-1");

    const rows = memory.evidence.listByItem(scope, captured.episode.item.id);
    const refs = rows.map((row) => `${row.evidence_type}:${row.reference}`);
    expect(refs).toContain("run:run-1");
    expect(refs).toContain("pr:pr-42");
    expect(refs).toContain("commit:head-1");
    expect(refs).toContain("test:evidence://events/run-1/7");
    expect(refs).toContain("reviewer_decision:evidence://review/run-1/approval");
    expect(captured.classification.positive).toBe(true);
    expect(captured.classification.known).toBe(true);
  });

  test("a timeout outcome stores an episode but no learnable evidence", () => {
    const captured = captureOutcome(memory, scope, timeoutEnvelope());
    expect(captured.episode.current.kind).toBe("episode");
    expect(captured.classification.positive).toBe(false);
    expect(captured.classification.known).toBe(false);
    expect(captured.evidence.every((entry) => !entry.known)).toBe(true);
    expect(captured.evidence.every((entry) => !entry.positive)).toBe(true);
  });

  test("unknown and infra-failure outcomes store episodes only", () => {
    for (const raw of [stoppedEnvelope("unknown"), stoppedEnvelope("infra_failure")]) {
      const captured = captureOutcome(memory, scope, raw);
      expect(captured.episode.current.kind).toBe("episode");
      expect(captured.classification.class).not.toBe("accepted");
      expect(captured.classification.known).toBe(false);
    }
  });

  test("test evidence records whether the validation attempt passed", () => {
    const captured = captureOutcome(memory, scope, mergedEnvelope());
    const passing = captured.evidence.find((entry) => entry.evidence_type === "test");
    expect(passing?.test_passed).toBe(true);

    const failedValidation = captureOutcome(
      memory,
      scope,
      stoppedEnvelope("failed", {
        failure_cause: "test_failure",
        delivery: {
          patch_status: "prepared_no_pr",
          head_sha: "head-3",
          pr_id: null,
          change_summary: "tests red",
          validation: [
            { tool: "test-runner", exit_status: 2, event_reference: "evidence://events/run-3/9" },
          ],
        },
      }),
    );
    const failing = failedValidation.evidence.find((entry) => entry.evidence_type === "test");
    expect(failing?.test_passed).toBe(false);
    expect(failing?.known).toBe(true);
  });

  test("captureEvidence is derived from the envelope, never from a claim", () => {
    const envelope = parseOutcomeEnvelope(rejectedEnvelope());
    const entries = captureEvidence(envelope);
    // No pr or commit evidence exists for a not_created delivery.
    expect(entries.some((entry) => entry.evidence_type === "pr")).toBe(false);
    expect(entries.some((entry) => entry.evidence_type === "commit")).toBe(false);
    expect(entries.some((entry) => entry.known)).toBe(true);
  });
});
