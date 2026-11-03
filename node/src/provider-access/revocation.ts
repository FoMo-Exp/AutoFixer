/**
 * Authority revocation (DAT-203).
 *
 * When source authority is lost — provider removal event, reconciliation
 * diff, or an administrator decision — revocation is one atomic operation:
 *
 * 1. The subject's authority becomes `removed`, which denies read, stream,
 *    artifact, approval, and write from the same request path on.
 * 2. Every live capability grant (checkout read, delivery write) is revoked.
 * 3. The authority epoch is bumped so no cached allow decision survives.
 *
 * Everything else (stopping affected executions) consumes the returned
 * {@link RevocationEffects}; the revocation itself never depends on a cache,
 * a timer, or a background job.
 */

import type { CapabilityKind } from "../control-plane/provider-access-types.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type { UserId, WorkspaceScope } from "../control-plane/types.js";
import type { AuthorityEpoch } from "./access-gate.js";
import { ACTION_KINDS, type ActionKind } from "./types.js";

export interface RevocationTarget {
  integration_id: string;
  subject: string;
  user_id?: UserId | null;
}

export interface RevocationEffects {
  integration_id: string;
  subject: string;
  user_id: UserId | null;
  /** Every action class revocation stops — all five, always. */
  stopped_actions: readonly ActionKind[];
  revoked_grants: readonly { id: string; capability: CapabilityKind }[];
  authority_state: "removed";
  at: string;
}

/**
 * Revoke one subject's repository authority and capability grants.
 * Idempotent: re-revoking an already-removed subject revokes nothing new.
 */
export function revokeAuthority(
  access: ProviderAccessRepositories,
  epoch: AuthorityEpoch,
  scope: WorkspaceScope,
  target: RevocationTarget,
  reason: string,
  at: string,
): RevocationEffects {
  // 1. Authority becomes `removed` — every action class denies from here on.
  access.roster.setAuthorityState(scope, target.integration_id, target.subject, "removed", at);

  // 2. Revoke live capability grants (checkout read, delivery write).
  const userId =
    target.user_id !== undefined
      ? target.user_id
      : (access.roster.getAuthority(scope, target.integration_id, target.subject)?.user_id ?? null);
  const revoked: { id: string; capability: CapabilityKind }[] = [];
  if (userId) {
    const live = access.grants.listLive(scope, target.integration_id, {
      grantee_user_id: userId,
      now: at,
    });
    for (const grant of live) {
      access.grants.revoke(scope, grant.id, reason, at);
      revoked.push({ id: grant.id, capability: grant.capability });
    }
  }

  // 3. Kill every cached decision in the same call — the next authorize in
  //    this or any other request path recomputes and denies.
  epoch.bump();

  return {
    integration_id: target.integration_id,
    subject: target.subject,
    user_id: userId,
    stopped_actions: ACTION_KINDS,
    revoked_grants: revoked,
    authority_state: "removed",
    at,
  };
}
