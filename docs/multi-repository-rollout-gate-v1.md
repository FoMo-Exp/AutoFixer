# Multi-repository rollout gate (v1)

Status: **closed. DAT-288 verified the decision path end to end and found the
runtime enforcement path missing; the gate must not be enabled in this build.**

This document records the DAT-288 acceptance run under ADR-0011, the evidence
for each of its eight criteria, the blockers that prevent a controlled opening,
and the preconditions, rollout, rollback and audit plan a later, separately
authorized change must satisfy. It is not an implementation of multi-repository
execution and it does not change any deployment gate.

Baseline: `main` at `322b755` (DAT-287). The acceptance suite added by this
change is `node/test/repository-set-change-http.test.ts` §
`full-chain acceptance gate (DAT-288)`.

> **DAT-291 update (2026-11-27).** The complete-set capability intersection and
> the versioned authorization context now exist
> (`node/src/provider-access/authorization-context.ts`,
> [authorization-context-v1.md](contracts/authorization-context-v1.md)). The
> engine evaluates a multi-repository set only when the immutable gate is
> `enabled` **and** the deployment is configured for complete-set enforcement;
> the shipped configuration still refuses, the gate stays `disabled`, and no
> route, stream, artifact, approval, memory, worker step or delivery path
> consumes the context yet. The findings and blockers below are therefore still
> in force: the gate must not be enabled in this build.

> **DAT-296 update (2026-11-28).** Forward-version protection is now enforced
> on every authority read (not only at process start), an unknown repository
> binding state refuses the whole set, and every authorization refusal on a
> protected path or worker step appends an immutable `authorization.denied`
> record to the storage-append-only `auth_audit`. An admin/owner can read
> build/database/gate/set versions, their own evidence freshness and a bounded
> denial trend at `GET /api/v1/workspaces/{id}/authorization-status` — even
> while authority is unverified. See
> [contracts/mixed-version-audit-observability-v1.md](contracts/mixed-version-audit-observability-v1.md).
> This closes the code side of blockers 5 and 6; the real rolling-upgrade
> rehearsal and the release decision remain open, and nothing here enables the
> gate.

> **DAT-294 update (2026-11-28).** Every protected runtime path now consumes
> that context
> ([protected-path-authority-v1.md](contracts/protected-path-authority-v1.md)):
> the request boundary (scoped and legacy task families), SSE open/replay/every
> event, artifacts, task approvals, messages, issues and their
> deliveries/approvals, memory, the task-target read, run starts and worker
> steps. A resource is decided against its own target and, for a stream, the
> set version it observed; approvals re-derive the whole-set intersection and
> fold the set version into the recorded authority digest; the delivery broker
> re-checks the requester's live capability on the delivery's repository before
> every provider write. Blocker 1 below is therefore implemented in code, but
> rollout is **still closed**: the shipped configuration keeps
> `multiRepositoryEnforcement` / `multiRepositoryRuntime` at `none` and the gate
> row at `disabled`, so a multi-repository workspace still refuses on every
> path. Blockers 2–5 (removal/rollback path, real deployment evidence,
> mixed-version rehearsal) and the release decision in §7 remain.

## 1. What was verified

The repository-addition decision (DAT-283/284/286/287) is complete and safe:
preview, explicit confirmation of the exact reductions, atomic audited commit,
last-effective-owner protection, unknown-evidence refusal, tenant isolation,
and stale/concurrent rejection. The frontend consumes the merged OpenAPI
contract and real captured fixtures.

What is **not** implemented is a runtime that can operate a multi-repository
workspace. `WorkspaceRepositorySetRepository.getSet` reports
`MULTI_REPOSITORY_SCOPE_UNSUPPORTED` for every set with more than one active
binding, and the request gate turns that into an unverified capability ceiling
for **every member, including every owner**. Fail-closed is correct, but it is
also a total outage for that workspace, and no path exists to undo the commit:

