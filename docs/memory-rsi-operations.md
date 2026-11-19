# Memory and RSI operations handbook

This handbook is for a workspace owner, administrator, or designated operator
who needs to collect reviewable evidence for workspace-memory distillation and
bounded RSI. It describes the controls that already exist in AutoFixer `main`;
it does not authorize a provider call, promote memory, change a guardrail, or
enable production RSI.

Use the linked contracts for field-level and HTTP details:

- [Real-model distillation verification pack](real-model-distillation-verification.md)
- [RSI offline drill](rsi-offline-drill.md)
- [Memory distillation contract](contracts/memory-distillation-v1.md)
- [Memory governance contract](contracts/memory-governance-v1.md)
- [Bounded RSI contract](contracts/memory-rsi-v1.md)

## 1. Read this before operating

There are three different kinds of result. Do not combine their labels in a
ticket, report, or workbench record.

| Result | What it establishes | What it does not establish |
| --- | --- | --- |
| Scripted or fixture result | The offline harness and its automated control path ran. | A real provider was called or its output is accepted. |
| Synthetic RSI drill | The in-memory, synthetic governance rehearsal passed. | Production enablement, real tenancy, a live model/gateway call, or live dsh execution. |
| Real-provider verification | The real-mode automated chain verified one trusted captured outcome through the approved gateway. | Human approval/promotion, an unrestricted rollout, or an authority change. |

A fixture evidence document is labelled `fixture_local_provider` and has
`accepted_as_real_model_evidence: false`. A real-mode document can set that
flag only when its automated chain is `verified`; it still has the
`HUMAN_REVIEW_REQUIRED` blocker. Treat a missing evidence document, a blocked
result, or an unknown cost/usage record as a stop condition, never as success.

Only a named human may promote a memory item. No run in this handbook grants a
capability, changes an approval rule, changes the evaluation definition,
changes safety policy, merges, or deploys.

## 2. Roles and evidence hygiene

| Activity | Required actor | Record to retain |
| --- | --- | --- |
| Authorize a real provider call | Accountable human | Non-secret authorization reference, approved provider/model, data scope, budget decision. |
| Run real-mode verification | Designated operator in the protected deployment | Redacted evidence JSON, command result, baseline SHA, and blocker codes (if any). |
| Review and promote a candidate | Named workspace owner/admin with standing | Candidate id and exact version, evidence references, reviewer identity/time, decision. |
| Run an RSI replay or start/observe/roll back a canary | Workspace owner; approval follows the risk ladder | Proposal id/version, server-produced replay and observation records, approval identities, run pins. |
| Engage or release kill switch | Workspace owner | Reason, actor, timestamp, affected rollout/proposal ids, and post-action status. |

Never put a provider credential, raw prompt or outcome envelope, memory
statement, holdout case, email, home path, or secret-shaped value in an
evidence report. Keep opaque identifiers, versions, counts, digests, stable
blocker codes, and provider-request identifiers only where the evidence schema
permits them. Evidence writing passes a redaction gate; a redaction failure is
a stop condition.

## 3. Real-model verification procedure

### 3.1 Preflight and authorization

Before a real run, a human must explicitly authorize the provider, the model,
the data class, and the budget. Record a non-secret reference such as the
approval ticket/comment id. The operator must confirm all of the following in
the protected deployment:

- Gateway policy, gateway credential-reference, and budget-policy files are
  configured and access-controlled; ambient provider credential environment
  variables are absent.
- The provider and model are approved by that policy.
- `FORGEPILOT_CAPTURE_DB_FILE` names the one trusted capture-outbox database;
  the selected capture is `captured`, digest-verified, known, learnable, and
  bound to the intended enterprise/workspace.
- The requested `--policy-scope` exactly matches that capture's scope.
- The per-invocation budget can cover the bounded context and output. Do not
  replace an unknown cost with zero.

If any prerequisite is missing, do not improvise a database, substitute an
envelope file, or bypass the gateway. Run the fixture procedure for harness
evidence instead and record the real-mode blocker.

### 3.2 Offline fixture procedure

This safe, reproducible command exercises the gateway controls and automatic
chain with an in-process loopback provider. It makes no real provider call.

```sh
cd node
npm run build
node dist/scripts/real-model-distillation-verify.js \
  --fixture \
  --evidence-out ./dat270-offline-evidence.json
```

Expected result: exit `0`, seven scenario probes pass, and the evidence is
labelled `fixture_local_provider`. Attach or retain only the redacted JSON;
do not relabel it as real-model evidence.

### 3.3 Authorized real-mode procedure

Run this only after the preflight is complete and the accountable human has
authorized the exact call. Paths below are examples of protected deployment
locations, not credentials.

