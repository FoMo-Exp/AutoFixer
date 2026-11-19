# Service integration operations runbook

This runbook covers the administrator-controlled repository service integration
added by DAT-267 and exposed in the workbench by DAT-268. It is an operator
procedure, not an authorization to change repository governance: this surface
does not change rules, approve a change, create an approval, merge a pull
request, or grant a user repository access.

## Baseline and scope

Checked against AutoFixer `main` at
`e9d7a65c9b5bc928e9c07d77f3504fd39b84df70` (2026-11-19):

| Capability                                               | Merged implementation                                             | Version / baseline                 |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| Administrator initialization, read, and deactivation API | [DAT-267 / PR #95](https://github.com/FoMo-Exp/AutoFixer/pull/95) | OpenAPI `0.10.0`; commit `a25bc47` |
| Workbench Integration panel                              | [DAT-268 / PR #98](https://github.com/FoMo-Exp/AutoFixer/pull/98) | web `0.1.0`; commit `c2d3785`      |
| Orchestrator package                                     | current main                                                      | `@autofixer/orchestrator` `0.6.0`  |

The API has one active integration at most for a workspace:

```text
/api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/service-integration
```

Only an enterprise administrator session or the deployment bootstrap authority
can use it. The service verifies this on every request; the workbench's admin
visibility is only a convenience and cannot grant access. A `403 FORBIDDEN`
means stop and obtain the appropriate administrator authority. A `401` means
the supplied session or bootstrap authority is not valid.

## Safety boundary

The request body accepts only opaque credential references. It never accepts a
provider token, provider or repository binding, permission visibility, or any
other field. The source reference is required; checkout and delivery
references are optional. Each reference must already resolve inside the server
credential boundary.

References are 1--200 characters, start with a letter or digit, and otherwise
may contain letters, digits, `.`, `_`, `:`, `/`, and `-`. Values with common
provider-token prefixes are rejected. Do not paste a secret into the UI, an API
body, shell history, terminal output, tickets, screenshots, or this document.

The response returns only these safe facts:

- Workspace-derived provider instance, canonical repository identifier, and
  repository display name.
- Derived permission visibility (`full`, `partial`, or `none`).
- Boolean presence for source, checkout, and delivery capabilities.
- Lifecycle status, version, and timestamps.

It never returns a reference, token, or other secret value. The server derives
the provider and repository from the pre-existing workspace binding; it will
not accept a request that attempts to choose or widen either one.

## First initialization

Before beginning, confirm all of the following:

1. The target workspace is active and is already bound to an approved provider
   instance and a canonical repository.
2. An approved credential-boundary operator has provisioned the intended
   reference names. This runbook deliberately does not describe secret storage
   locations or values.
3. You are using a current enterprise-administrator session, or a controlled
   deployment bootstrap procedure. Prefer the workbench for a session-based
   operation so that credentials do not enter shell history.
4. `(cd node && npm run doctor:json)` reports a usable deployment. The diagnostic is
   read-only and redacted; it does not install credentials or repair state.

In the workbench, select the workspace, open **Workspace administration**,
then **Integration**. Enter the required source reference and only the optional
capability references that have been provisioned. The panel trims the entered
names and locally rejects invalid or secret-looking input before it makes a
request. Select **Initialize integration**.

The first successful request returns `201`. Confirm the panel reports:

- the expected workspace-derived repository and provider instance;
- `Active` status;
- the expected configured capability booleans; and
- the provider adapter's reported visibility.

The equivalent API request has this shape; placeholders are deliberately not
usable credentials or reference values:

```http
PUT /api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/service-integration
Content-Type: application/json

{
  "source_credential_ref": "<pre-provisioned-source-reference>",
  "checkout_credential_ref": "<optional-pre-provisioned-checkout-reference>",
  "delivery_credential_ref": "<optional-pre-provisioned-delivery-reference>"
}
```

Omit either optional field when that capability is not intended. Do not add
`provider_instance_id`, `repository_id`, `permission_visibility`, or a secret
value: they are rejected. An identical retry is safe and returns `200` with the
existing view. A different configuration while an integration is active returns
`409 SERVICE_INTEGRATION_EXISTS`; it never overwrites installed references.

## Inspect and diagnose

Use the Integration panel's displayed facts for normal operation. The direct
read endpoint is `GET` on the same path and returns `200` only for an active
integration. After deactivation, it returns
`404 SERVICE_INTEGRATION_NOT_FOUND`; that is the expected lifecycle result,
not evidence that authority is open.

Use these distinctions when diagnosing a failed request:

| Response                                                         | Meaning                                                                                                      | Safe response                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `400 INVALID_REQUEST`                                            | A body field is invalid, secret-like, unresolvable in the credential boundary, or tries to supply a binding. | Correct the non-secret reference name or have the boundary owner provision it; do not retry with a token.              |
| `403 FORBIDDEN`                                                  | Caller lacks enterprise administrator authority.                                                             | Stop and use the authorized administrator process.                                                                     |
| `404`                                                            | The workspace is unknown/out of scope, or no active integration exists on a read.                            | Verify the selected workspace through normal administration; do not probe identifiers.                                 |
| `409 WORKSPACE_ARCHIVED` / `SERVICE_INTEGRATION_BINDING_INVALID` | The workspace cannot host an integration.                                                                    | Restore a valid active workspace binding through the appropriate administration process; do not force an installation. |
| `409 SERVICE_INTEGRATION_EXISTS`                                 | A different active configuration already exists.                                                             | Read the current safe view, decide whether rotation is approved, then use the rotation procedure below.                |
| `503 SERVICE_INTEGRATION_AUDIT_UNAVAILABLE`                      | The audit record could not be committed.                                                                     | Treat the operation as not applied. Restore audit availability, inspect state, and retry only the intended action.     |

Initialization and deactivation each commit their audit record and state change
in one transaction. Therefore a `503 SERVICE_INTEGRATION_AUDIT_UNAVAILABLE`
does not represent a partially completed lifecycle change. Preserve the request
ID and safe error details for support; do not guess from a retry alone.

`(cd node && npm run doctor)` and `(cd node && npm run doctor:json)` diagnose deployment readiness, not
the integration's credential values. The runtime endpoint is deployment
operator-only, whereas the integration panel and endpoint are administrator
surfaces. Neither diagnostic output is permission to expose a secret or widen
repository access.

## Rotate credentials or capabilities

There is intentionally no in-place update endpoint. This prevents an
otherwise-valid retry from silently replacing an active configuration.

1. Have the credential-boundary operator provision and validate the replacement
   reference without disclosing its value.
2. Record the intended repository, capability booleans, change authority, and
   maintenance window in the approved operational record. Do not record a
   reference or secret.
3. Deactivate the active integration. In the workbench choose **Deactivate**,
   then **Confirm deactivate**. API callers use `DELETE` on the same path.
   `204` is success, and repeating `DELETE` is idempotent.
4. Immediately initialize using the new reference set as described above.
5. Read back the safe view and verify `Active`, the workspace-derived binding,
   and the intended boolean capabilities. Review the available audit records
   through the administrator audit surface.

Deactivation sets the active row to `uninstalled`. It deliberately leaves an
authority marker behind, causing ordinary workspace requests to fail closed
until a new integration succeeds. The administrator lifecycle endpoint remains
available so recovery is possible. Plan the brief interruption; no automatic
fallback, approval, merge, or rule change occurs during rotation.

## Revoke or disable

To immediately stop the integration, perform the same **Deactivate** action.
The action is administrator-only and idempotent. It does not delete history or
credential material from the credential boundary; revocation of the underlying
secret itself is a separate, authorized boundary-owner operation.

After `204`, treat all ordinary workspace activity as denied until a deliberate
new initialization completes. Do not describe a successful `DELETE` as a
repository-access change, a PR cancellation, an approval revocation, or a
merge control: this endpoint performs none of those actions.

## Recovery after failure

For a failed first initialization, fix the reported safe condition and submit
the same intended reference set again. An identical post-success replay is
safe. If a prior attempt produced `503`, first recover the audit service and
read the integration state; because the mutation rolled back, re-issuing the
same intended request is the recovery action.

For an interrupted rotation:

1. Read the integration state with the administrator panel or `GET` endpoint.
2. If it is active, do not assume the replacement was installed; compare only
   the safe capability booleans and follow the approved rotation record.
3. If it is not active, ordinary workspace requests remain correctly
   fail-closed. Re-establish the intended binding with a new `PUT` only after
   the replacement reference is confirmed available in the credential boundary.
4. If the workspace is archived or its binding is invalid, resolve that
   administrative condition before retrying. Do not bypass the binding check.

## Verification and limits

For this documentation update, the repository's Node and workbench checks are
the applicable validation. Run from the repository root:

```sh
(cd node && npm run typecheck && npm run lint && npm run format:check && npm test)
(cd web && npm run typecheck && npm run lint && npm run format:check && npm test && npm run build)
```

The documentation change makes no API or generated-contract change, so no
OpenAPI export is required. It also does not execute a real initialization,
rotation, deactivation, provider request, approval, or merge: those require
explicit administrator authority and protected deployment credentials that are
outside this runbook.
