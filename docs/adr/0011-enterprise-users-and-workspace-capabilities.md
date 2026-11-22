# ADR 0011: Enterprise users and workspace capabilities

**Status:** Proposed — product boundaries below are a reviewable design, not a
claim of implementation. Workspace enrollment scope remains an open question.

**Date:** 2026-11-22

## Context

AutoFixer's first release serves enterprise users and repository-bound
workspaces; it does not offer public self-registration. An administrator adds
an approved GitHub or GitLab identity and the user joins the enterprise without
an additional invitation acceptance step. The person proves that identity by
signing in. Workspace access must reflect both AutoFixer membership and current
repository permissions; an enterprise administrator does not acquire
repository data access merely by holding enterprise authority.

ADR-0006 describes identity, membership, provider authority and invitations.
This ADR extends it with explicit enterprise membership, a repository-based
ceiling on workspace actions, module visibility, and the backend/frontend
handoff. It does not relax ADR-0001, ADR-0005, ADR-0007 or ADR-0009.

The current code has OAuth sessions, workspace memberships, invitations,
provider adapters and authority reconciliation. The workspace member API is
declared in OpenAPI and used by the UI, but its member list and mutation
routes are not wired in `node/src/api/server.ts`. The current
`computeEffectiveAccess` checks authority state and freshness, but does not
apply the provider role to individual actions. `app_user.status` and the
existing suspend route are global; an enterprise administrator can currently
affect a user associated with other enterprises. These are implementation
gaps, not guarantees made by this ADR.

## Decision

### Identity and enrollment

- An approved `(provider_instance_id, stable_subject)` is the only identity
  match key. Never merge accounts by login name, email, avatar or display
  name. Multiple linked identities require proof of each identity.
- An enterprise administrator may add a subject belonging to an approved
  provider instance of that enterprise. Record enterprise membership at
  addition; a subject that has not signed in has a pending identity binding and
  cannot use a session until a successful OAuth login proves the same subject.
  Addition is idempotent and concurrent login/addition binds once. Do not send
  a message or require invitation redemption for administrator addition.
- The membership is enterprise-scoped, with active/suspended status and
  administrator/member standing. Suspension in enterprise A does not change
  enterprise B or the global account. Enterprise reactivation restores no
  workspace permissions revoked under the repository reapproval rule below.
  Deployment-wide suspension is a separately authorized operator action.
- Login alone creates no enterprise membership. Existing invitations remain
  supported: successful authenticated redemption atomically establishes any
  required active enterprise membership, workspace membership and consumption.
  A suspended enterprise membership cannot be reactivated through an invite.
- Workspace selection remains **open**: the recommended initial default is
  that an administrator selects workspaces when adding a user, each subject to
  repository eligibility; automatic enrollment in every eligible workspace has
  not been approved. Do not implement or claim that product choice is settled
  until it is confirmed. A newly created workspace never silently enrolls an
  existing enterprise user under this unresolved rule.

### Repository authority and role transitions

The effective decision for a workspace action is the intersection of active
enterprise membership, assigned workspace role, verified current repository
capabilities, action policy, any separate duty or grant, and data sensitivity.
Provider identities are bound to the workspace's approved provider instance
and repository-scoped server integration. Login OAuth credentials are not the
service integration credential. Preserve direct, inherited, group and
organization provenance when observable; do not invent it when the provider
only reports effective access. Organization membership alone is not proof of
repository access.

For known standard roles, the initial conservative mapping is:

| Provider fact                                                                  | Maximum initial workspace role   |
| ------------------------------------------------------------------------------ | -------------------------------- |
| GitHub `read` or `triage`; GitLab `reporter`                                   | `viewer`                         |
| GitHub `write`, `maintain`, `admin`; GitLab `developer`, `maintainer`, `owner` | `member`                         |
| GitLab `guest`, unknown/custom or unverified permission                        | No automatic workspace admission |

This is an AutoFixer policy, not an assertion that provider roles are
equivalent. Require proof of repository code-read and action-specific
capabilities on the actual instance. Unsupported roles and incomplete or
ambiguous capability evidence fail closed rather than being ranked by name.
Repository roles never automatically confer workspace `admin`, `owner`,
enterprise administration, security duties or delivery approval.

The assigned role and the effective access ceiling are distinct. A verified
provider upgrade never upgrades the assigned role or a previously reduced
ceiling; an authorized administrator must approve the increase. A positively
verified downgrade immediately limits actions and data to the reduced ceiling
without rewriting the assigned role. A confirmed loss of repository access
blocks workspace access and revokes relevant grants. Persist the reduction and
its reason; a later provider recovery requires an audited administrator
reapproval before increasing access. Unknown, stale or unavailable evidence
is not a confirmed downgrade: do not overwrite authority or the approval
ceiling, but block sensitive actions until verification succeeds. Recovery
from a temporary verification failure may unblock previously approved access
without a new promotion. Provider event processing and bounded reconciliation
propagate changes; enforce each newly observed revocation on subsequent
requests and close affected subscriptions. Expose verification time and
reconciliation state. Do not promise instantaneous detection of provider-side
changes; define and test freshness limits and failure handling in the API.