| Fact                                                                                 | Where                                                         | Consequence                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| A multi-repository set is always `usable: false`                                     | `node/src/control-plane/workspace-repository-repositories.ts` | Every request, stream, worker step and delivery denies            |
| The ceiling has no multi-repository authorization state                              | `node/src/provider-access/capability-ceiling.ts`              | All modules report `data_ceiling: "none"`, `capabilities: []`     |
| Task creation requires exactly one binding and the deployment's pinned base revision | `node/src/api/workspace-bindings.ts`                          | There is no target-repository binding for a run                   |
| A second addition cannot even be previewed after the first commit                    | verified by this change                                       | The manager's own ceiling is unverified                           |
| `addBinding` / `removeBinding` always refuse                                         | `node/src/control-plane/workspace-repository-repositories.ts` | No API path returns a workspace to one binding                    |
| The gate is append-only and enabled only by a forward migration                      | `docs/contracts/workspace-repository-scope-v1.md` §4          | Enabling is a one-way deployment decision, not an operator toggle |

Committing a second repository therefore deauthorizes the whole workspace and
leaves no supported way back. That makes "enable the gate and add a repository"
today a self-inflicted outage, not a rollout. The gate stays closed.

## 2. The eight acceptance criteria

Each row names the test that is the evidence. Run:

```
cd node
npx vitest run test/repository-set-change-http.test.ts test/repository-set-change.test.ts \
  test/runtime-authority.test.ts test/capability-ceiling.test.ts test/workspace-repository-set.test.ts
```

| #   | Criterion                                                                                                                        | Evidence (all passing)                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Confirmed loss of code read rejects the whole addition; unknown is never recorded as a removal                                   | `refuses the whole addition when a member would lose verified code read`; `refuses the whole addition when a member's evidence is unknown`; domain `repository-set-change` admission tests                                                                 |
| 2   | A verified reduction may proceed only after an exact, informed preview and explicit confirmation; the assigned role is preserved | `confirms the exact reduction and commits the bindings atomically`; `refuses a confirmation that does not acknowledge the exact reductions`                                                                                                                |
| 3   | The last effective owner is protected even when everyone retains read                                                            | `protects the last effective owner even when everyone still reads`; `commitBlockedReasons` / `LAST_EFFECTIVE_OWNER_MISSING` domain tests                                                                                                                   |
| 4   | Missing, stale, expired, incomplete or ambiguous evidence fails closed and blocks confirmation                                   | `refuses the whole addition when a member's evidence is unknown`; `refuses the whole addition when a member's evidence has expired`; `capability-ceiling` unverified tests                                                                                 |
| 5   | A stale preview, changed facts, expired or consumed confirmation, and concurrent commits can never commit                        | `refuses a stale confirmation and requires a fresh preview after facts change`; `refuses a consumed confirmation and a stale set version`; `serializes concurrent commits: one addition commits and the other is stale`; `refuses an expired confirmation` |
| 6   | Required audit and the whole mutation commit or roll back atomically                                                             | `refuses a commit whose required audit cannot be written, committing nothing`; domain transaction/audit tests                                                                                                                                              |
| 7   | Another tenant cannot read the set, enumerate the workspace, or use a confirmation                                               | `another tenant and an unknown workspace never expose the set or its preview`; `does not enumerate workspaces the caller is not a member of`; domain `repository-set change scope isolation`                                                               |
| 8   | After the commit, every legacy and current path refuses the set; a restart and a mixed-version process cannot bypass it          | `the committed set denies every protected path before and after a restart`; `a worker step bound to the old set is terminal, and the new set grants nothing`; `an older build or a newer rollout decision refuses to establish authority`                  |

## 3. Full-chain matrix

The closure test drives real HTTP with a real control-plane database and a real
login session, before and after `AuthApp.restart()`:

