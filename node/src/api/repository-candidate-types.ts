/**
 * Approved-repository discovery vocabulary (DAT-289, ADR-0011).
 *
 * Kept in its own module for the same reason as the member-candidate
 * vocabulary: the disclosure service and the exported OpenAPI contract consume
 * one list, so a code that appears on the wire is always a code the service can
 * produce and a new state cannot silently drift into the schema as free text.
 *
 * ## Why every non-eligible state is a *restriction* code
 *
 * A candidate is offered so an administrator can select it for the DAT-286
 * preview. Selection is not authority: the preview re-verifies the installation,
 * every member's evidence and the set version, and the commit re-verifies them
 * again. Discovery therefore answers one narrow question — "may this
 * installation serve as evidence for this workspace at all?" — and every answer
 * other than "yes" is a named restriction, never a silent omission and never a
 * guess that the repository is approved.
 */

/**
 * Why a discovered repository cannot be proposed as it stands.
 *
 * Each code describes the *installation*, not the members: the per-member
 * impact and any expired evidence stay the preview's answer, so a restriction
 * never reads as a confirmed capability loss.
 */
export const REPOSITORY_CANDIDATE_RESTRICTIONS = Object.freeze([
  /** The installation row is suspended or uninstalled: it observes nothing. */
  "installation_inactive",
  /** The named provider instance is not registered for this enterprise. */
  "provider_instance_unapproved",
  /** The provider cannot observe effective permissions at all. */
  "permission_visibility_none",
  /** Some access path cannot be enumerated, so absence is not removal. */
  "permission_visibility_partial",
  /** The provider could not be reached on the last reconciliation. */
  "provider_unavailable",
  /** The last roster fetch was truncated; it is not the complete truth. */
  "roster_incomplete",
] as const);

export type RepositoryCandidateRestriction = (typeof REPOSITORY_CANDIDATE_RESTRICTIONS)[number];

/**
 * Which stores the candidate list is built from. There is exactly one in this
 * build: installations an enterprise administrator already registered for the
 * workspace. Candidate discovery never creates an installation.
 */
export const REPOSITORY_DISCOVERY_SOURCES = Object.freeze([
  "registered_service_integrations",
] as const);

/**
 * Sources this build cannot enumerate. They are reported, not hidden, because
 * the difference between "no other repository is approvable" and "this build
 * cannot see the rest of the provider's repositories" decides whether an
 * administrator waits or provisions an installation.
 */
export const REPOSITORY_DISCOVERY_UNSUPPORTED_SOURCES = Object.freeze([
  "provider_repository_enumeration",
] as const);

/**
 * Why the list is a bounded subset. Always non-empty: no response ever claims
 * to be the complete set of repositories the provider would allow.
 */
export const REPOSITORY_DISCOVERY_LIMITS = Object.freeze([
  /** The provider adapters expose rosters, not repository enumeration. */
  "provider_repository_enumeration_unsupported",
  /** Evidence is workspace-scoped, so another workspace's installation cannot
   * serve as this workspace's evidence even for the same repository. */
  "installation_scoped_to_workspace",
] as const);

export type RepositoryDiscoveryLimit = (typeof REPOSITORY_DISCOVERY_LIMITS)[number];

/** The one completeness claim this build may make. */
export const REPOSITORY_DISCOVERY_COMPLETENESS = Object.freeze(["bounded"] as const);

/** How current the installation's observed authority is. */
export const REPOSITORY_CANDIDATE_FRESHNESS = Object.freeze([
  "fresh",
  "stale",
  "never_verified",
] as const);

export type RepositoryCandidateFreshness = (typeof REPOSITORY_CANDIDATE_FRESHNESS)[number];
