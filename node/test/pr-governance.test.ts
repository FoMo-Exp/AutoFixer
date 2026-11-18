import { describe, expect, test } from "vitest";

import { CollabError } from "../src/collab/errors.js";
import {
  GovernanceProviderError,
  PullRequestGovernanceService,
  finalizeGovernanceObservation,
  observationStillCurrent,
} from "../src/collab/pr-governance.js";
import type {
  GovernanceApprovalObservation,
  GovernanceCheckObservation,
  PRGovernanceProvider,
  ProviderGovernanceSnapshot,
  PullRequestGovernanceObservation,
} from "../src/collab/pr-governance.js";
import type { DeliveryRecord, RepositoryRef } from "../src/collab/types.js";

/**
 * Pull-request governance observation and invalidation (DAT-261).
 *
 * These cases are the issue's acceptance semantics without a provider: what a
 * current head may claim, what a new head inherits (nothing), how missing or
 * unreadable answers are reported, and that an observation never approves or
 * merges. The GitHub reader is covered against a fake provider separately.
 */

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const OTHER_HEAD = "c".repeat(40);
const NOW = new Date("2026-11-18T09:00:00.000Z");

const REPOSITORY: RepositoryRef = {
  repository_id: "github:FoMo-Exp/AutoFixer",
  url: "https://github.com/FoMo-Exp/AutoFixer.git",
  base_ref: "main",
  base_sha: "d".repeat(40),
};

const DELIVERY: DeliveryRecord = {
  delivery_id: "dlv_dat261",
  operation_id: "op_dat261",
  issue_id: "iss_dat261",
  candidate_id: "cand_dat261",
  approval_id: "apr_dat261",
  repository: REPOSITORY,
  target_branch: "main",
  head_sha: HEAD,
  provider: "github",
  state: "delivered",
  branch: "autofixer/iss_dat261",
  pr_id: "7",
  pr_url: "https://github.com/FoMo-Exp/AutoFixer/pull/7",
  error_code: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  reconciled_at: null,
  grant_id: "grt_dat261",
};

function check(
  name: string,
  status: GovernanceCheckObservation["status"],
  head = HEAD,
): GovernanceCheckObservation {
  return { name, status, head_sha: head, observed_at: NOW.toISOString() };
}

function approval(
  identity: string,
  decision: GovernanceApprovalObservation["decision"],
  head = HEAD,
  submitted_at = NOW.toISOString(),
): GovernanceApprovalObservation {
  return { identity, decision, head_sha: head, submitted_at };
}

function snapshot(overrides: Partial<ProviderGovernanceSnapshot> = {}): ProviderGovernanceSnapshot {
  return {
    head_sha: HEAD,
    pull_request_state: "open",
    checks: [check("build", "passed"), check("test", "passed")],
    checks_complete: true,
    approvals_complete: true,
    head_stable: true,
    approvals: [
      approval("Luthiel", "approved"),
      approval("Ludwig-Planck", "approved", HEAD, "2026-11-18T09:01:00.000Z"),
    ],
    unresolved_discussions: 0,
    ...overrides,
  };
}

class ScriptedProvider implements PRGovernanceProvider {
  readonly provider = "github" as const;
  readonly observations: Array<{ head: string }> = [];
  private readonly answers: Array<ProviderGovernanceSnapshot | GovernanceProviderError>;

  constructor(...answers: Array<ProviderGovernanceSnapshot | GovernanceProviderError>) {
    this.answers = answers;
  }

  observe(_repository: RepositoryRef, _prId: string): Promise<ProviderGovernanceSnapshot> {
    const answer = this.answers.shift();
    if (answer === undefined) {
      throw new Error("no scripted observation left");
    }
    if (answer instanceof GovernanceProviderError) {
      return Promise.reject(answer);
    }
    this.observations.push({ head: answer.head_sha });
    return Promise.resolve(answer);
  }
}

let counter = 0;
function service(provider?: PRGovernanceProvider): PullRequestGovernanceService {
  counter += 1;
  let id = 0;
  return new PullRequestGovernanceService({
    ...(provider !== undefined ? { provider } : {}),
    clock: () => NOW,
    observationId: () => `gov_${String(counter)}_${String(++id)}`,
  });
}

