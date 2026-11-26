/**
 * Sensitive worker-step re-authorization (DAT-285, ADR-0011).
 *
 * A remediation run outlives the request that created it: the requester's
 * membership, their verified repository capabilities and the workspace's
 * repository set can all change while it is executing. The dsh grant issued at
 * creation is therefore necessary but not sufficient — every
 * `dsh_request_action` asks this policy immediately before dispatch, in
 * whichever process runs it and after any restart.
 *
 * Two independent facts are checked, both read live from durable state:
 *
 * 1. **The run's repository set is still the one it was bound to.** The
 *    versioned set (DAT-281) makes a decision formed against set N
 *    unrepresentable against set N+1, so a binding change refuses further
 *    steps instead of continuing against a stale scope.
 * 2. **The recorded requester still holds `write` authority in the run's
 *    workspace.** Suspension, membership removal, a confirmed capability loss
 *    or an unverifiable authority all deny. A confirmed loss is terminal (the
 *    run is stopped); an unverifiable state only blocks the step, so the run
 *    can continue when the same facts verify again — an outage is never
 *    recorded as a removal.
 *
 * Records persisted before the requester was recorded have nobody to
 * re-authorize. Where provider authority governs the workspace they fail
 * closed rather than falling back to the dsh grant; the identity-less
 * deployment (no integrations at all) keeps its grant-only boundary.
 */

import type { WorkspaceScope } from "../control-plane/types.js";
import { WorkspaceRepositorySetError } from "../control-plane/errors.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type { RunStepAuthority } from "./task-service.js";
import type { RequestAuthority } from "./request-authority.js";

export interface RunStepAuthorityDeps {
  enterpriseId: string;
  actorId: string;
  repositorySets: WorkspaceRepositorySetRepository;
  /** Live request boundary: membership, role, ceiling and freshness. */
  authority: RequestAuthority;
}

export function createRunStepAuthority(deps: RunStepAuthorityDeps): RunStepAuthority {
  const enterpriseScope = {
    enterprise_id: deps.enterpriseId,
    actor_id: deps.actorId,
  };
  return (input) => {
    if (input.repository_set_version !== null) {
      const scope: WorkspaceScope = {
        ...enterpriseScope,
        workspace_id: input.workspace_id,
      };
      try {
        const set = deps.repositorySets.getSetAtVersion(scope, input.repository_set_version);
        // The run's target must still be one of the set's active bindings;
        // a version match alone is not a target match.
        if (!set.bindings.some((binding) => binding.repository_id === input.repository_id)) {
          return { allowed: false, code: "REPOSITORY_BINDING_MISSING", terminal: true };
        }
      } catch (error) {
        if (!(error instanceof WorkspaceRepositorySetError)) {
          throw error;
        }
        // The set moved (or became unusable): every decision formed against
        // the old version is stale. A new run binds the new version.
        return { allowed: false, code: error.code, terminal: true };
      }
    }
    if (input.requested_by === null) {
      return deps.authority.isEnforcing(input.workspace_id)
        ? { allowed: false, code: "AUTHORITY_RECHECK_REQUIRED" }
        : { allowed: true };
    }
    if (input.requested_by.kind === "deployment") {
      // The deployment's own credential is not a provider subject; provider
      // membership never governed it (ADR-0006's local-operator mode).
      return { allowed: true };
    }
    const decision = deps.authority.check(input.requested_by.user_id, "write", input.workspace_id);
    if (decision.allowed) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: decision.requires_reconciliation ? "AUTHORITY_RECHECK_REQUIRED" : "FORBIDDEN",
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      // A confirmed loss ends the run; an unverifiable state only blocks the
      // dispatch, so the run can resume when the facts verify again.
      terminal: decision.requires_reconciliation !== true,
    };
  };
}
