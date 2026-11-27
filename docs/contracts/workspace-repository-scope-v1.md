# Workspace repository set and multi-repository gate (v1)

Status: **storage and read boundary implemented; repository-addition decision
implemented behind the gate; whole-set authorization engine implemented and
wired into every protected runtime path (DAT-294); multi-repository scope not
usable.** Implements DAT-281, with
DAT-283/284/286 adding the member-admission, audited-commit and HTTP
preview/confirm/commit surfaces. DAT-291 adds the versioned authorization
context and the complete-set capability intersection
([authorization-context-v1.md](authorization-context-v1.md)); DAT-294 wires
that context into the request boundary, SSE, artifacts, approvals, messages,
issues, memory, worker steps and delivery
([protected-path-authority-v1.md](protected-path-authority-v1.md)). Neither
change enables the gate: the shipped deployment keeps the refusing defaults,
so every multi-repository scope still fails closed until a release configures
complete-set enforcement and appends the enabled gate row. This contract
describes what exists, what is refused, and how a later release may turn the
capability on. DAT-288 recorded the acceptance evidence and remaining blockers
in [multi-repository-rollout-gate-v1.md](../multi-repository-rollout-gate-v1.md).

## 1. Model

A workspace owns a **versioned set** of repository bindings
(`workspace_repository_binding`, schema v20). One binding is:

| Field                  | Meaning                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `enterprise_id`        | Tenant scope. Every read is filtered by it, never by a client-supplied value. |
| `workspace_id`         | Owning workspace.                                                             |
| `provider_instance_id` | Administrator-approved provider instance of that enterprise.                  |
| `installation_ref`     | Approved, repository-scoped **active** server integration (`service_integration.id`). |
| `repository_id`        | Immutable provider-assigned repository identity. URLs and names are metadata. |
| `position`             | 1-based order; position 1 is the workspace's legacy binding.                  |
| `status`               | `active` or `retired` (retired while its workspace is archived).              |

Constraints, all enforced by storage rather than convention:

- `UNIQUE (workspace_id, provider_instance_id, repository_id)` — one workspace
  binds one repository once.
- `(enterprise_id, provider_instance_id, repository_id)` is unique among rows
  with `status = 'active'` — inside one enterprise a repository is bound
  actively by at most one workspace. Archiving retires the bindings so a
  repository is not blocked by history; ADR-0006's
  one-active-workspace-per-enterprise-and-repository rule stays in force.
- `workspace.repository_set_version` — the optimistic-concurrency token for the
  whole set, incremented by a repository transfer. An access decision formed
  against version _N_ is refused against version _N+1_.
- Workspace lifecycle and its bindings commit together: `archive` retires the
  bindings and `restore` reactivates them in the same transaction as the
  workspace status, so a crash cannot leave an archived workspace holding the
  repository or an active workspace whose bindings are still retired.

`workspace.repository_id` / `provider_instance_id` remain: they are the
deployment's pinned single-repository binding and the values the running
single-repository code paths use. While the gate is closed, a set that
disagrees with them is reported as `REPOSITORY_BINDING_INCONSISTENT`, never
resolved in favour of either side.

## 2. Reads

`createWorkspaceRepositorySetRepository(db)` provides:

- `getSet(scope)` — the validated set: `bindings`, `set_version`,
  `multi_repository`, `usable`, `blocked_reason`, `gate`.
- `getSetAtVersion(scope, version)` — the same, only if the set is still at the
  caller's observed version.
- `requireSingleRepository(scope)` — the only shape authorization may consume
  today: exactly one verified binding. This is what the workspace-scoped run
  binding (task creation, issue sync) uses.
- `listBindings(scope)` — storage rows for audits; grants nothing.
- `currentSetVersion(scope)`.

Every read verifies each binding against live `provider_instance` and
`service_integration` rows in the same enterprise and workspace, and an
installation reference counts only while `install_status = 'active'` — a
suspended integration fails closed exactly as it does in the request-authority
gate. Reads never retry, degrade, or fall back to a configured repository.

"A binding with no installation reference" is decided by the same existence
rule the request gate uses, not by the reference being null:

| Integration rows in the workspace | Binding reference | Result |
| --------------------------------- | ----------------- | ------ |
| none                              | null              | local-prototype mode (ADR-0006); the set is usable |
| any (`active`, `suspended`, `uninstalled`) | null or not the matching active one | `INSTALLATION_NOT_APPROVED` |
| any                               | the matching `active` installation | usable |

A workspace whose only integration is suspended or uninstalled therefore
refuses everything rather than silently reverting to prototype mode, which is
what the request-authority gate already enforces.

