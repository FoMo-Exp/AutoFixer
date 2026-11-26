/**
 * Repository-set change types: durable confirmation, commit input and result
 * (DAT-284, ADR-0011).
 *
 * A repository addition is decided in two steps. First an authorized actor
 * previews the *exact* impact and records an explicit confirmation bound to the
 * actor, workspace, proposed immutable repository identities, set version,
 * membership/role state, provider evidence and reductions. Then the commit
 * re-authorizes and revalidates all of it inside one transaction and writes
 * the bindings, the new set version, the approved ceiling reductions, the
 * required revocations and the audit evidence together.
 *
 * The confirmation is evidence of a decision, never a grant: every commit
 * rechecks the actor and the facts, and no HTTP route exists in this build
 * (DAT-286 owns the preview/confirm/submit API).
 */

import type { RepositoryCapability } from "./member-capability-types.js";
import type {
  EnterpriseId,
  ProviderInstanceId,
  UserId,
  WorkspaceId,
  WorkspaceRole,
} from "./types.js";

/**
 * The immutable identity of one proposed repository — the only fields that
 * participate in authorization, revalidation or persistence.
 *
 * A confirmation stores exactly these fields. Display metadata (repository URL
 * and name) is never recorded there: a committed binding takes its name from
 * the verified installation it references, so a private repository address
 * never enters a decision record or an audit row.
 */
export interface RepositorySetAdditionIdentity {
  provider_instance_id: ProviderInstanceId;
  installation_ref: string | null;
  repository_id: string;
}

/**
 * One repository proposed for addition.
 *
 * Only the identity fields carry authority. `repository_url` and
 * `repository_name` are display metadata a caller may send with a proposal;
 * they are never persisted in the confirmation and never used for the
 * committed binding — its name is read from the verified installation.
 * A new binding must name an approved instance and an active installation for
 * exactly that repository — a null installation is accepted only for the
 * legacy backfill, never for a new addition.
 */
export interface RepositorySetAdditionBinding extends RepositorySetAdditionIdentity {
  repository_url?: string | null;
  repository_name?: string | null;
}

/**
 * One protected member's confirmed impact.
 *
 * `proposed_capabilities` is the effective ceiling over the proposed set
 * (already bounded by the member's persisted ceiling); `reduction` is what the
 * addition takes away. Both are empty when the member does not retain
 * admission — but a confirmation with a non-retaining member is never
 * recorded.
 */
export interface ConfirmedMemberImpact {
  membership_id: string;
  user_id: UserId;
  role: WorkspaceRole;
  retains_admission: boolean;
  proposed_capabilities: RepositoryCapability[];
  reduction: RepositoryCapability[];
}

/** One owner assignment's effectiveness over the proposed set. */
export interface ConfirmedOwnerImpact {
  user_id: UserId;
  effective: boolean;
}

/**
 * The disclosable impact summary recorded with the confirmation and the
 * change. It is scoped to what a workspace administrator may see and contains
 * no credentials, provider subjects or repository URLs.
 */
export interface RepositorySetChangeImpactSummary {
  proposed_repository_count: number;
  protected_members: number;
  reduced_members: number;
  removed_capabilities: number;
  effective_owners: number;
  last_owner_survives: boolean;
}

/**
 * A durable, actor-bound confirmation of one exact proposed set.
 *
 * `set_version` is the stored token the decision was formed against. The
 * stored `members`/`owners` are the exact facts the actor confirmed; the commit
 * re-derives them from live facts and refuses on any difference, so a
 * concurrent membership, role, evidence or set change invalidates the
 * confirmation instead of committing a stale decision.
 */
export interface RepositorySetAdditionConfirmation {
  id: string;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  actor_user_id: UserId;
  /** Stored set version the confirmation was formed against. */
  set_version: number;
  /**
   * The exact repositories proposed for addition, as immutable identities
   * only. Display metadata is deliberately absent.
   */
  proposed_bindings: RepositorySetAdditionIdentity[];
  /** Every protected member's confirmed post-change facts, sorted by membership. */
  members: ConfirmedMemberImpact[];
  /** Owner assignments and their effectiveness over the proposed set. */
  owners: ConfirmedOwnerImpact[];
  last_owner_survives: boolean;
  all_members_retain_admission: boolean;
  evidence_complete: boolean;
  impact: RepositorySetChangeImpactSummary;
  /** When the preview facts were evaluated. */
  checked_at: string;
  /** Bounded validity; after this instant a fresh confirmation is required. */
  expires_at: string;
  /** Non-null once a commit consumed this confirmation. */
  consumed_at: string | null;
  /** The set version the commit produced. */
  consumed_by_set_version: number | null;
  created_at: string;
  created_by: UserId;
  version: number;
}

/**
 * One member reduction the actor explicitly confirmed.
 *
 * The caller records the exact affected members and capabilities it showed the
 * actor. The confirmation is refused when this list differs from the fresh
 * preview, which is what makes the reduction an informed decision instead of
 * a silent side effect of adding a repository.
 */
export interface ConfirmedReduction {
  membership_id: string;
  user_id: UserId;
  capabilities: RepositoryCapability[];
}

export interface RecordRepositorySetAdditionConfirmationInput {
  actor_user_id: UserId;
  /** The set version the preview was formed against (optimistic check). */
  expected_set_version: number;
  additional_repositories: RepositorySetAdditionBinding[];
  /** Exactly the impacted members and reductions the actor confirmed. */
  confirmed_reductions: ConfirmedReduction[];
  /** Optional bounded validity override; defaults to fifteen minutes. */
  ttl_ms?: number;
}

/**
 * Commit one recorded confirmation. The confirmation already carries the
 * proposed identities and impact; passing only its id prevents the commit from
 * diverging from what was confirmed.
 */
export interface CommitRepositorySetAdditionInput {
  actor_user_id: UserId;
  confirmation_id: string;
}

export interface CommitRepositorySetAdditionResult {
  workspace_id: WorkspaceId;
  confirmation_id: string;
  set_version_before: number;
  set_version_after: number;
  binding_ids: string[];
  repositories: Array<{ provider_instance_id: ProviderInstanceId; repository_id: string }>;
  members_reduced: Array<{ user_id: UserId; capabilities: RepositoryCapability[] }>;
  grants_revoked: number;
  effective_owners: UserId[];
  committed_at: string;
}

/**
 * Append-only audit events for the two decisions. The commit event is the
 * required audit evidence of the change itself; a failed insert rolls the
 * change back.
 */
export const REPOSITORY_SET_CHANGE_AUDIT_EVENTS = Object.freeze({
  additionConfirmed: "repository_set.addition_confirmed",
  additionCommitted: "repository_set.addition_committed",
});