Authorization and required audit evidence are committed atomically where they
share a transaction; failing required audit blocks the sensitive action.
Recheck durable authority for new requests and before sensitive worker or
delivery steps, and revoke affected execution grants. Cross-process behavior
must not rely solely on an in-memory event. Preserve the last effective
enterprise administrator and workspace owner against concurrent local
demotion/removal. If an external provider revokes the last owner's repository
authority, never keep access alive to preserve ownership: enter an audited,
deployment-admin recovery path.

### Operations and module visibility

The table is a ceiling, not a grant; every entry also requires the effective
enterprise and repository conditions above. `admin` and `owner` are separate
workspace roles. Security duties and enterprise administration are separately
granted and never follow solely from a workspace or provider role.

| Module              | Viewer                                                 | Member                                                                                            | Admin                                                                                        | Owner                                                                              |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Tasks               | Read scoped status and permitted redacted artifacts    | Viewer plus create/run/manage permitted tasks with verified repository write and run grants       | Member actions under policy                                                                  | Admin actions under policy                                                         |
| Issues              | Read scoped issues, candidate diffs and evidence       | Viewer plus create/comment and request approval or controlled delivery with provider capabilities | Member plus named-human candidate decision when eligible                                     | Same approval eligibility as admin                                                 |
| Memory              | Read applicable items through `internal` ceiling       | Viewer; eligible team leader may govern only their own team's applicable items                    | Read through `confidential`; govern eligible versions                                        | Same governance ceiling as admin                                                   |
| RSI                 | Hidden                                                 | Read bounded proposals/status and propose                                                         | Member plus independent version-bound approvals                                              | Admin plus policy-authorized replay, canary, observation, rollback and kill switch |
| Dashboard           | Read permitted operational overview and redacted trace | Same as viewer                                                                                    | Also permitted cost/budget detail, audit and export                                          | Same as admin                                                                      |
| Members and teams   | Read allowed workspace roster and teams                | Same as viewer                                                                                    | Manage members/viewers, teams and member invitations with verified repository administration | Admin plus role administration, subject to last-owner protection                   |
| Security            | No access solely by role                               | No access solely by role                                                                          | No access solely by role                                                                     | No access solely by role                                                           |
| Service integration | No configuration access solely by role                 | Same as viewer                                                                                    | Requires separate enterprise administration                                                  | Requires separate enterprise administration                                        |

Memory `restricted` data is not exposed through ordinary Memory governance;
team leadership grants neither repository nor security authority. RSI
approvals, holdout separation and human independence remain governed by
ADR-0009 and `docs/contracts/memory-rsi-v1.md`. Dashboard does not expose
captured content or quarantined material. Security handlers, independent
reviewers, enterprise security administrators and task owners get only the
specific actions and redacted views authorized by the security contract;
quarantine inspection additionally requires a live grant. A user may have
security duties in any workspace role, but a second duty does not permit
self-review. A deployment or security recovery path may be used as explicitly
authorized by its own contract even where ordinary workspace access is lost.

Enterprise user directory, enterprise membership/status and identity audit are
enterprise-admin surfaces. A separately authorized enterprise administrator
may manage service integration metadata without gaining workspace task or
repository content access. Any legacy enterprise-admin workspace membership
mutation must enforce the same target eligibility, repository authority,
last-owner, audit and revocation rules as the workspace administration path;
it must not be an authorization bypass. Workspace admins cannot change
owner/admin memberships; an owner can do so subject to repository management
authority and the last-owner rule. Administering a workspace requires verified
repository management authority. Candidate roster incompleteness is an error,
never an empty successful list.

### Backend contract and frontend handoff

Backend authorization is authoritative on every API request and sensitive
execution step. The UI hiding an entry or button is not an access control.
Introduce a session-scoped, workspace-scoped capability projection in the
backend contract, including an explicit schema/version, module visibility,
action permission, safe reason codes, effective data ceilings, and authority
freshness. Enterprise administration needs a distinct enterprise-scoped
projection so an enterprise admin without workspace membership can reach
permitted management functions without viewing repository data. Capability
responses are advisory snapshots, never bearer grants or a substitute for
checking the specific object and action. They must not expose other tenants,
credentials, invitation bearers, restricted content or sensitive policy
details. Unknown capabilities and expired or failed projections fail closed.

