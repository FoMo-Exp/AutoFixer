/**
 * Repository-set change service: explicit confirmation and the atomic audited
 * commit of a repository addition (DAT-284, ADR-0011).
 *
 * ## The decision
 *
 * Adding a repository changes every current effective member's capability
 * intersection, so ADR-0011 never applies it as a side effect:
 *
 * 1. **Confirm.** An authorized workspace manager (owner/admin with verified
 *    `repository_manage` across every current repository) records a durable
 *    confirmation of the *exact* impacted members and reductions. The
 *    confirmation is bound to the actor, workspace, proposed immutable
 *    repository identities, the observed set version and a bounded expiry.
 * 2. **Commit.** Inside one `BEGIN IMMEDIATE` transaction the commit
 *    re-authorizes the actor, re-reads the set version, re-evaluates the whole
 *    member/owner/evidence set from current provider facts, compares it with
 *    the confirmed facts, and only then writes the bindings, the new set
 *    version, the approved ceiling reductions, the required grant revocations,
 *    the required audit row and the confirmation's consumption.
 *
 * Any difference, expiry, permission loss or write failure refuses the whole
 * change: a stale decision can never commit, and an unauditable change never
 * commits. A conflict is retried by previewing and confirming again against the
 * new facts — the old confirmation stays refused.
 *
 * ## What this module does not do
 *
 * It exposes no route and no consumer-interface writer: there is no public
 * entry that bypasses the preview and confirmation. The multi-repository gate
 * stays closed, so a committed set is storage, not authority, until a later
 * release enforces the whole set. Wiring the preview/confirm/submit HTTP
 * surface, OpenAPI and fixtures belongs to DAT-286.
 */

import { runInTransaction } from "../control-plane/db.js";
import type { ControlPlaneDb } from "../control-plane/db.js";
import { RepositorySetChangeError, WorkspaceRepositorySetError } from "../control-plane/errors.js";
import type { RepositorySetChangeErrorCode } from "../control-plane/errors.js";
import type { IdentityRepositories } from "../control-plane/identity-repositories.js";
import type {
  CapabilityBlockReason,
  RepositoryCapability,
} from "../control-plane/member-capability-types.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type { MembershipRepository } from "../control-plane/repositories.js";
import type { RepositorySetChangeRepository } from "../control-plane/repository-set-change-repositories.js";
import type {
  CommitRepositorySetAdditionInput,
  CommitRepositorySetAdditionResult,
  ConfirmedMemberImpact,
  ConfirmedOwnerImpact,
  ConfirmedReduction,
  RecordRepositorySetAdditionConfirmationInput,
  RepositorySetAdditionBinding,
  RepositorySetAdditionConfirmation,
  RepositorySetChangeImpactSummary,
} from "../control-plane/repository-set-change-types.js";
import { REPOSITORY_SET_CHANGE_AUDIT_EVENTS } from "../control-plane/repository-set-change-types.js";
import type {
  EnterpriseId,
  UserId,
  WorkspaceId,
  WorkspaceRole,
  WorkspaceScope,
} from "../control-plane/types.js";
import type { WorkspaceRepositorySet } from "../control-plane/workspace-repository-types.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type { AuthorityEpoch } from "./access-gate.js";
import type { CapabilityCeilingService } from "./capability-ceiling.js";
import type {
  AdmissionEvidenceClass,
  EffectiveOwnerReason,
  MemberAdmissionService,
  ProposedMemberAdmission,
  ProposedSetAdmissionPreview,
} from "./member-admission.js";
import { AdmissionPreviewError } from "./member-admission.js";
import { createRepositoryManagerGuard } from "./repository-manager.js";
import { grantSupportedByCeiling, normalizeCapabilitySet } from "./repository-capabilities.js";

