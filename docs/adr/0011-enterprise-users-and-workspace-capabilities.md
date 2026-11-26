# ADR 0011: Enterprise users and workspace capabilities

**Status:** Proposed — product boundaries below are a reviewable design, not a
claim of implementation. Multi-repository workspace support is not yet delivered.

**Date:** 2026-11-22

## Context

AutoFixer's shared service serves enterprise users and workspaces containing
one or more repositories; it does not offer public self-registration. An administrator adds
an approved GitHub or GitLab identity and the user joins the enterprise without
an additional invitation acceptance step. The person proves that identity by
signing in. Workspace access must reflect both AutoFixer membership and current
repository permissions; an enterprise administrator does not acquire
repository data access merely by holding enterprise authority.

ADR-0006 describes identity, membership, provider authority and invitations.
This ADR replaces its one-repository-per-workspace decision with the model
below; its other identity and security boundaries remain in force. It extends
the access model with enterprise membership, an all-repository ceiling, module
visibility, and the backend/frontend handoff. It does not relax ADR-0001,
ADR-0005, ADR-0007 or ADR-0009.

The code at the initial design baseline has OAuth sessions, workspace
memberships, invitations, provider adapters and authority reconciliation. The
workspace member API is
declared in OpenAPI and used by the UI, but its member list and mutation
routes are not wired in `node/src/api/server.ts`. The current
`computeEffectiveAccess` checks authority state and freshness, but does not
apply the provider role to individual actions. `app_user.status` and the
existing suspend route are global; an enterprise administrator can currently
affect a user associated with other enterprises. These are implementation
gaps at that baseline, not guarantees made by this ADR. DAT-275 subsequently
merged enterprise membership, scoped suspension and identity enrollment in
PR #103; remaining boundaries require their own implementation and review.

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
- An administrator explicitly selects the workspaces to join, each subject to
  eligibility across all of its repositories. Adding an enterprise user or a
  new workspace does not automatically enroll that user in workspaces. An
  invitation remains an explicit alternative subject to the same eligibility.

### Workspace repository set and admission

One workspace may contain multiple repositories, for example separate
microservices. Each binding identifies an approved provider instance,
installation and immutable repository ID; repository URLs and names are
metadata. An active workspace must contain at least one repository before it
can admit members or grant access. Retain ADR-0006's existing one-active-
workspace-per-enterprise-and-repository uniqueness constraint unless a later
decision changes it. Repository transfer requires revalidation, never silent
cross-enterprise reassignment.

For a given user and workspace, translate each repository's verified effective
provider permissions into a set of supported capabilities, then intersect
those sets across **every** active repository. Only a user with verified code
read in every repository is eligible to join. The resulting intersection is
also the ceiling on workspace actions; a stronger permission on one repository
cannot compensate for a missing capability on another. For example, write on
repository A and read-only on B permits at most viewer-level workspace access;
no read on either means no admission. This is a set intersection, not a ranking
of provider role names across GitHub and GitLab. Every action also requires
the assigned workspace role, policy, separate duties and resource checks.

Missing, stale, incomplete, unsupported or ambiguous evidence for any
repository cannot establish admission. For an existing member, fail closed
for workspace access when current eligibility cannot be established; do not
record an outage as a confirmed removal. Evaluate the full repository set for
invitations, existing members, new requests, streams, worker steps and delivery.
Any newly observed loss or reduced intersection revokes the affected access
and grants, closes subscriptions, invalidates affected approvals and records
an audit event. Reauthorization after a confirmed downgrade follows the rule
below; provider recovery alone does not elevate a member. An uncertain check
may recover without promotion when the previously approved facts are verified.

Adding or removing a repository changes every member's intersection. For this
decision a **current effective member** is an active workspace membership with
an active enterprise membership, previously admitted and not confirmed revoked
or removed. Include such a member even when present provider evidence is
temporarily unavailable: otherwise an outage could silently remove that member
from the protection set. Pending invitations and inactive, suspended, removed
or confirmed-revoked memberships are not current effective members; they must
meet the full admission rules before later activation. A **current effective
owner** is such a member with an active owner assignment and verified necessary
repository management capabilities across every active repository, subject to
the existing role, policy and duty constraints. Unknown authority does not prove
an effective owner; it must not be treated as a confirmed revocation either.

