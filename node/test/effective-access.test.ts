import { describe, expect, test } from "vitest";

import { computeEffectiveAccess } from "../src/provider-access/effective-access.js";
import type { EffectiveAccessInput } from "../src/provider-access/types.js";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const FRESH = "2026-11-03T11:55:00.000Z"; // 5 minutes ago
const AGED = "2026-11-02T10:00:00.000Z"; // over 24 hours ago
const SEMI = "2026-11-03T11:00:00.000Z"; // one hour ago — older than the fresh window

function input(overrides: Partial<EffectiveAccessInput> = {}): EffectiveAccessInput {
  return {
    action: "read",
    enterprise: { member: true, user_status: "active" },
    workspace_role: "member",
    repository: { subject: "4242", state: "active", last_verified_at: FRESH },
    capability_grants: [],
    now: NOW,
    fresh_window_ms: 15 * 60 * 1000,
    stale_after_ms: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("effective access intersection", () => {
  test("all four dimensions present allows the action", () => {
    expect(computeEffectiveAccess(input()).allowed).toBe(true);
  });

  test("without enterprise membership everything is denied", () => {
    const decision = computeEffectiveAccess(
      input({ enterprise: { member: false, user_status: "active" } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("enterprise_membership");
  });

  test("a suspended user loses access immediately", () => {
    const decision = computeEffectiveAccess(
      input({ enterprise: { member: true, user_status: "suspended" } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("user_suspended");
  });

  test("without a workspace role the action is denied", () => {
    const decision = computeEffectiveAccess(input({ workspace_role: null }));
    expect(decision.reason).toBe("workspace_role");
  });

  test("workspace role rank is enforced per action", () => {
    expect(
      computeEffectiveAccess(input({ action: "read", workspace_role: "viewer" })).allowed,
    ).toBe(true);
    expect(
      computeEffectiveAccess(input({ action: "write", workspace_role: "viewer" })).reason,
    ).toBe("workspace_role");
    // Approvals need admin by default policy.
    expect(
      computeEffectiveAccess(input({ action: "approval", workspace_role: "member" })).reason,
    ).toBe("workspace_role");
  });

  test("enterprise administration is not a dimension: no workspace role means no access", () => {
    // Even an enterprise admin (recorded nowhere in this input) gets nothing
    // from it: enterprise administration never grants repository access.
    const decision = computeEffectiveAccess(input({ workspace_role: null }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("workspace_role");
  });

  test("without provider repository authority, login alone grants nothing", () => {
    const decision = computeEffectiveAccess(
      input({ repository: { subject: null, state: "absent", last_verified_at: null } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("authority_unknown");
    expect(decision.requires_reconciliation).toBe(true);
  });

  test("removed authority stops reads, streams, artifacts, approvals, and writes", () => {
    for (const action of ["read", "stream", "artifact_read", "approval", "write"] as const) {
      const decision = computeEffectiveAccess(
        input({
          action,
          workspace_role: "owner",
          repository: { subject: "4242", state: "removed", last_verified_at: FRESH },
          capability_grants: ["delivery_write"],
        }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("repository_access");
    }
  });
});

describe("unknown and stale authority", () => {
  test("unknown authority blocks every action and demands reconciliation", () => {
    for (const action of ["read", "write"] as const) {
      const decision = computeEffectiveAccess(
        input({
          action,
          repository: { subject: "4242", state: "unknown", last_verified_at: null },
        }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("authority_unknown");
      expect(decision.requires_reconciliation).toBe(true);
    }
  });

  test("stale authority blocks sensitive actions but not ordinary reads", () => {
    const stale = { subject: "4242", state: "stale" as const, last_verified_at: AGED };
    const sensitive = computeEffectiveAccess(
      input({ action: "write", repository: stale, capability_grants: ["delivery_write"] }),
    );
    expect(sensitive.allowed).toBe(false);
    expect(sensitive.reason).toBe("authority_stale");
    expect(sensitive.requires_reconciliation).toBe(true);

    const ordinary = computeEffectiveAccess(input({ action: "read", repository: stale }));
    expect(ordinary.allowed).toBe(true);
  });

  test("expired verification blocks sensitive actions even while state says active", () => {
    const aged = { subject: "4242", state: "active" as const, last_verified_at: AGED };
    const decision = computeEffectiveAccess(
      input({ action: "approval", workspace_role: "admin", repository: aged }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("authority_stale");
    expect(decision.requires_reconciliation).toBe(true);
  });

  test("sensitive actions require fresh verification, not just recent-ish authority", () => {
    const semi = { subject: "4242", state: "active" as const, last_verified_at: SEMI };
    const decision = computeEffectiveAccess(
      input({ action: "approval", workspace_role: "admin", repository: semi }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("verification_stale");
    expect(decision.requires_reconciliation).toBe(true);
    // Ordinary reads are fine with hour-old verification.
    expect(computeEffectiveAccess(input({ action: "read", repository: semi })).allowed).toBe(true);
  });
});

describe("capability grants", () => {
  test("write requires a live delivery capability grant", () => {
    const without = computeEffectiveAccess(input({ action: "write" }));
    expect(without.allowed).toBe(false);
    expect(without.reason).toBe("capability_grant");

    const withGrant = computeEffectiveAccess(
      input({ action: "write", capability_grants: ["delivery_write"] }),
    );
    expect(withGrant.allowed).toBe(true);
  });

  test("a checkout grant is not a delivery grant", () => {
    const decision = computeEffectiveAccess(
      input({ action: "write", capability_grants: ["checkout_read"] }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("capability_grant");
  });
});
