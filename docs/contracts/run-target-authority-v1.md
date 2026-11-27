# Run target resolution and dispatch authority v1 (DAT-293)

Every workspace-scoped remediation run binds **one** repository of its
workspace, one trusted base commit, and the repository-set version the decision
observed. This document describes how that target is resolved at creation and
how it is re-checked immediately before execution — and what is deliberately
still refused.

It is the runtime counterpart of the DAT-292 selection contract
(`GET /api/v1/workspaces/{workspace_id}/task-targets`) and the DAT-291
authorization context (`authorization-context-v1.md`).

## 1. What a run is bound to

The task (and every run record under it) stores the immutable target:

| Field                  | Meaning                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `binding_id`           | The exact `workspace_repository_binding` row that was selected.      |
| `provider_instance_id` | The workspace's approved provider instance for that binding.         |
| `repository_id`        | The provider-assigned immutable repository id.                       |
| `installation_ref`     | The approved active installation, or `null` in local-prototype mode. |
| `base_ref`             | The ref the trusted commit was resolved from.                        |
| `base_sha`             | A full commit id: the deployment pin, or the provider's answer.      |
| `set_version`          | The repository-set version the decision was formed against.          |

Names, URLs, ordering and the deployment's configured repository are metadata
or deployment defaults, never selection authority. Nothing in this path ever
falls back to another repository, another installation, or another credential.

## 2. Creation: trusted baseline and approved credentials

`createAsyncWorkspaceRunBindingResolver`
(`node/src/api/workspace-bindings.ts`) resolves a workspace-scoped create in
this order. A failure at any step refuses the create; nothing is materialized
and no dsh run is opened.

1. **Workspace** — unknown, archived and cross-enterprise are one
   `404 NOT_FOUND`; the locator is not an enumeration oracle.
2. **Provider instance** — the workspace's instance must be registered for the
   enterprise, else `409 PROVIDER_INSTANCE_NOT_APPROVED`.
3. **Set shape and gate** — a multi-repository set requires an explicit
   selection (`400 TARGET_REPOSITORY_REQUIRED` without one) and a set this
   build can execute (`403 MULTI_REPOSITORY_SCOPE_DISABLED` while the rollout
   gate is closed, `403 MULTI_REPOSITORY_SCOPE_UNSUPPORTED` when the build has
   no runtime consumer for the shape).
4. **Immutable identity** — the selection must match one active binding by
   `(provider_instance_id, installation_ref, repository_id)` at the observed
   `expected_set_version`; mismatches are `400 REPOSITORY_NOT_IN_WORKSPACE`,
   `409 TARGET_IDENTITY_MISMATCH`, `409 REPOSITORY_SET_VERSION_CONFLICT`.
5. **Trusted baseline** (`node/src/api/trusted-baselines.ts`):
   - the deployment's own repository keeps its configured pin, with no
     provider call;
   - every other repository is read through its approved integration's
     **checkout** capability (`GET /repos/{owner}/{repo}/commits/{ref}` on
     GitHub, `GET /projects/{path}/repository/commits/{ref}` on GitLab) and
     must answer with a full 40-hex commit id;
   - refusals: `409 TARGET_INSTALLATION_NOT_APPROVED` (no active installation
     for that binding), `409 CHECKOUT_CREDENTIAL_UNAVAILABLE` (no checkout
     reference, or a reference the credential boundary cannot materialize),
     `409 REPOSITORY_BINDING_UNAVAILABLE` (a repository this deployment cannot
     pin), `409 BASE_REF_NOT_SUPPORTED` (the ref does not resolve),
     `503 PROVIDER_UNAVAILABLE` (an outage, a rejected credential or an
     answer that is not a commit).
6. **Delivery capability** — a run that selects one repository of **several**
   also requires that repository's own delivery capability
   (`409 DELIVERY_CREDENTIAL_UNAVAILABLE`). Single-repository workspaces keep
   their previous behavior; the broker still refuses delivery later.
7. **Set version re-read** — after the provider answered, the set is re-read at
   the version the decision was formed against. A concurrent change makes the
   decision unrepresentable (`409 REPOSITORY_SET_VERSION_CONFLICT`).

Credential **values** never leave the DAT-203 credential boundary: the
resolver proves a reference exists and is materializable, then hands it to the
adapter, which resolves it per request. No credential reference or value is
added to the task projection, the run record, an event or a log.

## 3. Dispatch: the start and step check

`createRunStepAuthority` (`node/src/api/run-step-authority.ts`) is asked before
a session starts (`phase: "start"`, including a create that dsh auto-approved)
and before every `dsh_request_action` (`phase: "step"`). All facts are read
live; nothing is cached, so a change observed by another process or before a
restart applies immediately.

| Check                                                                                                             | Denial                                                                                | Terminal                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------- |
| Set at the run's recorded version                                                                                 | `REPOSITORY_SET_VERSION_CONFLICT`                                                     | yes                                      |
| Target still the same active binding of that version (binding id, provider instance, repository id, installation) | `TARGET_REPOSITORY_UNAVAILABLE`                                                       | yes                                      |
| Target's approved installation still active                                                                       | `TARGET_INSTALLATION_NOT_APPROVED`                                                    | yes                                      |
| Target's checkout capability still present                                                                        | `CHECKOUT_CREDENTIAL_UNAVAILABLE`                                                     | yes                                      |
| Delivery capability, multi-repository run only                                                                    | `DELIVERY_CREDENTIAL_UNAVAILABLE`                                                     | yes                                      |
| Multi-repository set without the complete-set engine configured                                                   | `AUTHORITY_RECHECK_REQUIRED`                                                          | no                                       |
| Versioned authorization context over the complete set (DAT-291), action `write`, target named                     | context code (`CAPABILITY_REQUIRED`, `CAPABILITY_LOSS`, `WORKSPACE_ROLE_REQUIRED`, …) | yes, except `AUTHORITY_RECHECK_REQUIRED` |

"Terminal" means the run is stopped for human triage; a non-terminal denial
only blocks that dispatch and recovers when the same facts verify again — an
outage is never recorded as a removal.

A denied **start** leaves the run `stopped` with the safe reason
`RUN_AUTHORITY_DENIED: <code>`; no Pi session is created and no gateway binding
is made. A denied **step** records `tool.denied` and dispatches nothing.

The identity-less local-operator deployment (no integrations at all, no
versioned set) keeps its dsh-grant-only boundary; the deployment's own
credential is not a provider subject.

## 4. What stays closed

- The rollout gate row is unchanged (`disabled`). The runtime capability
  `multiRepositoryRuntime: "complete"` exists in the repository-set read so a
  later release can open the shape together with an appended gate row; this
  change does **not** enable it in the deployment.
- Protected-path consumers (API/SSE/artifacts/approvals/messages/issues/memory/
  delivery) remain DAT-294. Until they re-check the target and the complete
  set, a multi-repository workspace continues to refuse them.
- Removal and rollback are not implemented; `removeBinding` still refuses.
