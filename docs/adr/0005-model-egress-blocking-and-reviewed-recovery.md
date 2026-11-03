# ADR 0005: Fail-closed model egress and independently reviewed recovery

**Status:** Proposed — product decision confirmed by the requester;
repository QA and merge pending.

**Date:** 2026-11-03

## Context

The next product stage is a shared enterprise service, initially deployed
privately for one enterprise while preserving enterprise and workspace
boundaries. Code and logs must not reach external models by default. Only
explicit enterprise-administrator configuration may enable a destination
and its permitted data classes; a workspace may restrict that policy further.

The requester confirmed that uncertain secret removal must block a model
call and require human handling. On 2026-11-03 the requester also confirmed
that phase one must provide no per-call human exemption, including for a
suspected false positive. Rule correction, independent review, and a new
scan of the complete request are mandatory.

An administrator's endpoint configuration, a remediation approval, and a
security investigation each answer different questions. None alone proves
that a particular outbound request is safe. A convenient "send anyway"
button would undermine the deny-by-default boundary and allow agents or
operators to turn uncertain detections into data disclosure.

This ADR specifies the future model-egress boundary. It does not claim that
the shared service, gateway, isolation, or recovery workflow exists today.
It preserves ADR-0003's dsh execution authority and does not amend
ADR-0001's repository review or merge requirements. Migration of the
desktop credential boundary in ADR-0004 needs a separate decision.

## Decision

### 1. Enforce one fail-closed model-egress path

All Pi model requests must pass through a service-controlled model gateway.
Agent and execution environments must be prevented from directly reaching
unapproved model endpoints. Agents cannot change policy or obtain gateway
provider credentials. An internal endpoint is explicitly registered and
validated; a private-looking hostname alone is insufficient evidence of trust.

If a suspected secret is detected and removal cannot be established by the
configured checks, the gateway must send no request bytes to the model and
must block the affected invocation. This secret-handling gate applies to
internal and external models; enabling external egress never bypasses it.
Unavailable scanners, unknown classification, missing authorization, or an
unavailable required audit sink also fail closed.

Phase one has no per-call exemption in the UI, API, tools, administrative
interface, or recovery path. No user, including an enterprise administrator,
can approve a blocked payload for immediate transmission. Switching model,
retrying, summarizing the material, or using a fallback cannot bypass checks.
Derived summaries retain the source's classification unless a separately
authorized deterministic policy permits a change.

### 2. Open a scoped human-handling case

Blocking creates or idempotently associates a case with the enterprise,
workspace, issue, run, invocation, and trace identifiers. Pause the affected
run's dependent work; unrelated runs need not stop. Do not silently retry or
replay the quarantined request. This handling state must not silently redefine
the existing harness stop-condition or terminal-state semantics; a future
runtime contract must specify how continuation is represented.

Notify the workspace's designated security handler, escalating to the
enterprise security administrator when nobody is available. Notifications
contain a redacted reason and an authenticated case reference, never the
suspected secret or a transferable credential to view it.

Use case states `pending`, `handling`, `awaiting_review`, `resolved`, and
`terminated`. A failed review returns the case to handling with an append-only
history. `resolved` means handling and required checks succeeded; it does not
assert that a model call was sent. Record dispatch separately.

Raw retained context, if needed, belongs in encrypted, access-controlled
quarantine with a retention limit. Viewing it requires separately granted,
scoped access and produces an audit event. Ordinary logs, notifications,
analytics, and agent-visible errors contain no secret values.

### 3. Separate handling, review, and policy administration

| Responsibility | Authority | Restriction |
| --- | --- | --- |
| Task owner | Read redacted status; request termination or reassignment | Cannot view quarantined values or unblock a call by task ownership alone |
| Security handler | Inspect authorized minimum context; propose content removal or rule correction | Cannot approve their own handling or rule change |
| Independent security reviewer | Review evidence, scope, expiry, and proposed correction; approve rechecking | Must be a different human principal from the handler or change author; cannot skip checks |
| Enterprise security administrator | Grant scoped security roles; configure approved endpoints and permitted data classes; activate reviewed rule revisions | Administrative status does not waive independent review or authorize blocked payload transmission |
| Agent | Receive redacted actionable errors and prepare non-sensitive assistance | Cannot approve, change rules, access quarantined values, or resume itself |

Role combinations never permit self-review on the same case or change.
If no independent reviewer is available, remain blocked and escalate.
Repository ownership does not automatically grant these security privileges.
Diff/PR approval remains independent of security recovery approval.

### 4. Correct data or rules without creating an exemption

For genuine secrets, remove the material or narrow the context and handle
credential revocation/rotation through the enterprise's incident procedure.
Rotation alone does not authorize sending the original value. Reconstruct
the minimum necessary request from approved sources after handling.

For false positives, submit a versioned rule correction with a reason,
bounded applicability, expiry or review date, and regression evidence that
true-secret detection remains effective. An independent reviewer must approve
it before an authorized administrator activates it. Activation and rollback
are versioned and audited; rollback cannot restore a superseded approval.