| Surface                                                       | Result                                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace capability projection                               | `200`, `state: "unverified"`, `blocked_reason: "repository_set_unsupported"`, no ceiling, no action allowed                                           |
| Tasks read / create / detail                                  | `403 AUTHORITY_RECHECK_REQUIRED`                                                                                                                      |
| SSE stream (`Last-Event-ID` replay path shares the same gate) | `403 AUTHORITY_RECHECK_REQUIRED`                                                                                                                      |
| Artifact read                                                 | `403 AUTHORITY_RECHECK_REQUIRED`                                                                                                                      |
| Approval, message/steer                                       | `403 AUTHORITY_RECHECK_REQUIRED`                                                                                                                      |
| Issues read and delivery/approval request                     | `403 AUTHORITY_RECHECK_REQUIRED`                                                                                                                      |
| Legacy `/api/v1/tasks` seam                                   | `403 AUTHORITY_RECHECK_REQUIRED`                                                                                                                      |
| Worker step (`dsh_request_action` policy)                     | old set version → terminal `REPOSITORY_SET_VERSION_CONFLICT`; current set → `AUTHORITY_RECHECK_REQUIRED`, `capability_unverified`, nothing dispatched |
| Process restart                                               | identical refusals; set version 2 and both bindings re-read from storage                                                                              |
| Older build / newer gate row                                  | `SchemaVersionMismatchError` / `FEATURE_GATE_UNREADABLE`; authority is never established                                                              |
| Another tenant                                                | `NOT_FOUND`; no rows, no preview, no confirmation                                                                                                     |

The existing DAT-276/285 suites additionally cover live-stream closure on an
authority epoch change and the delivery broker re-observing the approving human
on every provider write. The commit bumps the shared epoch, so a stream opened
before the addition is closed by the same signal; the closure test proves the
next subscription is refused.

## 4. Frontend and real-deployment evidence

- The three addition endpoints are in the merged OpenAPI (`0.10.0`), the
  generated types, `web/CONTRACT.md` (DAT-287 section), and the web panel.
- `docs/fixtures/repository-set-api-v1/*.json` are real responses captured from
  the service and validated against closed OpenAPI schemas by
  `node/test/repository-set-fixtures.test.ts`; the web panel test consumes the
  same fixtures. No invented field is present.
- **Blocked:** a real deployment with a real enterprise OAuth application,
  enterprise directory, and browser preview/confirm/commit was not available to
  this run. The in-repo OAuth provider is scripted, so it cannot stand in for
  that evidence. A release owner must perform and attach that run before any
  opening decision. This is reported, not substituted.

## 5. Blockers to a controlled opening

1. **Multi-repository runtime enforcement on the protected paths —
   implemented (DAT-294), not enabled.** The ceiling engine (DAT-291), the task
   target and its dispatch re-check (DAT-293) and the request boundary
   (DAT-294) now decide every protected path from the complete set, the
   resource's target and the observed version
   ([protected-path-authority-v1.md](contracts/protected-path-authority-v1.md)).
   The code path is only active in a build configured for complete-set
   enforcement while the immutable gate is `enabled`; the shipped deployment
   keeps the refusing defaults, so a multi-repository workspace still denies
   everywhere. Enabling remains a separate release decision (§6, §7).
2. **Target binding exists; the shape stays closed.** `workspace-bindings.ts`
   now has a runtime resolver (DAT-293) that selects one active binding by
   immutable identity at the observed set version, resolves a provider-verified
   trusted baseline through the target's approved checkout capability, and
   requires its delivery capability for a multi-repository run; the contract is
   `docs/contracts/run-target-authority-v1.md`. Because the build's
   `multiRepositoryRuntime` stays `none` in the deployment and the gate row
   stays `disabled`, a multi-repository set still refuses creation —
   `MULTI_REPOSITORY_SCOPE_DISABLED` / `MULTI_REPOSITORY_SCOPE_UNSUPPORTED`.
3. **No removal or rollback path.** `removeBinding` is an unconditional refusal,
   so an enabled multi-repository workspace cannot be returned to one repository
   through the API.
4. **Real deployment evidence outstanding.** See §4.
5. **Mixed-version operation is proven in-process, not against a real
   deployment.** DAT-296 added a per-authority-read schema guard (a rolling
   deploy cannot leave an older build silently serving newer state), an unknown
   binding-state refusal, and an append-only audit of every refusal. The
   production rolling-upgrade sequence (old build, new build, forward
   migration, rollback) has still not been rehearsed against a real deployment;
   a build predating the guard cannot be retrofitted and must not be left
   serving across a migration.

## 6. Preconditions for a later opening change

A separate, independently reviewed change must satisfy all of the following.
This document does not authorize any of them.

