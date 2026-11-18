# Real-model distillation verification pack (DAT-270)

This is the operator package for verifying **real-model** workspace-memory
distillation through the ADR-0005 model gateway. It exists because DAT-266
verified the capture → distillation → admission → delivery chain with a
scripted model stream. A scripted stream proves the pipeline; it does not prove
that an actual model, reached through the real gateway, produces a candidate
that survives validation and can be reviewed.

**Status: prepared, not accepted.** The automated half is runnable and has been
exercised with the labelled offline fixture. The real-provider half requires
explicit human authorization, protected gateway configuration, an approved
model, and a budget; none were supplied for this issue's run, so real-model
acceptance is **blocked**, not complete. See
[Blocked state](#8-blocked-state-at-the-time-of-writing).

Baseline: AutoFixer `main` at `1dc10a0` (`docs: add controlled delivery runbook
(#93)`). The harness lives in
`node/scripts/real-model-distillation-verify.ts`; its offline tests live in
`node/test/real-model-verification.test.ts`.

## 1. What one verification run does

```
trusted terminal outcome (captured, redacted, digest-verified)
  -> distillation outbox row (server-side workspace scope only)
  -> composed current-workspace context (secret/PII scrubbed)
  -> ADR-0005 gateway: scope, policy, credentials, budget, scan gate, audit
  -> real model response
  -> strict schema parse + evidence-ledger validation
  -> DAT-234 admission gate (dedupe, contradiction, poisoning, evidence)
  -> `candidate` memory item with captured evidence
  -> later-run retrieval reference (unapproved candidate, reduced weight)
```

The run records, for that exact execution: model id and prompt-template
version, gateway policy revision and endpoint id, credential reference, budget
revision, capture/distillation/run/candidate/evidence identifiers, accepted and
dropped counts, usage completeness, and the scenario probe results. It records
**no statement, change summary, raw envelope, credential, email, phone, card,
or home path** — identifiers, versions, counts, and digests only.

## 2. What it does not do

- It does not approve, promote, or activate memory. A named human must review
  the exact candidate version through the DAT-251 governance surface.
- It does not write to a provider repository, open a PR, or change a grant.
- It does not send repository code or real operational data. The only model
  input is the captured outcome envelope and its evidence references.
- It never sends a request outside the gateway, and it never uses an ambient
  provider credential. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and the other
  variables pi-ai can read are refused before any egress attempt.
- It does not treat a fixture or scripted response as real-model evidence. The
  evidence document says `verification_mode: fixture_local_provider` and
  `accepted_as_real_model_evidence: false`; a real run with a successful
  automated chain still records the pending human review as a blocker.

## 3. Modes

### Fixture mode (default, offline)

```sh
cd node
npm run build
node dist/scripts/real-model-distillation-verify.js \
  --fixture \
  --evidence-out ./dat270-offline-evidence.json
```

The transport is an in-process loopback OpenAI-compatible server. The real
gateway, scan gate, credential boundary, budget authority, usage ledger,
distillation pipeline, validation, admission gate, and retrieval service all
run unchanged. This proves the harness and the automated chain; it is not a
model-quality signal.

### Real mode (requires authorization and deployment configuration)

```sh
export FORGEPILOT_GATEWAY_POLICY_FILE=/protected/gateway-policy.json
export FORGEPILOT_GATEWAY_CREDENTIALS_FILE=/protected/gateway-credentials.json
export FORGEPILOT_PI_PROVIDER=<approved provider>
export FORGEPILOT_PI_MODEL=<approved model id>
export FORGEPILOT_BUDGET_POLICY_FILE=/protected/budget-policy.json
# optional, for OpenAI-compatible endpoints:
# export FORGEPILOT_PI_BASE_URL=https://approved.internal.example/v1

node dist/scripts/real-model-distillation-verify.js \
  --real \
  --authorization-ref "DAT-270#comment-<id>" \
  --envelope-file /protected/envelope.json \
  --policy-scope "<enterpriseId>/<workspaceId>" \
  --state-dir /protected/state/dat270 \
  --evidence-out /protected/evidence/dat270-real.json
```

Exit codes: `0` the automated chain verified, `1` an assertion failed, `2`
blocked before any dispatch. A blocked run still writes the evidence document
with the stable blocker codes, so the blockage is recorded rather than implied.
Invalid gateway configuration or an invalid envelope also lands as `blocked`
(`CONFIGURATION_INVALID:<error class>`, `TRUSTED_OUTCOME_ENVELOPE_INVALID:<error
class>`); the error class is recorded, never a message that could carry request
content.

## 4. Real-mode prerequisites

All of these are required; any missing item blocks the run before a byte is
sent (`--authorization-ref`, `--envelope-file`, and the environment variables
below).

| Requirement                                               | Why                                                                                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit human authorization reference                    | Someone accountable approved the model call, provider, data, and budget. The reference is recorded, never a secret.                                                                                |
| `FORGEPILOT_GATEWAY_POLICY_FILE` (0600)                   | Approved endpoint, model, credential reference, data classes, retry policy.                                                                                                                        |
| `FORGEPILOT_GATEWAY_CREDENTIALS_FILE` (0600)              | Provider secret by reference. Ambient credential variables must be unset.                                                                                                                          |
| `FORGEPILOT_PI_PROVIDER` + `FORGEPILOT_PI_MODEL`          | The model the gateway will match against the policy allow-list.                                                                                                                                    |
| `FORGEPILOT_BUDGET_POLICY_FILE`                           | Token and/or monetary bound; the gateway reserves before dispatch. The per-invocation ceiling must exceed the conservative context + output bound, or the gateway denies `TOKEN_CEILING_EXCEEDED`. |
| `--envelope-file`                                         | A redacted envelope captured from a real trusted terminal outcome (merged, rejected, cancelled, or classified failed). The fixture envelope is never accepted as real evidence.                    |
| `--policy-scope` when the policy file has several entries | Selects the policy to copy.                                                                                                                                                                        |

The policy and budget documents are validated, then **re-bound to the
isolated verification scope** so the temporary SQLite database does not need
the deployment's identifiers. The approved endpoint, model, credential
reference, data-class authorization, and budget limits are preserved exactly;
the gateway still performs scope resolution, scan, credential, budget, and
audit checks. The evidence records this as
`policy_binding: deployment_policy_rebound_to_isolated_scope`.

The envelope is parsed against the DAT-233 outcome contract before capture. A
malformed envelope, a non-terminal state, or a merged state without a delivery
record is refused with a stable error; nothing is distilled.

## 5. Evidence document

Top-level fields (schema version 1):

| Field                                                  | Contents                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verification_mode`, `accepted_as_real_model_evidence` | `fixture_local_provider` or `real_model`; the latter is only ever `true` for a real run whose automated chain passed — and even then the human-review blocker remains.                                                                |
| `status`                                               | `verified`, `failed`, or `blocked`.                                                                                                                                                                                                   |
| `baseline`                                             | Repository commit and Node version.                                                                                                                                                                                                   |
| `authorization`                                        | Whether a reference was supplied, and the reference itself (non-secret).                                                                                                                                                              |
| `configuration`                                        | Model provider/id, endpoint origin, policy revision, endpoint id, credential reference, budget revision, policy binding mode.                                                                                                         |
| `outcome`                                              | Envelope digest, terminal state, derived outcome class, run/task/issue ids, capture job id.                                                                                                                                           |
| `distillation`                                         | Job id/state, prompt-template version, model id, accepted/dropped counts, stable last error code.                                                                                                                                     |
| `candidate`                                            | Item id/version/status/kind, captured evidence references, admission candidate hash and disposition.                                                                                                                                  |
| `human_review`                                         | Always `required` for a produced candidate; names the exact item/version for the human.                                                                                                                                               |
| `next_run_reference`                                   | Retrieval bundle id and the served item's status, tier, `approved`, and `candidate` flags.                                                                                                                                            |
| `usage`                                                | Per-attempt finish status, completeness (`known`/`estimated`/`unknown`), total tokens, returned model, provider request id. Cost is never zero-filled: `cost_semantics` states that reported estimates and unknowns stay as reported. |
| `scenarios`                                            | Probe id, pass/fail, and a content-free detail string.                                                                                                                                                                                |
| `blockers`                                             | Stable codes for anything that prevents acceptance.                                                                                                                                                                                   |

Before writing, the harness runs the memory redaction gate over the serialized
document. Anything secret- or personal-shaped aborts the write.

## 6. Covered scenarios

Each scenario is exercised by the harness itself and has an independent
regression test in the repository.

| Scenario                                 | Harness probe                                                                                                                            | Independent coverage                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Request scan blocks secret-shaped egress | `request_scan_block`: dispatch with a credential-shaped token is denied `SENSITIVE_DATA_UNCERTAIN`, with zero pre-dispatch audit records | `node/test/gateway-secret-gate.test.ts`, `node/test/distill-egress.test.ts`           |
| Redaction/minimization                   | `redaction`: secret, email, and home path removed; raw text fails the persistence gate                                                   | `node/test/distill-redact.test.ts`                                                    |
| Insufficient evidence                    | `insufficient_evidence`: fabricated and empty citations are dropped                                                                      | `node/test/memory-distillation-pipeline.test.ts`                                      |
| Timeout/unknown are episode-only         | `timeout_unknown_episode_only`: both classify as episode-only and derive no distillation row                                             | `node/test/distill-outcome.test.ts`, `node/test/memory-distillation-pipeline.test.ts` |
| Duplicate content                        | `duplicate_content_merges`: re-admitting identical content returns the same item                                                         | `node/test/memory-admission-dedupe.test.ts`                                           |
| Cross-workspace isolation                | `cross_workspace_isolation`: composing a foreign-workspace outcome throws `ScopeError` before any line is built                          | `node/test/distill-egress.test.ts`, `node/test/memory-isolation.test.ts`              |
| Trusted outcome → candidate              | `known_outcome_to_candidate`: one derived job, one distilled candidate in `candidate` status                                             | `node/test/memory-distillation-pipeline.test.ts`                                      |

## 7. Human review and the next run

The harness stops at a `candidate`. It verifies that a later run's retrieval
can reference that item (as an unapproved candidate at reduced weight) and
records the bundle id and flags. The remaining steps are human-owned:

1. A named workspace owner or admin reviews the candidate's statement,
   preconditions, evidence references, and provenance in the workbench.
2. The human promotes that exact version through the DAT-251 governance
   surface (`approveAndPromote` / the workbench action). No agent may do this.
3. A subsequent run retrieves the now-`active`, approved version. Re-run the
   retrieval check (or read the run's memory bundle) and record the item id,
   version, bundle id, and time in the change record.

Until step 2 happens, the chain is **not** accepted, and the evidence
document's `human_review.status` says so.

## 8. Blocked state at the time of writing

DAT-270 was implemented without real-model execution:

| Precondition                                                            | State                                 |
| ----------------------------------------------------------------------- | ------------------------------------- |
| Explicit human authorization for a real provider call                   | Not supplied                          |
| Protected gateway policy and credential files for a restricted endpoint | Not supplied to the agent environment |
| Approved model id / base URL                                            | Not supplied                          |
| Budget policy and quota for the verification run                        | Not supplied                          |
| Real captured merged outcome envelope                                   | Not supplied                          |

Consequently the real-provider run was **not** performed, no third party
received code or real data, and this document must not be read as real-model
acceptance. The offline fixture run is evidence that the harness, gateway
boundaries, validation, admission, and evidence redaction work; it is not
evidence about a real model.

An operator with the prerequisites in §4 can run §3 real mode and attach the
resulting evidence document. Acceptance still needs the human review in §7.

## 9. Verification for this change

```sh
go test ./...
(cd node && npm run typecheck && npm run lint && npm run format:check && npm test)
(cd web && npm run typecheck && npm run lint && npm run format:check && npm test && npm run build)
```

The harness itself was also run against the offline fixture:

```sh
(cd node && npm run build && node dist/scripts/real-model-distillation-verify.js \
  --fixture --evidence-out ./dat270-offline-evidence.json)
```

## 10. Known limits

- The fixture provider is a transport fixture. It cannot show model quality,
  refusal behaviour, latency, or provider-specific schema quirks.
- The disposal-case machinery (encrypted quarantine, holds, security cases) is
  stubbed for the isolated process. A scan block still fails closed and is
  audited; the case is not opened in the deployment's security store.
- One verification run exercises one supplied envelope, one model call, and
  one attempt. Retry, fallback, and timeout behaviour against a real provider
  are covered by the gateway suites, not by this pack.
- A provider that reports no usage yields `unknown` completeness. That is the
  intended semantics, not a harness failure; it is not a zero-cost result.
- The isolated database is removed unless `--state-dir`/`--keep-state` is
  used. Preserve the state directory before a handoff if the capture and
  admission rows are needed for audit.
