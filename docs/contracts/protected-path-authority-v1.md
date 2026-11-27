# Protected-path runtime authorization v1 (DAT-294)

Every protected HTTP path of a provider-backed workspace decides one request
from **one** versioned authorization context: the enterprise membership, the
assigned workspace role, the action policy, the workspace's complete active
repository set at its current version, the repository the resource belongs to,
and the observed version. This document describes the wiring added by DAT-294
on top of the DAT-291 context (`authorization-context-v1.md`) and the DAT-293
run target (`run-target-authority-v1.md`), the refusals a client sees, and what
is deliberately still refused.

It is not a rollout. The shipped deployment keeps `multiRepositoryEnforcement`
and `multiRepositoryRuntime` at their refusing defaults and the immutable
`multi_repository_workspace` gate at `disabled`; a multi-repository workspace
therefore still denies on every path. Nothing here enables that gate.

## 1. The request boundary

`createRequestAuthority` (`node/src/api/request-authority.ts`) is the single
request gate. When the deployment configures the versioned context, every
decision is `contexts.evaluate(...)` over the **complete** active set — never
the single-integration access gate and never a per-route re-derivation. A
workspace with **zero** `service_integration` rows has no repository authority
to intersect (ADR-0006 local-prototype shape), so the gate keeps its
pre-existing abstention and the route's own role/object checks decide; the
context reports that shape as `repository_authority: "not_applicable"` for its
other consumers.

`actionForRequest` maps method and path to the closed action vocabulary, and
the resource's repository is attached before the decision:

| Surface | Action(s) | Scope the decision names |
| --- | --- | --- |
| `GET /tasks`, `GET /tasks/{id}`, `/runs`, `/timeline` | `read` | The task's recorded immutable target (workspace-wide for a list or a pre-DAT-292 record without one). |
| `POST /tasks` | `write` | The workspace set; the create's selected target is then resolved and re-checked by the DAT-292/293 resolver before anything is materialized. |
| `GET /tasks/{id}/stream` | `stream` | The task's target **and** the `repository_set_version` recorded on the task, as `expected_set_version`. |
| `GET /tasks/{id}/artifacts/{artifact_id}` | `artifact_read` | The task's target. |
| `POST /tasks/{id}/messages`, `/cancel`, `/archive`, `/recover` | `write` | The task's target. |
| `POST /tasks/{id}/approvals` | `approval` | The task's target. |
| `GET /workspaces/{id}/issues`, `GET /issues/{id}`, nested reads | `read` | The issue's own repository, resolved to its one active binding (workspace-wide for the list). |
| `POST /workspaces/{id}/issues` | `issue_sync` | The workspace set (a new issue has no prior repository target; the whole-set intersection bounds it). |
| `POST /issues/{id}/comments`, `/rollback`, `PATCH /issues/{id}` | `issue_sync` | The issue's repository. |
| `POST /issues/{id}/approvals`, `/deliveries`, `/deliveries/{id}/reconcile` | `delivery` | The issue's repository. |
| `POST /issues/{id}/approvals/{approval_id}/decision` | `approval` | The issue's repository. |
| `GET /workspaces/{id}/issues/{id}/stream` | `stream` | The issue's repository. |
| `GET /workspaces/{id}/memory/**` | `read` / `write` | The workspace set (no single target). |
| `GET /workspaces/{id}/task-targets` | `read` | The workspace set. |
| legacy `/api/v1/tasks**` | same as the scoped family | The task's target in the deployment's workspace. |

A resource whose repository is not an active binding of the current set is
**refused**, never downgraded to a workspace-wide decision: an issue, a
delivery or a task bound to a repository that was removed from the set stops
authorizing that resource with `TARGET_REPOSITORY_UNAVAILABLE`
(`details.reason: "target_repository"`). Two bindings matching one repository
identity are ambiguous and refused the same way.

The worker-step and run-start boundary is the same engine with the run's
recorded target and version (`run-target-authority-v1.md`); a run created
before a set change is refused with `REPOSITORY_SET_VERSION_CONFLICT` instead
of executing under the old scope.

## 2. Subscriptions and SSE

A stream is a protected path at open, during replay, and on every event:

- Opening and committing the replay call `require` with the task's target and
  the version the subscription was opened against. A set change makes the
  observed version stale: the stream is refused `409
  REPOSITORY_SET_VERSION_CONFLICT` and replays no history.
- Each replayed event, each live event and each authority-epoch signal
  re-evaluates the same decision. Any denial ends the stream instead of
  emitting under a scope the caller no longer holds. The epoch is a fast local
  close signal only; the re-read of shared storage is the boundary, so a
  change persisted by another process applies here too.
- `Last-Event-ID` selects a replay position, never an authorization. An
  unknown id replays from the start, and a read-only or lost authority denies
  the whole subscription rather than resuming partial history.

## 3. Approvals and delivery

