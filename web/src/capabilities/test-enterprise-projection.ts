import type { EnterpriseCapabilityProjection } from "../api/identity";

/**
 * Test-shaped copy of the merged DAT-278 enterprise capture. Only identifiers
 * and timestamps are substituted; module and action names come from
 * `docs/fixtures/capability-api-v1/enterprise-projection.json`, so a test can
 * never pin an invented field.
 */
export function enterpriseProjection(options: {
  enterpriseId?: string;
  now?: number;
  role?: "admin" | "member";
  status?: "active" | "suspended";
  deny?: Array<"add_user" | "suspend_user" | "restore_user" | "change_role" | "view">;
}): EnterpriseCapabilityProjection {
  const now = options.now ?? Date.now();
  const enterpriseId = options.enterpriseId ?? "ent_acme";
  const role = options.role ?? "admin";
  const status = options.status ?? "active";
  type DeniedAction = "view" | "add_user" | "suspend_user" | "restore_user" | "change_role";
  const denied = new Set<DeniedAction>(options.deny ?? []);
  const action = (name: DeniedAction) => {
    const allowed = role === "admin" && !denied.has(name);
    return {
      allowed,
      required: "enterprise_admin",
      ...(allowed ? {} : { reason: "enterprise_admin" }),
    };
  };
  return {
    schema_version: "enterprise-capability-v1",
    enterprise_id: enterpriseId,
    member: { status, role },
    modules: {
      enterprise_directory: {
        visible: role === "admin",
        data_ceiling: role === "admin" ? "directory" : "none",
        reason: role === "admin" ? null : "enterprise_admin",
        actions: {
          view: action("view"),
          add_user: action("add_user"),
          suspend_user: action("suspend_user"),
          restore_user: action("restore_user"),
          change_role: action("change_role"),
        },
      },
      identity_audit: {
        visible: role === "admin",
        data_ceiling: role === "admin" ? "audit" : "none",
        reason: role === "admin" ? null : "enterprise_admin",
        actions: {
          read: {
            allowed: role === "admin",
            required: "enterprise_admin",
            ...(role === "admin" ? {} : { reason: "enterprise_admin" }),
          },
        },
      },
      service_integration: {
        visible: false,
        data_ceiling: "none",
        reason: "enterprise_administration_is_not_repository_authority",
        actions: {
          view_metadata: {
            allowed: false,
            required: "workspace_membership_and_repository_capability",
            reason: "enterprise_administration_is_not_repository_authority",
          },
          configure: {
            allowed: false,
            required: "workspace_membership_and_repository_capability",
            reason: "enterprise_administration_is_not_repository_authority",
          },
        },
      },
      workspace_data: {
        visible: false,
        data_ceiling: "none",
        reason: "enterprise_administration_is_not_repository_authority",
        actions: {
          view_tasks: {
            allowed: false,
            required: "workspace_membership_and_repository_capability",
            reason: "enterprise_administration_is_not_repository_authority",
          },
          view_issues: {
            allowed: false,
            required: "workspace_membership_and_repository_capability",
            reason: "enterprise_administration_is_not_repository_authority",
          },
          view_memory: {
            allowed: false,
            required: "workspace_membership_and_repository_capability",
            reason: "enterprise_administration_is_not_repository_authority",
          },
          view_rsi: {
            allowed: false,
            required: "workspace_membership_and_repository_capability",
            reason: "enterprise_administration_is_not_repository_authority",
          },
          view_dashboard: {
            allowed: false,
            required: "workspace_membership_and_repository_capability",
            reason: "enterprise_administration_is_not_repository_authority",
          },
          view_security: {
            allowed: false,
            required: "workspace_membership_and_repository_capability",
            reason: "enterprise_administration_is_not_repository_authority",
          },
        },
      },
    },
    workspace_data_access: {
      granted: false,
      reason: "enterprise_administration_is_not_repository_authority",
    },
    freshness: {
      checked_at: new Date(now - 60_000).toISOString(),
      expires_at: new Date(now + 10 * 60_000).toISOString(),
      stale_after: new Date(now + 60 * 60_000).toISOString(),
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
    },
    checked_at: new Date(now - 60_000).toISOString(),
  };
}