describe("a current head is eligible only on its own evidence", () => {
  test("every dimension observed on the delivery head makes the head merge-eligible", async () => {
    const observation = await service(new ScriptedProvider(snapshot())).observe(DELIVERY);
    expect(observation).toMatchObject({
      head_sha: HEAD,
      delivery_head_sha: HEAD,
      validity: "current",
      observations_valid: true,
      conditions_satisfied: true,
      unmet_condition: null,
      pull_request_state: "open",
    });
    expect(observation.checks.items).toHaveLength(2);
    expect(observation.approvals.satisfied).toBe(true);
    expect(observation.supersedes).toBeNull();
    // The record cannot approve or merge anything; it only reports.
    expect(Object.keys(observation)).not.toContain("merge");
  });

  test("a failed check denies the head", async () => {
    const observation = await service(
      new ScriptedProvider(snapshot({ checks: [check("build", "failed")] })),
    ).observe(DELIVERY);
    expect(observation.conditions_satisfied).toBe(false);
    expect(observation.observations_valid).toBe(false);
    expect(observation.unmet_condition).toBe("checks_not_passed");
  });

  test("a pending check is not a pass", async () => {
    const observation = await service(
      new ScriptedProvider(snapshot({ checks: [check("build", "pending")] })),
    ).observe(DELIVERY);
    expect(observation.unmet_condition).toBe("checks_not_passed");
  });

  test("no check observed is checks_missing, never a passing gate", async () => {
    const observation = await service(new ScriptedProvider(snapshot({ checks: [] }))).observe(
      DELIVERY,
    );
    expect(observation.unmet_condition).toBe("checks_missing");
    expect(observation.conditions_satisfied).toBe(false);
  });

  test("an unresolved review conversation denies the head", async () => {
    const observation = await service(
      new ScriptedProvider(snapshot({ unresolved_discussions: 2 })),
    ).observe(DELIVERY);
    expect(observation.unmet_condition).toBe("review_discussions_unresolved");
    expect(observation.review_discussions.unresolved).toBe(2);
  });

  test("both named approvers must approve the head; one is incomplete", async () => {
    const observation = await service(
      new ScriptedProvider(snapshot({ approvals: [approval("Luthiel", "approved")] })),
    ).observe(DELIVERY);
    expect(observation.unmet_condition).toBe("approvals_incomplete");
    expect(observation.approvals.required).toEqual(["Luthiel", "Ludwig-Planck"]);
  });

  test("a changes-requested review overrides an earlier approval", async () => {
    const observation = await service(
      new ScriptedProvider(
        snapshot({
          approvals: [
            approval("Luthiel", "approved", HEAD, "2026-11-18T09:00:00.000Z"),
            approval("Luthiel", "changes_requested", HEAD, "2026-11-18T09:05:00.000Z"),
            approval("Ludwig-Planck", "approved"),
          ],
        }),
      ),
    ).observe(DELIVERY);
    expect(observation.unmet_condition).toBe("approvals_incomplete");
    expect(observation.approvals.items.find((item) => item.identity === "Luthiel")?.decision).toBe(
      "changes_requested",
    );
  });

  test("a closed or merged PR is not eligible", async () => {
    for (const pull_request_state of ["closed", "merged"] as const) {
      const observation = await service(
        new ScriptedProvider(snapshot({ pull_request_state })),
      ).observe(DELIVERY);
      expect(observation.unmet_condition).toBe("pull_request_not_open");
    }
  });
});

describe("a new head inherits nothing", () => {
  test("checks and approvals bound to an older commit are dropped, not carried", async () => {
    const observation = await service(
      new ScriptedProvider(
        snapshot({
          head_sha: OTHER_HEAD,
          checks: [check("build", "passed", OLD_HEAD), check("test", "passed", OTHER_HEAD)],
          approvals: [approval("Luthiel", "approved", OLD_HEAD)],
        }),
      ),
    ).observe(DELIVERY);
    // Only the item bound to the observed head survives.
    expect(observation.checks.items.map((item) => item.head_sha)).toEqual([OTHER_HEAD]);
    expect(observation.approvals.items).toEqual([]);
    expect(observation.approvals.satisfied).toBe(false);
  });

  test("a PR that moved past the delivered head is superseded and never eligible", async () => {
    const observation = await service(
      new ScriptedProvider(snapshot({ head_sha: OTHER_HEAD })),
    ).observe(DELIVERY);
    expect(observation.validity).toBe("superseded");
    expect(observation.observations_valid).toBe(false);
    expect(observation.conditions_satisfied).toBe(false);
    expect(observation.unmet_condition).toBe("head_changed");
  });

  test("the previous observation is reported as superseded when the head moves", async () => {
    const svc = service(new ScriptedProvider(snapshot(), snapshot({ head_sha: OTHER_HEAD })));
    const first = await svc.observe(DELIVERY);
    const second = await svc.observe(DELIVERY);
    expect(second.supersedes).toEqual({
      observation_id: first.observation_id,
      head_sha: HEAD,
      observed_at: NOW.toISOString(),
      invalidation_reason: "head_changed",
    });
    expect(observationStillCurrent(first, OTHER_HEAD)).toBe(false);
    expect(observationStillCurrent(second, OTHER_HEAD)).toBe(false);
    expect(observationStillCurrent(first, HEAD)).toBe(true);
  });

  test("the same head observed twice keeps the record current", async () => {
    const svc = service(new ScriptedProvider(snapshot(), snapshot()));
    const first = await svc.observe(DELIVERY);
    const second = await svc.observe(DELIVERY);
    expect(second.supersedes).toBeNull();
    expect(observationStillCurrent(second, HEAD)).toBe(true);
    expect(first.observation_id).not.toBe(second.observation_id);
  });
});

