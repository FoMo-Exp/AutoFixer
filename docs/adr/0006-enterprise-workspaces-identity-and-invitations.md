# ADR 0006: Enterprise workspaces, identity, and secure invitations

**Status:** Proposed — confirmed product direction; detailed defaults require
review. No enterprise functionality is claimed as implemented.

**Date:** 2026-11-03

## Context

The requester selected an enterprise shared service, initially deployed
privately for one enterprise while retaining enterprise/tenant boundaries.
Developers sign in with GitHub or GitLab. Each workspace represents one
repository, with administrator-selected membership or owner-created invitations.
Both browser and desktop clients must support the shared workflow.

Today the workbench stores operator-owned provider tokens in Electron and
the Node service accepts one configured pilot repository. Neither is an
enterprise identity or authorization system. ADR-0004 intentionally limits
those tokens to desktop discovery. Server-side discovery and execution
therefore need a distinct credential boundary.

## Decision

### Service, data, and client boundaries

Use a centrally operated control plane for identity, membership, issues,
coordination, approvals, and audit. Isolated workers execute tasks through
Pi and dsh; durable task processing does not depend on client uptime.
Start with a modular service and explicit worker boundaries rather than
requiring independently deployed microservices for every module.

Represent enterprises explicitly, even when the installation serves only one.
An enterprise owns its workspaces, users' memberships, policies, credentials,
tasks, and artifacts. Requests resolve enterprise/workspace scope from an
authenticated membership; client-provided IDs are never sufficient authority.
Scope storage lookups, queues, worker leases, caches, artifact links, searches,
exports, and SSE subscriptions, including same-enterprise workspace boundaries.
Use a transactional store for control-plane state and a separately protected
artifact store; exact database and queue products remain implementation choices.
Data ownership and consistency requirements do not depend on those choices.

A workspace binds a provider installation/instance and immutable repository
ID, not a mutable URL. Within one enterprise a repository has one active
workspace. Creation/archival/restore enforce that uniqueness transactionally.
Renames update metadata. Repository transfers require authority revalidation;
they never silently change the enterprise or expand credentials. Initial
delivery supports multiple repositories as separate workspaces, not one
multi-repository remediation task or a multi-tenant SaaS claim.

Browser and desktop use the same service authorization and core UI/API:
workspace/team administration, issue submission, task progress, diff/test
review, approval, trace, and analytics. Desktop additionally offers system
notifications and explicit IDE/local-directory actions. It does not host the
enterprise daemon or retain Git/model service credentials. Browser is the
primary complete client; desktop absence cannot prevent approval or operation.

### Login and repository integration are separate

Use registered provider OAuth authorization flows with state, exact redirect
validation, PKCE where supported, and server-side session establishment.
Desktop starts authentication in the system browser and completes a bound,
single-use callback; it does not collect Git passwords or embed a login page.
Web sessions use protected cookies and CSRF protection. Logout, suspension,
and revoked membership invalidate authorization and subscriptions. Do not
link identities by email or blame author name: use provider instance and
stable subject ID; account linking requires proof of both identities.

The first enterprise administrator is established through a deployment-owned,
audited bootstrap process, not whichever public Git account signs in first.
Provider instance origins are administrator-approved to prevent arbitrary
self-hosted URLs from becoming credential-exfiltration or internal-network
request endpoints. Authentication support for self-hosted variants must be
verified by their adapters before advertising compatibility.

Use a separately installed, repository-scoped service integration for member
discovery and authorized checkout/delivery. Prefer provider application or
equivalent short-lived service credentials where available. Provider adapters
must advertise effective permission visibility and token limitations; missing
permissions or incomplete roster pages are an error, not an empty member list.
Do not assume provider tokens can enforce branch-name limits themselves;
a trusted delivery broker also enforces branch and operation restrictions.

Secrets live in the server credential boundary, separate from Pi, renderer,
ordinary application logs, and task workspaces. Checkout gets only required
read capability; delivery gets narrowly scoped, expiring write capability.
Model calls follow ADR-0005. For the future shared-service deployment only,
this replaces ADR-0004's desktop-only discovery holder with a service-side
integration. Existing local-prototype behavior remains unchanged until an
explicit migration removes that mode's token dependence. No silent PAT upload,
automatic token migration, or reuse of login credentials for service execution.