- **Approval eligibility** (`createApprovalDirectory`) re-observes live facts
  at decision time: the issue's repository roster fact *and* the workspace-wide
  intersection for the `approval` action named against that repository. An
  admin who kept repository write on the issue's repository but lost it on
  another repository is not an eligible approver for either. The recorded
  approval authority digest includes the workspace's `repository_set_version`,
  so a decision formed under one set is distinguishable from one formed under
  another; the digest never becomes a stored grant.
- **Delivery** records `requester_authorized` when the delivery is requested,
  but a recorded boolean is not a durable fact. Immediately before **every**
  provider write, `createDeliveryPermission` re-checks the delivery's own
  repository and asks the live requester capability through the same request
  authority (`delivery` action, `repository_id` = the delivery's repository).
  A confirmed reduction on any repository, a target that left the set, a
  revoked/expired delivery grant, a suspended installation or workspace all
  refuse the write. The deployment's `local-operator` credential keeps its
  pre-existing mode unchanged.

## 4. Refusals over HTTP

The context's stable decision code is internal; the HTTP envelope stays inside
the existing error vocabulary:

| Envelope | When | `details` |
| --- | --- | --- |
| `409 REPOSITORY_SET_VERSION_CONFLICT` | `expected_set_version` (or a stream's recorded version) is not the stored version | `action`, `reason: "repository_set_version"` |
| `403 AUTHORITY_RECHECK_REQUIRED` (`next_action: reconcile`) | Unknown/stale/expired evidence, persistence failure, or a set-level refusal (archived workspace, unsupported shape, missing/inconsistent binding, unapproved instance/installation) | `action`, `reason`, `capability_reason` |
| `403 FORBIDDEN` (`next_action: request_review`) | Suspended account, missing enterprise membership or workspace role, target repository unavailable, confirmed capability loss, missing capability, missing capability grant | `action`, `reason`, optional `capability_reason` |

`reason` is the shared access-decision vocabulary (`enterprise_membership`,
`user_suspended`, `workspace_role`, `target_repository`, `capability_unverified`,
`capability_loss`, `capability_ceiling`, `authority_unknown`, `authority_stale`,
`verification_stale`, `capability_persistence`); `capability_reason` is the
precise ceiling reason (for example `repository_set_unsupported`,
`no_code_read`, `verification_expired`). Both are safe to expose and contain no
credential, teammate data or provider internals.

An unknown, stale or unavailable authority is **not** a recorded loss: it
blocks for its duration, records nothing, and clears itself when the same facts
verify again. Only a positively confirmed loss persists (and never auto-raises
on recovery).

## 5. Invalidation

Nothing is cached, so there is no invalidation path to miss:

- a set change, transfer or removal applies to the next request in every
  process without a local signal;
- an open subscription re-checks on every event and on the shared epoch, and
  refuses replay under a stale version;
- an approval is re-derived from live facts at decision time and its digest is
  bound to the set version;
- a delivery re-checks the requester immediately before each provider write;
- a run start or worker step re-checks the recorded target at the recorded
  version (DAT-293).

The frontend capability projection remains an **advisory navigation snapshot**.
It is never accepted as a credential: every request is decided again from the
server-side facts, and a projection read before a revocation grants nothing.

## 6. Enforcement configuration

Complete-set evaluation requires both:

1. the build to be configured with `multiRepositoryEnforcement: "complete"`
   (and the set repository with `multiRepositoryRuntime: "complete"`), and
2. the immutable `deployment_feature_gate` row `multi_repository_workspace` to
   be `enabled` (a forward migration, never an operator toggle).

The shipped deployment passes neither, so a multi-repository workspace stays
refused on every path (`403 AUTHORITY_RECHECK_REQUIRED`,
`capability_reason: "repository_set_unsupported"`) while a single-repository
workspace keeps exactly its previous behavior. Enabling the gate remains the
release decision described in
[multi-repository-rollout-gate-v1.md](../multi-repository-rollout-gate-v1.md);
DAT-294 does not make it.

## 7. Evidence

| Test | Covers |
| --- | --- |
| `node/test/protected-path-authority.test.ts` | Real HTTP over a two-repository workspace in complete-set mode: intersection on tasks/approvals/delivery/memory/issues, targeted task reads/streams/artifacts/cancel/messages, the legacy seam, SSE `Last-Event-ID` replay refused with 409, a live stream closed by a set change, a target that left the set, unavailable evidence and its recovery, the advisory projection not being a credential, restart, a change persisted by another process, and concurrent requests during a set change. |
| `node/test/protected-path-collab-authority.test.ts` | Approval eligibility as the whole-set intersection named against the issue's repository, a target that left the set, the digest bound to the set version, and the per-write delivery requester check on the delivery's repository (including a reduction on another repository and `local-operator` mode). |
| `node/test/runtime-authority.test.ts`, `run-target-dispatch.test.ts` | The same context at run start and worker steps (DAT-293). |
| `node/test/repository-set-change-http.test.ts` | The DAT-288 full-chain refusals still hold on the shipped configuration. |

No API route, request field or response field changed, no database migration
was added, and `web/src/api/contracts/openapi.json` regenerates identically.
The only new client-observable behavior is the `409` refusal on a stale-version
stream open and the `details` reason vocabulary above, both inside the existing
error envelope.
