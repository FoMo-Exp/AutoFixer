/**
 * Verified repository-access facts (DAT-204 eligibility; DAT-203 producers).
 *
 * Invitation redemption must check the invitee's *current repository access*
 * (ADR-0006): holding a provider identity is not enough — a forwarded
 * invitation redeemed by someone without access to the workspace's repository
 * stays denied. Access is therefore not inferred; it is a fact recorded by a
 * trusted producer that verified it against the provider, with the
 * verification time and source attached:
 *
 * - `provider_api` — a direct provider check (the DAT-203 repository-scoped
 *   service integration),
 * - `roster_sync` / `reconciliation` — DAT-203's member normalization and
 *   periodic reconciliation.
 *
 * Recording is the only way a fact enters storage; nothing on the HTTP
 * surface can self-assert access. Until a producer is deployed, no facts
 * exist and redemption fails closed as ineligible. Facts are read inside the
 * redemption transaction and only count while fresh
 * ({@link REPOSITORY_ACCESS_MAX_AGE_SECONDS}), so a stale or missing fact
 * denies the join instead of granting on old evidence.
 */

import type { ControlPlaneDb } from "./db.js";
import { newId, nowIso } from "./db.js";
import type {
  EnterpriseId,
  ProviderInstanceId,
  UserId,
  WorkspaceId,
  WorkspaceScope,
} from "./types.js";

/** Authority that produced a repository-access verification. */
export type RepositoryAccessVerificationSource = "provider_api" | "roster_sync" | "reconciliation";

/**
 * Eligibility freshness policy: a repository-access fact counts as current
 * only within this window of the redemption moment. Older evidence is stale
 * and denies the join; DAT-203's periodic reconciliation keeps facts inside
 * the window.
 */
export const REPOSITORY_ACCESS_MAX_AGE_SECONDS = 24 * 60 * 60;

/** One verified (or verified-absent) repository-access fact per subject. */
export interface RepositoryAccessVerification {
  id: string;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  provider_instance_id: ProviderInstanceId;
  /** Stable provider subject the fact is about. */
  subject: string;
  has_access: boolean;
  /** When the producing authority verified this against the provider. */
  verified_at: string;
  verified_by_source: RepositoryAccessVerificationSource;
  created_at: string;
  created_by: UserId;
  updated_at: string;
  updated_by: UserId;
}

export interface RecordRepositoryAccessInput {
  provider_instance_id: ProviderInstanceId;
  subject: string;
  has_access: boolean;
  /** Verification time as reported by the producing authority; defaults to now. */
  verified_at?: string;
  verified_by_source: RepositoryAccessVerificationSource;
  actor_id: UserId;
}

export interface RepositoryAccessVerificationRepository {
  /**
   * Record or refresh one fact. The only write path: producers call this
   * after verifying against the provider, so every stored fact carries when
   * and by which authority it was verified.
   */
  record(scope: WorkspaceScope, input: RecordRepositoryAccessInput): RepositoryAccessVerification;
  get(
    scope: WorkspaceScope,
    providerInstanceId: ProviderInstanceId,
    subject: string,
  ): RepositoryAccessVerification | undefined;
}

interface VerificationRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  provider_instance_id: string;
  subject: string;
  has_access: number;
  verified_at: string;
  verified_by_source: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

function toVerification(row: VerificationRow): RepositoryAccessVerification {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    provider_instance_id: row.provider_instance_id,
    subject: row.subject,
    has_access: row.has_access === 1,
    verified_at: row.verified_at,
    verified_by_source: row.verified_by_source as RepositoryAccessVerificationSource,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

class SqliteRepositoryAccessVerificationRepository implements RepositoryAccessVerificationRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  record(scope: WorkspaceScope, input: RecordRepositoryAccessInput): RepositoryAccessVerification {
    const at = nowIso();
    const verifiedAt = input.verified_at ?? at;
    const existing = this.get(scope, input.provider_instance_id, input.subject);
    if (existing === undefined) {
      const id = newId("rav");
      this.db
        .prepare(
          `INSERT INTO repository_access_verification
             (id, enterprise_id, workspace_id, provider_instance_id, subject, has_access,
              verified_at, verified_by_source, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          scope.enterprise_id,
          scope.workspace_id,
          input.provider_instance_id,
          input.subject,
          input.has_access ? 1 : 0,
          verifiedAt,
          input.verified_by_source,
          at,
          input.actor_id,
          at,
          input.actor_id,
        );
    } else {
      // Re-verification refreshes the fact in place: the row always carries
      // the latest verified state, never a history of guesses.
      this.db
        .prepare(
          `UPDATE repository_access_verification
           SET has_access = ?, verified_at = ?, verified_by_source = ?,
               updated_at = ?, updated_by = ?
           WHERE id = ?`,
        )
        .run(
          input.has_access ? 1 : 0,
          verifiedAt,
          input.verified_by_source,
          at,
          input.actor_id,
          existing.id,
        );
    }
    const stored = this.get(scope, input.provider_instance_id, input.subject);
    if (stored === undefined) {
      throw new Error("repository access verification disappeared after write");
    }
    return stored;
  }

  get(
    scope: WorkspaceScope,
    providerInstanceId: ProviderInstanceId,
    subject: string,
  ): RepositoryAccessVerification | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM repository_access_verification
         WHERE workspace_id = ? AND enterprise_id = ? AND provider_instance_id = ? AND subject = ?`,
      )
      .get(scope.workspace_id, scope.enterprise_id, providerInstanceId, subject) as
      VerificationRow | undefined;
    return row ? toVerification(row) : undefined;
  }
}

export function createRepositoryAccessVerificationRepository(
  db: ControlPlaneDb,
): RepositoryAccessVerificationRepository {
  return new SqliteRepositoryAccessVerificationRepository(db);
}
