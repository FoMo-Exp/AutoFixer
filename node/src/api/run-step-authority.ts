/**
 * Sensitive worker-step and run-start re-authorization (DAT-285, DAT-291,
 * DAT-293, ADR-0011).
 *
 * A remediation run outlives the request that created it: the requester's
 * membership, their verified repository capabilities and the workspace's
 * repository set can all change while it is executing. The dsh grant issued at
 * creation is therefore necessary but not sufficient — every
 * `dsh_request_action` and every run start asks this policy immediately before
 * dispatch, in whichever process runs it and after any restart.
 *
 * The facts checked here are all read live from durable state, in this order:
 *
 * 1. **The run's repository set is still the one it was bound to.** The
 *    versioned set (DAT-281) makes a decision formed against set N
 *    unrepresentable against set N+1, so a binding change refuses further
 *    steps instead of continuing against a stale scope.
 * 2. **The run's immutable target is still an active binding of that version.**
 *    The binding id, provider instance, repository id and approved installation
 *    recorded on the task must all still match. A removed or transferred target
 *    ends the run; it is never resolved to another repository.
 * 3. **The target's approved checkout (and, for a multi-repository run, its
 *    delivery) capability is still available.** A withdrawn or missing
 *    credential refuses before anything is dispatched; the credential value
 *    itself stays in the DAT-203 boundary.
 * 4. **The recorded requester still holds `write` authority in the run's
 *    workspace**, evaluated through the versioned authorization context
 *    (DAT-291) when it is configured, so the decision covers the complete set
 *    and names the run's target. Suspension, membership removal, a confirmed
 *    capability loss or an unverifiable authority all deny. A confirmed loss is
 *    terminal (the run is stopped); an unverifiable state only blocks the step,
 *    so the run can continue when the same facts verify again — an outage is
 *    never recorded as a removal.
 *
 * Records persisted before the requester was recorded have nobody to
 * re-authorize. Where provider authority governs the workspace they fail
 * closed rather than falling back to the dsh grant; the identity-less
 * deployment (no integrations at all) keeps its grant-only boundary.
 */

import type { ServiceIntegrationRepository } from "../control-plane/provider-access-repositories.js";
import type { WorkspaceScope } from "../control-plane/types.js";
import { WorkspaceRepositorySetError } from "../control-plane/errors.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type { WorkspaceRepositorySet } from "../control-plane/workspace-repository-types.js";
import type {
  AuthorizationContextService,
  AuthorizationDecisionCode,
} from "../provider-access/authorization-context.js";
import type { RunStepAuthority } from "./task-service.js";
import type { RequestAuthority } from "./request-authority.js";
import type { TaskTarget } from "./task-targets.js";

export interface RunStepAuthorityDeps {
  enterpriseId: string;
  actorId: string;
  repositorySets: WorkspaceRepositorySetRepository;
  /** Live request boundary: membership, role, ceiling and freshness. */
  authority: RequestAuthority;
  /**
   * The versioned authorization context (DAT-291). When set, the requester's
   * authority is decided as one fact over the complete repository set with the
   * run's target named — the same rule the request path uses. Unset keeps the
   * pre-DAT-293 single-integration check.
   */
  contexts?: AuthorizationContextService;
  /** The workspace's integrations, for the target's credential re-check. */
  integrations?: ServiceIntegrationRepository;
  /** Clock seam for context freshness in tests. */
  clock?: () => Date;
}

/** Decision codes a dispatch denial may carry. */
function terminalFor(code: AuthorizationDecisionCode): boolean {
  switch (code) {
    case "AUTHORITY_RECHECK_REQUIRED":
      // Unknown or stale evidence: block this dispatch, let a recheck recover
      // it. Never recorded as a loss.
      return false;
    default:
      // Membership, role, target, version and capability denials are all
      // facts a retry cannot change; the run stops for human triage.
      return true;
  }
}