Export the implemented backend OpenAPI and generated types to
`web/src/api/contracts/`; document each endpoint's path, request fields,
response, safe error codes, scope and authorization. Align or implement the
already-declared member endpoints; expose enterprise membership and capability
changes explicitly, including pending binding, suspension, confirmed provider
downgrade and audited reapproval. Both legacy and new mutation paths must use
the same authorization service. Retain existing clients through an explicit
compatibility plan; do not silently broaden any legacy path.

Frontend work depending on a changed backend contract starts only after that
contract is merged into `main`. Its PR lists each endpoint, request fields,
response type, verification result and a baseline commit containing the merged
contract. Fixtures come from real backend responses or the merged OpenAPI;
invented mock fields are prohibited. Reuse the existing component library and
`web/DESIGN.md` when present. Browser and desktop consume the same authority
model, while desktop credentials remain in the main process.

The UI uses the projection to show modules, actions and safe explanations;
object-specific authorization is still checked by the server. Re-fetch after
workspace selection, focus/reconnect and authority changes, and invalidate
visible sensitive state on denial or revocation. Close affected streams and
handle deep links, stale projections, missing module data, session expiry and
provider outages without displaying stale protected content. The backend
provides a documented change/refresh mechanism and expiration behavior; the
frontend cannot rely on a process-local signal as its security boundary.

### Migration and scope

Use a guarded forward migration; never edit a previously published migration.
Backfill enterprise memberships from authoritative existing workspace
memberships and enterprise-admin records, not provider identity alone. A
preexisting global suspension is not silently lifted. Report ambiguous or
inconsistent historical data and handle remediation in a separate governance
issue; do not invent access to make the migration succeed. Preserve the local
operator prototype as an explicitly scoped deployment mode; it cannot become
an enterprise authorization bypass. Audit changes without secrets, raw
invitation values or protected content.

## Consequences and alternatives

- Explicit enterprise membership prevents one enterprise administrator from
  suspending another enterprise's access, but adds migration and lifecycle work.
- Automatic restriction plus explicit reapproval prevents provider permission
  recovery from silently restoring a previously revoked privilege; administrators
  must handle legitimate reactivation. Temporary outages do not permanently
  demote the user.
- Provider roles are capability evidence, not AutoFixer roles. This avoids
  accidental management grants but requires per-provider capability adapters
  and explicit handling for custom or unobservable roles.
- Capability projections simplify consistent browser/desktop navigation but
  add synchronization and contract costs; independent server checks remain
  mandatory. We reject client-authored role assertions and frontend-only gates.

## Acceptance

1. Administrator addition followed by matching OAuth login establishes the
   correct enterprise membership once; a different subject, same email,
   suspended member or unapproved provider never acquires it. Invitation
   redemption remains atomic and cannot reactivate suspended membership.
2. Two enterprises sharing a user cannot read or change each other's
   membership or invalidate each other's access. Last-admin/owner concurrent
   mutations and externally revoked last-owner recovery are tested.
3. Known provider roles map conservatively; unknown/custom, missing scope and
   incomplete rosters fail closed. Direct and inherited permissions are tested
   only to the provenance granularity actually observed. Sensitive operations
   require fresh verified authority; a provider outage is not recorded as a
   confirmed removal.
4. Confirmed downgrade or removal limits next authorized requests, streams,
   worker steps and delivery grants across processes. Recovery after confirmed
   downgrade requires explicit audited reapproval; an unchanged authority
   after transient failure unblocks without promotion. Provider detection
   latency and configured freshness bounds are observable and tested.
5. For every module and each role/duty, test permitted entry, data ceiling and
   action; direct HTTP calls, cross-workspace IDs and stale projections cannot
   bypass checks. Verify the team-leader exception, RSI separation of duties,
   restricted Memory, cost restrictions and security quarantine grants.
6. Backend route and capability contracts, legacy mutations, OpenAPI export and
   actual responses agree. Frontend uses a merged contract baseline, real
   fixtures, role-specific navigation, revocation/deep-link handling and
   browser/desktop authorization parity.
7. Forward migration and rerun preserve legitimate prior memberships, global
   suspension, tenant isolation and local-operator behavior; ambiguous history
   is surfaced, not silently granted or rewritten.
8. Implementation issues use main-based linked PRs; CI-equivalent lint, format,
   typecheck and relevant tests pass before `in_review`, and a new remote head
   is sent to QA with the exact workspace mention. `done` requires QA pass.

## Open question

Does administrator addition enroll the user only in explicitly selected
workspaces, or automatically in every currently eligible workspace? The
recommendation is explicit selection. The enterprise addition and identity
binding above do not depend on that answer, but workspace admission and its
frontend flow must not be finalized until the product choice is confirmed.
