/**
 * Provider role → repository capability policy (DAT-276, ADR-0011).
 *
 * ## Why an explicit table
 *
 * ADR-0011 is clear that a provider role *name* is evidence, not authority:
 * "Require proof of repository code-read and action-specific capabilities on
 * the actual instance. Unsupported roles and incomplete or ambiguous
 * capability evidence fail closed rather than being ranked by name."
 *
 * So each supported provider vocabulary is mapped row by row, and anything
 * outside the table is `unsupported` — `guest`, a custom role, a renamed
 * enterprise role, or a future provider vocabulary can never be inferred into
 * a capability. The intersection across repositories is a set intersection:
 * write on repository A and read on B yields read, and no ranking of role
 * names can compensate for a missing capability on another repository.
 *
 * ## Conservative choices
 *
 * - GitHub `maintain` maps to code read, issue write and repository write, but
 *   **not** repository management: workspace administration requires
 *   administrator-level repository authority (`admin`), which `maintain` does
 *   not prove on every repository setting.
 * - GitLab `maintainer` is treated the same way; only `owner` proves
 *   management. A `maintainer` can administer some project settings in GitLab,
 *   but AutoFixer's policy is not a claim about GitLab semantics.
 * - GitHub `org_member` is a real, supported fact that proves *no* repository
 *   access: GitHub repository access still needs a team or direct grant. It
 *   maps to the empty capability set rather than an error.
 * - GitHub `org_owner` proves administrator authority on org-owned
 *   repositories, so it maps to the administrator capability set. This is a
 *   provider fact about the organization, not a workspace or enterprise role.
 * - GitLab `guest` is supported with no capabilities: the provider reports the
 *   person, and the honest answer is "no capability can be proven". Both this
 *   and `unsupported` end in the same refusal at the ceiling layer.
 */

import type { ProviderRoleSourceKind } from "../control-plane/provider-access-types.js";
import {
  REPOSITORY_CAPABILITIES,
  type CapabilityBlockReason,
  type RepositoryCapability,
} from "../control-plane/member-capability-types.js";
import type { ProviderType } from "../control-plane/types.js";
import type { ActionKind } from "./types.js";

/** The capability an action needs from *every* repository. */
const ACTION_CAPABILITY: Readonly<Record<ActionKind, RepositoryCapability>> = Object.freeze({
  read: "code_read",
  stream: "code_read",
  artifact_read: "code_read",
  issue_sync: "issue_write",
  write: "repository_write",
  delivery: "repository_write",
  approval: "repository_write",
  manage: "repository_manage",
});

export function requiredCapabilityForAction(action: ActionKind): RepositoryCapability {
  return ACTION_CAPABILITY[action];
}

const GITHUB_REPOSITORY_ROLES: Readonly<Record<string, readonly RepositoryCapability[]>> =
  Object.freeze({
    read: ["code_read"],
    triage: ["code_read", "issue_write"],
    write: ["code_read", "issue_write", "repository_write"],
    maintain: ["code_read", "issue_write", "repository_write"],
    admin: ["code_read", "issue_write", "repository_write", "repository_manage"],
  });

const GITLAB_ACCESS_LEVELS: Readonly<Record<string, readonly RepositoryCapability[]>> =
  Object.freeze({
    guest: [],
    reporter: ["code_read"],
    developer: ["code_read", "issue_write", "repository_write"],
    maintainer: ["code_read", "issue_write", "repository_write"],
    owner: ["code_read", "issue_write", "repository_write", "repository_manage"],
  });

/** One repository's capability evidence for one member. */
export interface RepositoryCapabilityEvidence {
  repository_id: string;
  provider_instance_id: string;
  integration_id: string | null;
  /**
   * `removed` is a positive provider statement that access is gone;
   * `unverified` means no capability can be proven right now (never a
   * downgrade); `verified` carries the proven capability set.
   */
  state: "verified" | "unverified" | "removed";
  capabilities: RepositoryCapability[];
  reason: CapabilityBlockReason | null;
  verified_at: string | null;
}

