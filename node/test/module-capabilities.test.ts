import { describe, expect, test } from "vitest";

import type { RepositoryCapability } from "../src/control-plane/member-capability-types.js";
import type { WorkspaceRole } from "../src/control-plane/types.js";
import { computeEffectiveAccess } from "../src/provider-access/effective-access.js";
import {
  CAPABILITY_MODULES,
  MODULE_ACTIONS,
  computeModuleCapabilities,
  type ModuleCapabilityInput,
  type ModuleCapabilityView,
} from "../src/provider-access/module-capabilities.js";
import { DEFAULT_ACTION_POLICY } from "../src/provider-access/types.js";
import type { ActionKind, AccessDecision } from "../src/provider-access/types.js";
import type { SecurityDuty } from "../src/security/duties.js";

/**
 * DAT-278 module matrix, independent of HTTP. It is built from the real
 * effective-access decisions so a projection cannot claim an action the gate
 * denies, and it proves the two authorities that are deliberately independent
 * of workspace role: security duty and enterprise administration.
 */

const NOW = new Date("2026-11-22T12:03:00.000Z");
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

type CeilingState = "verified" | "unverified" | "confirmed_loss";

function decisionsFor(input: {
  role: WorkspaceRole | null;
  capabilities: readonly RepositoryCapability[];
  ceiling?: CeilingState;
}): Record<ActionKind, AccessDecision> {
  const ceiling = input.ceiling ?? "verified";
  const decisions = {} as Record<ActionKind, AccessDecision>;
  for (const action of Object.keys(DEFAULT_ACTION_POLICY) as ActionKind[]) {
    decisions[action] = computeEffectiveAccess({
      action,
      enterprise: { member: true, user_status: "active" },
      workspace_role: input.role,
      repository: {
        subject: input.role === null ? null : "1001",
        state: "active",
        last_verified_at: FRESH,
      },
      capability_grants: ["checkout_read", "delivery_write"],
      capability_ceiling: {
        state: ceiling,
        capabilities: ceiling === "verified" ? [...input.capabilities] : [],
        reason:
          ceiling === "unverified"
            ? "authority_unknown"
            : ceiling === "confirmed_loss"
              ? "repository_access_removed"
              : null,
      },
      now: NOW,
    });
  }
  return decisions;
}

function modules(
  role: WorkspaceRole | null,
  options: {
    capabilities?: readonly RepositoryCapability[];
    ceiling?: CeilingState;
    teamLeader?: boolean;
    enterpriseAdmin?: boolean;
    duties?: readonly SecurityDuty[];
    enterpriseMember?: boolean;
  } = {},
): Record<string, ModuleCapabilityView> {
  const input: ModuleCapabilityInput = {
    role,
    enterprise_member: options.enterpriseMember ?? true,
    enterprise_admin: options.enterpriseAdmin ?? false,
    decisions: decisionsFor({
      role,
      capabilities: options.capabilities ?? [],
      ...(options.ceiling !== undefined ? { ceiling: options.ceiling } : {}),
    }),
    team_leader: options.teamLeader ?? false,
    security_duties: options.duties ?? [],
  };
  return computeModuleCapabilities(input);
}

const READ_ONLY: readonly RepositoryCapability[] = ["code_read"];
const WRITE: readonly RepositoryCapability[] = ["code_read", "issue_write", "repository_write"];
const MANAGE: readonly RepositoryCapability[] = [
  "code_read",
  "issue_write",
  "repository_write",
  "repository_manage",
];

function allowed(module: ModuleCapabilityView, action: string): boolean {
  return module.actions[action]?.allowed ?? false;
}