```sh
cd node
npm run build
FORGEPILOT_GATEWAY_POLICY_FILE=/protected/gateway-policy.json \
FORGEPILOT_GATEWAY_CREDENTIALS_FILE=/protected/gateway-credentials.json \
FORGEPILOT_PI_PROVIDER=<approved-provider> \
FORGEPILOT_PI_MODEL=<approved-model-id> \
FORGEPILOT_BUDGET_POLICY_FILE=/protected/budget-policy.json \
FORGEPILOT_CAPTURE_DB_FILE=/protected/control-plane.sqlite \
node dist/scripts/real-model-distillation-verify.js \
  --real \
  --authorization-ref '<human-authorization-reference>' \
  --capture-db /protected/control-plane.sqlite \
  --capture-id '<capture-job-id>' \
  --policy-scope '<enterprise-id>/<workspace-id>' \
  --state-dir /protected/state/dat270 \
  --evidence-out /protected/evidence/dat270-real.json
```

Use exactly one selector: `--capture-id` or `--run-id`. The process exits `0`
only when the automated chain verifies, `1` on an assertion failure, and `2`
when blocked before dispatch. Stable blockers such as
`CAPTURE_DB_NOT_TRUSTED`, `CAPTURE_ENVELOPE_DIGEST_MISMATCH`,
`CAPTURE_OUTCOME_CLASS_MISSING`, `SOURCE_SCOPE_MISMATCH`, and configuration or
budget blockers must be retained as evidence and resolved through the normal
human process. They are not retry instructions.

Real mode reads only the protected, canonical capture database, opens it
read-only, and verifies capture state, digest, task/run binding, learnability,
outcome class, and scope before gateway construction. It rejects an envelope
file and ambient provider credentials. Do not weaken these checks to obtain a
result.

### 3.4 Candidate review and manual promotion

After a verified chain creates a candidate, a named workspace owner or admin
reviews the *exact* item version in the memory governance surface. Verify its
provenance, evidence references, scope, preconditions, sensitivity, and
candidate status. Confirm the candidate has not changed since review.

Promotion uses the governance action for that exact version and its optimistic
concurrency token. A stale version conflicts rather than being silently
overwritten. Procedural memory (`lesson`, `playbook`, `anti_pattern`, and
`policy`) cannot become active without the human review stamp; `policy` is
also human-authored. Record the resulting item id/version, approver, time,
decision, and audit-event id. A later run may be cited only after its retrieval
bundle identifies the served item/version and status.

## 4. Holdout permissions and offline RSI replay

The holdout is not an operator dataset. It is stored separately and may be
read only by the server-side replay capability. There is no HTTP operation to
read, provision, or submit holdout cases; status surfaces expose only aggregate
counts and timestamps. Do not copy holdout content into a ticket, prompt,
candidate, fixture, or manual scorecard.

For a proposal, an independent owner runs the server-side replay across both
`golden` and `holdout`. The proposer cannot evaluate their own proposal, and
request bodies cannot supply a score, metric, case, verifier, or sample. Both
datasets must pass before a canary can begin. A result below the minimum sample
is `inconclusive`, not a pass.

Use the role and risk gates in `memory-rsi-v1`:

- Class A (`retrieval_weights`, `ranking_tiebreakers`): replay, plus a named
  human unless the workspace's low-risk setting is enabled.
- Class B (`lesson`, `playbook`, `prompt_hint`): replay plus one owner/admin
  approval distinct from the proposer.
- Class C (`retrieval_bounds`, `scope_taxonomy`,
  `consolidation_thresholds`): replay plus two distinct human approvals.
- Class D (capability grants, approval/evaluation definitions, safety policy,
  evidence schema, merge/deploy): refused. Use normal reviewed change control.

The synthetic drill is the reproducible rehearsal for these gates:

```sh
cd node
npx vitest run test/rsi-drill.test.ts
npm run build
node dist/scripts/rsi-drill.js > rsi-drill-report.json
```

The report is synthetic and in-memory. Retain its summary, `checks`, normalized
digest, `not_verified` list, baseline SHA, and command exit code; do not claim
that it exercises production data, a real model, a real gateway, a provider,
or live dsh.

## 5. Canary, budgets, rollback, and kill switch

### Canary

Start a canary only after the server records passing golden and holdout replay,
all required distinct human approvals, a remaining budget, an inactive kill
switch, and an unchanged evaluation baseline. Only one canary can be active in
a workspace. The server chooses deterministic candidate/control arms and
calculates observations from pinned run-level evidence; users do not submit
sample values.

Stages are `10%`, `50%`, and `100%`, with minimum candidate samples `10`,
`25`, and `50`. A security event, regression, or over-budget result fails the
gate and rolls back automatically. An inconclusive result does not advance.
At `100%`, a policy proposal publishes one immutable policy version; a memory
item activates only with its exact approving human review stamp. Historical
run pins are never rewritten.