1. **Complete-set authorization.** Replace the unconditional multi-repository
   refusal with an intersection over every active binding for every action
   class; keep `unverified` for genuinely unknown evidence, not for a known
   unsupported shape.
2. **Explicit task target.** A run binds one active repository of the
   workspace, with its own base revision, checkout credential and delivery
   credential; the workspace-wide capability intersection still bounds every
   action. No "first repository" fallback. DAT-293 implements this for
   creation, run start and worker steps; the remaining protected paths are
   DAT-294.
3. **All consumers.** Request, SSE (including replay), artifacts, worker steps,
   delivery, issue sync, memory and approvals re-check the set version and the
   target; a set change invalidates old decisions across processes. DAT-294
   implements this for every listed path
   ([protected-path-authority-v1.md](contracts/protected-path-authority-v1.md));
   DAT-297 verifies the whole runtime before any opening decision.
4. **Removal and rollback.** An audited removal path, with the same last-owner,
   evidence, preview/confirmation and audit rules as addition, and an explicit
   statement that removal never auto-promotes a reduced ceiling.
5. **Evidence.** The full acceptance suite below runs green against a real
   deployment: OAuth login, enterprise directory, two providers, preview,
   confirmation, commit, then every path on the new set; process restart;
   mixed-version (old build refuses the new schema/gate row).
6. **Observability — implemented (DAT-296), alert policy outstanding.**
   Audit events, denial reasons, gate/schema/set versions and evidence
   freshness are queryable through
   `GET /api/v1/workspaces/{id}/authorization-status` (admin/owner) and the
   append-only `auth_audit`; the bounded denial trend groups by safe code,
   action and capability reason. A deployment-specific alert threshold for
   unexpected `MULTI_REPOSITORY_SCOPE_*` / `capability_unverified` /
   `schema_version_unsupported` rates remains release configuration.

## 7. Controlled rollout (after preconditions)

1. Ship the enforcement build with the gate still disabled; verify all
   single-repository behavior is unchanged.
2. Enable only by appending a `deployment_feature_gate` row with
   `state = 'enabled'` and `min_schema_version` equal to the forward migration
   that introduces enforcement. Never `UPDATE`, never an environment variable,
   never a UI toggle; the table's triggers already forbid updates and deletes.
3. Internal staging workspace with two repositories of one enterprise. Exercise
   preview, confirmation, commit, every surface in §3, a restart, and the
   rollback rehearsal.
4. Canary one designated tenant; observe denial/audit dashboards and
   reconciliation state. Then a named pilot group. No global enable in the same
   step.
5. Keep the feature off for every workspace that has not been explicitly
   onboarded with a preview and confirmation.

## 8. Rollback

The gate is append-only, so rollback is a forward migration too:

1. Deploy a build that understands the current schema and still enforces it.
   An older binary refuses the newer database (`SCHEMA_VERSION_UNSUPPORTED`) —
   that refusal is the mixed-version protection, not a rollback.
2. While the gate is still enabled and enforcement is running, reduce affected
   workspaces to one binding through the audited removal path (precondition 4).
   Closing the gate while a workspace still has two bindings makes that whole
   workspace deny for every member, including owners.
3. Append a `disabled` gate row with a reason and the operator identity. Do not
   delete bindings, audit rows, confirmations or ceilings.
4. A reduced ceiling stays reduced: closing the gate never promotes access.
   Reopening later requires fresh preview/confirmation against the then-current
   facts.

If a build that cannot enforce a multi-repository set is ever started against a
database whose gate is enabled, it must keep refusing
(`MULTI_REPOSITORY_SCOPE_UNSUPPORTED`). That is the current safe failure and it
must not be weakened to make a rollout look green.

## 9. Audit plan

- `repository_set.addition_confirmed` and `repository_set.addition_committed`
  record actor, workspace, confirmation, set versions, immutable repository
  identities, affected members and reductions. No URL, name or credential is
  stored.
- A confirmation is consumed exactly once; replay, expiry, changed facts and
  concurrent commits are refused without a partial write.
- Gate rows record state, reason, deciding schema and author; they are
  immutable and append-only.
- Opening and rollback decisions are deployment-wide audited events; retain the
  gate history and the acceptance evidence with the release record.
