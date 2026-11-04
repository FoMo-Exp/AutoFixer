/**
 * Explicit provider role normalization (DAT-203).
 *
 * Provider organizations, groups, inherited roles, and direct collaborators
 * are normalized one explicit rule at a time — no implicit role algebra, no
 * guessed authority. Two hard rules:
 *
 * - A GitHub repository has no "owner" user. Organization owner authority is
 *   normalized as `org_owner` with the organization as authority_ref; a raw
 *   record claiming repository-level owner for GitHub is a
 *   {@link NormalizationError}, never a fabricated user owner.
 * - Provenance is preserved row by row. A subject appearing through several
 *   sources yields several rows, so "why does this person have access?" is
 *   always answerable from the data.
 */

import type { ProviderType } from "../control-plane/types.js";
import {
  NormalizationError,
  type NormalizedRosterEntry,
  type ProviderAdapter,
  type RawProviderRole,
} from "./types.js";

/** Provider-native permission rank; higher wins for effective access. */
const GITHUB_RANK: Readonly<Record<string, number>> = Object.freeze({
  // Repository permission vocabulary.
  read: 0,
  triage: 1,
  write: 2,
  maintain: 3,
  admin: 4,
  // Organization role vocabulary. An org owner effectively administers
  // org-owned repositories; plain org membership is *below* read — it is not
  // repository access by itself on GitHub.
  owner: 4,
  member: -1,
});

const GITLAB_RANK: Readonly<Record<string, number>> = Object.freeze({
  guest: 0,
  reporter: 1,
  developer: 2,
  maintainer: 3,
  owner: 4,
});

/** Repository permission vocabulary for GitHub teams and collaborators. */
const GITHUB_REPO_ROLES = new Set(["read", "triage", "write", "maintain", "admin"]);

function rankOf(provider: ProviderType, role: string): number {
  const table = provider === "github" ? GITHUB_RANK : GITLAB_RANK;
  const rank = table[role];
  if (rank === undefined) {
    throw new NormalizationError(`unknown ${provider} role vocabulary "${role}"`);
  }
  return rank;
}

/**
 * Normalize one raw provider record for one provider type. Throws
 * {@link NormalizationError} instead of guessing when the record references
 * authority the provider model does not have.
 */
