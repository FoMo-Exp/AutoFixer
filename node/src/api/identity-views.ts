/**
 * API view projections for the identity/workspace surface (DAT-205 shapes).
 *
 * These are the wire shapes of the shared OpenAPI schemas — UserRef,
 * EnterpriseRef, Workspace, Membership, MemberAuthority — assembled from
 * control-plane entities. Projections are display-only: a role here is
 * computed server-side from authenticated membership and is never an input.
 *
 * Member authority provenance is owned by DAT-203's provider integration.
 * Until a provider adapter reports provenance it is `unknown` and stale —
 * never invented (ADR-0006).
 */

import type {
  AppUser,
  Enterprise,
  Membership,
  ProviderType,
  UserId,
  Workspace,
  WorkspaceRole,
  WorkspaceStatus,
} from "../control-plane/index.js";
import type { MEMBER_PROVENANCES, WORKSPACE_ROLES } from "./openapi.js";

export type WorkspaceRoleName = (typeof WORKSPACE_ROLES)[number];
export type MemberProvenance = (typeof MEMBER_PROVENANCES)[number];

export interface UserRefView {
  id: string;
  display_name: string;
}

export interface EnterpriseRefView {
  id: string;
  name: string;
  slug: string;
}

export interface WorkspaceRefView {
  id: string;
  name: string;
}

export interface WorkspaceRepositoryView {
  repository_id: string;
  provider_instance_id: string;
  provider_type: ProviderType;
}

export interface WorkspaceView {
  id: string;
  enterprise_id: string;
  name: string;
  status: WorkspaceStatus;
  repository: WorkspaceRepositoryView;
  /** The caller's effective workspace role, computed from authenticated membership. */
  role: WorkspaceRole;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MemberAuthorityView {
  provider_role: string | null;
  provenance: MemberProvenance;
  verified_at: string | null;
  stale: boolean;
}

export interface MembershipView {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  user_id: UserId;
  user: UserRefView;
  role: WorkspaceRole;
  authority: MemberAuthorityView;
  version: number;
  created_at: string;
  updated_at: string;
}

export function userRef(user: Pick<AppUser, "id" | "display_name">): UserRefView {
  return { id: user.id, display_name: user.display_name };
}

export function enterpriseRef(enterprise: Enterprise): EnterpriseRefView {
  return { id: enterprise.id, name: enterprise.name, slug: enterprise.slug };
}

export function workspaceRef(workspace: Workspace): WorkspaceRefView {
  return { id: workspace.id, name: workspace.name };
}

export function workspaceView(
  workspace: Workspace,
  providerType: ProviderType,
  role: WorkspaceRole,
): WorkspaceView {
  return {
    id: workspace.id,
    enterprise_id: workspace.enterprise_id,
    name: workspace.name,
    status: workspace.status,
    repository: {
      repository_id: workspace.repository_id,
      provider_instance_id: workspace.provider_instance_id,
      provider_type: providerType,
    },
    role,
    version: workspace.version,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
}

/**
 * The authority view served until DAT-203's provider integration verifies
 * provenance: unverifiable authority is `unknown` and stale, never invented.
 */
export function unverifiedAuthority(): MemberAuthorityView {
  return { provider_role: null, provenance: "unknown", verified_at: null, stale: true };
}

export function membershipView(membership: Membership, member: UserRefView): MembershipView {
  return {
    id: membership.id,
    enterprise_id: membership.enterprise_id,
    workspace_id: membership.workspace_id,
    user_id: membership.user_id,
    user: member,
    role: membership.role,
    authority: unverifiedAuthority(),
    version: membership.version,
    created_at: membership.created_at,
    updated_at: membership.updated_at,
  };
}
