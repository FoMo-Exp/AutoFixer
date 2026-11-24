/**
 * Eight-module capability projection (DAT-278, ADR-0011).
 *
 * The workspace projection answers two different questions and keeps them
 * separate:
 *
 * - **Visibility** — may this role see the module at all? RSI is hidden from
 *   viewers, Security is hidden without a duty, and Service integration is
 *   hidden without enterprise administration.
 * - **Actions and data ceiling** — even inside a visible module, each action
 *   and the highest data class the caller may read are decided separately.
 *   A hidden button is never the control: the same action is rechecked on the
 *   request path.
 *
 * Every data-plane action is derived from the real access-gate decisions
 * (`read`, `write`, `approval`, `delivery`, `issue_sync`, `manage`) so the
 * projection cannot disagree with the request boundary about enterprise
 * membership, workspace role, provider capability intersection, action
 * sensitivity or freshness.
 *
 * Two authorities are deliberately *not* repository capabilities:
 *
 * - **Security duties** are a separate, human-only matrix. A workspace owner
 *   without a duty gets no security action, and a duty holder keeps their
 *   recovery/stop actions when an ordinary workspace role is reduced — the
 *   duty is not derived from the role, so lowering the role cannot erase it.
 * - **Enterprise administration** is not repository authority. It reaches the
 *   enterprise directory, identity audit and service-integration metadata, and
 *   never workspace repository data.
 */

import type { WorkspaceRole } from "../control-plane/types.js";
import {
  SECURITY_DUTY_MATRIX,
  type SecurityAction,
  type SecurityDuty,
} from "../security/duties.js";
import { sensitivityCeiling } from "../memory/retrieval/rank.js";
import type { MemorySensitivity } from "../memory/types.js";
import {
  WORKSPACE_ROLE_RANK,
  type AccessDecision,
  type ActionKind,
  type DenyReason,
} from "./types.js";

/** Stable schema/version of the workspace projection served to clients. */
export const WORKSPACE_CAPABILITY_SCHEMA_VERSION = "workspace-capability-v2" as const;

/**
 * Events that make a previously fetched projection stale. The projection is
 * advisory only; clients refetch on any of these and the server never accepts
 * a projection as a grant. An in-process authority epoch is a convenience
 * signal, not the security boundary: persisted membership, enterprise status,
 * ceiling and provider facts are re-read on every request.
 */
export const PROJECTION_INVALIDATION_REASONS = [
  "authority_epoch_changed",
  "capability_ceiling_changed",
  "membership_changed",
  "enterprise_status_changed",
  "session_revoked",
  "provider_reconciled",
  "projection_expired",
] as const;

export const CAPABILITY_MODULES = [
  "tasks",
  "issues",
  "memory",
  "rsi",
  "dashboard",
  "members",
  "security",
  "service_integration",
] as const;

export type CapabilityModule = (typeof CAPABILITY_MODULES)[number];

/**
 * Highest data class a module may return to this caller. `none` means the
 * module is visible as navigation but returns no data. `restricted` is never
 * produced by the ordinary workspace projection: restricted Memory needs a
 * separate authorization, not a higher workspace role.
 */
export const CAPABILITY_DATA_CEILINGS = [
  "none",
  "repository",
  "internal",
  "confidential",
  "operational",
  "financial",
  "roster",
  "governance",
  "redacted",
  "audit",
  "metadata",
] as const;

export type CapabilityDataCeiling = (typeof CAPABILITY_DATA_CEILINGS)[number];