describe("missing or unreadable observations are explicit", () => {
  test("no provider is blocked, not an empty passing snapshot", async () => {
    const observation = await service().observe(DELIVERY);
    expect(observation.validity).toBe("blocked");
    expect(observation.head_sha).toBeNull();
    expect(observation.unmet_condition).toBe("governance_blocked");
    expect(observation.checks).toMatchObject({
      state: "blocked",
      reason: "integration_not_configured",
      items: [],
    });
    expect(observation.approvals.state).toBe("blocked");
    expect(observation.review_discussions.unresolved).toBeNull();
    expect(observation.conditions_satisfied).toBe(false);
  });

  test("a permission denial is blocked and names only the reason", async () => {
    const observation = await service(
      new ScriptedProvider(new GovernanceProviderError("blocked", "permission_denied")),
    ).observe(DELIVERY);
    expect(observation.validity).toBe("blocked");
    expect(observation.checks.reason).toBe("permission_denied");
    expect(JSON.stringify(observation)).not.toContain("token");
  });

  test("a transport failure is unknown, never the last known facts", async () => {
    const svc = service(
      new ScriptedProvider(
        snapshot(),
        new GovernanceProviderError("unknown", "provider_unavailable"),
      ),
    );
    const fresh = await svc.observe(DELIVERY);
    expect(fresh.conditions_satisfied).toBe(true);

    const unavailable = await svc.observe(DELIVERY);
    expect(unavailable.validity).toBe("unknown");
    expect(unavailable.observations_valid).toBe(false);
    expect(unavailable.conditions_satisfied).toBe(false);
    expect(unavailable.head_sha).toBeNull();
    expect(unavailable.checks.items).toEqual([]);
    expect(unavailable.approvals.satisfied).toBe(false);
    expect(unavailable.unmet_condition).toBe("head_unavailable");
    // The previous head's passing evidence is not carried into this record.
    expect(unavailable.supersedes).not.toBeNull();
  });

  test("an unreadable newer rejection makes approvals unknown, not the old approval", async () => {
    // The reader proved it cannot interpret a decisive review; the service must
    // discard the whole reviewer set instead of keeping the old APPROVED row.
    const observation = await service(
      new ScriptedProvider(
        snapshot({
          approvals: [approval("Luthiel", "approved", HEAD, "2026-11-18T09:00:00.000Z")],
          approvals_complete: false,
        }),
      ),
    ).observe(DELIVERY);
    expect(observation.approvals).toMatchObject({
      state: "unknown",
      reason: "invalid_provider_response",
      satisfied: false,
      items: [],
    });
    expect(observation.checks.state).toBe("observed");
    expect(observation.validity).toBe("unknown");
    expect(observation.observations_valid).toBe(false);
    expect(observation.conditions_satisfied).toBe(false);
    expect(observation.unmet_condition).toBe("governance_unknown");
  });

  test("an incomplete check set is unknown, not an all-passed check set", async () => {
    const observation = await service(
      new ScriptedProvider(
        snapshot({
          checks: [check("build", "passed")],
          checks_complete: false,
        }),
      ),
    ).observe(DELIVERY);
    expect(observation.checks).toMatchObject({
      state: "unknown",
      reason: "invalid_provider_response",
      items: [],
    });
    expect(observation.approvals.state).toBe("observed");
    expect(observation.conditions_satisfied).toBe(false);
    expect(observation.unmet_condition).toBe("governance_unknown");
  });

  test("a head that moved during the read is discarded as unknown/superseded", async () => {
    const moved = await service(
      new ScriptedProvider(
        snapshot({ head_sha: OTHER_HEAD, head_stable: false, checks: [], approvals: [] }),
      ),
    ).observe(DELIVERY);
    expect(moved.head_sha).toBe(OTHER_HEAD);
    expect(moved.validity).toBe("superseded");
    expect(moved.conditions_satisfied).toBe(false);
    expect(moved.unmet_condition).toBe("head_changed");
    for (const dimension of [moved.checks, moved.approvals, moved.review_discussions]) {
      expect(dimension).toMatchObject({
        state: "unknown",
        reason: "head_changed_during_observation",
      });
    }
    expect(moved.checks.items).toEqual([]);
    expect(moved.approvals.items).toEqual([]);
    expect(moved.review_discussions.unresolved).toBeNull();
  });

  test("a head that moved and came back is unknown, never a passing read", async () => {
    const raced = await service(
      new ScriptedProvider(snapshot({ head_stable: false, checks: [], approvals: [] })),
    ).observe(DELIVERY);
    expect(raced.head_sha).toBe(HEAD);
    expect(raced.validity).toBe("unknown");
    expect(raced.conditions_satisfied).toBe(false);
    expect(raced.unmet_condition).toBe("governance_unknown");
    expect(raced.checks.reason).toBe("head_changed_during_observation");
  });

  test("an unparseable review timestamp makes approvals unknown", async () => {
    const observation = await service(
      new ScriptedProvider(
        snapshot({
          approvals: [
            approval("Luthiel", "approved", HEAD, "zzzz"),
            approval("Luthiel", "changes_requested", HEAD, "2026-11-18T09:30:00Z"),
            approval("Ludwig-Planck", "approved"),
          ],
        }),
      ),
    ).observe(DELIVERY);
    expect(observation.approvals).toMatchObject({
      state: "unknown",
      reason: "invalid_provider_response",
      satisfied: false,
      items: [],
    });
    expect(observation.conditions_satisfied).toBe(false);
    expect(observation.unmet_condition).toBe("governance_unknown");
  });

  test("an unexpected provider throw is unknown, not a fabricated result", async () => {
    const broken: PRGovernanceProvider = {
      provider: "github",
      observe: () => Promise.reject(new Error("socket exploded at /secret/path")),
    };
    const observation = await service(broken).observe(DELIVERY);
    expect(observation.validity).toBe("unknown");
    expect(observation.checks.reason).toBe("provider_unavailable");
    expect(JSON.stringify(observation)).not.toContain("socket exploded");
  });

  test("a delivery without a pull request is not observable", async () => {
    await expect(
      service(new ScriptedProvider(snapshot())).observe({ ...DELIVERY, pr_id: null }),
    ).rejects.toMatchObject({ code: "GOVERNANCE_NOT_OBSERVABLE" });
    await expect(
      service(new ScriptedProvider(snapshot())).observe({ ...DELIVERY, pr_id: null }),
    ).rejects.toBeInstanceOf(CollabError);
  });
});