/** Fifteen minutes: long enough to read a preview, short enough to stay current. */
export const DEFAULT_CONFIRMATION_TTL_MS = 15 * 60 * 1000;
/** A confirmation that outlives a workday is not a bounded decision. */
export const MAX_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface RepositorySetChangeDeps {
  /** The control-plane handle the whole change commits on. */
  db: ControlPlaneDb;
  /** The authoritative, versioned repository set (DAT-281). */
  repositorySets: WorkspaceRepositorySetRepository;
  /** Durable confirmations and transaction-scoped change writers (DAT-284). */
  changes: RepositorySetChangeRepository;
  access: ProviderAccessRepositories;
  memberships: MembershipRepository;
  identity: IdentityRepositories;
  capabilityCeilings: CapabilityCeilingService;
  /** The DAT-283 admission/preview engine; the commit re-runs it. */
  admission: MemberAdmissionService;
  /** Shared in-process "authority changed" signal, bumped after a commit. */
  epoch?: AuthorityEpoch;
  clock?: () => Date;
}

export interface PreviewRepositorySetAdditionInput {
  actor_user_id: UserId;
  /**
   * The set version the caller observed, when it has one. An omitted version
   * previews the stored set as-is; the confirmation still binds the version.
   */
  expected_set_version?: number;
  additional_repositories: RepositorySetAdditionBinding[];
}

/** One protected member's before/after facts in an addition preview. */
export interface RepositorySetAdditionPreviewMember {
  membership_id: string;
  user_id: UserId;
  /** The assigned workspace role. A capability change never rewrites it. */
  role: WorkspaceRole;
  retains_admission: boolean;
  /**
   * The verified effective intersection today, never a provider role name.
   * Empty when today's evidence cannot establish one — `evidence_classes`
   * says why, and an empty list here is never a recorded revocation.
   */
  current_capabilities: RepositoryCapability[];
  /** Intersection the proposed set would produce, empty when it cannot verify. */
  proposed_capabilities: RepositoryCapability[];
  /** Effective capabilities the addition would take away. */
  reduction: RepositoryCapability[];
  /**
   * Evidence classes that are not `verified` — why a verdict is missing. A
   * non-empty list is unknown/expired/truncated/unavailable/revoked evidence,
   * never a confirmed downgrade on its own.
   */
  evidence_classes: AdmissionEvidenceClass[];
  evidence_complete: boolean;
  reason: CapabilityBlockReason | null;
  verified_at: string | null;
}

/** One owner assignment's effectiveness over the proposed set. */
export interface RepositorySetAdditionPreviewOwner {
  user_id: UserId;
  effective: boolean;
  reason: EffectiveOwnerReason | null;
}

/**
 * Why the previewed addition cannot be committed. The preview is still
 * produced (it is a report, not a decision), so a caller can show the reason
 * instead of guessing from a refusal.
 */
export const REPOSITORY_SET_ADDITION_COMMIT_BLOCKS = Object.freeze([
  "MULTI_REPOSITORY_GATE_DISABLED",
  "CURRENT_SET_UNUSABLE",
  "MEMBER_ADMISSION_NOT_RETAINED",
  "LAST_EFFECTIVE_OWNER_MISSING",
] as const);
export type RepositorySetAdditionCommitBlock =
  (typeof REPOSITORY_SET_ADDITION_COMMIT_BLOCKS)[number];

/**
 * The repository-addition preview (DAT-286, ADR-0011).
 *
 * Every field is a preview: `authorizes_access` is always false and nothing is
 * stored. The object is safe to disclose to the authorized manager that asked
 * for it — it carries no credentials, provider subjects, repository URLs or
 * repository names.
 */
export interface RepositorySetAdditionPreview {
  preview: true;
  authorizes_access: false;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  /** The stored set version this preview was formed against. */
  set_version: number;
  proposed_repository_count: number;
  /** The rollout gate's state; a change cannot commit while it is disabled. */
  multi_repository_gate: "enabled" | "disabled" | "unreadable";
  /** Why the *current* set already authorizes nothing, when it does not. */
  current_set_blocked_reason: CapabilityBlockReason | null;
  checked_at: string;
  members: RepositorySetAdditionPreviewMember[];
  owners: RepositorySetAdditionPreviewOwner[];
  last_owner_survives: boolean;
  all_members_retain_admission: boolean;
  /**
   * The exact reductions a confirmation must acknowledge. Empty when the
   * addition removes no capability; a confirmation with any other list is
   * refused, so a reduction is never a silent side effect.
   */
  reductions_required: ConfirmedReduction[];
  impact: RepositorySetChangeImpactSummary;
  /** True only when this exact addition may proceed to confirmation. */
  committable: boolean;
  /** Every reason the addition cannot be committed, in canonical order. */
  commit_blocked_reasons: RepositorySetAdditionCommitBlock[];
}

