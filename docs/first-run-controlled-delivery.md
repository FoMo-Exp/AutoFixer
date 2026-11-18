# First-run and controlled-delivery runbook

This runbook is for an operator who is starting a local ForgePilot workbench
and using the reviewed candidate-to-pull-request flow. It is an operational
guide, not an authorization to bypass repository governance. The agent never
writes `main`, approves its own work, waives checks, or merges a pull request.

## Baseline and delivery status

This document was checked against AutoFixer `main` at
`daafd060897ed0ac8cedb0e1d8702c028d2e2edb`.

| Capability | Merged implementation | Merge commit |
| --- | --- | --- |
| Runtime diagnostics and recoverable startup | [PR #84](https://github.com/FoMo-Exp/AutoFixer/pull/84) | `67b62f0` |
| Candidate review, approvals, and delivery API | [PR #87](https://github.com/FoMo-Exp/AutoFixer/pull/87) | `ef270bf` |
| Controlled GitHub delivery broker | [PR #89](https://github.com/FoMo-Exp/AutoFixer/pull/89) | `e270bf1` |
| Current-head PR governance observation | [PR #90](https://github.com/FoMo-Exp/AutoFixer/pull/90) | `70e365e` |
| Workbench candidate, delivery, and governance status | [PR #91](https://github.com/FoMo-Exp/AutoFixer/pull/91) | `b10b831` |

All listed implementation PRs were reviewed before merge. This does **not**
mean that a real provider delivery has been accepted: DAT-190 remains blocked
until an administrator supplies an isolated repository, least-privilege
provider credentials, and the required protected-branch/approval governance.
Do not represent local fixtures, mocks, or a successfully built workbench as
that end-to-end acceptance.

## Before starting

Install Go 1.25+, Node.js 20.11+, and the platform sandbox backend (`bubblewrap`
on Linux or `sandbox-exec` on macOS). On macOS the runner refuses untrusted
execution because it cannot guarantee descendant-process reaping.

Keep all tokens and provider secrets out of shell history, issue text, logs,
and screenshots. Gateway and OAuth files are protected deployment inputs; use
owner-only permissions. Do not set ambient provider credential variables such
as `ANTHROPIC_API_KEY`: startup deliberately blocks that bypass path.

Choose a pinned, reviewed base and one private state location per orchestrator.
The following values are the minimum local composition; replace paths and the
approver identity for the environment, never with secret values in this file.

```sh
export FORGEPILOT_BASE_SHA="$(git rev-parse HEAD)"
export FORGEPILOT_DSH_SOCKET=/tmp/autofixer-dsh.sock
export FORGEPILOT_APPROVER_IDENTITY=github:local-operator
```

The base SHA is required and must be a 7--40 character hexadecimal commit id.
`FORGEPILOT_BASE_REF` defaults to `main`. The Node service binds to loopback by
default and its API bearer token is written to a `0600` file. For persistent or
enterprise operation, explicitly set the task state, gateway audit, and (when
identity is enabled) control-plane paths to a private location.

For model egress, configure both of the following protected files:

| Setting | Purpose |
| --- | --- |
| `FORGEPILOT_GATEWAY_POLICY_FILE` | One scoped policy per enterprise/workspace pair; allow-listed endpoints, models, retry, and fallbacks. |
| `FORGEPILOT_GATEWAY_CREDENTIALS_FILE` | `credentialRef` to provider-secret mapping. Credentials are referenced by policy, never embedded in it. |

The policy scope is resolved from the caller's live workspace membership for
each dispatch. Missing, revoked, ambiguous, or mismatched membership denies
model egress; the legacy deployment workspace variables are not a model-egress
default.

## Start and diagnose

Build dependencies, then start the local dsh authority before the workbench:

```sh
go run ./cmd/autofixer dsh serve \
  --socket "$FORGEPILOT_DSH_SOCKET" \
  --approver "$FORGEPILOT_APPROVER_IDENTITY"

(cd node && npm install && npm run build)
(cd web && npm install && npm run build)

(cd node && npm run doctor)

cd web
npm start
```

Run `npm run doctor:json` when a machine-readable report is needed. The
diagnostic is read-only and redacted: it never creates, repairs, truncates, or
prints protected values. It reports these independent readiness boundaries:

| Boundary | Ready means | Typical blocked condition |
| --- | --- | --- |
| `startup` | The process can serve. | Invalid configuration, unsafe ambient credential, or corrupt/unwritable startup state. |
| `task` | A remediation run can begin. | dsh or boot token unavailable, invalid pinned base, or unrestorable task projection. |
| `model` | Model bytes may leave the host. | No Pi model, no valid policy/credential pair, invalid gateway configuration, or no authenticated workspace scope. |

Exit `0` means ready or degraded only; `1` means a boundary is blocked; `2`
means startup itself is blocked. Treat `blocked` as a stop, follow the report's
`next_action`, and run the diagnostic again. `degraded` is a warning, not a
silent success. While the service is running, an operator bearer may read the
same schema at `GET /api/v1/runtime/diagnostics`; user sessions are refused
because deployment readiness is not tenant data.

Only one orchestrator may use a given state directory. The task projection,
budget journal, control-plane SQLite database, and JSONL audit streams are
single-writer. Use distinct `FORGEPILOT_*_FILE` values for another instance.
If a task projection is corrupt, move it aside only after preserving it for
incident review; the next start has an empty projection and does not recover
the persisted tasks.

## Operate a reviewed change

1. Sign in and select a workspace. The server verifies live membership for
   every workspace-scoped request; a viewer is read-only. A revoked membership
   becomes an indistinguishable `404`, so stop rather than trying another
   workspace identifier.
2. Create or select the product issue and start a bounded run with its approved
   repository, pinned base, scope, limits, and capability grant. A stop
   condition needs a human disposition and a fresh run/grant; it is not a
   resumable execution button.
3. Review the frozen candidate before requesting approval. Check its summary,
   changed paths, diff, validation evidence, repository, base SHA, head SHA,
   and candidate/diff/test digests. A candidate is immutable; no provider
   branch or PR exists at this point.
4. An eligible human requests and decides the change approval. Eligibility is
   a live `owner` or `admin` workspace role plus current, non-unknown provider
   repository access. The decision must carry the reviewed `diff_digest`; the
   authenticated human, not a deployment bearer or agent, is the approver.
5. Request controlled delivery only with the current approved approval and its
   delivery grant. The broker re-checks approval, permission, grant, audit,
   branch constraint, and exact candidate identity immediately before each
   provider write. It can create or update only the approved `autofixer/*`
   branch and corresponding PR; it has no direct-main, merge, self-review,
   force-push, close, delete, or waiver operation.
6. Record the returned delivery id, state, branch/PR evidence, candidate head,
   approval id, grant id, and time in the change record. A `202` records an
   operation; it is not a claim that a PR was created or merged.

Approval validity is bound to the candidate, diff and test evidence,
repository/base/head, target branch, policy, and authority. A rebase or other
head change, altered diff or test evidence, policy change, role/repository
access change, issue cancellation, or expiry invalidates it. Do not attempt to
revive the approval: produce and review a current candidate, then request a
new approval.

## Delivery outcomes and reconciliation

| State | Meaning | Operator action |
| --- | --- | --- |
| `delivered` | Provider evidence confirms both the approved branch and PR. | Continue with the repository's normal human review and merge process. |
| `partial` | One provider write is confirmed and the other is not. | Do not call it success or retry delivery. Reconcile the same operation. |
| `unknown` | The provider outcome cannot be determined, including an unreadable pre-write PR probe. | Do not treat it as "no PR" and do not retry. Reconcile first. |
| `pushing` / `opening_pr` | A write was recorded before the provider call; a crash can leave an orphan. | Check whether a live writer remains, then reconcile evidence. |
| `failed` / `cancelled` | No completed delivery is established. | Read the recorded reason and create a new authorized path only when appropriate. |

Use the delivery card's **Reconcile outcome** action (or
`POST .../deliveries/{delivery_id}/reconcile`) for `unknown`, `partial`,
`pushing`, or `opening_pr`. Reconciliation reads provider branch and PR
evidence but performs no provider write, then records `delivered`, `partial`,
`failed`, or `unknown`. If the provider is unavailable, it remains unreconciled
and a retryable `503 PROVIDER_ERROR` is returned. An approval is consumed once;
another delivery request for it is rejected.

## Inspect the delivered PR

Read the delivery's governance observation from the workbench or:

```text
GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/deliveries/{delivery_id}/governance
```

The observation is read-only and names `delivery_head_sha`, the provider's
`head_sha`, and `observed_at`. It reports checks, latest decisive approvals,
and unresolved review discussions only for that exact current head. A new head
never inherits old observations.

`conditions_satisfied` means only that this read could observe an open PR with
checks, approvals, and discussions in the required observed state. It is **not**
merge eligibility. The record intentionally cannot establish the QA verdict,
branch-protection required check set, merge-queue availability, conflict state,
or a state after the response.

Treat `blocked`, `unknown`, `superseded`, unreadable rows, a head change during
the read, or a PR state race as unmet conditions. Do not reuse an earlier green
result. A closed or merged final PR state is reported as not open; a missing
PR has no governance observation; no governance endpoint can approve, dismiss,
waive, rerun, merge, or change delivery state.

## Restart, audit, and handoff

The durable task projection re-associates tasks with dsh runs after a normal
restart, and the issue event stream replays durable events from `Last-Event-ID`
in sequence order. Deduplicate events by `event_id`; do not invent a cursor or
interpret a server cursor. Preserve the candidate/approval/delivery bindings,
evidence bundle, audit records, and PR URL/SHA before changing deployment
configuration or state files.

For a handoff or incident record, capture only redacted facts: runtime report
status and timestamp, issue/run/candidate/approval/delivery ids, base and head
SHAs, grant id, delivery state, reconciliation result, governance observation
time and validity, and the next human action. Never attach boot tokens,
provider credentials, OAuth secrets, bearer tokens, or raw protected files.

## Verification and known limits

The commands below are the repository's applicable checks for this document
change. They validate the existing codebase and the new documentation link;
they do not perform a provider write or satisfy DAT-190:

```sh
go test ./...
(cd node && npm run typecheck && npm run lint && npm run format:check && npm test)
(cd web && npm run typecheck && npm run lint && npm run format:check && npm test && npm run build)
```

Unexecuted by this runbook: a real isolated-repository write, protected-branch
and merge-queue checks, a two-person approval, rejection/rollback exercises,
and the corresponding DAT-190 acceptance package. These require explicit
administrator-provided environment, credentials, repository scope, and human
authorization.
