# ForgePilot governance and threat model

**Status:** Proposed

ForgePilot's first vertical slice is a constrained remediation workflow, not an autonomous repository operator. We choose explicit, per-run capability grants, deny-by-default execution, immutable audit evidence, and GitHub's protected pull-request path because a usable remediation loop must not gain a bypass around code review, CI, or release controls.

## Decision

### Scope and non-negotiable boundaries

The slice may inspect an approved repository checkout, run approved local diagnostic and validation tools, create or update a branch whose name begins `autofixer/`, and open or update a pull request for its assigned issue. It may prepare a patch only inside that checkout.

The slice must not directly write to `main`; read or write secrets; edit CI/workflow definitions; change repository governance, branch protection, or merge-queue configuration; publish a package; deploy; alter infrastructure; or invoke an external side effect not explicitly granted. A branch or pull request is a proposal, never an authorization to merge.

### Run state and risk

A remediation run has one of these states:

| State | Meaning | Allowed transition |
| --- | --- | --- |
| `requested` | A task exists but has no issued capability grant. | `approved`, `rejected`, `cancelled` |
| `approved` | Scope, risk class, and capability grant are recorded. | `running`, `cancelled`, `expired` |
| `running` | The runner may exercise only the recorded grant. | `awaiting_review`, `stopped`, `timed_out`, `cancelled` |
| `awaiting_review` | A PR for the current commit exists; no repository mutation continues. | `approved_for_merge`, `stopped`, `cancelled` |
| `approved_for_merge` | GitHub alone may admit the PR to the merge queue after all gates hold. | `merged`, `stopped` |
| `stopped` | A stop condition requires human disposition; the grant is revoked. | `cancelled`, `approved` (new grant only) |
| `timed_out`, `expired`, `rejected`, `cancelled`, `merged` | Terminal for that grant. | A new `requested` run only |

Risk is classified before `approved` as `low`, `elevated`, or `prohibited`. Low-risk work is a localized, reversible source or test change. Elevated work includes broad refactors, dependency changes, data-shape changes, migrations, permission-sensitive code, or any material uncertainty; it requires named human approval before a grant is issued. Prohibited work is every action outside the boundaries above and is rejected rather than downgraded.

### Capability model and isolation

Every grant names the repository and base commit, permitted paths, permitted tool identities and arguments, network destinations (normally none), maximum wall-clock duration, resource limits, and whether a patch/PR may be created. Capabilities compose by intersection, never by ambient identity: missing scope means denied.

The runner uses an isolated, ephemeral workspace with no inherited user credentials, SSH agent, cloud credentials, secret mounts, writable shared caches, or access to other checkouts. It receives short-lived, repository-scoped credentials only when required to push its `autofixer/*` branch or create/update its own PR. Generated artifacts are treated as untrusted input; they may be retained as evidence but are not executable authority.

Cancellation, expiry, or timeout immediately revokes run credentials, blocks further tool dispatch, and preserves the evidence bundle. Cleanup must delete only run-owned ephemeral resources; it must never delete an existing branch, PR, or shared artifact automatically.

### Audit record

For each state transition and every tool invocation, append an immutable event containing: run ID; issue and PR IDs; actor and execution identity; UTC timestamp; prior and resulting state; risk class; policy and capability-grant versions; repository URL, base SHA, branch, and head SHA; requested and actual tool/arguments; path and network scopes; redacted exit status and output digest; artifact digests; approval identities and timestamps; and the decision or stop-condition code.

Logs must be append-only, access-controlled, retained according to project policy, and correlated with the exact PR head. Secret values, access tokens, and raw sensitive outputs must be redacted before persistence. An absent or malformed audit record is a control failure and blocks `awaiting_review` and merge-queue eligibility.

### GitHub merge boundary

The runner may push only `autofixer/*` branches and create/update an issue-linked PR. Direct pushes or merges to `main` are forbidden. GitHub's merge queue is the only component permitted to merge.

For the PR's current head, entry to the merge queue requires all of the following at the same time: QA has passed; every required GitHub check has passed; all review discussions are resolved; and Luthiel and Ludwig-Planck have each approved that exact head. A new commit invalidates the prior QA result and both approvals until renewed. The runner cannot dismiss reviews, alter required checks, waive a gate, self-approve, or enqueue a PR.

### Stop and escalation conditions

Stop the run, revoke its grant, and create a human-triage record when any of these occurs: an attempted action is outside the grant; a secret or credential is detected or requested; an isolation boundary or audit write fails; unapproved network access is attempted; repository identity, base SHA, or policy version changes unexpectedly; a prohibited path is touched; validation fails; a tool exceeds resource/time limits; the PR receives a security-related review concern; or the evidence cannot be tied to the current head.

Human triage decides whether to cancel, issue a narrower new grant, or reclassify the task. It may not turn a prohibited action into an in-run exception; that requires a separately reviewed governance change.

## Threat model and controls

| Threat / failure mode | Control that can be verified |
| --- | --- |
| Prompt injection or malicious repository content induces unsafe commands | Grant allowlist constrains executable/tool arguments, paths, and network; blocked dispatch is recorded with a stop code. |
| Credential theft or leakage through logs/artifacts | Ephemeral runner has no ambient credentials or secret mounts; logs are redacted and artifact/output digests are stored; secret detection stops the run. |
| Branch-protection or main bypass | Token scope permits only `autofixer/*` push and PR mutation; GitHub audit log shows no runner write to `main`; merge queue is the sole merger. |
| Review/CI TOCTOU after a new commit | Audit binds QA, checks, resolved discussions, and both approvals to the head SHA; a head change invalidates all four conditions. |
| Unbounded or destructive tool behavior | Per-run command, path, duration, and resource limits; cancellation/timeout revoke the grant and preserve evidence. |
| Supply-chain or network exfiltration | Default network deny; every permitted destination is named in the grant and logged; unapproved egress stops the run. |
| Audit tampering or missing evidence | Append-only event store with digest chain and restricted writers; missing/invalid evidence blocks review and merge eligibility. |
| Unsafe automation loop after failure | Terminal stop states require human disposition and a new grant; no automatic retry, privilege expansion, or merge action exists. |

## Considered options

- **Broad repository token with policy checks in the runner:** rejected because a compromised or defective runner could bypass its own policy.
- **Direct merge after tests:** rejected because it omits independent QA, named owner quorum, and GitHub's protected merge boundary.
- **Human approval for every individual command:** rejected for the pilot because narrowly scoped, auditable grants preserve review at the consequential boundaries while keeping diagnosis practical.

## Consequences

The first implementation must make grant issuance, isolation, event recording, and GitHub gate evidence explicit product surfaces. It will trade some autonomy and throughput for a small blast radius and proof that every proposed change followed the same control path.
