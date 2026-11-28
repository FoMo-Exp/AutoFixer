/**
 * Member-candidate refusal vocabulary (DAT-277, ADR-0006/0011).
 *
 * Kept in its own module so the domain service and the exported OpenAPI
 * contract consume one list: a code that appears on the wire is always a code
 * the service can produce, and a new refusal cannot silently drift into the
 * schema as free-form text.
 *
 * Every code is a refusal. A candidate is added only when the verified
 * provider intersection proves code read on every repository; any unknown,
 * stale, removed, unsupported, unlinked or unobservable fact becomes one of
 * these codes instead of an empty roster or a guessed eligibility.
 */

export const MEMBER_INELIGIBLE_REASONS = [
  /** The provider subject has never signed in, so no account can be granted. */
  "identity_unlinked",
  /** The user already holds a membership; change it instead of adding it. */
  "already_member",
  "workspace_archived",
  "repository_missing",
  "repository_set_unsupported",
  "repository_binding_inconsistent",
  "installation_not_approved",
  "provider_instance_unapproved",
  "subject_missing",
  "authority_unknown",
  "authority_stale",
  "verification_expired",
  "permission_visibility_none",
  "permission_visibility_partial",
  "role_missing",
  "unsupported_role",
  "repository_access_removed",
  "no_code_read",
  "capability_store_unavailable",
  "schema_version_unsupported",
  "repository_set_state_unsupported",
] as const;

export type MemberIneligibleReason = (typeof MEMBER_INELIGIBLE_REASONS)[number];

/** The provider-derived ceiling on a viewer/member grant (never admin/owner). */
export type MemberRoleCeiling = "viewer" | "member";
