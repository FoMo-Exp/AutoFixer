/**
 * Enterprise-scoped capability projection (DAT-278, ADR-0011).
 *
 * Enterprise administration is a separate grant from workspace access. This
 * projection exists so an enterprise administrator without a workspace
 * membership can reach the surfaces their enterprise role actually covers —
 * the user directory, identity audit, and service-integration metadata —
 * while the same response states explicitly that no workspace repository data
 * is included.
 *
 * The workspace projection (`module-capabilities.ts`) remains the only place
 * that can report workspace module data. Enterprise administration never
 * appears there as a repository-data grant either.
 */

import { PROJECTION_INVALIDATION_REASONS } from "../provider-access/module-capabilities.js";
import type { ModuleActionView } from "../provider-access/module-capabilities.js";

export const ENTERPRISE_CAPABILITY_SCHEMA_VERSION = "enterprise-capability-v1" as const;

export const ENTERPRISE_MODULES = [
  "enterprise_directory",
  "identity_audit",
  "service_integration",
  "workspace_data",
] as const;

export type EnterpriseCapabilityModule = (typeof ENTERPRISE_MODULES)[number];

export const ENTERPRISE_MODULE_ACTIONS = {
  enterprise_directory: ["view", "add_user", "suspend_user", "restore_user", "change_role"],
  identity_audit: ["read"],
  service_integration: ["view_metadata", "configure"],
  workspace_data: [
    "view_tasks",
    "view_issues",
    "view_memory",
    "view_rsi",
    "view_dashboard",
    "view_security",
  ],
} as const satisfies Record<EnterpriseCapabilityModule, readonly string[]>;

export interface EnterpriseModuleView {
  visible: boolean;
  data_ceiling: "none" | "directory" | "audit" | "metadata";
  reason: string | null;
  actions: Record<string, ModuleActionView>;
}

export interface EnterpriseCapabilityProjection {
  schema_version: typeof ENTERPRISE_CAPABILITY_SCHEMA_VERSION;
  enterprise_id: string;
  member: {
    status: "active" | "suspended";
    role: "admin" | "member";
  };
  modules: Record<EnterpriseCapabilityModule, EnterpriseModuleView>;
  /**
   * Always false here. Holding enterprise administration is not repository
   * authority; workspace data comes only from the workspace projection and the
   * per-request gate.
   */
  workspace_data_access: {
    granted: false;
    reason: "enterprise_administration_is_not_repository_authority";
  };
  freshness: {
    checked_at: string;
    expires_at: string;
    stale_after: string;
    state: "fresh";
    invalidation: readonly string[];
  };
  checked_at: string;
}

export interface EnterpriseCapabilityInput {
  enterprise_id: string;
  status: "active" | "suspended";
  role: "admin" | "member";
  now: Date;
  fresh_window_ms: number;
  stale_after_ms: number;
}

function actionsFor(
  names: readonly string[],
  allowed: boolean,
  required: string,
  reason: ModuleActionView["reason"],
): Record<string, ModuleActionView> {
  const actions: Record<string, ModuleActionView> = {};
  for (const name of names) {
    actions[name] = allowed ? { allowed: true, required } : { allowed: false, required, reason };
  }
  return actions;
}

export function computeEnterpriseCapabilityProjection(
  input: EnterpriseCapabilityInput,
): EnterpriseCapabilityProjection {
  const admin = input.status === "active" && input.role === "admin";
  const checkedAt = input.now.toISOString();

  const directory: EnterpriseModuleView = {
    visible: admin,
    data_ceiling: admin ? "directory" : "none",
    reason: admin ? null : "enterprise_admin_required",
    actions: actionsFor(
      ENTERPRISE_MODULE_ACTIONS.enterprise_directory,
      admin,
      "enterprise_admin",
      "enterprise_admin_required",
    ),
  };
  const audit: EnterpriseModuleView = {
    visible: admin,
    data_ceiling: admin ? "audit" : "none",
    reason: admin ? null : "enterprise_admin_required",
    actions: actionsFor(
      ENTERPRISE_MODULE_ACTIONS.identity_audit,
      admin,
      "enterprise_admin",
      "enterprise_admin_required",
    ),
  };
  const integration: EnterpriseModuleView = {
    visible: admin,
    data_ceiling: admin ? "metadata" : "none",
    reason: admin ? null : "enterprise_admin_required",
    actions: actionsFor(
      ENTERPRISE_MODULE_ACTIONS.service_integration,
      admin,
      "enterprise_admin",
      "enterprise_admin_required",
    ),
  };
  const workspaceData: EnterpriseModuleView = {
    visible: false,
    data_ceiling: "none",
    reason: "enterprise_administration_is_not_repository_authority",
    actions: actionsFor(
      ENTERPRISE_MODULE_ACTIONS.workspace_data,
      false,
      "workspace_membership_and_repository_capability",
      "enterprise_administration_is_not_repository_authority",
    ),
  };

  return {
    schema_version: ENTERPRISE_CAPABILITY_SCHEMA_VERSION,
    enterprise_id: input.enterprise_id,
    member: { status: input.status, role: input.role },
    modules: {
      enterprise_directory: directory,
      identity_audit: audit,
      service_integration: integration,
      workspace_data: workspaceData,
    },
    workspace_data_access: {
      granted: false,
      reason: "enterprise_administration_is_not_repository_authority",
    },
    freshness: {
      checked_at: checkedAt,
      expires_at: new Date(input.now.getTime() + input.fresh_window_ms).toISOString(),
      stale_after: new Date(input.now.getTime() + input.stale_after_ms).toISOString(),
      state: "fresh",
      invalidation: PROJECTION_INVALIDATION_REASONS,
    },
    checked_at: checkedAt,
  };
}