### Budget check

The fixed upper bounds are a weekly change budget of three promotions and a
weekly reflection-token budget of 200,000 tokens. A workspace may tighten but
never relax them. Confirm remaining budget before replay or canary start; a
run that would exceed the reflection budget is refused before it writes an
evaluation. Record the status view's budgets and the server result, not an
operator estimate.

### Rollback

For a live canary, use the proposal rollback action with the required human
reason and record the proposal/rollout ids, actor, timestamp, and resulting
status. For a promoted policy, rollback publishes the evaluated baseline as a
new immutable version. For a promoted memory item, rollback deprecates it.
Never rewrite a historical pin or edit a past evidence record.

### Kill switch

Engage the workspace kill switch immediately on a suspected safety, integrity,
or budget-control incident. It rolls back every active canary in the same call,
keeps candidates unpublished, pins new runs to baseline, and refuses new
proposals, evaluations, approvals, and canaries until a workspace owner
releases it. Capture the reason and post-action status. Release is a separate
owner decision after investigation; it does not restore a rolled-back canary
or approve a pending candidate.

## 6. Rollback rehearsal checklist

Use the synthetic drill for a regular, non-production rehearsal:

1. Run the commands in [§4](#4-holdout-permissions-and-offline-rsi-replay).
2. Confirm the report has `scope.production_enabled: false`, all checks pass,
   and its `not_verified` list remains present.
3. Confirm the report covers named approval, 10% → 50% → 100% canary stages,
   automatic regression rollback, post-promotion rollback, and kill-switch
   engagement/release.
4. Record the normalized digest and tool versions. A changed digest is a
   change to investigate, not a reason to edit expected output.
5. If a rehearsal fails, preserve the redacted report, stop promotion/canary
   activity for the affected scope, and use normal incident/change control.

## 7. Evidence record and stop criteria

For every run or rehearsal, retain this content-free record:

| Field | Record |
| --- | --- |
| Baseline | Repository commit, Node/Go versions, command, timestamp. |
| Mode | `fixture_local_provider`, `real_model`, or `synthetic_rsi_drill`. |
| Scope | Opaque enterprise/workspace, policy version/revision, and capture/proposal ids where applicable. |
| Authorization | Non-secret human authorization reference for real mode; named approvals for governance/RSI. |
| Result | Exit code, status, stable blockers, checks/scenario counts, and normalized digest when produced. |
| Usage/budget | Completeness plus reported/estimated/unknown values; never zero-fill unknown. |
| Candidate/canary | Exact item/proposal/version, retrieval bundle/run-pin identifiers, rollout stage/status, rollback/kill-switch outcome. |
| Limitations | Which items in the relevant `not_verified` or blocked list still apply. |

Stop and escalate to the responsible human when authorization is absent;
gateway/capture provenance or scope validation blocks; a secret/PII redaction
check fails; a holdout boundary is requested to be bypassed; a budget is
exhausted; a replay/canary is inconclusive or fails; a baseline drifts; or the
kill switch is engaged. Do not clear a blocker by changing a contract, a
policy, an approval rule, or a safety guardrail in an operational run.

## 8. Reproducibility record for this handbook

This handbook is based on `main` commit
`073e2132f8b18e602a18b12834d503fe96e1a9eb` (DAT-270 and DAT-271 merged).
The repository declares Node.js `>=20.11` and Go `1.25+`. This revision was
checked with Node `v22.20.0` and Go `go1.25.6 darwin/arm64`:

| Check | Observed result |
| --- | --- |
| `go test ./...` | pass |
| Node typecheck, lint, and format check | pass |
| `npm test` | 162 files / 2547 tests pass |
| Fixture verification | exit 0; 7/7 probes pass; `fixture_local_provider` only |
| Direct RSI drill JSON | exit 0; 41/41 checks pass; two fresh runs have matching digest `bc9ad117c8db5c0bcfbce221c64acb182a959e34d08f075748f3fdd52f4fd34e` |

Run the following commands for every documentation revision and retain the
result with its pull request:

```sh
go test ./...
(cd node && npm run typecheck)
(cd node && npm run lint)
(cd node && npm run format:check)
(cd node && npm test)
(cd node && npm run build && node dist/scripts/real-model-distillation-verify.js --fixture --evidence-out ./dat272-fixture-evidence.json)
(cd node && npm run build && node dist/scripts/rsi-drill.js > ./dat272-rsi-drill-report.json)
```

The fixture evidence and RSI report created by these commands are local,
redacted verification artifacts. They are not provider evidence and are not
checked into source control. See the pull request validation record for the
exact tool versions, test totals, drill digest, and exit status.
