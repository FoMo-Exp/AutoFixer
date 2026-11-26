/**
 * Member admission and capability intersection across a workspace repository
 * set (DAT-283, ADR-0011).
 *
 * ## What this module answers
 *
 * Three questions share one evaluation, which is why they live together:
 *
 * 1. **Admission** — may this person hold workspace access right now? Only a
 *    *verified* code read on **every** active repository proves it. The set is
 *    intersected per provider-proven capability, never ranked by provider role
 *    name: write on repository A and read on B is admitted as read-only, and a
 *    repository with no read means no admission (`no_code_read`).
 * 2. **The protection set** — which members must a repository-set change
 *    protect? A *current effective member* has an active workspace membership
 *    and an active enterprise membership, was previously admitted, and is not
 *    confirmed revoked. Such a member stays in the set while their present
 *    evidence is temporarily unavailable, because otherwise a provider outage
 *    would silently remove them from the set the change must not break.
 * 3. **Effective owners** — a current effective member with an `owner`
 *    assignment **and** verified `repository_manage` on every active
 *    repository. An owner role assignment alone is not an effective owner, and
 *    unknown authority is neither proof of one nor a confirmed revocation.
 *
 * ## Evidence classes
 *
 * ADR-0011 requires the *kind* of missing evidence to be distinguishable, and
 * none of the non-verified kinds may establish admission:
 *
 * | class                  | meaning                                                    |
 * | ---------------------- | ---------------------------------------------------------- |
 * | `verified`             | the provider proved this subject's capabilities here        |
 * | `unknown`              | never verified, no provable role, or unobservable integration |
 * | `expired`              | the last verification aged past the freshness bound         |
 * | `truncated`            | the roster cannot be enumerated completely (partial/limit)  |
 * | `provider_unavailable` | the provider could not be reached; not a confirmed removal   |
 * | `confirmed_revocation` | the provider positively says the access is gone              |
 *
 * ## What this module never does
 *
 * It never grants. Every result is either a refusal or a verified fact for the
 * request-path gates to consume; a **preview** of an uncommitted repository set
 * additionally reports `authorizes_access: false` because it describes a set
 * that does not exist yet. Nothing here opens the multi-repository gate, writes
 * a binding, or changes an assigned workspace role.
 */

import type {
  CapabilityBlockReason,
  MemberCapabilityCeiling,
  RepositoryCapability,
} from "../control-plane/member-capability-types.js";
import type { IdentityRepositories } from "../control-plane/identity-repositories.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type {
  EnterpriseId,
  UserId,
  WorkspaceId,
  WorkspaceRole,
  WorkspaceScope,
} from "../control-plane/types.js";
import type { MembershipRepository } from "../control-plane/repositories.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type { WorkspaceRepositorySetErrorCode } from "../control-plane/workspace-repository-types.js";
import type {
  CapabilityCeilingEvaluation,
  CapabilityCeilingService,
  ProposedRepositoryBindingInput,
} from "./capability-ceiling.js";
import type { RepositoryCapabilityEvidence } from "./repository-capabilities.js";
import { normalizeCapabilitySet } from "./repository-capabilities.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Coarse evidence class. The precise refusal stays in `reason`, so a caller can
 * explain "the provider could not be reached" without inventing a downgrade.
 */
export type AdmissionEvidenceClass =
  | "verified"
  | "unknown"
  | "expired"
  | "truncated"
  | "provider_unavailable"
  | "confirmed_revocation";

/** Canonical order for reporting and comparisons. */
export const ADMISSION_EVIDENCE_CLASSES: readonly AdmissionEvidenceClass[] = Object.freeze([
  "verified",
  "unknown",
  "expired",
  "truncated",
  "provider_unavailable",
  "confirmed_revocation",
]);

/**
 * The decision for one member.
 *
 * - `admitted` — every repository verified and the intersection contains code
 *   read; `capabilities` is the effective ceiling.
 * - `unverifiable` — at least one repository's evidence is missing, unknown,
 *   expired, truncated or the provider is unavailable. Access fails closed for
 *   the duration and nothing is recorded as a downgrade.
 * - `confirmed_revoked` — a provider fact positively denies admission (access
 *   removed, or verified capabilities without code read). Only an audited
 *   reapproval raises it again.
 */
