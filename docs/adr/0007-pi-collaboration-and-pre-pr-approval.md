# ADR 0007: Durable Pi collaboration and approval before PR delivery

**Status:** Proposed — requester requirements with reviewable design defaults;
no production workflow is claimed as implemented.

**Date:** 2026-11-03

## Context

The enterprise product must accept developer-created issues and eventually
observe a log system, diagnose defects, prepare fixes, run local validation,
and send a summary/diff card to a responsible developer before any PR.
The requester wants Multica-like agent collaboration using Pi, adapted to
this product, with blame/team-assisted assignment and manual reassignment.

Existing dsh exposes echo/sleep, creates no patch, and grants no PR writes.
Current harness awaiting_review means a PR exists. Its stopped state revokes
the grant and requires human disposition; validation failure is a stop
condition. A new pre-PR workflow must not relabel those states or add an
automatic repair loop around their controls.

## Decision

### Durable issue orchestration, bounded execution

The shared service owns durable issues, child tasks, dependencies, agent
assignments, leases, handoff artifacts, notifications, and human decisions.
One issue can have several bounded remediation runs. Roles are Pi
configurations for analysis/planning, implementation, and independent
verification; the service routes tasks to specific agents, not an implicitly
distributed squad. Start with these roles, not a general-purpose agent market.

Each run gets a repository/base revision, isolated worktree, tool/path/network
scope, duration/resource and token/cost limits, and auditable grant. dsh checks
execution authority; the model gateway independently enforces ADR-0005.
Agents cannot grant capabilities, change policy, approve, merge, or acquire
ambient host credentials. Untrusted code, logs, comments, and inter-agent
messages are data, never authorization. Structured tool calls are revalidated.

Lease/fencing tokens prevent two workers mutating one run; queue delivery is
at least once, so state transitions and external operations need operation
IDs and deduplication. Handoffs persist bounded summaries plus immutable
artifact references and head identity, not another agent's raw memory.
Different runs use separate worktrees. No concurrent edits to a shared checkout.

On restart, reconstruct only persisted state and authorized context; do not
claim the current Pi session can resume. Lost leases, missing artifacts, or
uncertain mutations require reconciliation. Expired or revoked grants never
revive. A stopped or terminal harness run cannot be automatically restarted
by a queue retry or a model's follow-up message.

### Log intake and issue creation

Use a service-owned connector/daemon per configured log source, supervised
independently of clients. Its credentials are read-only and source-scoped.
Persist cursors/checkpoints, acknowledge only durable intake, and deduplicate
provider event IDs or versioned fingerprints. Backpressure, reconnects,
overlap replay, retention gaps, and out-of-order events have explicit outcomes.
The initial connector target remains to be selected; no generic adapter is
claimed to support every log provider.

Before model analysis, deterministic rules select severity, service/environment,
error signature, rate/window, suppressions, and repository mapping. Suppression
is audited; ambiguous repository mapping needs triage. Correlate events with
an open issue, enforce source/workspace budgets and cooldowns, and allow manual
issue submission. A repeated alert updates evidence instead of spawning
unbounded tasks. Send only permitted, minimized data through ADR-0005.

Map stack locations to deployed release/build SHA where available, then to
the chosen repair base; do not blame current main as though it were necessarily
the deployed version. If version/location mapping is uncertain, expose it and
avoid pretending blame proves ownership or root cause. A log is a signal,
not permission to change code.

### Routing and responsibility

Resolve candidates deterministically from configured ownership paths/team
rules, CODEOWNERS where applicable, verified provider identities, and blame
on relevant revisions. Ignore cosmetic/bulk changes where evidence supports
doing so. Match stable provider identities; an author email is not an account.
Weight affected substantive code rather than raw line count alone, recording
sources, ambiguity, candidate eligibility, and routing-policy version.

An LLM may recommend the main responsible developer or a configured team's
active leader using these bounded candidates and descriptions. The routing
tool accepts only current eligible workspace members; arbitrary model names
or confidence assertions cannot assign privileged work. Routing makes an
assignee, not an approver. If confidence is insufficient, enter manual triage.
No candidate, departed author, inactive leader, or unmapped service falls
back to an eligible configured owner/admin triage queue; if nobody qualifies,
remain unassigned and alert the enterprise operator.

Members may propose transfer; an assignee or owner/admin may confirm it under
workspace policy. The service validates the destination and audits reason,
actor, previous/new assignee, and evidence. A transfer cannot bestow approval
rights. Role revocation or a changed reviewer invalidates pending approval
requests and creates a newly addressed request.

### Product lifecycle and the existing harness

Use product issue states, distinct from harness execution states:

| Product stage | Required evidence or action |
| --- | --- |
| triage | Deduplicated signal/manual issue, repository and routing context |
| planning | Bounded diagnosis and proposed scope; human grant if elevated |
| implementing | Authorized code read/search/edit in an isolated checkout |
| validating | Approved test plan against the exact candidate revision |
| awaiting_change_approval | Immutable candidate, passing required checks, summary/diff card |
| delivering | Current approval and separate delivery grant; broker-controlled push/PR |
| pr_review | Provider PR exists; repository review/check/merge requirements apply |
| completed | Provider-confirmed merge under the repository's gates; published PR alone is not completion |
| needs_human / cancelled | Stop reason or cancellation with grants revoked |