describe("role × module visibility and actions", () => {
  test("viewer reads but never mutates, and RSI is hidden", () => {
    const m = modules("viewer", { capabilities: READ_ONLY });
    expect(m["tasks"]).toMatchObject({ visible: true, data_ceiling: "repository" });
    expect(allowed(m["tasks"]!, "view")).toBe(true);
    expect(allowed(m["tasks"]!, "create")).toBe(false);
    expect(m["issues"]).toMatchObject({ visible: true, data_ceiling: "repository" });
    expect(allowed(m["issues"]!, "create")).toBe(false);
    expect(m["memory"]).toMatchObject({ visible: true, data_ceiling: "internal" });
    expect(allowed(m["memory"]!, "view_confidential")).toBe(false);
    expect(m["rsi"]).toMatchObject({ visible: false, data_ceiling: "none" });
    expect(m["dashboard"]).toMatchObject({ visible: true, data_ceiling: "operational" });
    expect(allowed(m["dashboard"]!, "view_financial")).toBe(false);
    expect(m["members"]).toMatchObject({ visible: true, data_ceiling: "roster" });
    expect(m["security"]).toMatchObject({ visible: false, data_ceiling: "none" });
    expect(m["service_integration"]).toMatchObject({ visible: false, data_ceiling: "none" });
  });

  test("member adds task/issue work and RSI proposals, never admin data", () => {
    const m = modules("member", { capabilities: WRITE });
    expect(allowed(m["tasks"]!, "create")).toBe(true);
    expect(allowed(m["tasks"]!, "approve")).toBe(false);
    expect(allowed(m["issues"]!, "create")).toBe(true);
    expect(allowed(m["issues"]!, "decide_candidate")).toBe(false);
    expect(m["memory"]).toMatchObject({ data_ceiling: "internal" });
    expect(m["rsi"]).toMatchObject({ visible: true, data_ceiling: "internal" });
    expect(allowed(m["rsi"]!, "view")).toBe(true);
    expect(allowed(m["rsi"]!, "propose")).toBe(true);
    expect(allowed(m["rsi"]!, "approve")).toBe(false);
    expect(m["dashboard"]).toMatchObject({ data_ceiling: "operational" });
    expect(m["members"]).toMatchObject({ data_ceiling: "roster" });
    expect(allowed(m["members"]!, "manage_members")).toBe(false);
  });

  test("admin gets confidential memory, financial dashboard, approvals and member management", () => {
    const m = modules("admin", { capabilities: MANAGE });
    expect(allowed(m["tasks"]!, "approve")).toBe(true);
    expect(allowed(m["issues"]!, "decide_candidate")).toBe(true);
    expect(m["memory"]).toMatchObject({ data_ceiling: "confidential" });
    expect(allowed(m["memory"]!, "view_confidential")).toBe(true);
    expect(allowed(m["memory"]!, "govern_workspace")).toBe(true);
    expect(allowed(m["rsi"]!, "approve")).toBe(true);
    expect(allowed(m["rsi"]!, "evaluate")).toBe(false);
    expect(m["dashboard"]).toMatchObject({ data_ceiling: "financial" });
    expect(allowed(m["dashboard"]!, "audit")).toBe(true);
    expect(allowed(m["members"]!, "manage_members")).toBe(true);
    expect(allowed(m["members"]!, "manage_roles")).toBe(false);
    // Enterprise administration is a separate grant even for a workspace owner.
    expect(m["service_integration"]!.visible).toBe(false);
  });

  test("owner adds role administration and the full RSI control surface", () => {
    const m = modules("owner", { capabilities: MANAGE });
    expect(allowed(m["members"]!, "manage_roles")).toBe(true);
    for (const action of ["evaluate", "replay", "canary", "rollback", "kill_switch"]) {
      expect(allowed(m["rsi"]!, action), action).toBe(true);
    }
  });

  test("provider management capability gates member administration, not the assigned role", () => {
    const m = modules("admin", { capabilities: WRITE });
    expect(allowed(m["members"]!, "manage_members")).toBe(false);
    expect(m["members"]!.actions["manage_members"]?.reason).toBe("capability_ceiling");
  });
});

describe("data need-to-know ceilings", () => {
  test("restricted Memory is never exposed through the ordinary projection", () => {
    for (const role of ["viewer", "member", "admin", "owner"] as WorkspaceRole[]) {
      const m = modules(role, { capabilities: MANAGE });
      expect(m["memory"]!.data_ceiling).not.toBe("restricted");
      expect(allowed(m["memory"]!, "restricted_access")).toBe(false);
    }
  });

  test("memory ceiling follows the retrieval policy exactly", () => {
    expect(modules("viewer", { capabilities: READ_ONLY })["memory"]!.data_ceiling).toBe("internal");
    expect(modules("member", { capabilities: WRITE })["memory"]!.data_ceiling).toBe("internal");
    expect(modules("admin", { capabilities: MANAGE })["memory"]!.data_ceiling).toBe("confidential");
    expect(modules("owner", { capabilities: MANAGE })["memory"]!.data_ceiling).toBe("confidential");
  });
});

describe("team leadership", () => {
  test("a team-leading member may govern only through the team exception", () => {
    const leader = modules("member", { capabilities: WRITE, teamLeader: true });
    expect(allowed(leader["memory"]!, "govern_team")).toBe(true);
    expect(allowed(leader["memory"]!, "govern_workspace")).toBe(false);
    const other = modules("member", { capabilities: WRITE });
    expect(allowed(other["memory"]!, "govern_team")).toBe(false);
    expect(other["memory"]!.actions["govern_team"]?.reason).toBe("team_leader");
  });
});

