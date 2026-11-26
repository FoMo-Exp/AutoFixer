import { ApiError } from "../api/client";
import type {
  EnterpriseUserRole,
  EnterpriseUserStatus,
  InvitationStatus,
  MemberAuthority,
  MemberCandidate,
  Membership,
  Workspace,
  WorkspaceRole,
  WorkspaceSession,
} from "../api/identity";

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

export const ROLE_OPTIONS: Array<{ value: WorkspaceRole; label: string }> = (
  ["owner", "admin", "member", "viewer"] as const
).map((role) => ({ value: role, label: ROLE_LABELS[role] }));

export const PROVENANCE_LABELS: Record<MemberAuthority["provenance"], string> = {
  organization_owner: "Organization owner",
  group: "Group",
  inherited_role: "Inherited role",
  direct_collaborator: "Direct collaborator",
  unknown: "Unknown",
};

export const INVITATION_STATUS_LABELS: Record<InvitationStatus, string> = {
  active: "Active",
  consumed: "Consumed",
  revoked: "Revoked",
  expired: "Expired",
};

export const ENTERPRISE_STATUS_LABELS: Record<EnterpriseUserStatus, string> = {
  pending_claim: "Pending sign-in",
  active: "Active",
  suspended: "Suspended in this enterprise",
};

export const ENTERPRISE_ROLE_LABELS: Record<EnterpriseUserRole, string> = {
  admin: "Enterprise admin",
  member: "Member",
};

export const CAPABILITY_LABELS: Record<string, string> = {
  code_read: "Read code",
  issue_write: "Write issues",
  repository_write: "Write repository",
  repository_manage: "Manage repository",
};

export const REPOSITORY_EVIDENCE_LABELS: Record<string, string> = {
  verified: "Verified",
  unverified: "Unverified",
  removed: "Access removed",
  confirmed_loss: "Confirmed loss",
};

/** Every candidate refusal is a refusal; none is rendered as eligibility. */
export const INELIGIBLE_REASON_LABELS: Record<
  NonNullable<MemberCandidate["ineligible_reason"]>,
  string
> = {
  identity_unlinked: "The provider subject has not signed in yet.",
  already_member: "Already a member of this workspace.",
  workspace_archived: "The workspace is archived.",
  repository_missing: "A workspace repository is missing.",
  repository_set_unsupported: "The repository set is not supported.",
  repository_binding_inconsistent: "The repository binding is inconsistent.",
  installation_not_approved: "The provider installation is not approved.",
  provider_instance_unapproved: "The provider instance is not approved.",
  subject_missing: "The provider subject is missing.",
  authority_unknown: "Provider authority is unknown.",
  authority_stale: "Provider authority is stale; reconciliation is pending.",
  verification_expired: "Capability verification expired.",
  permission_visibility_none: "The provider grants no observable permission.",
  permission_visibility_partial: "Provider permissions are only partially observable.",
  role_missing: "No provider role is recorded.",
  unsupported_role: "The provider role cannot be mapped to a workspace role.",
  repository_access_removed: "Repository access was removed by the provider.",
  no_code_read: "Code read is not proven on every repository.",
  capability_store_unavailable: "The capability store is unavailable.",
};