A rule cannot select an invocation, case, request digest, or individual secret
value merely to authorize that blocked request. A whole-detector disable or
blanket allow rule is not a false-positive correction. Review must check for
these disguised exemptions. Rule changes are policy changes, not run grants;
the same complete-request checks still apply after activation.

### 5. Bind recovery to a freshly checked complete request

Recovery approval binds the reviewed context revision, enterprise, workspace,
issue, run, case, destination/model, and applicable policy and rule revisions.
Use an expiring, single-use recovery authorization; it authorizes rechecking,
not bypass. Revoked identity, expired authorization, or changed relevant
context, destination, policy, or rules invalidates the approval.

Rebuild the entire request, including system messages, user input, history,
code, logs, diffs, tool results, and any derived summaries. Apply current
authorization, destination, classification, minimization, and secret checks.
Continued uncertainty keeps the request blocked. A passing scan means only
that the configured checks passed; it is not proof of absence of secrets.

Bind the scan result to an immutable representation of the final provider
request and its destination. The adapter must not add unchecked content
after scanning. Record the required audit evidence durably before dispatch,
revalidate relevant authorization at dispatch, and atomically consume the
recovery authorization so concurrent workers cannot send it twice.

Every retry is another invocation subject to the same gateway checks and
auditing. An unknown provider outcome after a timeout must be recorded as
unknown, not reported as "not sent" or automatically replayed under the
consumed authorization. Fallbacks require their own authorized destination
and applicable approval. Clearing a security case never authorizes a PR,
repository write, or merge.

### 6. Keep a durable, non-secret audit trail

Record detection and blocking, assignment/escalation, sensitive-context
access, handling, rule proposal/review/activation/rollback, approval,
recheck results, authorization invalidation, dispatch attempts/outcomes,
and termination as distinct events. Include:

- Enterprise, workspace, issue, run, case, invocation, and trace identifiers.
- Human/service identity, effective role, timestamp, action, reason, result,
  and independent-review relationship.
- Destination/model identity, data classes, protected source references,
  policy and detector/redaction versions, and scan result.
- Protected context-revision identifiers, recovery-authorization lifecycle,
  and linkage from the original block to the actual dispatch attempt.

Use protected keyed identifiers where content correlation is needed, not
plain hashes of low-entropy secret values. Never copy secrets into audit
events. Protect audit records against ordinary modification/deletion, restrict
reads/exports, and audit those accesses. Retention and deletion follow the
enterprise's separately defined lifecycle, including quarantine expiry.
Runtime traces and billing analytics may reference events but cannot replace
the security audit trail. Failure to persist required pre-dispatch evidence
blocks dispatch; later outcome-recording failures must raise an explicit
operational incident without replaying the request.

Expose stable, redacted errors such as `SENSITIVE_DATA_UNCERTAIN`,
`SECURITY_REVIEW_REQUIRED`, `RECOVERY_APPROVAL_INVALID`, and
`MODEL_EGRESS_DENIED`, with stage, trace/case reference, retryability, and
an authorized next action. No instruction may advise the agent to bypass
the gate. These are future error-contract requirements, not existing API fields.

## Consequences and rejected alternatives

The decision trades slower recovery and additional reviewer availability
requirements for a consistent enterprise-controlled data boundary. False
positives require maintained rules and regression evidence. Gateway and
network enforcement, protected quarantine, versioned policies, and durable
audit are necessary implementation work; this ADR provides none of them.

Rejected alternatives are one-click "send anyway", administrator-only
per-call overrides, agent self-approval, treating internal models as exempt,
reusing a previous scan after request mutation, and recording an exemption as
a narrowly targeted detector rule. Each would let a blocked request avoid
the independently reviewed, complete-request validation path.

## Implementation acceptance

Future implementation issues must demonstrate that:

1. Uncertain secret removal sends zero model-request bytes, including through
   internal models, retries, alternate endpoints, and fallback paths.
2. All human and agent interfaces reject per-call bypass; unavailable
   scanners, missing independent review, and failed required pre-dispatch
   audit writes remain blocked.
3. A false-positive correction cannot target one invocation or secret value;
   activation requires a different human reviewer's approval and regression
   evidence; the complete reconstructed request is scanned again.
4. Context/endpoint/policy changes, expiry, revocation, concurrent recovery,
   worker crashes, and unknown provider outcomes cannot reuse approval or
   silently duplicate dispatch. Audit distinguishes approval from sending.
5. Notifications, errors, traces, analytics, and audit exports do not expose
   secret values; quarantine access and policy changes are independently
   authorized and auditable across workspace boundaries.
6. Every implementation uses a `main`-based linked PR with applicable
   lint/format/type checks and tests; it moves to `in_review` with the exact
   QA mention and current remote head, and to `done` only after QA passes.

This documentation PR validates the decision and its consistency only.
Passing document review does not certify the future controls as implemented.
