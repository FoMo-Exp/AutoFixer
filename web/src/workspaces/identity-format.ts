import { ApiError } from "../api/client";
import type {
  InvitationStatus,
  MemberAuthority,
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