### Membership and teams

An owner/admin with current repository administration authority may import
eligible members, inspect provenance of effective provider roles, and select
who joins. Provider organization owners, groups, inherited roles, and direct
collaborators are normalized explicitly; do not invent a GitHub repository
"owner" user when authority belongs to an organization. Workspace roles are
owner, admin, member, and viewer, assigned only within the actor's authority.
Enterprise administration does not automatically grant repository data access.

Effective access intersects enterprise membership, workspace role, current
repository access, and action policy. Sync provider events plus periodic
reconciliation. Revocation is enforced on reads, streams, artifacts, approvals,
and writes; stop affected execution and revoke capability grants when source
authority is lost. New sensitive actions require fresh provider verification;
unknown or stale authority blocks those actions pending reconciliation.

Owner/admin manages teams, active leaders, and responsibility descriptions or
path mappings. Leaders must be active workspace members; team membership
does not itself grant repository access, security privileges, or delivery
approval. Team ownership is a routing signal, not an authorization source.

### Owner-created invitations

Both QR and copied code convey the same opaque bearer invitation. The QR
opens the trusted service's invitation screen; consuming it always requires
login, an explicit join confirmation, and live eligibility checks.

Proposed defaults are 24-hour expiry, one redemption, and member role only;
owners may shorten expiry or bind a verified provider subject. Administrative
role elevation is a separate audited action. Use at least 128 bits of random
entropy, a URL-safe QR value and a grouped copyable code; store only a keyed
token digest. Never include a raw invitation in telemetry, referrers, error
messages, analytics, or third-party assets. The landing page must not consume
the token on GET, including link previews or security scanners.
Use a URL fragment for the QR bearer value, clear it from browser history
after capture, and submit it only in the authenticated confirmation POST
body; copied codes follow the same path. Do not load third-party scripts on
this screen, and exclude sensitive request bodies from proxy/application logs.

Redemption transactionally checks expiry, revocation, remaining uses, intended
enterprise/workspace/subject, inviter's current authority, existing membership,
and invitee's current repository access. It atomically adds membership and
consumes the invitation, deduplicating same-subject retries. Concurrent
redeemers cannot both succeed. Login alone or possession of a leaked code
never grants repository access. Rate-limit by actor and request origin and
return non-enumerating errors. Owners can revoke invitations; authority loss
invalidates outstanding invitations. No short, guessable numeric join codes.

Audits record creation, revocation, attempted redemption, result, effective
roles, policy versions, and identity, never the bearer token. An expired,
revoked, forwarded-to-ineligible-user, or wrong-subject invitation stays denied.

## Consequences and rejected alternatives

Central service ownership enables durable collaboration and removes client
uptime dependency, but introduces identity, credential, revocation, and
operator responsibilities. Provider-specific differences remain visible.
Reject email-based identity matching, client-authoritative roles, universal
PATs, direct worker-held write credentials, public reusable join codes, and
invitations that independently grant repository permission.

No provision here relaxes ADR-0001's repository governance or ADR-0005's
no-exemption policy. Detailed API/OpenAPI contracts must merge before
dependent frontend implementation starts.

## Implementation acceptance

1. Two workspaces cannot read each other's tasks, streams, artifacts,
   search results, invitations, credentials, or analytics by substituting IDs.
2. OAuth callback replay/login CSRF and email-based account takeover fail;
   administrator bootstrap cannot be captured by the first ordinary login.
3. Incomplete provider rosters surface explicitly. Removal, stale authority,
   rename, transfer, and organization-owned repositories have tested outcomes.
4. Invitations reject expired/revoked/wrong-subject/ineligible redemption;
   concurrency, link previews, leakage, and retry tests verify one-time use.
5. Desktop and browser exercise the same service authorization; secrets
   never enter renderer responses, Agent environments, or analytics.
6. Changes use main-based linked PRs, applicable checks, in_review and exact
   QA mention on a new remote head; done requires QA pass. This ADR-only
   review certifies design consistency, not implemented controls.