export interface RoleCapabilityResult {
  /** False when the role vocabulary proves nothing at all (fail closed). */
  supported: boolean;
  capabilities: readonly RepositoryCapability[];
  /** Safe, provider-neutral explanation for reports; never a role ranking. */
  reason: "supported" | "unsupported_role" | "organization_membership_only";
}

/**
 * Map one normalized provider role row to capabilities.
 *
 * The row's `source_kind` participates deliberately: a GitHub `org_member`
 * row carrying a repository-level role would be contradictory data, and the
 * normalizer already refuses it; here the kind decides that organization
 * membership alone proves no repository access.
 */
export function providerRoleCapabilities(
  provider: ProviderType,
  sourceKind: ProviderRoleSourceKind,
  providerRole: string,
): RoleCapabilityResult {
  if (provider === "github") {
    if (sourceKind === "org_member") {
      return {
        supported: true,
        capabilities: [],
        reason: "organization_membership_only",
      };
    }
    if (sourceKind === "org_owner") {
      // Only `org_owner` carries organization ownership; the normalizer refuses
      // any other role for this kind, so an unexpected role fails closed.
      return providerRole === "owner"
        ? {
            supported: true,
            capabilities: GITHUB_REPOSITORY_ROLES.admin ?? [],
            reason: "supported",
          }
        : { supported: false, capabilities: [], reason: "unsupported_role" };
    }
    if (sourceKind === "group") {
      // GitHub has no group authority distinct from teams/organizations; the
      // normalizer never emits this kind, and a row claiming it proves nothing.
      return { supported: false, capabilities: [], reason: "unsupported_role" };
    }
    const capabilities = GITHUB_REPOSITORY_ROLES[providerRole];
    return capabilities === undefined
      ? { supported: false, capabilities: [], reason: "unsupported_role" }
      : { supported: true, capabilities, reason: "supported" };
  }

  if (sourceKind === "org_member" || sourceKind === "org_owner") {
    // GitLab models organizations as groups; a stale organization row is not a
    // project access fact and must not be interpreted as one.
    return { supported: false, capabilities: [], reason: "unsupported_role" };
  }
  const capabilities = GITLAB_ACCESS_LEVELS[providerRole];
  return capabilities === undefined
    ? { supported: false, capabilities: [], reason: "unsupported_role" }
    : { supported: true, capabilities, reason: "supported" };
}

/** Canonical order for reporting and comparisons. */
export function normalizeCapabilitySet(
  capabilities: Iterable<RepositoryCapability>,
): RepositoryCapability[] {
  const set = new Set(capabilities);
  return REPOSITORY_CAPABILITIES.filter((capability) => set.has(capability));
}

/**
 * Set intersection across repositories. A single repository's capability
 * cannot compensate for another repository's missing capability — write on A
 * and read on B yields read.
 */
export function intersectRepositoryCapabilities(
  perRepository: readonly (readonly RepositoryCapability[])[],
): RepositoryCapability[] {
  if (perRepository.length === 0) {
    return [];
  }
  const [first, ...rest] = perRepository;
  const intersection = new Set(first ?? []);
  for (const capabilities of rest) {
    const present = new Set(capabilities);
    for (const capability of [...intersection]) {
      if (!present.has(capability)) {
        intersection.delete(capability);
      }
    }
  }
  return normalizeCapabilitySet(intersection);
}

/**
 * Whether a capability grant is still supported by a ceiling. A grant never
 * substitutes for a capability: an expired or unsupported grant is revoked
 * when the ceiling tightens.
 */
export function grantSupportedByCeiling(
  grant: "checkout_read" | "delivery_write",
  ceiling: readonly RepositoryCapability[],
): boolean {
  return grant === "checkout_read"
    ? ceiling.includes("code_read")
    : ceiling.includes("repository_write");
}