export function createRunStepAuthority(deps: RunStepAuthorityDeps): RunStepAuthority {
  const enterpriseScope = {
    enterprise_id: deps.enterpriseId,
    actor_id: deps.actorId,
  };

  function readSetAt(workspaceId: string, version: number): WorkspaceRepositorySet | null {
    try {
      return deps.repositorySets.getSetAtVersion(
        { ...enterpriseScope, workspace_id: workspaceId },
        version,
      );
    } catch (error) {
      if (error instanceof WorkspaceRepositorySetError) {
        return null;
      }
      throw error;
    }
  }

  /** The run's target must still be exactly this binding at this version. */
  function targetStillBound(
    set: WorkspaceRepositorySet,
    repositoryId: string,
    target: TaskTarget | null,
  ): boolean {
    if (!set.bindings.some((binding) => binding.repository_id === repositoryId)) {
      return false;
    }
    if (target === null) {
      // A record persisted before the target contract names its repository
      // only. That is the legacy shape, bounded by the set check above.
      return true;
    }
    return set.bindings.some(
      (binding) =>
        binding.id === target.binding_id &&
        binding.status === "active" &&
        binding.repository_id === target.repository_id &&
        binding.provider_instance_id === target.provider_instance_id &&
        binding.installation_ref === target.installation_ref &&
        binding.repository_id === repositoryId,
    );
  }

  /**
   * The approved checkout capability of the target, and the delivery
   * capability a multi-repository run needs. Both are proven from the live
   * integration row; neither value is read here.
   */
  function credentialRefusal(
    set: WorkspaceRepositorySet,
    target: TaskTarget | null,
  ): { allowed: false; code: string; terminal: true } | null {
    const integrations = deps.integrations;
    if (integrations === undefined || target === null) {
      return null;
    }
    const scope: WorkspaceScope = {
      ...enterpriseScope,
      workspace_id: set.workspace_id,
    };
    // No integration row at all is the local-prototype workspace: there is no
    // approved credential to require, and the legacy boundary is unchanged.
    if (integrations.listByWorkspace(scope).length === 0) {
      return null;
    }
    const integration = integrations.getByRepository(enterpriseScope, target.repository_id);
    const approved =
      integration !== undefined &&
      integration.workspace_id === set.workspace_id &&
      integration.provider_instance_id === target.provider_instance_id &&
      integration.install_status === "active" &&
      (target.installation_ref === null || integration.id === target.installation_ref);
    if (!approved) {
      return { allowed: false, code: "TARGET_INSTALLATION_NOT_APPROVED", terminal: true };
    }
    if (
      integration.checkout_credential_ref === null ||
      integration.checkout_credential_ref.trim() === ""
    ) {
      return { allowed: false, code: "CHECKOUT_CREDENTIAL_UNAVAILABLE", terminal: true };
    }
    if (
      set.multi_repository &&
      (integration.delivery_credential_ref === null ||
        integration.delivery_credential_ref.trim() === "")
    ) {
      return { allowed: false, code: "DELIVERY_CREDENTIAL_UNAVAILABLE", terminal: true };
    }
    return null;
  }

  return (input) => {
    let set: WorkspaceRepositorySet | null = null;
    if (input.repository_set_version !== null) {
      set = readSetAt(input.workspace_id, input.repository_set_version);
      if (set === null) {
        // The set moved (or became unusable): every decision formed against
        // the old version is stale. A new run binds the new version.
        return { allowed: false, code: "REPOSITORY_SET_VERSION_CONFLICT", terminal: true };
      }
      if (!targetStillBound(set, input.repository_id, input.target ?? null)) {
        return { allowed: false, code: "TARGET_REPOSITORY_UNAVAILABLE", terminal: true };
      }
    }

    const credentialCheck = set === null ? null : credentialRefusal(set, input.target ?? null);
    if (credentialCheck !== null) {
      return credentialCheck;
    }
    if (
      set !== null &&
      set.multi_repository &&
      deps.contexts === undefined &&
      deps.authority.isEnforcing(input.workspace_id)
    ) {
      // A multi-repository run cannot be authorized by a single-integration
      // check: that would read one repository's roster as the whole set's
      // authority. Without the complete-set engine the run stays blocked —
      // nothing was recorded as lost, so it can resume once the deployment
      // enforces the complete set.
      return {
        allowed: false,
        code: "AUTHORITY_RECHECK_REQUIRED",
        reason: "capability_unverified",
        terminal: false,
      };
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

    if (deps.contexts !== undefined) {
      // One evaluation over the complete set, with the run's target named and
      // the version it was bound to asserted. `evaluate` never throws for a
      // denial; an unexpected failure is a denial too.
      const decision = deps.contexts.evaluate({
        scope: { ...enterpriseScope, workspace_id: input.workspace_id },
        user_id: input.requested_by.user_id,
        action: "write",
        target:
          input.target === null || input.target === undefined
            ? null
            : {
                provider_instance_id: input.target.provider_instance_id,
                repository_id: input.target.repository_id,
              },
        ...(input.repository_set_version !== null
          ? { expected_set_version: input.repository_set_version }
          : {}),
        ...(deps.clock !== undefined ? { now: deps.clock() } : {}),
      });
      if (decision.decision.allowed) {
        return { allowed: true };
      }
      return {
        allowed: false,
        code: decision.decision.code,
        ...(decision.decision.reason !== null ? { reason: decision.decision.reason } : {}),
        terminal: terminalFor(decision.decision.code),
      };
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