export interface RepositorySetChangeService {
  /**
   * Preview the proposed set under the actor's authority. Reports the exact
   * before/after capability impact of every protected member, the surviving
   * owners, the reductions a confirmation must acknowledge and why the change
   * could not be committed. Writes nothing.
   *
   * The preview is disclosed only to an authorized manager: an actor who
   * cannot see the full impact is refused instead of being shown a redacted
   * preview, because a redacted preview is not informed consent (ADR-0011).
   */
  previewAddition(
    scope: WorkspaceScope,
    input: PreviewRepositorySetAdditionInput,
  ): RepositorySetAdditionPreview;
  /**
   * Preview the proposed set under the actor's authority, require every
   * protected member to retain admission and an effective owner to survive,
   * verify the exact confirmed reductions, and persist the confirmation with
   * its audit row in one transaction. Writes no binding.
   */
  recordAdditionConfirmation(
    scope: WorkspaceScope,
    input: RecordRepositorySetAdditionConfirmationInput,
  ): RepositorySetAdditionConfirmation;
  /**
   * Commit one recorded confirmation atomically. Re-authorizes and
   * revalidates; refuses on any change, expiry, permission loss or audit
   * failure. Returns the committed impact.
   */
  commitAddition(
    scope: WorkspaceScope,
    input: CommitRepositorySetAdditionInput,
  ): CommitRepositorySetAdditionResult;
}