Because the order "create workspace, then register the integration" is normal,
registering an `active` installation for a repository — and reactivating a
suspended one — re-links the same repository's binding to it
(`linkWorkspaceBindingInstallation`, inside the caller's transaction). This is
registration bookkeeping: the enterprise, provider instance and immutable
repository identity do not change, so no authority is expanded. A binding that
already points at an `active` installation is left alone.

Consumers must use the value these reads return, not an earlier workspace
snapshot: `requireSingleRepository` reports the verified binding and the set
version it was validated at, and the legacy run-binding resolver re-reads the
set at that version before dispatch. A repository transfer that commits during
resolution therefore causes `REPOSITORY_SET_VERSION_CONFLICT` instead of a run
against the pre-transfer repository.

## 3. Fail-closed refusals

| Code                                 | When                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `REPOSITORY_BINDING_MISSING`         | Workspace has no active binding (or a transfer found none).                                        |
| `REPOSITORY_BINDING_INCONSISTENT`    | Binding disagrees with the workspace's immutable identity, or has no repository id.                |
| `REPOSITORY_BINDING_UNAPPROVED`      | Binding names a provider instance the enterprise has not approved.                                 |
| `INSTALLATION_NOT_APPROVED`          | `installation_ref` is unknown, belongs to another workspace/repository, or was uninstalled.        |
| `REPOSITORY_SET_VERSION_CONFLICT`    | The caller observed an older set version.                                                          |
| `WORKSPACE_ARCHIVED`                 | The workspace is archived; its retired set authorizes nothing.                                     |
| `MULTI_REPOSITORY_SCOPE_DISABLED`    | More than one active binding while the gate is `disabled`.                                         |
| `MULTI_REPOSITORY_SCOPE_UNSUPPORTED` | More than one active binding while the gate is `enabled` but this build has no enforcement for it. |
| `SCOPE_MUTATION_DISABLED`            | The storage-layer `addBinding` / `removeBinding` helpers, or a change attempted while the gate is disabled. The supported addition path is the preview/confirm/commit API, and it refuses while the gate is closed. |
| `FEATURE_GATE_UNREADABLE`            | Gate row missing, malformed, or decided by a newer schema.                                         |

A refusal is an authorization outcome (403) or a binding/version fact (409). It
is never rewritten into a generic failure, and its details carry no repository
URLs, credentials or other tenants' identifiers.

## 4. Immutable feature gate

`deployment_feature_gate` stores deployment-level rollout decisions:

```
key = 'multi_repository_workspace'
PRIMARY KEY (key, min_schema_version)
state       'enabled' | 'disabled'
reason      free text (why this state)
min_schema_version  the forward migration that decided it
```

Rules:

1. **Append-only.** `BEFORE UPDATE` / `BEFORE DELETE` triggers abort with
   `deployment_feature_gate rows are immutable; append a new forward migration`.
   Nothing in the application updates or deletes a row.
2. **Effective state** is the row with the highest `min_schema_version`. Schema
   v20 seeds `disabled`.
3. **Enabling is a forward migration**, not an operator `UPDATE`, an
   environment variable, or a hidden UI toggle. The migration appends
   `('multi_repository_workspace', <N>, 'enabled', ...)` where `<N>` is the
   schema version that introduces the enforcement.
4. **Enabling is not implementing.** A build that reads `enabled` but has no
   enforcement for the whole set still refuses
   (`MULTI_REPOSITORY_SCOPE_UNSUPPORTED`). Turning the gate on is only correct
   in a release where every membership, invitation, execution, stream,
   artifact, memory and delivery path checks the complete set.

## 5. Mixed-version rollout

- The service refuses to serve a database whose `schema_migrations` version is
  newer than the build (`SchemaVersionMismatchError`,
  `SCHEMA_VERSION_UNSUPPORTED`). An older single-repository process can
  therefore never open a database that already records a multi-repository
  decision it cannot enforce: it would read one column, ignore the rest of the
  set, and authorize against one repository of many.
- A gate row newer than the build is `FEATURE_GATE_UNREADABLE`, so authority
  cannot be established from a rollout decision the process does not
  understand.
- `assertSchemaSupported(db, version)` is exported so a deploy can check before
  accepting traffic.

## 6. Migration and historical data

- `v20` adds `workspace.repository_set_version`, the binding table and the
  gate. It never edits a previously published migration.
- Backfill copies each workspace's own immutable provider/repository identity
  as binding #1. `status` mirrors the workspace (`archived` workspaces get a
  `retired` binding), because the active-binding index is enterprise-wide and
  the workspace-level index explicitly allows an archived and an active
  workspace to share a repository. `installation_ref` is linked only for an
  **active** integration covering exactly that repository; a suspended or
  uninstalled integration is never approval. The backfill has no
  `INSERT OR IGNORE`: an active conflict is unreachable given the
  workspace-level index, so one would fail and roll back the migration instead
  of silently dropping a workspace's binding. It invents nothing, adds no
  member, and grants nothing.
- Ambiguous history is reported, not repaired: a workspace whose binding
  disagrees with its legacy columns surfaces as
  `REPOSITORY_BINDING_INCONSISTENT` and is handled by a separate governance
  issue.
- Re-running the migration is a no-op (`schema_migrations`, `INSERT OR IGNORE`,
  unique constraints); a failed migration statement rolls back the version.