export function normalizeRole(provider: ProviderType, raw: RawProviderRole): NormalizedRosterEntry {
  const inherited_from = raw.inherited_from ?? null;
  switch (provider) {
    case "github": {
      switch (raw.kind) {
        case "org_owner":
        case "org_member":
          // Organization authority belongs to the organization. The org is
          // the authority_ref; there is no repository owner user to invent.
          if (!raw.authority_ref) {
            throw new NormalizationError(
              "github organization role requires an organization authority_ref",
            );
          }
          break;
        case "inherited_role":
          // GitHub repository permissions are inherited through teams.
          if (!raw.authority_ref) {
            throw new NormalizationError("github inherited role requires a team authority_ref");
          }
          break;
        case "effective_access":
          // The provider reports effective access but cannot attribute it to
          // a direct grant, team inheritance, or organization default. The
          // row says "has effective access" and nothing more; it still needs
          // the repository it describes.
          if (!raw.authority_ref) {
            throw new NormalizationError(
              "github effective_access requires a repository authority_ref",
            );
          }
          break;
        case "direct_collaborator":
          // A GitHub repository has no owner user. Repository-level
          // collaborator vocabulary is read/triage/write/maintain/admin; a
          // claimed "owner" here would fabricate authority GitHub does not
          // model, so it is refused explicitly.
          if (raw.provider_role === "owner") {
            throw new NormalizationError(
              "github repositories have no owner user; organization authority is normalized as org_owner",
            );
          }
          if (!raw.authority_ref) {
            throw new NormalizationError(
              "github direct collaborator requires a repository authority_ref",
            );
          }
          break;
        case "group":
          // GitHub has no group authority distinct from organizations/teams.
          throw new NormalizationError(
            `github has no "${raw.kind}" authority source; use org_owner, org_member, inherited_role, or direct_collaborator`,
          );
      }
      // Validate the role vocabulary for the claimed kind.
      if (raw.kind === "org_owner" && raw.provider_role !== "owner") {
        throw new NormalizationError(
          `github org owner role must be "owner", got "${raw.provider_role}"`,
        );
      }
      if (raw.kind === "org_member" && raw.provider_role !== "member") {
        throw new NormalizationError(
          `github org member role must be "member", got "${raw.provider_role}"`,
        );
      }
      if (
        (raw.kind === "inherited_role" ||
          raw.kind === "direct_collaborator" ||
          raw.kind === "effective_access") &&
        !GITHUB_REPO_ROLES.has(raw.provider_role)
      ) {
        throw new NormalizationError(
          `github repository role must be one of read/triage/write/maintain/admin, got "${raw.provider_role}"`,
        );
      }
      rankOf("github", raw.provider_role);
      break;
    }
    case "gitlab": {
      switch (raw.kind) {
        case "group":
          // GitLab group membership; subgroups use inherited_role.
          if (!raw.authority_ref) {
            throw new NormalizationError("gitlab group role requires a group authority_ref");
          }
          break;
        case "inherited_role":
          // Inherited through a parent group or subgroup chain.
          if (!raw.authority_ref || !inherited_from) {
            throw new NormalizationError(
              "gitlab inherited role requires authority_ref and inherited_from group ids",
            );
          }
          break;
        case "direct_collaborator":
          if (!raw.authority_ref) {
            throw new NormalizationError(
              "gitlab direct collaborator requires a project authority_ref",
            );
          }
          break;
        case "effective_access":
          // GitLab's aggregate membership views mix project, group, and
          // ancestor-group grants the same way; the source is accepted as
          // "effective access", never as a direct grant. This issue only
          // produces it for GitHub.
          if (!raw.authority_ref) {
            throw new NormalizationError(
              "gitlab effective_access requires a project authority_ref",
            );
          }
          break;
        case "org_owner":
        case "org_member":
          // GitLab models organizations as groups.
          throw new NormalizationError(
            `gitlab has no "${raw.kind}" authority source; use group, inherited_role, or direct_collaborator`,
          );
      }
      rankOf("gitlab", raw.provider_role);
      break;
    }
    default: {
      const exhaustive: never = provider;
      throw new NormalizationError(`unsupported provider ${String(exhaustive)}`);
    }
  }

  return {
    subject: raw.subject,
    login: raw.login,
    source_kind: raw.kind,
    provider_role: raw.provider_role,
    authority_ref: raw.authority_ref,
    inherited_from,
    provenance: {
      provider,
      source_kind: raw.kind,
      authority_ref: raw.authority_ref,
      inherited_from,
      provider_role: raw.provider_role,
    },
  };
}

/**
 * Normalize a complete raw roster. The result preserves every source row; use
 * {@link effectiveProviderRole} to fold a subject's rows into one effective
 * permission level when a single rank is needed.
 */
export function normalizeRoster(
  provider: ProviderType,
  raw: readonly RawProviderRole[],
): NormalizedRosterEntry[] {
  return raw.map((entry) => normalizeRole(provider, entry));
}

export interface EffectiveProviderRole {
  subject: string;
  /** Highest-ranked provider role across all provenance rows. */
  provider_role: string;
  rank: number;
  /** Every provenance row that contributes authority. */
  sources: readonly NormalizedRosterEntry[];
}

/**
 * Fold one subject's normalized rows into one effective permission level.
 * Ranking is provider vocabulary only — enterprise membership, workspace
 * role, and action policy intersect later in the effective-access step.
 */
export function effectiveProviderRole(
  provider: ProviderType,
  entries: readonly NormalizedRosterEntry[],
  subject: string,
): EffectiveProviderRole | null {
  const sources = entries.filter((entry) => entry.subject === subject);
  if (sources.length === 0) {
    return null;
  }
  let best: NormalizedRosterEntry | null = null;
  for (const entry of sources) {
    if (
      best === null ||
      rankOf(provider, entry.provider_role) > rankOf(provider, best.provider_role)
    ) {
      best = entry;
    }
  }
  if (best === null) {
    return null;
  }
  return {
    subject,
    provider_role: best.provider_role,
    rank: rankOf(provider, best.provider_role),
    sources,
  };
}

/** The provider vocabulary ranks this module validates. */
export function isKnownRole(provider: ProviderType, role: string): boolean {
  const table = provider === "github" ? GITHUB_RANK : GITLAB_RANK;
  return Object.prototype.hasOwnProperty.call(table, role);
}

/** Convenience: the adapter's own provider type drives normalization. */
export function normalizeRosterFor(
  adapter: ProviderAdapter,
  raw: readonly RawProviderRole[],
): NormalizedRosterEntry[] {
  return normalizeRoster(adapter.provider_type, raw);
}