export function createRepositorySetChangeService(
  deps: RepositorySetChangeDeps,
): RepositorySetChangeService {
  const {
    db,
    repositorySets,
    changes,
    access,
    memberships,
    identity,
    capabilityCeilings,
    admission,
    epoch,
  } = deps;
  const clock = deps.clock ?? (() => new Date());
  /**
   * The repository-administration rule is shared with the discovery surface
   * (DAT-289), so the two endpoints can never disagree about who may see or
   * decide a repository set.
   */
  const managers = createRepositoryManagerGuard({
    memberships,
    identity,
    capabilityCeilings,
  });

  // -------------------------------------------------------------------------
  // Guards and canonical facts
  // -------------------------------------------------------------------------

  function refuse(
    code: Exclude<RepositorySetChangeErrorCode, "REPOSITORY_SET_CHANGE_AUDIT_FAILED">,
    message: string,
    status: 403 | 409 = 409,
    details: Record<string, unknown> = {},
  ): never {
    throw new RepositorySetChangeError(code, message, status, details);
  }

  /**
   * The multi-repository gate is the rollout switch, not an implementation
   * detail: while it is disabled no binding change may be stored, because no
   * access path enforces the resulting set.
   */
  function requireGateEnabled(scope: WorkspaceScope): void {
    const gate = repositorySets.gate();
    if (gate.state !== "enabled") {
      throw new WorkspaceRepositorySetError(
        "SCOPE_MUTATION_DISABLED",
        "changing a workspace repository set is refused: the multi-repository gate is disabled until every access path enforces the whole set",
        403,
        { workspace_id: scope.workspace_id, gate_state: gate.state },
      );
    }
  }

  /**
   * The current set must be readable, approved and usable. An anomalous
   * historical set is refused, never repaired or re-authorized silently.
   */
  function requireUsableSet(scope: WorkspaceScope): WorkspaceRepositorySet {
    const set = repositorySets.getSet(scope);
    if (!set.usable || set.blocked_reason !== null) {
      throw new WorkspaceRepositorySetError(
        set.blocked_reason ?? "SCOPE_MUTATION_DISABLED",
        `workspace ${set.workspace_id} cannot change its repository set while the current set is not usable`,
        403,
        {
          workspace_id: set.workspace_id,
          binding_count: set.bindings.length,
          set_version: set.set_version,
        },
      );
    }
    return set;
  }

  /**
   * A repository-set change is workspace administration: an active owner or
   * admin whose provider-proven `repository_manage` covers *every* current
   * repository. Enterprise administration alone is not repository authority,
   * and a role-only claim never substitutes for provider evidence.
   */
  /**
   * A repository-set change is workspace administration: see
   * {@link createRepositoryManagerGuard} for the rule the discovery surface
   * shares.
   */
  function requireManager(scope: WorkspaceScope, actorUserId: UserId, now: Date): void {
    managers.require(scope, actorUserId, now);
  }

  function previewSet(
    scope: WorkspaceScope,
    bindings: readonly RepositorySetAdditionBinding[],
    expectedSetVersion: number | undefined,
    now: Date,
  ): ProposedSetAdmissionPreview {
    try {
      return admission.previewProposedSet(
        scope,
        {
          additional_repositories: bindings.map((binding) => ({
            provider_instance_id: binding.provider_instance_id,
            installation_ref: binding.installation_ref,
            repository_id: binding.repository_id,
          })),
          ...(expectedSetVersion !== undefined ? { expected_set_version: expectedSetVersion } : {}),
        },
        { now },
      );
    } catch (error) {
      if (error instanceof AdmissionPreviewError) {
        if (error.code === "ADMISSION_PROPOSAL_SET_VERSION_CONFLICT") {
          throw new WorkspaceRepositorySetError(
            "REPOSITORY_SET_VERSION_CONFLICT",
            "the workspace repository set changed; re-read and preview the addition again",
            409,
            { workspace_id: scope.workspace_id },
          );
        }
        if (error.code === "ADMISSION_PROPOSAL_DUPLICATE_REPOSITORY") {
          refuse(
            "REPOSITORY_SET_CHANGE_INVALID_PROPOSAL",
            "a proposed repository is already bound; a proposal only adds repositories",
          );
        }
        refuse(
          "REPOSITORY_SET_CHANGE_CONFLICT",
          "the workspace repository set cannot be read for a preview; re-read before deciding",
        );
      }
      throw error;
    }
  }

  function canonicalMembers(members: readonly ProposedMemberAdmission[]): ConfirmedMemberImpact[] {
    return members
      .map((member) => ({
        membership_id: member.membership_id,
        user_id: member.user_id,
        role: member.role,
        retains_admission: member.retains_admission,
        proposed_capabilities: normalizeCapabilitySet(member.proposed_capabilities),
        reduction: normalizeCapabilitySet(member.reduction),
      }))
      .sort((a, b) => a.membership_id.localeCompare(b.membership_id));
  }

  function canonicalOwners(preview: ProposedSetAdmissionPreview): ConfirmedOwnerImpact[] {
    return preview.owners_after
      .map((owner) => ({ user_id: owner.user_id, effective: owner.effective }))
      .sort((a, b) => a.user_id.localeCompare(b.user_id));
  }

  function impactSummary(preview: ProposedSetAdmissionPreview): RepositorySetChangeImpactSummary {
    const owners = canonicalOwners(preview);
    return {
      proposed_repository_count: preview.proposed_repository_count,
      protected_members: preview.members.length,
      reduced_members: preview.members.filter((member) => member.reduction.length > 0).length,
      removed_capabilities: preview.members.reduce(
        (total, member) => total + member.reduction.length,
        0,
      ),
      effective_owners: owners.filter((owner) => owner.effective).length,
      last_owner_survives: preview.last_owner_survives,
    };
  }

  /** The exact reductions a confirmation must acknowledge, canonicalized. */
  function expectedReductions(preview: ProposedSetAdmissionPreview): ConfirmedReduction[] {
    return preview.members
      .filter((member) => member.reduction.length > 0)
      .map((member) => ({
        membership_id: member.membership_id,
        user_id: member.user_id,
        capabilities: normalizeCapabilitySet(member.reduction),
      }))
      .sort((a, b) => a.membership_id.localeCompare(b.membership_id));
  }

  function canonicalConfirmedReductions(
    confirmed: readonly ConfirmedReduction[],
  ): ConfirmedReduction[] {
    if (!Array.isArray(confirmed)) {
      refuse(
        "REPOSITORY_SET_CHANGE_INVALID_PROPOSAL",
        "confirmed_reductions must list the exact affected members and capabilities",
      );
    }
    return confirmed
      .map((entry) => ({
        membership_id: String(entry.membership_id),
        user_id: String(entry.user_id),
        capabilities: normalizeCapabilitySet(entry.capabilities ?? []),
      }))
      .sort((a, b) => a.membership_id.localeCompare(b.membership_id));
  }

  function assertExplicitReductions(
    preview: ProposedSetAdmissionPreview,
    confirmed: readonly ConfirmedReduction[],
  ): void {
    const expected = expectedReductions(preview);
    const given = canonicalConfirmedReductions(confirmed);
    if (JSON.stringify(expected) !== JSON.stringify(given)) {
      // Counts only: an error must not become a disclosure of members the
      // caller did not already see in its own preview.
      refuse(
        "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
        "the confirmed reductions do not match the exact impact of the proposed set; preview again and confirm the affected members and capabilities",
        409,
        {
          expected_reductions: expected.length,
          confirmed_reductions: given.length,
        },
      );
    }
  }

  /**
   * The proposed set may proceed only when every protected member retains
   * admission with complete evidence and at least one effective owner retains
   * management across the whole proposed set. Otherwise the *entire* addition
   * is refused; no member is removed to make it pass.
   */
  function assertAdmissible(preview: ProposedSetAdmissionPreview): void {
    if (!preview.all_members_retain_admission) {
      refuse(
        "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE",
        "the proposed repository set would leave at least one current effective member without verified admission; the whole addition is refused",
        409,
        {
          protected_members: preview.members.length,
          blocked_members: preview.members.filter((member) => !member.retains_admission).length,
        },
      );
    }
    if (!preview.last_owner_survives) {
      refuse(
        "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE",
        "the proposed repository set would leave no effective owner with all necessary management capabilities; the whole addition is refused",
        409,
        { effective_owners_after: impactSummary(preview).effective_owners },
      );
    }
  }

  /**
   * Compare the live preview with the confirmed facts. Any difference means a
   * relevant fact changed after the actor decided; the confirmation is stale
   * and a fresh preview + confirmation is required.
   */
  function assertFactsMatch(
    confirmation: RepositorySetAdditionConfirmation,
    preview: ProposedSetAdmissionPreview,
  ): void {
    if (
      JSON.stringify(confirmation.members) !== JSON.stringify(canonicalMembers(preview.members))
    ) {
      refuse(
        "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
        "the workspace membership, role or capability state changed since the confirmation; preview and confirm again",
        409,
        { changed: "members" },
      );
    }
    if (JSON.stringify(confirmation.owners) !== JSON.stringify(canonicalOwners(preview))) {
      refuse(
        "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
        "the effective-owner facts changed since the confirmation; preview and confirm again",
        409,
        { changed: "owners" },
      );
    }
    if (
      confirmation.last_owner_survives !== preview.last_owner_survives ||
      confirmation.all_members_retain_admission !== preview.all_members_retain_admission
    ) {
      refuse(
        "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
        "the admission or last-owner outcome changed since the confirmation; preview and confirm again",
        409,
        { changed: "outcome" },
      );
    }
    if (confirmation.impact.proposed_repository_count !== preview.proposed_repository_count) {
      refuse(
        "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
        "the proposed repository set changed since the confirmation; preview and confirm again",
        409,
        { changed: "repositories" },
      );
    }
  }

  /**
   * Revoke live capability grants the reduced ceiling no longer supports.
   * Runs inside the change transaction, so a grant never outlives the
   * capability that justified it.
   */
  function revokeUnsupportedGrants(
    scope: WorkspaceScope,
    userId: UserId,
    ceiling: readonly RepositoryCapability[],
    at: string,
  ): number {
    let revoked = 0;
    for (const integration of access.integrations.listByWorkspace(scope)) {
      const live = access.grants.listLive(scope, integration.id, {
        grantee_user_id: userId,
        now: at,
      });
      for (const grant of live) {
        if (!grantSupportedByCeiling(grant.capability, ceiling)) {
          access.grants.revoke(
            scope,
            grant.id,
            "capability ceiling reduced by repository set change",
            at,
          );
          revoked += 1;
        }
      }
    }
    return revoked;
  }

  function nextPositions(scope: WorkspaceScope, count: number): number[] {
    const existing = repositorySets.listBindings(scope, { include_retired: true });
    const highest = existing.reduce((max, binding) => Math.max(max, binding.position), 0);
    return Array.from({ length: count }, (_, index) => highest + index + 1);
  }

  function effectiveOwnerIds(preview: ProposedSetAdmissionPreview): UserId[] {
    return canonicalOwners(preview)
      .filter((owner) => owner.effective)
      .map((owner) => owner.user_id);
  }

  /**
   * Why the previewed addition could not commit, in canonical order. The
   * preview reports these instead of refusing, so a caller sees the reason it
   * would be refused rather than having to infer it from an error.
   */
  function commitBlockedReasons(
    preview: ProposedSetAdmissionPreview,
  ): RepositorySetAdditionCommitBlock[] {
    const reasons: RepositorySetAdditionCommitBlock[] = [];
    if (preview.multi_repository_gate !== "enabled") {
      reasons.push("MULTI_REPOSITORY_GATE_DISABLED");
    }
    if (preview.current_set_blocked_reason !== null) {
      reasons.push("CURRENT_SET_UNUSABLE");
    }
    if (!preview.all_members_retain_admission) {
      reasons.push("MEMBER_ADMISSION_NOT_RETAINED");
    }
    if (!preview.last_owner_survives) {
      reasons.push("LAST_EFFECTIVE_OWNER_MISSING");
    }
    return reasons;
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  function previewAddition(
    scope: WorkspaceScope,
    input: PreviewRepositorySetAdditionInput,
  ): RepositorySetAdditionPreview {
    const now = clock();
    if (
      !Array.isArray(input.additional_repositories) ||
      input.additional_repositories.length === 0
    ) {
      refuse(
        "REPOSITORY_SET_CHANGE_INVALID_PROPOSAL",
        "a repository-set change must propose at least one repository to add",
      );
    }

    // Authority first: a caller without the full management intersection sees
    // nothing. A redacted preview is not informed consent (ADR-0011).
    requireManager(scope, input.actor_user_id, now);
    const preview = previewSet(
      scope,
      input.additional_repositories,
      input.expected_set_version,
      now,
    );

    const members: RepositorySetAdditionPreviewMember[] = preview.members
      .map((member) => ({
        membership_id: member.membership_id,
        user_id: member.user_id,
        role: member.role,
        retains_admission: member.retains_admission,
        current_capabilities: normalizeCapabilitySet(member.current_capabilities),
        proposed_capabilities: normalizeCapabilitySet(member.proposed_capabilities),
        reduction: normalizeCapabilitySet(member.reduction),
        evidence_classes: [...member.blockers],
        evidence_complete: member.evidence_complete,
        reason: member.reason,
        verified_at: member.verified_at,
      }))
      .sort((a, b) => a.membership_id.localeCompare(b.membership_id));
    const owners: RepositorySetAdditionPreviewOwner[] = preview.owners_after
      .map((owner) => ({
        user_id: owner.user_id,
        effective: owner.effective,
        reason: owner.reason,
      }))
      .sort((a, b) => a.user_id.localeCompare(b.user_id));
    const blockedReasons = commitBlockedReasons(preview);

    return {
      preview: true,
      authorizes_access: false,
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      set_version: preview.current_set_version,
      proposed_repository_count: preview.proposed_repository_count,
      multi_repository_gate: preview.multi_repository_gate,
      current_set_blocked_reason: preview.current_set_blocked_reason,
      checked_at: now.toISOString(),
      members,
      owners,
      last_owner_survives: preview.last_owner_survives,
      all_members_retain_admission: preview.all_members_retain_admission,
      reductions_required: expectedReductions(preview),
      impact: impactSummary(preview),
      committable: blockedReasons.length === 0,
      commit_blocked_reasons: blockedReasons,
    };
  }

  // -------------------------------------------------------------------------
  // Record a confirmation
  // -------------------------------------------------------------------------

  function recordAdditionConfirmation(
    scope: WorkspaceScope,
    input: RecordRepositorySetAdditionConfirmationInput,
  ): RepositorySetAdditionConfirmation {
    const now = clock();
    const at = now.toISOString();
    if (
      !Array.isArray(input.additional_repositories) ||
      input.additional_repositories.length === 0
    ) {
      refuse(
        "REPOSITORY_SET_CHANGE_INVALID_PROPOSAL",
        "a repository-set change must propose at least one repository to add",
      );
    }
    const ttl = input.ttl_ms ?? DEFAULT_CONFIRMATION_TTL_MS;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_CONFIRMATION_TTL_MS) {
      refuse(
        "REPOSITORY_SET_CHANGE_INVALID_PROPOSAL",
        `ttl_ms must be a positive integer no larger than ${MAX_CONFIRMATION_TTL_MS}`,
      );
    }

    return runInTransaction(db, () => {
      requireGateEnabled(scope);
      const set = requireUsableSet(scope);
      if (input.expected_set_version !== set.set_version) {
        throw new WorkspaceRepositorySetError(
          "REPOSITORY_SET_VERSION_CONFLICT",
          `workspace ${scope.workspace_id} repository set changed (expected version ${input.expected_set_version}, found ${set.set_version}); re-read and preview again`,
          409,
          {
            expected_set_version: input.expected_set_version,
            actual_set_version: set.set_version,
          },
        );
      }
      requireManager(scope, input.actor_user_id, now);
      const preview = previewSet(scope, input.additional_repositories, set.set_version, now);
      assertAdmissible(preview);
      assertExplicitReductions(preview, input.confirmed_reductions);

      const members = canonicalMembers(preview.members);
      const owners = canonicalOwners(preview);
      const confirmation: RepositorySetAdditionConfirmation = {
        id: newConfirmationId(),
        enterprise_id: scope.enterprise_id,
        workspace_id: scope.workspace_id,
        actor_user_id: input.actor_user_id,
        set_version: set.set_version,
        // Immutable identities only: a decision record must never retain a
        // private repository URL or name. The committed binding takes its name
        // from the verified installation instead.
        proposed_bindings: input.additional_repositories.map((binding) => ({
          provider_instance_id: binding.provider_instance_id,
          installation_ref: binding.installation_ref,
          repository_id: binding.repository_id,
        })),
        members,
        owners,
        last_owner_survives: preview.last_owner_survives,
        all_members_retain_admission: preview.all_members_retain_admission,
        evidence_complete: preview.members.every((member) => member.evidence_complete),
        impact: impactSummary(preview),
        checked_at: at,
        expires_at: new Date(now.getTime() + ttl).toISOString(),
        consumed_at: null,
        consumed_by_set_version: null,
        created_at: at,
        created_by: input.actor_user_id,
        version: 1,
      };
      const actor = { actor_id: input.actor_user_id };
      changes.record(scope, actor, confirmation);
      changes.appendAudit(scope, actor, REPOSITORY_SET_CHANGE_AUDIT_EVENTS.additionConfirmed, {
        confirmation_id: confirmation.id,
        set_version: confirmation.set_version,
        expires_at: confirmation.expires_at,
        repositories: confirmation.proposed_bindings.map((binding) => ({
          provider_instance_id: binding.provider_instance_id,
          repository_id: binding.repository_id,
        })),
        impact: confirmation.impact,
      });
      return confirmation;
    });
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  function commitAddition(
    scope: WorkspaceScope,
    input: CommitRepositorySetAdditionInput,
  ): CommitRepositorySetAdditionResult {
    const now = clock();
    const at = now.toISOString();
    const actor = { actor_id: input.actor_user_id };

    const result = runInTransaction(db, () => {
      const confirmation = changes.requireForActor(
        scope,
        input.confirmation_id,
        input.actor_user_id,
      );
      if (confirmation.consumed_at !== null) {
        refuse(
          "REPOSITORY_SET_CHANGE_CONFIRMATION_CONSUMED",
          "the repository-set change confirmation was already consumed; a change commits at most once",
          409,
          { confirmation_id: confirmation.id },
        );
      }
      if (Date.parse(confirmation.expires_at) < now.getTime()) {
        refuse(
          "REPOSITORY_SET_CHANGE_CONFIRMATION_EXPIRED",
          "the repository-set change confirmation expired; preview and confirm the change again",
          409,
          { confirmation_id: confirmation.id, expires_at: confirmation.expires_at },
        );
      }

      requireGateEnabled(scope);
      const set = requireUsableSet(scope);
      if (set.set_version !== confirmation.set_version) {
        refuse(
          "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
          `the workspace repository set changed since the confirmation (confirmed version ${confirmation.set_version}, found ${set.set_version}); preview and confirm again`,
          409,
          {
            changed: "set_version",
            confirmed_set_version: confirmation.set_version,
            current_set_version: set.set_version,
          },
        );
      }
      requireManager(scope, input.actor_user_id, now);

      const preview = previewSet(
        scope,
        confirmation.proposed_bindings,
        confirmation.set_version,
        now,
      );
      assertAdmissible(preview);
      assertFactsMatch(confirmation, preview);

      // --- writes: all of the following commit or none of it does ----------

      const positions = nextPositions(scope, confirmation.proposed_bindings.length);
      const bindingIds = confirmation.proposed_bindings.map((binding, index) =>
        changes.insertBinding(scope, actor, {
          provider_instance_id: binding.provider_instance_id,
          installation_ref: binding.installation_ref ?? "",
          repository_id: binding.repository_id,
          position: positions[index]!,
        }),
      );

      const setVersionAfter = changes.bumpSetVersion(scope, confirmation.set_version, at);

      const membersReduced: Array<{
        user_id: UserId;
        capabilities: RepositoryCapability[];
      }> = [];
      let grantsRevoked = 0;
      for (const member of confirmation.members) {
        if (member.reduction.length === 0) {
          continue;
        }
        // The bindings above are now part of the stored set, so a plain
        // evaluation covers the whole proposed set — every existing repository
        // and every addition. The verified intersection over that full set is
        // the new `available_ceiling`; the persisted ceiling only ever moves
        // down.
        const evaluation = capabilityCeilings.evaluate(scope, member.user_id, {
          now,
          persist: false,
        });
        const ceiling = normalizeCapabilitySet(member.proposed_capabilities);
        changes.persistCeilingReduction(scope, actor, {
          user_id: member.user_id,
          ceiling,
          available_ceiling: normalizeCapabilitySet(evaluation.available_capabilities),
          set_version: setVersionAfter,
          verified_at: evaluation.verified_at ?? at,
          reason: "repository_set_changed",
        });
        grantsRevoked += revokeUnsupportedGrants(scope, member.user_id, ceiling, at);
        membersReduced.push({ user_id: member.user_id, capabilities: ceiling });
      }

      const ownersAfter = effectiveOwnerIds(preview);
      changes.appendAudit(scope, actor, REPOSITORY_SET_CHANGE_AUDIT_EVENTS.additionCommitted, {
        confirmation_id: confirmation.id,
        result: "committed",
        set_version_before: confirmation.set_version,
        set_version_after: setVersionAfter,
        binding_ids: bindingIds,
        repositories: confirmation.proposed_bindings.map((binding) => ({
          provider_instance_id: binding.provider_instance_id,
          repository_id: binding.repository_id,
        })),
        impact: impactSummary(preview),
        members_reduced: membersReduced,
        effective_owners: ownersAfter,
        grants_revoked: grantsRevoked,
      });

      // Consumption is part of the same transaction: a rolled-back commit
      // leaves the confirmation usable, a committed one consumes it once.
      changes.consume(scope, confirmation.id, setVersionAfter, at);

      return {
        workspace_id: scope.workspace_id,
        confirmation_id: confirmation.id,
        set_version_before: confirmation.set_version,
        set_version_after: setVersionAfter,
        binding_ids: bindingIds,
        repositories: confirmation.proposed_bindings.map((binding) => ({
          provider_instance_id: binding.provider_instance_id,
          repository_id: binding.repository_id,
        })),
        members_reduced: membersReduced,
        grants_revoked: grantsRevoked,
        effective_owners: ownersAfter,
        committed_at: at,
      } satisfies CommitRepositorySetAdditionResult;
    });

    // Outside the transaction: consumers that cache a decision formed against
    // the old set are told to re-read. Durable propagation is DAT-285.
    epoch?.bump();
    return result;
  }

  return { previewAddition, recordAdditionConfirmation, commitAddition };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function newConfirmationId(): string {
  // Opaque, non-guessable decision id; the prefix aids log correlation only.
  return `rsc_${crypto.randomUUID().replaceAll("-", "")}`;
}
