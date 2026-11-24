import type { WorkspaceCapabilityProjection } from "../api/identity";
import type { WorkspaceRole } from "../api/identity";
import type {
  ActionDecision,
  CapabilityDataCeiling,
  CapabilityModule,
  ModuleAccess,
} from "./projection";
import verified from "../../../docs/fixtures/capability-api-v1/projection-verified.json";
import downgraded from "../../../docs/fixtures/capability-api-v1/projection-downgraded.json";
import unverified from "../../../docs/fixtures/capability-api-v1/projection-unverified.json";

/**
 * Test-shaped copies of the merged DAT-278 captures. Only identifiers and
 * timestamps are substituted; module/action names and shapes come from
 * `docs/fixtures/capability-api-v1/`, so a test can never pin an invented
 * field.
 */

interface RawAction {
  allowed: boolean;
  required: string;
  reason?: string;
}

interface RawModule {
  visible: boolean;
  data_ceiling: string;
  reason: string | null;
  actions: Record<string, RawAction>;
}

interface RawProjection {
  schema_version: string;
  enterprise_id: string;
  workspace_id: string;
  assigned_role: string | null;
  state: string;
  blocked_reason: string | null;
  capabilities: string[];
  modules: Record<string, RawModule>;
  freshness: {
    checked_at: string;
    expires_at: string;
    stale_after: string;
    state: string;
    invalidation: string[];
  };
  checked_at: string;
}

export type TestProjectionRole =
  | "viewer"
  | "member"
  | "admin"
  | "owner"
  | "enterprise_admin"
  | "security_handler"
  | "unverified"
  | "downgraded";

function clone(source: unknown): RawProjection {
  return structuredClone(source) as RawProjection;
}

function allow(module: RawModule, names: readonly string[]): void {
  for (const name of names) {
    const existing = module.actions[name];
    module.actions[name] = {
      allowed: true,
      required: existing?.required ?? "workspace_role",
    };
  }
}

function deny(module: RawModule, names: readonly string[]): void {
  for (const name of names) {
    const existing = module.actions[name];
    module.actions[name] = {
      allowed: false,
      required: existing?.required ?? "workspace_role",
      reason: "workspace_role",
    };
  }
}

function modulesOf(projection: RawProjection): Record<string, RawModule> {
  return projection.modules;
}

function applyViewer(projection: RawProjection): void {
  const modules = modulesOf(projection);
  allow(modules.tasks, ["view", "stream", "artifacts"]);
  deny(modules.tasks, ["create", "run", "manage", "approve"]);
  allow(modules.issues, ["view"]);
  deny(modules.issues, ["create", "comment", "request_approval", "decide_candidate", "deliver"]);
  allow(modules.memory, ["view"]);
  deny(modules.memory, [
    "view_confidential",
    "govern_team",
    "govern_workspace",
    "restricted_access",
  ]);
  modules.memory.data_ceiling = "internal";
  modules.rsi.visible = false;
  modules.rsi.data_ceiling = "none";
  deny(modules.rsi, [
    "view",
    "propose",
    "approve",
    "evaluate",
    "replay",
    "canary",
    "rollback",
    "kill_switch",
  ]);
  allow(modules.dashboard, ["view", "view_trace"]);
  deny(modules.dashboard, ["view_financial", "audit", "export"]);
  modules.dashboard.data_ceiling = "operational";
  allow(modules.members, ["view"]);
  deny(modules.members, ["manage_members", "manage_teams", "invite", "manage_roles"]);
  modules.members.data_ceiling = "roster";
  modules.security.visible = false;
  modules.security.data_ceiling = "none";
  modules.service_integration.visible = false;
  modules.service_integration.data_ceiling = "none";
}

function applyAdmin(projection: RawProjection): void {
  const modules = modulesOf(projection);
  allow(modules.members, ["view", "manage_members", "manage_teams", "invite"]);
  modules.members.data_ceiling = "governance";
  allow(modules.memory, ["view_confidential", "govern_workspace"]);
  modules.memory.data_ceiling = "confidential";
  allow(modules.dashboard, ["view_financial", "audit", "export"]);
  modules.dashboard.data_ceiling = "financial";
  allow(modules.rsi, ["approve"]);
  allow(modules.issues, ["decide_candidate"]);
}

