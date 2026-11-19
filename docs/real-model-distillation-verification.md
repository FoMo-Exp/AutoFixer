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
# protected deployment config: the one trusted capture outbox this harness may read
export FORGEPILOT_CAPTURE_DB_FILE=/protected/control-plane.sqlite
# optional, for OpenAI-compatible endpoints:
# export FORGEPILOT_PI_BASE_URL=https://approved.internal.example/v1

node dist/scripts/real-model-distillation-verify.js \
  --real \
  --authorization-ref "DAT-270#comment-<id>" \
  --capture-db /protected/control-plane.sqlite \
  --capture-id <capture-job-id> \
  --policy-scope "<enterpriseId>/<workspaceId>" \
  --state-dir /protected/state/dat270 \
  --evidence-out /protected/evidence/dat270-real.json
```

Exit codes: `0` the automated chain verified, `1` an assertion failed, `2`
blocked before any dispatch. A blocked run still writes the evidence document
with the stable blocker codes, so the blockage is recorded rather than implied.
Invalid gateway configuration also lands as `blocked`
(`CONFIGURATION_INVALID:<error class>`); the error class is recorded, never a
message that could carry request content. A capture row that fails provenance
is blocked with its stable code (`CAPTURE_RECORD_NOT_FOUND`,
`CAPTURE_NOT_COMPLETED`, `CAPTURE_ENVELOPE_DIGEST_MISMATCH`,
`CAPTURE_BINDING_MISMATCH`, `CAPTURE_NOT_LEARNABLE`,
`CAPTURE_OUTCOME_CLASS_MISSING`, `CAPTURE_OUTCOME_CLASS_MISMATCH`,
`CAPTURE_DB_NOT_TRUSTED`, `SOURCE_SCOPE_MISMATCH`, …).

## 4. Real-mode prerequisites

All of these are required; any missing item blocks the run before a byte is
sent (`--authorization-ref`, the capture DB and selector, and the environment
variables below).

| Requirement                                               | Why                                                                                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit human authorization reference                    | Someone accountable approved the model call, provider, data, and budget. The reference is recorded, never a secret.                                                                                |
| `FORGEPILOT_GATEWAY_POLICY_FILE` (0600)                   | Approved endpoint, model, credential reference, data classes, retry policy.                                                                                                                        |
| `FORGEPILOT_GATEWAY_CREDENTIALS_FILE` (0600)              | Provider secret by reference. Ambient credential variables must be unset.                                                                                                                          |
| `FORGEPILOT_PI_PROVIDER` + `FORGEPILOT_PI_MODEL`          | The model the gateway will match against the policy allow-list.                                                                                                                                    |
| `FORGEPILOT_BUDGET_POLICY_FILE`                           | Token and/or monetary bound; the gateway reserves before dispatch. The per-invocation ceiling must exceed the conservative context + output bound, or the gateway denies `TOKEN_CEILING_EXCEEDED`. |
| `--capture-db` + exactly one of `--capture-id`/`--run-id` | A capture outbox row in the trusted control-plane database, written by the DAT-264/266 capture path from dsh/provider evidence. Opened read-only; never migrated or repaired.                      |
| `--policy-scope`                                          | Must equal the capturing workspace (enterprise/workspace) of the selected row; it also selects the policy binding when the file has several.                                                       |

The policy and budget documents are validated, then **re-bound to the
isolated verification scope** so the temporary SQLite database does not need
the deployment's identifiers. The approved endpoint, model, credential
reference, data-class authorization, and budget limits are preserved exactly;
the gateway still performs scope resolution, scan, credential, budget, and
audit checks. The evidence records this as
`policy_binding: deployment_policy_rebound_to_isolated_scope`.

### Capture provenance gate

A structurally valid envelope is not evidence. Real mode does not accept an
envelope file at all; the only accepted source is a row in the trusted capture
outbox. Before any dispatch the harness verifies:

0. the caller-supplied `--capture-db` resolves to the exact file named by the
   protected `FORGEPILOT_CAPTURE_DB_FILE`; the configured file is what is
   opened. A self-made database — even one with a captured row, a valid merged
   envelope, matching identities, and a self-computed matching digest — is
   refused as `CAPTURE_DB_NOT_TRUSTED` before dispatch;
1. the row exists and is `captured` (not pending, processing, or failed);
2. its stored envelope is present and its SHA-256 equals the stored digest;
3. the envelope parses under the DAT-233 outcome contract and its `task_id`,
   `run_id`, and `terminal_state` equal the row's;
4. the derived outcome is known and learnable (not timeout/unknown/infra);
5. the row records an outcome class (a null class fails closed as
   `CAPTURE_OUTCOME_CLASS_MISSING`) and it agrees with the derived class;
6. the selected policy scope is the row's capturing enterprise/workspace.

Any mismatch blocks before gateway construction or a model call. The evidence
records the source capture id, source enterprise/workspace,
`source_digest_verified: true`, and
`source_db_trust_anchor: deployment_config_path_match`. A forged but structurally valid envelope —
whether placed in a tampered row or bound to another run — is refused with zero
dispatch (regression tests cover both).

The verified envelope is then re-captured into the isolated workspace, so the
source outbox row is never mutated or re-derived from caller input.

## 5. Evidence document

Top-level fields (schema version 1):

| Field                                                  | Contents                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verification_mode`, `accepted_as_real_model_evidence` | `fixture_local_provider` or `real_model`. The flag is `true` only when real mode's automated chain verified (`status: verified`) and is always `false` for fixture, failed, and blocked runs. A `true` value still carries the `HUMAN_REVIEW_REQUIRED` blocker: it means the automated half passed, not that the chain is accepted. |
| `status`                                               | `verified`, `failed`, or `blocked`.                                                                                                                                                                                                                                                                                                 |
| `baseline`                                             | Repository commit and Node version.                                                                                                                                                                                                                                                                                                 |
| `authorization`                                        | Whether a reference was supplied, and the reference itself (non-secret).                                                                                                                                                                                                                                                            |
| `configuration`                                        | Model provider/id, endpoint origin, policy revision, endpoint id, credential reference, budget revision, policy binding mode.                                                                                                                                                                                                       |
| `outcome`                                              | Source (`trusted_capture_outbox`/`synthetic_fixture`), verified provenance (source capture id, enterprise/workspace, digest verified), envelope digest, terminal state, outcome class, run/task/issue ids, isolated capture job id.                                                                                                 |
| `distillation`                                         | Job id/state, prompt-template version, model id, accepted/dropped counts, stable last error code.                                                                                                                                                                                                                                   |
| `candidate`                                            | Item id/version/status/kind, captured evidence references, admission candidate hash and disposition.                                                                                                                                                                                                                                |
| `human_review`                                         | Always `required` for a produced candidate; names the exact item/version for the human.                                                                                                                                                                                                                                             |
| `next_run_reference`                                   | Retrieval bundle id and the served item's status, tier, `approved`, and `candidate` flags.                                                                                                                                                                                                                                          |
| `usage`                                                | Per-attempt finish status, completeness (`known`/`estimated`/`unknown`), total tokens, returned model, provider request id. Cost is never zero-filled: `cost_semantics` states that reported estimates and unknowns stay as reported.                                                                                               |
| `scenarios`                                            | Probe id, pass/fail, and a content-free detail string.                                                                                                                                                                                                                                                                              |
| `blockers`                                             | Stable codes for anything that prevents acceptance.                                                                                                                                                                                                                                                                                 |

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
- `--capture-db` must match the protected `FORGEPILOT_CAPTURE_DB_FILE` and is
  opened read-only. Point it at a stable snapshot or backup of the
  control-plane database; a live WAL database may need a consistent copy so
  the selected row and its digest are visible. Configuring a forged file at
  the trusted path is a deployment compromise, not a caller input: keep the
  env file and the outbox owner-only and reviewed like the gateway files.