Before adding a repository, compute the proposed full-set intersection for
every current effective member. Reject the entire addition if any member is
confirmed to lack code read, or any necessary evidence is missing, stale,
incomplete, ambiguous, unsupported or unavailable. Do not convert unknown
evidence into a confirmed denial or remove a member to make the change pass.
If all retain admission, a verified reduction of their effective capability
ceiling may proceed only after an authorized actor previews and explicitly
confirms the exact affected members and reductions. The assigned workspace
role remains unchanged; the approved ceiling is reduced, and normal action,
policy and duty checks still apply. Reject the addition if no effective owner
would retain all necessary management capabilities across the proposed set,
even if everyone retains read and the reductions are confirmed. This protects
the last effective owner, not merely an owner role assignment.

The preview is scoped to the actor's existing authority: never disclose a
member, repository, permission or other protected detail the actor cannot
see. If the actor cannot view enough detail to make an informed confirmation,
return a safe denial or require an appropriately authorized actor; a redacted
preview is not consent to undisclosed reductions. Bind confirmation to the
actor, workspace, proposed immutable repository identities and set version,
membership/role state, evidence and exact reductions, with a bounded expiry;
it is not an authorization grant. At commit reauthorize the actor and
revalidate the complete current membership, repository set, owner and fresh
provider permissions. If any relevant fact, result or confirmation has changed
or expired, reject and require a fresh preview and confirmation. Serialize or
use equivalent version checks against concurrent repository, membership, role
and authority changes; stale decisions cannot commit. A provider change not
yet observable remains subject to the documented freshness and reconciliation
limits, not a promise of instantaneous detection.

Commit the repository-set version, approved ceiling reductions, required
revocations and durable audit evidence atomically. Failure of authorization,
revalidation, concurrency control or required audit leaves none of the
addition or its reductions committed. Invalidate old decisions and ensure no
request authorizes against the old set after commit; propagate revocations to
streams, worker steps and delivery using durable cross-process mechanisms.
Never silently remove members or expand access. Repository removal must not
automatically promote previously reduced authority; retain the audited
reapproval rule. If an external change affects the last owner, use the audited
recovery path below rather than retaining unauthorized access.

Workspace-wide membership does not authorize a multi-repository remediation
run. Existing single-repository tasks must explicitly bind their target to an
active workspace repository, and check that target plus the workspace-wide
intersection. Atomic multi-repository changes, delivery and approvals require
a separate design before implementation; this decision does not grant them.

### Repository authority and role transitions

The effective decision for a workspace action is the intersection of active
enterprise membership, assigned workspace role, the intersection of verified
current capabilities for all workspace repositories, action policy, any separate
duty or grant, and data sensitivity. Provider identities are bound to each
repository's approved provider instance and repository-scoped server integration.
Login OAuth credentials are not the
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
ceiling, but block workspace access until eligibility can be verified. Recovery
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
repository management authority across the repository set. Candidate roster incompleteness is an error,
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
Backfill each existing workspace's single repository as its first binding,
preserving its immutable provider and repository identity and uniqueness.
Keep multi-repository binding changes and the feature disabled until all
authorization paths, including legacy APIs, background workers, streams,
artifacts, memory and delivery, enforce the complete set, end-to-end tests
pass, and mixed-version protection is verified. Only then may a controlled
rollout enable the feature. Make mixed-version rollout fail closed; never let an
older single-repository server accept a multi-repository scope.
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
- Rejecting an addition that loses admission or cannot be verified preserves
  existing members during a change they did not initiate; verified reductions
  can still proceed with informed confirmation. Last-effective-owner protection
  avoids creating a workspace no authorized owner can administer, at the cost
  of delaying additions until provider authority is repaired.
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
9. With repositories A and B, write/read yields viewer ceiling; read/no-access
   and incomplete, stale or unknown evidence reject admission. Cross-provider
   capability intersections, explicit selection and invitations are tested.
10. Repository additions, removals, transfer and concurrent membership changes
    cannot leak data through old decisions, caches, streams, legacy endpoints or
    worker grants. Previously reduced access is never silently promoted.
    Existing one-repository records migrate without changing their access.
11. Addition rejects the whole change for any effective member's confirmed
    no-read or unknown, stale, incomplete or unavailable evidence, including a
    temporarily unverifiable existing member. A verified write-to-read
    reduction requires an authorized, sufficiently informative preview and
    explicit confirmation; the assigned role remains and the reduced ceiling
    persists through provider recovery until audited reapproval. An outage alone
    does not persist a downgrade. Independently granted Security duties follow
    their own contract and do not become ordinary workspace authority.
12. Adding a repository that would leave no effective owner with all required
    management capabilities fails even with confirmed read and consent. Test
    concurrent last-owner, membership, permission and repository changes,
    expired or changed previews, incomplete disclosure, audit failure and
    rollback; no stale approval, partial mutation or old-set authorization
    succeeds. Feature activation requires all-path end-to-end and mixed-version
    fail-closed verification before a controlled rollout.
