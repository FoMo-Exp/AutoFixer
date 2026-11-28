# Mixed-version protection, authorization audit and denial observability (v1)

Status: **implemented (DAT-296).** It adds forward-version guards, an
append-only authorization-denial audit and one admin-scoped status read. It
does **not** enable the multi-repository workspace gate, change any
authorization rule, or make a multi-repository workspace usable. The shipped
deployment still configures no complete-set enforcement and the immutable gate
row stays `disabled`.

Baseline: `main` at `d3120d0` (DAT-294). Related contracts:
[authorization-context-v1.md](authorization-context-v1.md),
[protected-path-authority-v1.md](protected-path-authority-v1.md),
[workspace-repository-scope-v1.md](workspace-repository-scope-v1.md) and
[../multi-repository-rollout-gate-v1.md](../multi-repository-rollout-gate-v1.md).

## 1. Forward-version protection

Three durable facts can be newer than the process reading them: the control
plane schema, the immutable rollout gate, and a repository binding's state.
Each is refused, never interpreted under older rules.

| Fact | Guard | Refusal |
| --- | --- | --- |
| Control-plane schema | `openControlPlaneDb` at startup, **and every authority read** (`getSet`, `gate`, `currentSetVersion`) re-reads `MAX(schema_migrations)` | `SCHEMA_VERSION_UNSUPPORTED` (409) |
| Rollout gate row | `deployment_feature_gate.min_schema_version` newer than the build | `FEATURE_GATE_UNREADABLE` (403) |
| Binding state | a row whose `status` is not `active` / `retired` | `REPOSITORY_SET_STATE_UNSUPPORTED` (409) |
| Set version observed by a caller | `expected_set_version` / recorded stream version | `REPOSITORY_SET_VERSION_CONFLICT` (409) |

The per-read schema guard is what makes a **rolling deploy** fail closed: a
newer process may migrate the shared database while an older process is still
serving. That older process refuses on its next authority read instead of
applying its older rules to newer state. The guard is a normal authorization
refusal, not a crash, so the caller surfaces a safe denial
(`403 AUTHORITY_RECHECK_REQUIRED` with
`capability_reason: "schema_version_unsupported"` on a protected request, and
`repository_set.unreadable_reason` on the status read).

Unknown binding states are refused because silently filtering them would
**shrink** the set and could over-authorize the remaining repositories.

Re-running the migration runner remains a no-op; v23 only adds columns,
indexes and triggers, and never edits a previously published migration. A
process older than the database refuses at open (`SchemaVersionMismatchError`)
and at its next authority read.

What this cannot do: a build predating this guard, already running, cannot be
taught to re-check. The deployment rule is therefore explicit — a release that
migrates the shared database must not leave a pre-DAT-296 process serving
traffic. The guard protects every build from this release onward and turns the
remaining sequence into an observed refusal rather than silent degradation.

## 2. Append-only authorization audit

`auth_audit` is the existing authorization trail (membership, invitation,
capability-ceiling and repository-set changes). DAT-296 adds:

- `workspace_id`, `action`, `decision_code` columns and
  `(workspace_id, at)` / `(event, at)` indexes (v23);
- `BEFORE UPDATE` / `BEFORE DELETE` triggers that abort, so the trail is
  append-only at the storage layer, not only by convention.

Every **refused** authorization on a protected request path and every refused
run start / worker step appends exactly one `authorization.denied` row:

| Field | Example | Notes |
| --- | --- | --- |
| actor | `usr_…` or deployment | who made the request; never a subject hash |
| workspace | `ws_…` | the evaluated scope |
| action | `read`, `write`, `approval`, `delivery`, … | the action vocabulary |
| target | `(provider_instance_id, repository_id)` | immutable identity only; no URL/name |
| versions | set version, context schema, build schema, database schema | the facts the refusal was formed against |
| result | `authorization.denied` + stable code + safe reason + capability reason | e.g. `AUTHORITY_RECHECK_REQUIRED`, `no_code_read` |

Allowed requests are deliberately **not** recorded here. Successful sensitive
mutations already commit their required audit row in their own transaction
(membership change, ceiling reapproval, repository-set change, delivery); the
authorization boundary contributes the fact those domains never see — the
refusal. A failed audit append propagates; it is never swallowed into an allow.