export type MemberAdmissionState = "admitted" | "unverifiable" | "confirmed_revoked";

/** The provider-derived ceiling on a viewer/member grant (never admin/owner). */
export type MemberRoleCeiling = "viewer" | "member";

/**
 * The one place the provider intersection is translated into a role ceiling:
 * `repository_write` on every repository supports at most `member`, anything
 * less (including no admission) supports `viewer` only. `admin`/`owner` are a
 * separate owner decision and never derive from provider facts.
 */
export function memberRoleCeiling(
  capabilities: readonly RepositoryCapability[],
): MemberRoleCeiling {
  return capabilities.includes("repository_write") ? "member" : "viewer";
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Per-repository evidence with its coarse class. */
export interface MemberRepositoryAdmission extends RepositoryCapabilityEvidence {
  evidence_class: AdmissionEvidenceClass;
}

export interface MemberAdmissionCeiling {
  state: MemberCapabilityCeiling["state"] | null;
  capabilities: RepositoryCapability[];
  reason: string | null;
  version: number | null;
  verified_at: string | null;
  /** A provider recovery exceeds the persisted ceiling; never auto-applied. */
  promotion_available: boolean;
}

export interface MemberAdmission {
  user_id: UserId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  /** Set version this decision was formed against. */
  set_version: number;
  /** Assigned workspace role, preserved: provider facts never rewrite it. */
  assigned_role: WorkspaceRole | null;
  state: MemberAdmissionState;
  /** True only for `admitted`. */
  admitted: boolean;
  /** Effective intersection; empty unless admitted. */
  capabilities: RepositoryCapability[];
  /** Highest workspace role the intersection supports. */
  role_ceiling: MemberRoleCeiling;
  reason: CapabilityBlockReason | null;
  repositories: MemberRepositoryAdmission[];
  /** Distinct classes among the repositories, in canonical order. */
  evidence_classes: AdmissionEvidenceClass[];
  /** True when every repository is `verified`. */
  evidence_complete: boolean;
  /** Oldest verification timestamp among the repositories (safe bound). */
  verified_at: string | null;
  checked_at: string;
  repository_count: number;
  /** Persisted ceiling; never raised by a provider recovery. */
  ceiling: MemberAdmissionCeiling;
}

export type MemberExclusionReason = "user_inactive" | "enterprise_inactive" | "confirmed_revoked";

/**
 * A member as seen by the repository-set change rules.
 *
 * `protected` is the ADR's *current effective member* membership: the member
 * must be protected by a proposed change. An excluded member is still reported
 * (never silently dropped) with the safe reason.
 */
export interface WorkspaceAdmissionMember extends MemberAdmission {
  membership_id: string;
  role: WorkspaceRole;
  protected: boolean;
  excluded_reason: MemberExclusionReason | null;
}

export type EffectiveOwnerReason =
  | "user_inactive"
  | "enterprise_inactive"
  | "admission_unverifiable"
  | "admission_revoked"
  | "management_missing";

/** Canonical order for reporting, matching the type above one-for-one. */
export const EFFECTIVE_OWNER_REASONS: readonly EffectiveOwnerReason[] = Object.freeze([
  "user_inactive",
  "enterprise_inactive",
  "admission_unverifiable",
  "admission_revoked",
  "management_missing",
]);

export interface EffectiveOwnerStatus {
  user_id: UserId;
  membership_id: string;
  /** Always `owner`: only an owner assignment can be an effective owner. */
  assigned_role: "owner";
  user_active: boolean;
  enterprise_active: boolean;
  /** `repository_manage` proven on every active repository. */
  management_proven: boolean;
  /** All of the above, plus a verified admission. */
  effective: boolean;
  reason: EffectiveOwnerReason | null;
  /** Coarse evidence class behind the verdict (safe to show). */
  evidence_class: AdmissionEvidenceClass;
  verified_at: string | null;
}

/** The two facts a membership change needs about effective ownership. */
export interface OwnerRemovalCheck {
  /** The target currently satisfies every effective-owner condition. */
  target_effective: boolean;
  /** An effective owner other than the target remains. */
  other_effective: boolean;
}

export interface WorkspaceAdmissionCounts {
  members: number;
  protected: number;
  admitted: number;
  unverifiable: number;
  confirmed_revoked: number;
  effective_owners: number;
}

export interface WorkspaceAdmissionReport {
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  set_version: number;
  checked_at: string;
  /** Why the stored repository set itself is unusable, when it is. */
  set_blocked_reason: WorkspaceRepositorySetErrorCode | null;
  multi_repository: boolean;
  /** Gate state as read; `unreadable` fails closed like any other refusal. */
  gate: "enabled" | "disabled" | "unreadable";
  /** True only when every protected member verified on every repository. */
  evidence_complete: boolean;
  /** Union of the protected members' evidence classes, canonical order. */
  evidence_classes: AdmissionEvidenceClass[];
  /** Current effective members, including temporarily unverifiable ones. */
  members: WorkspaceAdmissionMember[];
  /** Reported for completeness; excluded members never block a change. */
  excluded: WorkspaceAdmissionMember[];
  effective_owners: EffectiveOwnerStatus[];
  counts: WorkspaceAdmissionCounts;
}

// ---------------------------------------------------------------------------
// Proposal preview (ADR-0011 "before adding a repository")
// ---------------------------------------------------------------------------

/**
 * One repository a caller proposes to add. Only authority-bearing fields are
 * accepted: an unapproved instance, an installation that is not active for that
 * exact repository, or a missing installation simply fails evidence and the
 * preview reports it — a proposal cannot invent authority.
 */
export interface ProposedRepositoryBinding {
  provider_instance_id: string;
  installation_ref: string | null;
  repository_id: string;
}

export interface ProposedSetInput {
  /** Bindings to add to the current active set. */
  additional_repositories: readonly ProposedRepositoryBinding[];
  /** Observed set version the change is formed against (optimistic check). */
  expected_set_version?: number;
}

export interface ProposedMemberAdmission {
  user_id: UserId;
  membership_id: string;
  role: WorkspaceRole;
  /** True when admission survives the proposed set. */
  retains_admission: boolean;
  /**
   * Intersection over the *current* set, for a before/after disclosure. It is
   * the verified effective ceiling today and never a provider role name.
   */
  current_capabilities: RepositoryCapability[];
  /** Intersection over the proposed set; empty unless it is fully verified. */
  proposed_capabilities: RepositoryCapability[];
  /** Effective capabilities the proposal would take away, canonical order. */
  reduction: RepositoryCapability[];
  /** Coarse evidence classes blocking a verdict (empty when complete). */
  blockers: AdmissionEvidenceClass[];
  /** Why the proposed set does not verify, when it does not. */
  reason: CapabilityBlockReason | null;
  evidence_complete: boolean;
  verified_at: string | null;
}

export interface ProposedOwnerStatus {
  user_id: UserId;
  effective: boolean;
  reason: EffectiveOwnerReason | null;
}

/**
 * The repository-addition preview.
 *
 * Every field is a *preview*: `authorizes_access` is always false and the
 * proposed set is not stored. Committing is a separate, audited decision
 * (ADR-0011), and even then the multi-repository gate stays closed until every
 * access path enforces the whole set.
 */
export interface ProposedSetAdmissionPreview {
  preview: true;
  authorizes_access: false;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  /** Stored set version the proposal was formed against. */
  current_set_version: number;
  /** True when the caller's observed version matched the stored one. */
  set_version_current: boolean;
  proposed_repository_count: number;
  /** Why the stored set is currently unusable (the closed gate, for example). */
  current_set_blocked_reason: CapabilityBlockReason | null;
  multi_repository_gate: "enabled" | "disabled" | "unreadable";
  checked_at: string;
  members: ProposedMemberAdmission[];
  owners_after: ProposedOwnerStatus[];
  /** False when no owner retains every necessary management capability. */
  last_owner_survives: boolean;
  /** True when every protected member retains admission and all evidence verifies. */
  all_members_retain_admission: boolean;
  /**
   * True when at least one protected member keeps admission but loses verified
   * capabilities; such a change requires an informed confirmation.
   */
  reductions_confirmed_by_impact: boolean;
}

/** A proposal that cannot even be evaluated (never a denial of its own). */
export class AdmissionPreviewError extends Error {
  constructor(
    readonly code:
      | "ADMISSION_PROPOSAL_DUPLICATE_REPOSITORY"
      | "ADMISSION_PROPOSAL_SET_VERSION_CONFLICT"
      | "ADMISSION_PROPOSAL_SET_UNREADABLE",
    message: string,
  ) {
    super(message);
    this.name = "AdmissionPreviewError";
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface MemberAdmissionDeps {
  repositorySets: WorkspaceRepositorySetRepository;
  access: ProviderAccessRepositories;
  memberships: MembershipRepository;
  identity: IdentityRepositories;
  capabilityCeilings: CapabilityCeilingService;
  clock?: () => Date;
}

export interface MemberAdmissionService {
  /** One member's admission, evaluated from current provider facts. */
  evaluate(
    scope: WorkspaceScope,
    userId: UserId,
    options?: { now?: Date; persist?: boolean },
  ): MemberAdmission;
  /**
   * The whole workspace: current effective members, their admission, and the
   * effective owners. Read-only: a report never records a downgrade, so it is
   * safe to call from a preview or a request path.
   */
  workspace(scope: WorkspaceScope, options?: { now?: Date }): WorkspaceAdmissionReport;
  /** Effective owners only (verified management capability across the set). */
  effectiveOwners(
    scope: WorkspaceScope,
    options?: { now?: Date; exclude_user_id?: UserId },
  ): EffectiveOwnerStatus[];
  /**
   * True when at least one *other* current effective owner remains. Unknown
   * authority never counts as an effective owner, so a last effective owner is
   * protected even when a second owner exists on paper.
   */
  hasOtherEffectiveOwner(scope: WorkspaceScope, userId: UserId, options?: { now?: Date }): boolean;
  /**
   * The forked question the membership transaction asks (see
   * `MembershipMutationOptions.verifyOwnerRemoval`): is this target an
   * effective owner, and does another effective owner remain? One evaluation
   * answers both, so the two halves can never disagree.
   */
  verifyOwnerRemoval(
    scope: WorkspaceScope,
    userId: UserId,
    options?: { now?: Date },
  ): OwnerRemovalCheck;
  /** Evaluate an uncommitted repository set; grants nothing, writes nothing. */
  previewProposedSet(
    scope: WorkspaceScope,
    proposal: ProposedSetInput,
    options?: { now?: Date },
  ): ProposedSetAdmissionPreview;
}

/** Reconcile failure codes that describe *why* authority is not current. */
const PROVIDER_UNAVAILABLE_FAILURE = "PROVIDER_UNAVAILABLE";
const ROSTER_INCOMPLETE_FAILURE = "PROVIDER_ROSTER_INCOMPLETE";

function classifyEvidence(
  evidence: RepositoryCapabilityEvidence,
  failureCode: string | null,
): AdmissionEvidenceClass {
  if (evidence.state === "verified") {
    return "verified";
  }
  if (evidence.state === "removed") {
    return "confirmed_revocation";
  }
  switch (evidence.reason) {
    case "repository_access_removed":
      return "confirmed_revocation";
    case "permission_visibility_partial":
      // Some access path cannot be enumerated: incomplete, not absent.
      return "truncated";
    case "verification_expired":
      return "expired";
    case "authority_stale":
      // `stale` is also what reconciliation leaves behind when the provider
      // could not be reached or the roster was cut short. Those are distinct
      // facts and must not read as "the verification simply got old".
      if (failureCode === PROVIDER_UNAVAILABLE_FAILURE) {
        return "provider_unavailable";
      }
      if (failureCode === ROSTER_INCOMPLETE_FAILURE) {
        return "truncated";
      }
      return "expired";
    default:
      return "unknown";
  }
}

function canonicalClasses(classes: Iterable<AdmissionEvidenceClass>): AdmissionEvidenceClass[] {
  const set = new Set(classes);
  return ADMISSION_EVIDENCE_CLASSES.filter((entry) => set.has(entry));
}

function difference(
  from: readonly RepositoryCapability[],
  subtract: readonly RepositoryCapability[],
): RepositoryCapability[] {
  return normalizeCapabilitySet(from.filter((capability) => !subtract.includes(capability)));
}

function isSubset(
  subset: readonly RepositoryCapability[],
  superset: readonly RepositoryCapability[],
): boolean {
  return subset.every((capability) => superset.includes(capability));
}

/**
 * A provider recovery that exceeds the persisted ceiling, reported but never
 * applied. Computed here rather than taken from the ceiling evaluation so a
 * persisted *revocation* (an empty ceiling, recorded on the first confirmed
 * loss) also shows the recovery: otherwise "access is back, an administrator
 * must reapprove it" would be invisible exactly where it matters most.
 */
function promotionAvailable(evaluation: CapabilityCeilingEvaluation): boolean {
  const record = evaluation.record;
  if (record === null || record === undefined || evaluation.state !== "verified") {
    return false;
  }
  const available = evaluation.available_capabilities;
  return isSubset(record.ceiling, available) && record.ceiling.length !== available.length;
}

export function createMemberAdmissionService(deps: MemberAdmissionDeps): MemberAdmissionService {
  const { repositorySets, access, memberships, identity, capabilityCeilings } = deps;
  const clock = deps.clock ?? (() => new Date());

  /** The latest reconcile failure for an installation, or null. */
  function latestFailureCode(scope: WorkspaceScope, integrationId: string): string | null {
    const [latest] = access.reconcileRuns.list(scope, integrationId, 1);
    return latest?.failure_code ?? null;
  }

  function latestFailureByIntegration(scope: WorkspaceScope): ReadonlyMap<string, string | null> {
    const failures = new Map<string, string | null>();
    for (const integration of access.integrations.listByWorkspace(scope)) {
      failures.set(integration.id, latestFailureCode(scope, integration.id));
    }
    return failures;
  }

  function buildAdmission(
    scope: WorkspaceScope,
    userId: UserId,
    evaluation: CapabilityCeilingEvaluation,
    failures: ReadonlyMap<string, string | null>,
    assignedRole: WorkspaceRole | null,
  ): MemberAdmission {
    const repositories: MemberRepositoryAdmission[] = evaluation.repositories.map((evidence) => ({
      ...evidence,
      evidence_class: classifyEvidence(
        evidence,
        evidence.integration_id === null ? null : (failures.get(evidence.integration_id) ?? null),
      ),
    }));
    const state: MemberAdmissionState =
      evaluation.state === "verified"
        ? // A persisted reduction can hold the ceiling below the admission
          // requirement even after verified facts recover: recovery never
          // re-admits on its own (ADR-0011).
          evaluation.capabilities.includes("code_read")
          ? "admitted"
          : "confirmed_revoked"
        : evaluation.state === "confirmed_loss"
          ? "confirmed_revoked"
          : "unverifiable";
    const admitted = state === "admitted";
    const capabilities = admitted ? evaluation.capabilities : [];
    const reason: CapabilityBlockReason | null =
      evaluation.state === "verified" && !admitted ? "no_code_read" : evaluation.reason;
    const evidenceClasses = canonicalClasses(
      repositories.map((repository) => repository.evidence_class),
    );
    return {
      user_id: userId,
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      set_version: evaluation.set_version,
      assigned_role: assignedRole,
      state,
      admitted,
      capabilities,
      role_ceiling: memberRoleCeiling(capabilities),
      reason,
      repositories,
      evidence_classes: evidenceClasses,
      evidence_complete:
        repositories.length > 0 &&
        repositories.every((repository) => repository.evidence_class === "verified"),
      verified_at: evaluation.verified_at,
      checked_at: evaluation.checked_at,
      repository_count: evaluation.repository_count,
      ceiling: {
        state: evaluation.record?.state ?? null,
        capabilities: evaluation.record?.ceiling ?? [],
        reason: evaluation.record?.reason ?? null,
        version: evaluation.record?.version ?? null,
        verified_at: evaluation.record?.verified_at ?? null,
        promotion_available: promotionAvailable(evaluation),
      },
    };
  }

  /**
   * Why this membership is outside the protection set, or null when it is in
   * it. A persisted empty ceiling is the durable mark of a confirmed
   * revocation: it survives restarts and a later provider recovery, so a
   * revoked member cannot be re-admitted by merely being observed again.
   */
  function exclusionReason(
    scope: WorkspaceScope,
    userId: UserId,
    admission: MemberAdmission,
  ): MemberExclusionReason | null {
    const user = identity.users.getById(userId);
    if (user === undefined || user.status !== "active") {
      return "user_inactive";
    }
    const enterpriseUser = identity.enterpriseUsers.getByUser(scope.enterprise_id, userId);
    if (enterpriseUser === undefined || enterpriseUser.status !== "active") {
      return "enterprise_inactive";
    }
    const revoked = (admission.ceiling.capabilities ?? []).length === 0;
    if (admission.ceiling.state !== null && revoked) {
      return "confirmed_revoked";
    }
    return null;
  }

  function evaluate(
    scope: WorkspaceScope,
    userId: UserId,
    options: { now?: Date; persist?: boolean } = {},
  ): MemberAdmission {
    const evaluation = capabilityCeilings.evaluate(scope, userId, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      persist: options.persist ?? false,
    });
    const membership = memberships.getByUser(scope, userId);
    return buildAdmission(
      scope,
      userId,
      evaluation,
      latestFailureByIntegration(scope),
      membership?.role ?? null,
    );
  }

  function ownerStatus(
    member: WorkspaceAdmissionMember,
    admission: MemberAdmission,
  ): EffectiveOwnerStatus {
    const user = identity.users.getById(member.user_id);
    const userActive = user !== undefined && user.status === "active";
    const enterpriseUser = identity.enterpriseUsers.getByUser(member.enterprise_id, member.user_id);
    const enterpriseActive = enterpriseUser !== undefined && enterpriseUser.status === "active";
    const managementProven =
      admission.admitted && admission.capabilities.includes("repository_manage");
    const evidenceClass: AdmissionEvidenceClass = admission.admitted
      ? "verified"
      : (admission.evidence_classes.find((entry) => entry !== "verified") ?? "unknown");
    let reason: EffectiveOwnerReason | null = null;
    if (!userActive) {
      reason = "user_inactive";
    } else if (!enterpriseActive) {
      reason = "enterprise_inactive";
    } else if (admission.state === "confirmed_revoked") {
      reason = "admission_revoked";
    } else if (!admission.admitted) {
      reason = "admission_unverifiable";
    } else if (!managementProven) {
      reason = "management_missing";
    }
    return {
      user_id: member.user_id,
      membership_id: member.membership_id,
      assigned_role: "owner",
      user_active: userActive,
      enterprise_active: enterpriseActive,
      management_proven: managementProven,
      effective: reason === null,
      reason,
      evidence_class: evidenceClass,
      verified_at: admission.verified_at,
    };
  }

  function workspace(
    scope: WorkspaceScope,
    options: { now?: Date } = {},
  ): WorkspaceAdmissionReport {
    const now = options.now ?? clock();
    const checkedAt = now.toISOString();
    const failures = latestFailureByIntegration(scope);

    let setVersion = 0;
    let setBlockedReason: WorkspaceRepositorySetErrorCode | null = null;
    let multiRepository = false;
    try {
      const set = repositorySets.getSet(scope);
      setVersion = set.set_version;
      multiRepository = set.multi_repository;
      setBlockedReason = set.blocked_reason;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === undefined) {
        throw error;
      }
      setBlockedReason = code as WorkspaceRepositorySetErrorCode;
      // Report the stored version/count when they are still readable, so the
      // refusal is explainable without pretending the set is empty.
      try {
        setVersion = repositorySets.currentSetVersion(scope);
        multiRepository = repositorySets.listBindings(scope).length > 1;
      } catch {
        // Unreadable storage stays at 0/false: the refusal is the answer.
      }
    }

    let gate: WorkspaceAdmissionReport["gate"] = "unreadable";
    try {
      gate = repositorySets.gate().state;
    } catch {
      // An unreadable gate is a refusal, not a disabled feature: every
      // admission below fails closed on its own evidence anyway.
      gate = "unreadable";
    }

    const rows = memberships
      .list(scope)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const members: WorkspaceAdmissionMember[] = [];
    const excluded: WorkspaceAdmissionMember[] = [];
    const owners: EffectiveOwnerStatus[] = [];

    for (const membership of rows) {
      const admission = buildAdmission(
        scope,
        membership.user_id,
        capabilityCeilings.evaluate(scope, membership.user_id, {
          now,
          persist: false,
        }),
        failures,
        membership.role,
      );
      const reason = exclusionReason(scope, membership.user_id, admission);
      const entry: WorkspaceAdmissionMember = {
        ...admission,
        membership_id: membership.id,
        role: membership.role,
        protected: reason === null,
        excluded_reason: reason,
      };
      if (reason === null) {
        members.push(entry);
      } else {
        excluded.push(entry);
      }
      if (membership.role === "owner") {
        owners.push(ownerStatus(entry, admission));
      }
    }

    const evidenceClasses = canonicalClasses(members.flatMap((member) => member.evidence_classes));
    const counts: WorkspaceAdmissionCounts = {
      members: rows.length,
      protected: members.length,
      admitted: members.filter((member) => member.state === "admitted").length,
      unverifiable: members.filter((member) => member.state === "unverifiable").length,
      confirmed_revoked: members.filter((member) => member.state === "confirmed_revoked").length,
      effective_owners: owners.filter((owner) => owner.effective).length,
    };

    return {
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      set_version: setVersion,
      checked_at: checkedAt,
      set_blocked_reason: setBlockedReason,
      multi_repository: multiRepository,
      gate,
      evidence_complete: members.length > 0 && members.every((member) => member.evidence_complete),
      evidence_classes: evidenceClasses,
      members,
      excluded,
      effective_owners: owners,
      counts,
    };
  }

  function effectiveOwners(
    scope: WorkspaceScope,
    options: { now?: Date; exclude_user_id?: UserId } = {},
  ): EffectiveOwnerStatus[] {
    return workspace(scope, options).effective_owners.filter(
      (owner) =>
        owner.effective &&
        (options.exclude_user_id === undefined || owner.user_id !== options.exclude_user_id),
    );
  }

  function hasOtherEffectiveOwner(
    scope: WorkspaceScope,
    userId: UserId,
    options: { now?: Date } = {},
  ): boolean {
    return effectiveOwners(scope, { ...options, exclude_user_id: userId }).length > 0;
  }

  function verifyOwnerRemoval(
    scope: WorkspaceScope,
    userId: UserId,
    options: { now?: Date } = {},
  ): OwnerRemovalCheck {
    const owners = workspace(scope, options).effective_owners;
    return {
      target_effective: owners.some((owner) => owner.user_id === userId && owner.effective),
      other_effective: owners.some((owner) => owner.effective && owner.user_id !== userId),
    };
  }

  function previewProposedSet(
    scope: WorkspaceScope,
    proposal: ProposedSetInput,
    options: { now?: Date } = {},
  ): ProposedSetAdmissionPreview {
    const now = options.now ?? clock();
    const at = now.toISOString();

    let storedBindings: Array<{
      repository_id: string;
      provider_instance_id: string;
      installation_ref: string | null;
    }>;
    let setVersion: number;
    try {
      // Raw storage rows, not `getSet`: the preview must be formable while the
      // scope itself is refused (the closed multi-repository gate), because
      // that refusal is exactly what the caller is asking about. Each proposed
      // binding still has to prove approved instance + active installation, so
      // an unreadable scope cannot smuggle authority through the preview.
      setVersion = repositorySets.currentSetVersion(scope);
      storedBindings = repositorySets
        .listBindings(scope)
        .filter((binding) => binding.status === "active")
        .map((binding) => ({
          repository_id: binding.repository_id,
          provider_instance_id: binding.provider_instance_id,
          installation_ref: binding.installation_ref,
        }));
    } catch (error) {
      throw new AdmissionPreviewError(
        "ADMISSION_PROPOSAL_SET_UNREADABLE",
        `the workspace repository set cannot be read, so no preview can be formed: ${
          (error as { code?: string }).code ?? String(error)
        }`,
      );
    }

    if (
      proposal.expected_set_version !== undefined &&
      proposal.expected_set_version !== setVersion
    ) {
      throw new AdmissionPreviewError(
        "ADMISSION_PROPOSAL_SET_VERSION_CONFLICT",
        `the workspace repository set changed (expected version ${proposal.expected_set_version}, found ${setVersion})`,
      );
    }

    const existing = new Set(storedBindings.map((binding) => binding.repository_id));
    const merged: ProposedRepositoryBindingInput[] = [...storedBindings];
    for (const binding of proposal.additional_repositories) {
      if (existing.has(binding.repository_id)) {
        throw new AdmissionPreviewError(
          "ADMISSION_PROPOSAL_DUPLICATE_REPOSITORY",
          `repository ${binding.repository_id} is already bound; a proposal only adds repositories`,
        );
      }
      existing.add(binding.repository_id);
      merged.push({
        repository_id: binding.repository_id,
        provider_instance_id: binding.provider_instance_id,
        installation_ref: binding.installation_ref,
      });
    }

    const report = workspace(scope, { now });
    const failures = latestFailureByIntegration(scope);
    const members: ProposedMemberAdmission[] = [];
    const ownersAfter: ProposedOwnerStatus[] = [];
    let currentSetBlocked: CapabilityBlockReason | null = null;

    for (const member of report.members) {
      const evaluation = capabilityCeilings.evaluate(scope, member.user_id, {
        now,
        persist: false,
        proposed_bindings: merged,
        proposed_set_version: setVersion,
      });
      currentSetBlocked ??= evaluation.current_set_blocked_reason;
      const admission = buildAdmission(scope, member.user_id, evaluation, failures, member.role);
      const evidenceComplete = admission.evidence_complete;
      const proposedAvailable = evidenceComplete
        ? normalizeCapabilitySet(evaluation.available_capabilities)
        : [];
      // A previously confirmed reduction bounds the proposal too: a provider
      // recovery does not silently restore what an administrator must
      // reapprove, so a preview cannot promise more than the persisted ceiling.
      const proposedEffective =
        member.ceiling.state === null
          ? proposedAvailable
          : normalizeCapabilitySet(
              proposedAvailable.filter((capability) =>
                member.ceiling.capabilities.includes(capability),
              ),
            );
      const retains = evidenceComplete && proposedEffective.includes("code_read");
      members.push({
        user_id: member.user_id,
        membership_id: member.membership_id,
        role: member.role,
        retains_admission: retains,
        current_capabilities: normalizeCapabilitySet(member.capabilities),
        proposed_capabilities: retains ? proposedEffective : [],
        reduction: retains ? difference(member.capabilities, proposedEffective) : [],
        blockers: admission.evidence_classes.filter((entry) => entry !== "verified"),
        reason: admission.reason,
        evidence_complete: evidenceComplete,
        verified_at: admission.verified_at,
      });
      if (member.role === "owner") {
        const reason: EffectiveOwnerReason | null = !member.excluded_reason
          ? retains
            ? proposedEffective.includes("repository_manage")
              ? null
              : "management_missing"
            : "admission_unverifiable"
          : member.excluded_reason === "confirmed_revoked"
            ? "admission_revoked"
            : member.excluded_reason;
        ownersAfter.push({
          user_id: member.user_id,
          effective: reason === null,
          reason,
        });
      }
    }

    return {
      preview: true,
      authorizes_access: false,
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      current_set_version: setVersion,
      set_version_current: true,
      proposed_repository_count: merged.length,
      current_set_blocked_reason: currentSetBlocked,
      multi_repository_gate: report.gate,
      checked_at: at,
      members,
      owners_after: ownersAfter,
      last_owner_survives: ownersAfter.some((owner) => owner.effective),
      all_members_retain_admission:
        members.length > 0 && members.every((member) => member.retains_admission),
      reductions_confirmed_by_impact: members.some(
        (member) => member.retains_admission && member.reduction.length > 0,
      ),
    };
  }

  return {
    evaluate,
    workspace,
    effectiveOwners,
    hasOtherEffectiveOwner,
    verifyOwnerRemoval,
    previewProposedSet,
  };
}