describe("security duties are independent of workspace role", () => {
  test("no duty means no security module, even for an owner", () => {
    const m = modules("owner", { capabilities: MANAGE });
    expect(m["security"]!.visible).toBe(false);
    expect(Object.values(m["security"]!.actions).every((action) => !action.allowed)).toBe(true);
  });

  test("handler and reviewer duties authorize only their matrix actions", () => {
    const handler = modules("viewer", { capabilities: READ_ONLY, duties: ["security_handler"] });
    expect(handler["security"]).toMatchObject({ visible: true, data_ceiling: "redacted" });
    expect(allowed(handler["security"]!, "case.handle")).toBe(true);
    expect(allowed(handler["security"]!, "quarantine.view")).toBe(true);
    expect(allowed(handler["security"]!, "case.review_decide")).toBe(false);
    expect(allowed(handler["security"]!, "audit.export")).toBe(false);

    const reviewer = modules("member", {
      capabilities: WRITE,
      duties: ["independent_reviewer"],
    });
    expect(allowed(reviewer["security"]!, "case.review_decide")).toBe(true);
    expect(allowed(reviewer["security"]!, "audit.read")).toBe(true);
    expect(allowed(reviewer["security"]!, "case.handle")).toBe(false);
  });

  test("enterprise security administration does not create review authority", () => {
    const admin = modules("admin", {
      capabilities: MANAGE,
      duties: ["enterprise_security_admin"],
    });
    expect(admin["security"]).toMatchObject({ visible: true, data_ceiling: "audit" });
    expect(allowed(admin["security"]!, "audit.export")).toBe(true);
    expect(allowed(admin["security"]!, "recovery.revoke")).toBe(true);
    expect(allowed(admin["security"]!, "case.review_decide")).toBe(false);
    expect(allowed(admin["security"]!, "rule.review")).toBe(false);
  });

  test("a workspace demotion does not erase a duty holder's stop/recovery actions", () => {
    const before = modules("owner", {
      capabilities: MANAGE,
      duties: ["security_handler", "independent_reviewer"],
    });
    const after = modules("viewer", {
      capabilities: READ_ONLY,
      duties: ["security_handler", "independent_reviewer"],
    });
    expect(before["security"]!.actions).toEqual(after["security"]!.actions);
    expect(allowed(after["security"]!, "case.terminate")).toBe(true);
    expect(allowed(after["security"]!, "recovery.approve")).toBe(true);
    // The data plane really did tighten; only the duty surface stayed.
    expect(allowed(after["tasks"]!, "create")).toBe(false);
    expect(after["memory"]!.data_ceiling).toBe("internal");
  });
});

describe("enterprise administration is not repository authority", () => {
  test("an enterprise admin with a workspace role gets metadata, not workspace data", () => {
    const m = modules("owner", { capabilities: MANAGE, enterpriseAdmin: true });
    expect(m["service_integration"]).toMatchObject({
      visible: true,
      data_ceiling: "metadata",
    });
    expect(allowed(m["service_integration"]!, "configure")).toBe(true);
    expect(m["tasks"]!.data_ceiling).toBe("repository");
  });

  test("an enterprise-only admin has no workspace module data", () => {
    const m = computeModuleCapabilities({
      role: null,
      enterprise_member: true,
      enterprise_admin: true,
      decisions: decisionsFor({ role: null, capabilities: [] }),
      team_leader: false,
      security_duties: [],
    });
    for (const name of CAPABILITY_MODULES) {
      if (name === "service_integration") {
        continue;
      }
      expect(m[name]!.data_ceiling, name).toBe("none");
    }
    expect(m["service_integration"]!.visible).toBe(true);
  });
});

describe("fail-closed behavior", () => {
  test("unverifiable provider evidence denies every data action but keeps duties and metadata", () => {
    const m = modules("owner", {
      capabilities: MANAGE,
      ceiling: "unverified",
      enterpriseAdmin: true,
      duties: ["security_handler"],
    });
    for (const name of ["tasks", "issues", "memory", "rsi", "dashboard", "members"] as const) {
      expect(m[name]!.data_ceiling, name).toBe("none");
      for (const [action, decision] of Object.entries(m[name]!.actions)) {
        if (["restricted_access", "govern_team", "manage_roles"].includes(action)) {
          continue;
        }
        expect(decision.allowed, `${name}.${action}`).toBe(false);
      }
      expect(m[name]!.reason, name).not.toBeNull();
    }
    // Security duty is a separate human authority and survives a provider
    // outage; service-integration metadata is enterprise administration.
    expect(allowed(m["security"]!, "case.handle")).toBe(true);
    expect(allowed(m["service_integration"]!, "view_metadata")).toBe(true);
  });

  test("a confirmed loss denies every data action and never promotes on its own", () => {
    const m = modules("admin", { capabilities: MANAGE, ceiling: "confirmed_loss" });
    expect(m["tasks"]!.data_ceiling).toBe("none");
    expect(m["memory"]!.data_ceiling).toBe("none");
    expect(m["rsi"]!.data_ceiling).toBe("none");
    expect(m["dashboard"]!.data_ceiling).toBe("none");
    expect(m["members"]!.data_ceiling).toBe("none");
  });

  test("an inactive enterprise membership suppresses duties and enterprise metadata", () => {
    const m = modules("owner", {
      capabilities: MANAGE,
      enterpriseAdmin: true,
      enterpriseMember: false,
      duties: ["security_handler"],
    });
    // The real gate computes the data decisions from live enterprise status;
    // this function additionally refuses the two independent authorities.
    expect(m["security"]!.visible).toBe(false);
    expect(m["service_integration"]!.visible).toBe(false);
  });
});

describe("module/action vocabulary", () => {
  test("every module declares a closed, non-empty action set", () => {
    expect(CAPABILITY_MODULES).toHaveLength(8);
    for (const module of CAPABILITY_MODULES) {
      expect(MODULE_ACTIONS[module].length, module).toBeGreaterThan(0);
      expect(new Set(MODULE_ACTIONS[module]).size, module).toBe(MODULE_ACTIONS[module].length);
    }
  });
});