/** Every action name of every module. The contract closes each module over its set. */
export const MODULE_ACTIONS = {
  tasks: ["view", "stream", "artifacts", "create", "run", "manage", "approve"],
  issues: ["view", "create", "comment", "request_approval", "decide_candidate", "deliver"],
  memory: ["view", "view_confidential", "govern_team", "govern_workspace", "restricted_access"],
  rsi: ["view", "propose", "approve", "evaluate", "replay", "canary", "rollback", "kill_switch"],
  dashboard: ["view", "view_trace", "view_financial", "audit", "export"],
  members: ["view", "manage_members", "manage_teams", "invite", "manage_roles"],
  security: [...(Object.keys(SECURITY_DUTY_MATRIX) as SecurityAction[])].sort(),
  service_integration: ["view_metadata", "configure"],
} as const satisfies Record<CapabilityModule, readonly string[]>;

export interface ModuleActionView {
  allowed: boolean;
  /** Repository capability, role, team or duty this action requires. */
  required: string;
  /** Safe machine reason; never names a repository, teammate or credential. */
  reason?:
    | DenyReason
    | "workspace_role"
    | "team_leader"
    | "security_duty"
    | "enterprise_admin"
    | "enterprise_admin_required"
    | "enterprise_administration_is_not_repository_authority";
}

export interface ModuleCapabilityView {
  visible: boolean;
  data_ceiling: CapabilityDataCeiling;
  reason: string | null;
  actions: Record<string, ModuleActionView>;
}

export interface ModuleCapabilityInput {
  /** Assigned workspace role; null when the caller has no membership. */
  role: WorkspaceRole | null;
  /** Active enterprise membership (the outer boundary). */
  enterprise_member: boolean;
  /** Enterprise administrator grant in this enterprise. */
  enterprise_admin: boolean;
  /** Live gate decisions for the request-path action classes. */
  decisions: Readonly<Record<ActionKind, AccessDecision>>;
  /** True when the caller leads at least one team in this workspace. */
  team_leader: boolean;
  /** Security duties held by this specific human principal. */
  security_duties: readonly SecurityDuty[];
}

const ROLE_ORDER: readonly WorkspaceRole[] = ["viewer", "member", "admin", "owner"];

function roleAtLeast(role: WorkspaceRole | null, minimum: WorkspaceRole): boolean {
  return role !== null && WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[minimum];
}

function allow(required: string): ModuleActionView {
  return { allowed: true, required };
}

function deny(required: string, reason: ModuleActionView["reason"]): ModuleActionView {
  return { allowed: false, required, ...(reason !== undefined ? { reason } : {}) };
}

function fromDecision(decision: AccessDecision, required: string): ModuleActionView {
  if (decision.allowed) {
    return allow(required);
  }
  return deny(required, decision.reason ?? "action_policy");
}

/**
 * A data action that also needs a minimum assigned role. The gate already
 * evaluates the role for its own action classes; this adds the module's
 * stricter role where ADR-0011 requires one (confidential memory, financial
 * dashboard, RSI approvals, role administration).
 */
function fromDecisionWithRole(
  decision: AccessDecision,
  required: string,
  role: WorkspaceRole | null,
  minimum: WorkspaceRole,
): ModuleActionView {
  if (!decision.allowed) {
    return deny(required, decision.reason ?? "action_policy");
  }
  if (!roleAtLeast(role, minimum)) {
    return deny(required, "workspace_role");
  }
  return allow(required);
}

function dataCeilingForMemory(
  role: WorkspaceRole | null,
  readable: boolean,
): CapabilityDataCeiling {
  if (!readable || role === null) {
    return "none";
  }
  // `restricted` is intentionally unreachable: the ordinary role ceiling stops
  // at `confidential`, and restricted material needs separate authorization.
  return sensitivityCeiling(role) satisfies MemorySensitivity as CapabilityDataCeiling;
}

function moduleReason(
  visible: boolean,
  required: string,
  actions: Record<string, ModuleActionView>,
): string | null {
  if (visible) {
    return null;
  }
  const denied = Object.values(actions).find((action) => !action.allowed);
  return denied?.reason ?? required;
}

/**
 * Compute all eight modules from the caller's role, the gate decisions, and
 * the two independent authority sources (team leadership and security duty).
 */