describe("finalizeGovernanceObservation is the single eligibility rule", () => {
  test("an eligible record flips to ineligible when the head changes", () => {
    const base: PullRequestGovernanceObservation = {
      observation_id: "gov_1",
      issue_id: "iss_1",
      delivery_id: "dlv_1",
      repository_id: REPOSITORY.repository_id,
      provider: "github",
      pr_id: "7",
      pr_url: "https://github.com/FoMo-Exp/AutoFixer/pull/7",
      delivery_head_sha: HEAD,
      head_sha: HEAD,
      pull_request_state: "open",
      observed_at: NOW.toISOString(),
      validity: "current",
      observations_valid: true,
      conditions_satisfied: true,
      not_evaluated: [
        "qa_verdict",
        "branch_protection_required_checks",
        "merge_queue_availability",
      ],
      unmet_condition: null,
      checks: {
        state: "observed",
        reason: null,
        observed_at: NOW.toISOString(),
        items: [check("build", "passed")],
      },
      approvals: {
        state: "observed",
        reason: null,
        observed_at: NOW.toISOString(),
        required: ["Luthiel", "Ludwig-Planck"],
        satisfied: true,
        items: [approval("Luthiel", "approved"), approval("Ludwig-Planck", "approved")],
      },
      review_discussions: {
        state: "observed",
        reason: null,
        observed_at: NOW.toISOString(),
        unresolved: 0,
      },
      supersedes: null,
    };
    expect(finalizeGovernanceObservation(base).conditions_satisfied).toBe(true);
    const moved = finalizeGovernanceObservation({ ...base, head_sha: OTHER_HEAD });
    expect(moved.validity).toBe("superseded");
    expect(moved.unmet_condition).toBe("head_changed");
    expect(moved.conditions_satisfied).toBe(false);
  });
});