## 7. Out of scope here

Multi-repository **execution**: cross-repository remediation/delivery, memory
or approval enforcement over a multi-repository set. DAT-292 added the task
target **contract**: `GET /api/v1/workspaces/{workspace_id}/task-targets`
names the active bindings and the trusted baseline, and a workspace-scoped
create may select one by immutable identity at the observed set version. The
task records that target and the set version. DAT-293 added the runtime path —
provider-verified trusted baseline, approved installation and checkout/delivery
credentials, and a start/step re-check of the target at the recorded version
(see [run-target-authority-v1.md](run-target-authority-v1.md)) — but a
multi-repository set still refuses creation (`TARGET_REPOSITORY_REQUIRED`
without a selection, `MULTI_REPOSITORY_SCOPE_*` with one) because the shipped
configuration does not enable complete-set enforcement and the gate stays
closed (DAT-294 wired the protected paths; see §10). The addition decision itself is implemented (DAT-283/284/286): a
repository may only be added through an authorized preview and explicit
confirmation, the whole addition is refused when any current effective member
would lose admission or an effective owner would lose the required management
capabilities, and the audited commit is atomic. `addBinding` remains an
unconditional refusal; it is not the addition path. ADR-0011's product question
is settled as "reject the addition", not "remove or suspend the member".

Removal is not implemented: `removeBinding` refuses, so a workspace cannot be
returned to one repository through the API until a later audited change adds
that path (see the rollout gate document).

## 8. Whole-set authorization engine (DAT-291)

`provider-access/authorization-context.ts` produces one versioned authorization
context per member and action: enterprise membership, workspace role, the set
at one version, per-repository verified evidence, the intersected and persisted
ceiling, freshness and an optional target repository. Its contract is
[authorization-context-v1.md](authorization-context-v1.md).

The engine can evaluate a multi-repository set only when **both** hold:

1. the capability engine is constructed with
   `multiRepositoryEnforcement: "complete"`, and
2. the immutable gate row is `enabled`.

A `disabled` or unreadable gate still refuses, and the default
single-repository configuration still reports
`MULTI_REPOSITORY_SCOPE_UNSUPPORTED` for every multi-repository set. DAT-291
ships the engine and its tests, not a rollout: the deployment gate remains
`disabled` and `requireSingleRepository` continues to refuse a multi-repository
set for the legacy run binding.

DAT-293 added the target model's runtime wiring: the workspace-scoped create
path resolves a provider-verified baseline and the run start / worker step
re-check the recorded target through this context (see
[run-target-authority-v1.md](run-target-authority-v1.md)). DAT-294 wired the
remaining protected paths (API reads, SSE and replay, artifacts, approvals,
messages, issues, memory, delivery) to the same context; see §10 and
[protected-path-authority-v1.md](protected-path-authority-v1.md).

## 9. Runtime target and dispatch authority (DAT-293)

A workspace-scoped create binds one immutable target per run: the binding row,
the provider instance, the repository id, the approved installation, a trusted
base commit and the observed set version. The trusted baseline is the
deployment pin for its own repository and a checkout-capability read for any
other repository; a missing installation, checkout or delivery capability, an
unresolvable ref or a provider outage refuses the create with a stable code and
never falls back to another repository. Before a session starts and before
every dispatched action, the run is re-checked against the live set version,
the recorded target's identity, its approved credentials and the requester's
whole-set capability intersection. The contract is
[run-target-authority-v1.md](run-target-authority-v1.md).

`multiRepositoryRuntime` on the repository-set repository declares whether the
build can execute a multi-repository set at all; it defaults to `none` and is
**not** enabled by this change. Opening a multi-repository workspace therefore
still needs a release that configures complete-set enforcement (`"complete"`)
and appends the enabled gate row.

## 10. Protected-path runtime authorization (DAT-294)

Every protected request is decided by one versioned authorization context:
enterprise membership, assigned role, action policy, the **complete** active
repository set at its current version, and the repository the resource belongs
to. Task-shaped resources (detail, runs, timeline, artifacts, messages, cancel,
archive, approvals) name the task's recorded immutable target; a stream also
asserts the task's recorded set version, so a set change refuses the
subscription (`409 REPOSITORY_SET_VERSION_CONFLICT`) and closes a live one.
Issue-shaped resources (issues, their deliveries and approvals, the issue
stream) name the issue's repository, resolved to its one active binding; a
repository that left the set is refused as a target, never authorized
workspace-wide. Memory and the task-target read are workspace-shaped. The
approval directory re-derives eligibility from the whole-set intersection and
records the set version in its authority digest; the delivery broker re-checks
the requester's live capability on the delivery's repository before every
provider write. Nothing is cached: a set or permission change applies to the
next request in every process.

The boundary, its HTTP refusals and its evidence are
[protected-path-authority-v1.md](protected-path-authority-v1.md). It does not
open the gate: a multi-repository workspace still refuses on every path in the
shipped configuration, and a single-repository workspace keeps its previous
behavior.