Completion of local preparation stops the execution run and revokes its grant
while preserving the candidate. awaiting_change_approval is a product state;
it does not map to harness awaiting_review. After approval, delivery uses a
new explicitly scoped run/grant bound to the candidate. Harness awaiting_review
is used only once a PR actually exists. Security blocks follow ADR-0005 and
human disposition; continuation requires a fresh grant/run or the existing
stopped-to-approved path with a new grant, never stopped-to-running.

Independent verification reviews the exact candidate and its test evidence.
Agents may not generate a QA pass for their own implementation. Validation
failure, uncertain scope, or security concerns stop under ADR-0001; human
disposition is required before another implementation attempt. Agent review
feedback may propose corrections but cannot silently reissue grants. Cap
verification-requested revisions at two after the initial attempt; the third
failed verification escalates once to human triage. Duplicate events or agent
messages do not restart review of the same revision.

### Code, validation, and immutable candidates

Register structured dsh read/search/edit/test operations rather than exposing
raw Pi shell/file tools. Fetch a pinned repository revision through an approved
read broker. Enforce path/symlink containment, prohibited paths, allowed edits,
test command profiles, resource limits, and approved dependency access.
The runner needs OS-enforced process/filesystem/network isolation for untrusted
tests; the current temporary-directory runner alone is insufficient. Dependency
preparation must also be isolated and not execute install scripts with control-
plane credentials. Dependency/workflow/migration changes retain elevated or
prohibited classification under ADR-0001; no implicit expansion.

Freeze a patch artifact with base SHA, candidate tree/commit identity, diff
digest, changed paths, validation configuration/environment identity, test
results, and audit references. Preserve it outside the ephemeral workspace
before cleanup. Pre-PR reviewers see a summary card expanding to authorized
diff, tests, risks, and provenance. Notifications have authenticated links,
not bearer approvals or sensitive previews; approval uses a confirmed,
authenticated mutation in either client.

### Approval and delivery

Proposed phase-one default: one eligible named human delivery approver,
selected from workspace-configured maintainers, must approve the frozen
candidate before any remote branch push or PR mutation. Assignee/blame/team
leader status alone is insufficient; current repository access and explicit
approval authority are checked. Stricter enterprise rules compose by
intersection. The separate PR review still requires the repository's applicable
non-author/QA/check/quorum policy. Security-case review never substitutes.

Bind approval to enterprise/workspace/issue, candidate and diff digests,
repository identity, base and candidate SHA, test-evidence digest, intended
target branch, approver, and policy version. Content, required test evidence,
base advancement, target, approval policy, expiry, or relevant authority changes
invalidate approval. Refresh/rebase and rerun tests, then request a new card;
never rebase after approval and push under the old one. Set a finite configurable
approval TTL; proposed default is 24 hours.
Closing a PR without merge enters needs_human or an explicitly recorded human
cancellation. No state change deploys the change or claims the incident is fixed
in production; incident recovery needs its own observed evidence.

Only the trusted delivery broker can obtain provider write credentials.
It checks current human approval, enterprise/repository permissions, dsh grant,
audit availability, branch constraints, and exact candidate identity before
each write. Publish only the approved tree/commit; no generated files or edits
may be added after validation. Restrict writes to the issue's autofixer branch
and PR; no direct main write, merge, self-review, check waiver, or queue admission.
GitLab merge-request delivery requires a reviewed mapping to that provider's
repository governance before enablement; GitHub queue semantics must not be
silently advertised as implemented GitLab protection. Unsupported governance
or missing integration permissions leave delivery blocked.

Persist operation identity and intention before writes. Reconcile ambiguous
push/PR outcomes by branch and provider operation evidence before retrying;
do not create duplicate PRs. A pushed branch with failed PR creation remains
an explicit partial delivery, not success or automatic deletion. Cancellation
revokes remaining actions but cannot undo a completed provider side effect.
Approval is consumed by its delivery operation; safe retries reconcile that
same operation, never reuse it to authorize a new candidate or PR.

## Consequences and rejected alternatives

This carries over Multica's specific assignments, dependency gates, immutable
revision handoffs, independent verification, and bounded escalation, with a
new human pre-PR boundary. It rejects copying implicit mention-triggered work,
unbounded automatic repair, model-assigned privileges, raw shell access,
blame-only authority, and PR creation as a substitute for human preview.
Worker isolation, connector choice, repository tools, and API contracts remain
implementation work. ADR-0006 governs access; ADR-0008 governs observability.

## Implementation acceptance

1. Replayed/out-of-order log events do not duplicate issues or runs; ambiguous
   release/repository mapping and source outages surface actionable triage.
2. Routing handles multiple authors, departed members, missing leaders,
   unmatched identities, manual transfers, and insufficient confidence.
3. Lease expiry/crash/restart never mutates a shared worktree or revives grants;
   verification failures and security blocks require the stated disposition.
4. No branch push or PR exists before a valid candidate-bound human approval;
   stale/reassigned/revoked/expired approvals fail, including concurrent workers.
5. Untrusted tests cannot access control-plane secrets or unapproved network;
   artifacts and results bind exactly to the approved revision.
6. Changed bases, provider drift, partial delivery and unknown outcomes have
   auditable reconciliation; retries never merge, self-approve, or duplicate PRs.
7. API/OpenAPI contracts merge before dependent frontend implementation.
   Main-based linked PRs need applicable checks, new-head in_review/QA gates,
   and QA pass before done. Design review is not runtime certification.