Records contain no credential, bearer value, provider URL or name, task/issue
content, diff or other member's identity. A test asserts the serialized row
matches none of those shapes.

## 3. Denial trend and workspace authorization status

`GET /api/v1/workspaces/{workspace_id}/authorization-status?window_minutes=`
(admin/owner) returns, for the caller's own enterprise + workspace:

```jsonc
{
  "schema_version": "1",
  "build": { "schema_version": 23, "database_schema_version": 23, "mixed_version": false },
  "rollout": {
    "gate": { "key": "multi_repository_workspace", "state": "disabled",
              "min_schema_version": 20, "unreadable_code": null },
    "enforcement": "complete"
  },
  "repository_set": { "readable": true, "version": 1, "repository_count": 1,
                      "multi_repository": false, "usable": true, "blocked_reason": null },
  "caller": {
    "evaluated": true, "allowed": false, "code": "AUTHORITY_RECHECK_REQUIRED",
    "reason": "capability_unverified", "capability_reason": "repository_set_unsupported",
    "requires_reconciliation": true, "required_capability": "code_read",
    "freshness": { "state": "unknown", "...": "..." },
    "repositories": [ { "repository_id": "…", "state": "unverified",
                        "freshness": "unknown", "target": false, "...": "..." } ]
  },
  "denials": { "total": 1, "by_code": [ { "code": "AUTHORITY_RECHECK_REQUIRED", "count": 1 } ],
               "by_action": [ { "action": "read", "count": 1 } ],
               "by_capability_reason": [ { "code": "repository_set_unsupported", "count": 1 } ],
               "series": [ { "bucket_start": "2026-11-28T08:00:00.000Z", "count": 1 } ] }
}
```

- **Readable while authority is unverified.** The route is authorized by live
  workspace membership plus the admin/owner role, not by the provider gate:
  an unverified set is exactly the state an operator must be able to inspect.
  It is read-only, grants nothing, and every protected request still decides on
  its own.
- **The caller's own facts.** `caller` is a fresh versioned-context evaluation
  for the requesting user (action `read`), never a cached projection and never
  another member's evidence.
- **Bounded trend.** `window_minutes` defaults to 1440 and is clamped to
  1 minute … 7 days. Counts are grouped by safe code, action and capability
  reason — plus sparse UTC hourly counts in `series` — and no actor, target
  or content is listed. `mixed_version: true` plus
  `repository_set.unreadable_reason` make a rolling-deploy refusal explicit.
- **Non-enumerating.** A non-member gets the same `404` as every other
  workspace route; a viewer/member gets `403 WORKSPACE_ROLE_REQUIRED`.

The frontend capability projection (`GET …/capabilities`) remains the
per-member, contract-merged advisory shape for navigation. This endpoint is the
admin operational surface and is not a substitute for it.

## 4. What is still open

- Enabling `multi_repository_workspace` remains a forward-migration release
  decision; DAT-296 does not append an enabled row and no deployment config
  changes.
- Repository removal/rollback, real deployment evidence and the production
  rolling-upgrade rehearsal stay with the rollout gate
  ([§5](../multi-repository-rollout-gate-v1.md)). This change makes the mixed
  version *observable and refused*; it does not rehearse a real deployment.
- A denial-trend threshold/alerting policy is deployment configuration, not
  code. The audit rows and the bounded aggregate are the inputs.

## 5. Evidence

| Test | Covers |
| --- | --- |
| `node/test/authorization-observability.test.ts` | v23 additive/idempotent migration; a running process refusing a newer schema; an unknown binding state refusing the set; append-only triggers; denial payload has no secret/URL/content; workspace-scoped bounded trend; status mixed-version reporting |
| `node/test/authorization-status-http.test.ts` | Real HTTP: admin reads gate/set/caller/trend while authority is unverified; a refusal elsewhere appears in the trend; survives restart; viewer 403; stranger 404; invalid window 400; no credential/URL leak |
| `node/test/workspace-repository-set.test.ts` | Existing schema/open/gate mixed-version cases still hold |
| `node/test/openapi.test.ts` | The new endpoint and schemas are in the merged contract; committed JSON/types match a fresh generation |