function applyOwner(projection: RawProjection): void {
  applyAdmin(projection);
  const modules = modulesOf(projection);
  allow(modules.members, ["manage_roles"]);
  allow(modules.rsi, ["evaluate", "replay", "canary", "rollback", "kill_switch"]);
}

function applySecurityHandler(projection: RawProjection): void {
  const security = modulesOf(projection).security;
  security.visible = true;
  security.data_ceiling = "redacted";
  security.reason = null;
  allow(security, [
    "case.read_redacted_status",
    "case.handle",
    "case.submit_for_review",
    "quarantine.view",
    "rule.propose",
    "audit.read",
    "recovery.reconcile",
  ]);
}

function applyEnterpriseAdmin(projection: RawProjection): void {
  const service = modulesOf(projection).service_integration;
  service.visible = true;
  service.data_ceiling = "metadata";
  service.reason = null;
  allow(service, ["view_metadata", "configure"]);
}

/** A fresh, contract-shaped projection for one test role. */
export function capabilityProjection(
  options: {
    role?: TestProjectionRole;
    workspaceId?: string;
    enterpriseId?: string;
    now?: number;
    /** Enterprise administration is a separate grant, not a workspace role. */
    enterpriseAdmin?: boolean;
  } = {},
): WorkspaceCapabilityProjection {
  const {
    role = "member",
    workspaceId = "ws_test",
    enterpriseId = "ent_test",
    now = Date.now(),
    enterpriseAdmin = false,
  } = options;
  const baseRole =
    role === "unverified" ? "unverified" : role === "downgraded" ? "downgraded" : undefined;
  const projection =
    baseRole === "unverified"
      ? clone(unverified)
      : baseRole === "downgraded"
        ? clone(downgraded)
        : clone(verified);
  projection.workspace_id = workspaceId;
  projection.enterprise_id = enterpriseId;
  const assigned: WorkspaceRole =
    role === "viewer"
      ? "viewer"
      : role === "admin" || role === "enterprise_admin"
        ? "admin"
        : role === "owner"
          ? "owner"
          : "member";
  projection.assigned_role = assigned;

  if (role === "viewer") applyViewer(projection);
  if (role === "admin" || role === "enterprise_admin") applyAdmin(projection);
  if (role === "owner") applyOwner(projection);
  if (role === "security_handler") applySecurityHandler(projection);
  if (role === "enterprise_admin") applyEnterpriseAdmin(projection);
  if (enterpriseAdmin) applyEnterpriseAdmin(projection);

  const checked = new Date(now - 30_000).toISOString();
  projection.checked_at = checked;
  projection.freshness = {
    checked_at: checked,
    expires_at: new Date(now + 15 * 60_000).toISOString(),
    stale_after: new Date(now + 24 * 60 * 60_000).toISOString(),
    state: "fresh",
    invalidation: [
      "authority_epoch_changed",
      "capability_ceiling_changed",
      "membership_changed",
      "enterprise_status_changed",
      "session_revoked",
      "provider_reconciled",
      "projection_expired",
    ],
  };
  return projection as unknown as WorkspaceCapabilityProjection;
}

export function expiredCapabilityProjection(
  options: { workspaceId?: string; now?: number } = {},
): WorkspaceCapabilityProjection {
  const now = options.now ?? Date.now();
  const projection = capabilityProjection({
    role: "member",
    workspaceId: options.workspaceId ?? "ws_test",
    now,
  });
  const raw = projection as unknown as RawProjection;
  raw.freshness.checked_at = new Date(now - 3_600_000).toISOString();
  raw.freshness.expires_at = new Date(now - 60_000).toISOString();
  raw.freshness.stale_after = new Date(now - 30_000).toISOString();
  raw.checked_at = raw.freshness.checked_at;
  return projection;
}

/** The normalized `ModuleAccess` a component receives for one module. */
export function accessOf(
  projection: WorkspaceCapabilityProjection,
  module: CapabilityModule,
): ModuleAccess {
  // The test builder produced this value from the merged fixture shape.
  const raw = projection as unknown as RawProjection;
  const source = raw.modules[module];
  const actions: Record<string, ActionDecision> = {};
  for (const [name, action] of Object.entries(source.actions)) {
    actions[name] = {
      allowed: action.allowed,
      required: action.required,
      reason: action.reason ?? null,
    };
  }
  return {
    visible: source.visible,
    dataCeiling: source.data_ceiling as CapabilityDataCeiling,
    reason: source.reason,
    actions,
  };
}