export interface ErrorDescription {
  message: string;
  code: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

/**
 * Fixed guidance for the codes this surface can receive. Unknown codes and
 * network failures fall back to the envelope's own safe message, never to a
 * guessed cause (the contract's non-enumeration rule: the UI must not infer
 * which condition an invitation failure was).
 */
const ERROR_COPY: Record<string, string> = {
  INVITATION_NOT_ACCEPTED:
    "This invitation cannot be used. Ask the workspace owner for a new invitation.",
  RATE_LIMITED: "Too many attempts. Try again later.",
  VERSION_CONFLICT: "The resource changed while you were editing. Reload and reapply.",
  ROLE_NOT_ASSIGNABLE: "You cannot assign a role above your own authority.",
  TEAM_LEADER_NOT_MEMBER: "A team leader must be an active workspace member.",
  FORBIDDEN: "Your role does not permit this action.",
  UNAUTHENTICATED: "Sign in to continue.",
  NOT_FOUND: "The requested resource was not found in your visible scope.",
  PROVIDER_ROSTER_INCOMPLETE: "The provider roster is incomplete. Retry after reconciliation.",
  CSRF_TOKEN_INVALID: "Your session changed. Reload the page and try again.",
  SERVICE_INTEGRATION_NOT_FOUND: "This workspace has no active service integration.",
  SERVICE_INTEGRATION_EXISTS:
    "This workspace already has a service integration with a different configuration. Deactivate it before installing another.",
  SERVICE_INTEGRATION_BINDING_INVALID:
    "This workspace's repository binding cannot carry a service integration. Ask an enterprise administrator to fix the provider binding.",
  SERVICE_INTEGRATION_AUDIT_UNAVAILABLE:
    "The audit trail is unavailable, so nothing changed. Retry when it recovers.",
  WORKSPACE_ARCHIVED: "Archived workspaces cannot carry a service integration.",
  LAST_ENTERPRISE_ADMIN:
    "This is the last active enterprise administrator. Grant another administrator first.",
  USER_NOT_CLAIMED:
    "This person has not signed in yet, so the enterprise role cannot change until the identity is claimed.",
  LAST_WORKSPACE_OWNER:
    "This is the workspace's last owner. Assign another owner before removing or demoting them.",
  TARGET_NOT_ELIGIBLE:
    "The provider facts do not currently prove access for this person in every workspace repository.",
  MEMBERSHIP_CONFLICT: "This person is already a member of this workspace.",
  ENTERPRISE_MEMBERSHIP_SUSPENDED:
    "This person's enterprise membership is suspended. Restore it in the enterprise directory first.",
  CAPABILITY_MANAGEMENT_REQUIRED:
    "Repository management must be verified across every workspace repository to read or change this ceiling.",
  CAPABILITY_ADMIN_REQUIRED: "Only an enterprise administrator may reapprove a capability ceiling.",
  CAPABILITY_CEILING_UNAVAILABLE:
    "Current provider evidence is missing or stale, so no ceiling decision can be made yet.",
  CAPABILITY_CEILING_EXCEEDS_VERIFIED:
    "The requested capabilities exceed the provider-verified intersection.",
  CAPABILITY_CEILING_NOT_ELIGIBLE:
    "The verified intersection lacks code read, so this member cannot be approved.",
  CAPABILITY_CEILING_MISMATCH:
    "Provider evidence changed while you were editing. Reload the verification and decide again.",
  AUTHORITY_RECHECK_REQUIRED: "Provider authority is being rechecked. Retry after reconciliation.",
  INVALID_CURSOR: "The page cursor is no longer valid. Reload the list.",
  REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED:
    "Only an active owner or admin whose repository management is verified on every current repository can decide this addition.",
  REPOSITORY_SET_CHANGE_INVALID_PROPOSAL:
    "This proposal cannot be applied. Check that each repository is not already bound and that its installation is approved.",
  REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE:
    "The addition is refused: a protected member would lose access, evidence is not verified, or no effective owner would survive.",
  REPOSITORY_SET_VERSION_CONFLICT:
    "The repository set changed while you were deciding. Preview the addition again.",
  REPOSITORY_SET_CHANGE_CONFIRMATION_REQUIRED:
    "Preview and confirm the impact before committing this addition.",
  REPOSITORY_SET_CHANGE_CONFIRMATION_STALE:
    "The confirmed impact no longer matches the current facts. Preview and confirm again.",
  REPOSITORY_SET_CHANGE_CONFIRMATION_EXPIRED:
    "This confirmation expired. Preview and confirm the addition again.",
  REPOSITORY_SET_CHANGE_CONFIRMATION_CONSUMED:
    "This confirmation was already used. Preview and confirm the addition again.",
  REPOSITORY_SET_CHANGE_CONFLICT:
    "Membership or provider facts changed during the commit. Nothing was applied; preview and confirm again.",
  REPOSITORY_SET_CHANGE_AUDIT_FAILED:
    "The audit trail was unavailable, so nothing changed. Retry when it recovers.",
  SCOPE_MUTATION_DISABLED:
    "Repository additions are disabled until the multi-repository rollout gate opens.",
  FEATURE_GATE_UNREADABLE: "The rollout gate could not be read, so the change is refused.",
};

export function describeError(caught: unknown): ErrorDescription {
  if (caught instanceof ApiError) {
    return {
      message: ERROR_COPY[caught.code] ?? caught.message,
      code: caught.code,
      ...(caught.requestId ? { requestId: caught.requestId } : {}),
      ...(typeof caught.retryAfterSeconds === "number"
        ? { retryAfterSeconds: caught.retryAfterSeconds }
        : {}),
    };
  }
  return {
    message: caught instanceof Error ? caught.message : "The request failed.",
    code: "REQUEST_FAILED",
  };
}

/** 401 is the contract's uniform "no valid credential" signal. */
export function isUnauthenticated(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 401;
}

export function isEnterpriseAdmin(
  session: WorkspaceSession | undefined,
  enterpriseId: string,
): boolean {
  return Boolean(
    session?.enterprise_roles.some(
      (entry) => entry.enterprise_id === enterpriseId && entry.role === "admin",
    ),
  );
}

/**
 * UI-only gate for showing administrative controls. Authority itself is always
 * resolved server-side; every mutation still renders the server's denial.
 */
export function canManageWorkspace(
  workspace: Workspace | undefined,
  session: WorkspaceSession | undefined,
): boolean {
  if (!workspace) return false;
  return (
    workspace.role === "owner" ||
    workspace.role === "admin" ||
    isEnterpriseAdmin(session, workspace.enterprise_id)
  );
}

export function authoritySummary(membership: Membership): string {
  const authority = membership.authority;
  if (!authority) return "No provider authority recorded";
  return [
    authority.provider_role ?? "No provider role",
    PROVENANCE_LABELS[authority.provenance],
    authority.verified_at ? `Verified ${formatTimestamp(authority.verified_at)}` : "Unverified",
  ].join(" · ");
}

/** Missing or unknown authority is stale by the contract's fail-closed rule. */
export function isStaleAuthority(membership: Membership): boolean {
  const authority = membership.authority;
  return !authority || authority.stale || authority.provenance === "unknown";
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Invitation expiry is shorten-only: the contract's default is 24 hours and
 * anything above it is rejected, so the UI cannot offer more.
 */
export const INVITE_EXPIRY_OPTIONS = [
  { value: "3600", label: "1 hour" },
  { value: "28800", label: "8 hours" },
  { value: "86400", label: "24 hours" },
];

export const MAX_INVITE_EXPIRY_SECONDS = 86400;

export function parseInviteExpiry(value: string): number | undefined {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_INVITE_EXPIRY_SECONDS) {
    return undefined;
  }
  return seconds;
}
