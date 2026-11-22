# Workspace repository set and multi-repository gate (v1)

Status: **storage and read boundary implemented; multi-repository scope not
usable.** Implements DAT-281 under ADR-0011. This contract describes what
exists, what is refused, and how a later release may turn the capability on. It
is not a claim that multi-repository membership, execution, delivery, memory or
approvals are enforced — they are not, and until they are, every multi-
repository scope fails closed.

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
| `SCOPE_MUTATION_DISABLED`            | `addBinding` / `removeBinding` — there is no API that creates or changes a multi-repository scope. |
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

Adding a repository to an existing workspace, multi-repository membership
intersection, cross-repository remediation/delivery, and the affected-member
preview are **not** implemented. ADR-0011's open product question (reject the
addition versus suspending excluded members) stays unanswered; the current
decision is to reject, which `addBinding` enforces unconditionally.