export function computeModuleCapabilities(
  input: ModuleCapabilityInput,
): Record<CapabilityModule, ModuleCapabilityView> {
  const { role, decisions } = input;
  const atLeastViewer = roleAtLeast(role, "viewer");
  const atLeastMember = roleAtLeast(role, "member");
  const atLeastAdmin = roleAtLeast(role, "admin");

  const tasks: ModuleCapabilityView = {
    visible: atLeastViewer,
    data_ceiling: decisions.read.allowed && atLeastViewer ? "repository" : "none",
    reason: null,
    actions: {
      view: fromDecision(decisions.read, "code_read"),
      stream: fromDecision(decisions.stream, "code_read"),
      artifacts: fromDecision(decisions.artifact_read, "code_read"),
      create: fromDecision(decisions.write, "repository_write"),
      run: fromDecision(decisions.write, "repository_write"),
      manage: fromDecision(decisions.write, "repository_write"),
      approve: fromDecision(decisions.approval, "repository_write"),
    },
  };

  const issues: ModuleCapabilityView = {
    visible: atLeastViewer,
    data_ceiling: decisions.read.allowed && atLeastViewer ? "repository" : "none",
    reason: null,
    actions: {
      view: fromDecision(decisions.read, "code_read"),
      create: fromDecision(decisions.issue_sync, "issue_write"),
      comment: fromDecision(decisions.issue_sync, "issue_write"),
      request_approval: fromDecision(decisions.delivery, "repository_write"),
      decide_candidate: fromDecision(decisions.approval, "repository_write"),
      deliver: fromDecision(decisions.delivery, "repository_write"),
    },
  };

  const memoryReadable = decisions.read.allowed && atLeastViewer;
  const memory: ModuleCapabilityView = {
    visible: atLeastViewer,
    data_ceiling: dataCeilingForMemory(role, memoryReadable),
    reason: null,
    actions: {
      view: fromDecision(decisions.read, "code_read"),
      view_confidential: fromDecisionWithRole(
        decisions.read,
        "workspace_role:admin",
        role,
        "admin",
      ),
      govern_team: input.team_leader
        ? fromDecision(decisions.write, "team_leader")
        : deny("team_leader", "team_leader"),
      govern_workspace: fromDecisionWithRole(
        decisions.write,
        "workspace_role:admin",
        role,
        "admin",
      ),
      // Never allowed through the ordinary projection. Quarantine inspection
      // and restricted material need their own live grant.
      restricted_access: deny("separate_grant", "action_policy"),
    },
  };

  const rsi: ModuleCapabilityView = {
    visible: atLeastMember,
    data_ceiling: decisions.read.allowed && atLeastMember ? "internal" : "none",
    reason: null,
    actions: {
      view: fromDecisionWithRole(decisions.read, "workspace_role:member", role, "member"),
      propose: fromDecisionWithRole(decisions.write, "workspace_role:member", role, "member"),
      approve: fromDecisionWithRole(decisions.write, "workspace_role:admin", role, "admin"),
      evaluate: fromDecisionWithRole(decisions.write, "workspace_role:owner", role, "owner"),
      replay: fromDecisionWithRole(decisions.write, "workspace_role:owner", role, "owner"),
      canary: fromDecisionWithRole(decisions.write, "workspace_role:owner", role, "owner"),
      rollback: fromDecisionWithRole(decisions.write, "workspace_role:owner", role, "owner"),
      kill_switch: fromDecisionWithRole(decisions.write, "workspace_role:owner", role, "owner"),
    },
  };

  const dashboard: ModuleCapabilityView = {
    visible: atLeastViewer,
    data_ceiling:
      decisions.read.allowed && atLeastViewer
        ? atLeastAdmin
          ? "financial"
          : "operational"
        : "none",
    reason: null,
    actions: {
      view: fromDecision(decisions.read, "code_read"),
      view_trace: fromDecision(decisions.read, "code_read"),
      view_financial: fromDecisionWithRole(decisions.read, "workspace_role:admin", role, "admin"),
      audit: fromDecisionWithRole(decisions.read, "workspace_role:admin", role, "admin"),
      export: fromDecisionWithRole(decisions.read, "workspace_role:admin", role, "admin"),
    },
  };

  const members: ModuleCapabilityView = {
    visible: atLeastViewer,
    data_ceiling:
      decisions.read.allowed && atLeastViewer ? (atLeastAdmin ? "governance" : "roster") : "none",
    reason: null,
    actions: {
      view: fromDecision(decisions.read, "code_read"),
      manage_members: fromDecisionWithRole(decisions.manage, "repository_manage", role, "admin"),
      manage_teams: fromDecisionWithRole(decisions.manage, "repository_manage", role, "admin"),
      invite: fromDecisionWithRole(decisions.manage, "repository_manage", role, "admin"),
      manage_roles: fromDecisionWithRole(decisions.manage, "repository_manage", role, "owner"),
    },
  };

  // Security has no role- or capability-derived access at all: the only
  // authority is an explicit duty held by this human principal. That is why a
  // workspace demotion cannot remove a security handler's or reviewer's stop /
  // recovery responsibility.
  const securityActions: Record<string, ModuleActionView> = {};
  const duties = input.enterprise_member ? input.security_duties : [];
  for (const action of MODULE_ACTIONS.security) {
    const permitted = SECURITY_DUTY_MATRIX[action as SecurityAction] ?? [];
    securityActions[action] = duties.some((duty) => permitted.includes(duty))
      ? allow("security_duty")
      : deny("security_duty", "security_duty");
  }
  const securityVisible = Object.values(securityActions).some((action) => action.allowed);
  const security: ModuleCapabilityView = {
    visible: securityVisible,
    data_ceiling: securityVisible
      ? duties.includes("enterprise_security_admin")
        ? "audit"
        : "redacted"
      : "none",
    reason: null,
    actions: securityActions,
  };

  // Enterprise administration is a separate grant. It reaches metadata only —
  // never repository data — and does not depend on the workspace role or the
  // provider capability ceiling.
  const serviceIntegrationAllowed =
    input.enterprise_member && input.enterprise_admin ? true : false;
  const serviceIntegration: ModuleCapabilityView = {
    visible: serviceIntegrationAllowed,
    data_ceiling: serviceIntegrationAllowed ? "metadata" : "none",
    reason: null,
    actions: {
      view_metadata: serviceIntegrationAllowed
        ? allow("enterprise_admin")
        : deny("enterprise_admin", "enterprise_admin"),
      configure: serviceIntegrationAllowed
        ? allow("enterprise_admin")
        : deny("enterprise_admin", "enterprise_admin"),
    },
  };

  const modules: Record<CapabilityModule, ModuleCapabilityView> = {
    tasks,
    issues,
    memory,
    rsi,
    dashboard,
    members,
    security,
    service_integration: serviceIntegration,
  };

  // Visibility reasons are computed after the actions exist so a hidden module
  // explains the role/duty that is missing.
  for (const [name, module] of Object.entries(modules) as Array<
    [CapabilityModule, ModuleCapabilityView]
  >) {
    module.reason = moduleReason(
      module.visible,
      name === "security"
        ? "security_duty"
        : name === "service_integration"
          ? "enterprise_admin"
          : name === "rsi"
            ? "workspace_role:member"
            : "workspace_role:viewer",
      module.actions,
    );
    // A visible module with no readable data still reports why.
    if (module.visible && module.data_ceiling === "none" && module.reason === null) {
      const denial = Object.values(module.actions).find((action) => !action.allowed);
      module.reason = denial?.reason ?? null;
    }
  }

  return modules;
}

/** Canonical role order for documentation and tests (never a grant). */
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ROLE_ORDER;
