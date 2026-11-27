# Versioned authorization context (v1)

Status: **implemented for the complete-set capability intersection (DAT-291) and
wired into the protected runtime paths (DAT-294).** The
`multi_repository_workspace` rollout gate stays `disabled`, so no deployment
authorizes a multi-repository workspace in this build. DAT-293 (task target)
and DAT-294 (protected-path runtime authorization) consume this contract;
DAT-297 verifies the whole runtime. This document describes the shared context
those tasks build on.

## 1. Purpose

One evaluation answers, for exactly one member and one action:

- who the member is in the enterprise and the workspace (status, membership,
  assigned role);
- which repositories the workspace owns **now**, at which set version;
- what each repository's provider evidence proves (and how fresh it is);
- what the intersection of those proofs allows;
- whether the requested **target repository** is one of those bindings;
- and therefore whether the action may proceed, or which safe refusal applies.

Every consumer that needs repository authority should evaluate this context
rather than re-derive part of it. The rule "the intersection across **every**
active repository is the ceiling" then exists once, not once per route.

## 2. Inputs

| Input | Source | Meaning |
| --- | --- | --- |
| `scope` | server-side resolution | Enterprise + workspace. Never a client-authored tenant. |
| `user_id` | session / run record | The member the decision is about. |
| `action` | route or worker step | `read`, `stream`, `artifact_read`, `issue_sync`, `write`, `delivery`, `approval`, `manage`. |
| `target` | optional | Immutable `(provider_instance_id, repository_id)` of the repository the action touches. |
| `expected_set_version` | optional | The set version the caller observed; a mismatch is a 409 conflict. |
| `now` | optional | Freshness evaluation time (tests, replay). |

Identity facts are read from the control plane, never accepted from the
client: `app_user.status`, the enterprise membership row, the workspace
membership role, and the provider identity bound to each binding's provider
instance. Repository evidence is read from the approved installation that
observes that binding — never from names, URLs, the first repository, or the
deployment's pinned repository.

## 3. Result

```ts
interface AuthorizationContext {
  schema_version: 1;
  enterprise_id; workspace_id; user_id; action;
  enterprise: { member; user_status };
  workspace: { role; member };
  repository_authority: "not_applicable" | "verified" | "unverified" | "confirmed_loss";
  repository_set: {
    version; readable; repository_count; multi_repository;
    gate: "enabled" | "disabled" | "unreadable";
    enforced; target; version_conflict;
  };
  repositories: Array<{
    repository_id; provider_instance_id; installation_id;
    state: "verified" | "unverified" | "removed";
    capabilities; reason; verified_at; target;
  }>;
  available_capabilities; capabilities;   // verified intersection / effective ceiling
  ceiling: { state; capabilities; reason; version; verified_at; promotion_available };
  freshness: { checked_at; verified_at; fresh_window_ms; stale_after_ms; fresh };
  decision: {
    allowed; code; status; reason; capability_reason;
    requires_reconciliation; required_capability;
  };
  checked_at;
}
```

`available_capabilities` is what the providers prove right now across every
repository. `capabilities` is the *effective* set after the persisted ceiling:
a confirmed downgrade stays in force after provider recovery until an audited
administrator reapproval (`ceiling.promotion_available` reports that recovery).

`repository_set.enforced` is true only when a **multi-repository** set was
evaluated as a whole: the gate is enabled and the capability engine is
configured for complete-set enforcement. It is false for single-repository
sets (nothing needs enforcing) and for every preview.

The context is a snapshot. It is frozen, names the set version it observed, and
grants nothing by itself; a consumer evaluates again for each new action.

## 4. Decision rules

Ordered, first match wins:

| # | Rule | `code` | `status` |
| --- | --- | --- | --- |
| 1 | Account not `active` | `USER_SUSPENDED` | 403 |
| 2 | No active enterprise membership | `ENTERPRISE_MEMBERSHIP_REQUIRED` | 403 |
| 3 | Role missing or below the action policy's minimum | `WORKSPACE_ROLE_REQUIRED` | 403 |
| 4 | `expected_set_version` is not the stored version | `REPOSITORY_SET_VERSION_CONFLICT` | 409 |
| 5 | No integration row at all (local-prototype mode) | `ALLOWED` | 200 |
| 6 | Archived workspace, unsupported multi-repository shape, missing/inconsistent binding, unapproved instance/installation | `REPOSITORY_SET_UNAVAILABLE` | 403 |
| 7 | Target names no active binding, or more than one (ambiguous identity) | `TARGET_REPOSITORY_UNAVAILABLE` | 403 |
| 8 | Missing, stale, expired, partial, unsupported or unavailable evidence | `AUTHORITY_RECHECK_REQUIRED` (`requires_reconciliation: true`) | 403 |
| 9 | A verified confirmed loss (removal or no code read) | `CAPABILITY_LOSS` | 403 |
| 10 | Verified ceiling lacks the action's capability | `CAPABILITY_REQUIRED` | 403 |
| 11 | Sensitive action and the oldest verification is past the fresh/stale bound | `AUTHORITY_RECHECK_REQUIRED` | 403 |
| 12 | Required live capability grant is absent on the target (or on any binding when no target is named) | `CAPABILITY_GRANT_REQUIRED` | 403 |
| — | Otherwise | `ALLOWED` | 200 |

Rules 8 and 11 are *not* confirmed losses: they block the action for as long as
the evidence cannot be verified and clear themselves when the same facts verify
again. They never write a ceiling, a revocation or an audit decision. Rules 6
and 9 are positive states (the set is unusable, or the provider said access is
gone); only rule 9 is a persisted confirmed loss. `decision.capability_reason`
carries the precise ceiling reason (for example `no_code_read`,
`verification_expired`, `repository_set_unsupported`), which is safe to expose.

## 5. Version binding and freshness

- The context names `repository_set.version`. A caller that observed version N
  passes it as `expected_set_version`; against N+1 the decision is
  `REPOSITORY_SET_VERSION_CONFLICT` with status 409, never a stale allow.
- `isCurrent(context)` re-reads the workspace's current set version and answers
  whether the context is still bound to it. It is a cheap guard for a consumer
  that already holds a context; re-evaluating is the authoritative recheck.
- No decision is cached. Every evaluation re-reads the set, memberships,
  provider evidence and grants, so a concurrent provider change applies to the
  next action without an invalidation path. The set version alone does not
  describe evidence freshness — that is what `freshness` and a fresh
  evaluation are for.
- Sensitive actions use the **oldest** verification timestamp across all
  repositories: a freshly verified repository can never carry a stale one.

## 6. Complete-set enforcement and the rollout gate

The capability engine only evaluates a multi-repository set as a whole when it
is constructed with `multiRepositoryEnforcement: "complete"`. That setting is
not a rollout switch:

- the immutable `deployment_feature_gate` row must say `enabled`; a `disabled`
  or unreadable gate keeps the set `REPOSITORY_SET_UNAVAILABLE` regardless of
  the engine setting;
- enabling the gate is a **forward migration** in a release that enforces the
  whole set on every path (ADR-0011, `docs/contracts/workspace-repository-scope-v1.md`
  §4). This contract does not enable it, and no code path appends that row;
- a build configured `"none"` refuses every multi-repository set as an
  unsupported shape, exactly as before DAT-291.

## 7. Deliberately outside this context

The context covers enterprise/workspace identity, role, action policy, the
repository set, target, capability ceiling, freshness and capability grants.
It does **not** replace:

- security duties and separation of duties (their own contract);
- module visibility and data ceilings (`provider-access/module-capabilities`);
- object-level resource checks (a task belongs to the workspace, an issue
  belongs to the repository, an artifact belongs to the run);
- the delivery broker's own re-observation of the approving human and its
  candidate-bound grants before a provider write;
- the frontend capability projection, which stays advisory and is never
  accepted as a grant.

Those checks remain in force **in addition to** this context, never instead of
it.

## 8. Compatibility and delivery boundaries

- **Single repository:** the context reproduces the request gate's decision for
  every action class; a workspace that binds one repository keeps exactly the
  access it had.
- **Local prototype:** a workspace with zero `service_integration` rows has no
  repository authority to intersect (`repository_authority:
  "not_applicable"`). The request gate keeps its pre-existing abstention for
  that shape, so the route's own role/object checks decide; consumers that
  evaluate the context directly (run start, worker step) still apply the
  enterprise membership and action policy. Neither shape grants repository
  data.
- **No migration, no route, no field:** DAT-291 adds no schema version and no
  HTTP surface. `web/src/api/contracts/openapi.json` and generated types are
  unchanged. The task target model and its API belong to DAT-292.

### Handoff to DAT-292/293

- Persist a run's target as exactly `(provider_instance_id, repository_id)`
  plus the `repository_set_version` observed at creation. Those are
  `RepositoryTarget` and `AuthorizationContext.repository_set.version`; do not
  invent a name/URL identity or a second version field.
- Re-evaluate with `target` and `expected_set_version` before dispatch and
  before every sensitive step. An `allowed: true` context is a point-in-time
  decision, never a stored grant.
- Never fall back to another repository when the target is not an active
  binding: the context refuses with `TARGET_REPOSITORY_UNAVAILABLE`.

### Consumed by DAT-293

The run-start and worker-step boundary (`createRunStepAuthority`) now consumes
this context for every `dsh_request_action` and for a session start, with
`action: "write"`, the run's recorded `target` and the task's
`repository_set_version` as `expected_set_version`. A denial code becomes the
dispatch refusal: `AUTHORITY_RECHECK_REQUIRED` blocks only that dispatch, every
other code stops the run for human triage. The HTTP write policy is used (an
API write is task-plane mutation, not a repository delivery write), so the
check remains the whole-set `repository_write` intersection plus freshness and
the persisted ceiling. See `run-target-authority-v1.md`.

### Consumed by DAT-294

`createRequestAuthority` now decides **every** protected request through this
context when the deployment configures it: the scoped and legacy task
families, SSE (open, replay and every event), artifacts, task approvals,
messages/cancel/archive, issues and their deliveries/approvals, the
task-target read and memory. A task-shaped resource names its recorded
immutable target (a stream also asserts the task's `repository_set_version`);
an issue-shaped resource names the issue's repository, resolved to its one
active binding; a workspace-shaped action names no target and is bounded by
the whole set. The same authority is asked by the approval directory (approval
eligibility, with the set version folded into the recorded authority digest)
and by the delivery broker immediately before each provider write (the
requester's live capability on the delivery's repository). A workspace with
zero integration rows keeps the pre-existing request-gate abstention described
in §8. The boundary, its refusal envelopes and its evidence are
`protected-path-authority-v1.md`.
