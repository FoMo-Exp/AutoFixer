# RSI offline holdout, approval, and rollback drill

This drill is an executable acceptance exercise for the bounded recursive
self-improvement (RSI) loop described by
[ADR-0009](adr/0009-workspace-memory-lessons-and-rsi.md) and
[memory-rsi-v1](contracts/memory-rsi-v1.md). It drives the real stores,
retrieval path, RSI governance service, and task-projection outcome adapter
over a **synthetic, in-memory workspace**:

```
proposal → independent golden/holdout replay → named human approval
        → canary pins → promotion → rollback / kill switch
```

**This is not production enablement.** The drill calls no model, gateway,
provider, dsh, or network endpoint. It uses no production data, credential, or
permission. Its report states that explicitly (`scope.production_enabled` is
`false`), and nothing here should be read as evidence that a real model,
real provider delivery, or a production RSI rollout has been accepted.

## Baseline

The report in this document was produced against AutoFixer `main` at
`1dc10a0ff1b5dd33f1687fa5c772c5a2b2f6a686` (the commit this drill was added
on). The committed API contract is unchanged: the drill adds no route and no
field, so `web/src/api/contracts/openapi.json` is untouched.

| Input | Value |
| --- | --- |
| Replay clock (fixed) | `2026-11-02T12:00:00.000Z` (ISO week `2026-11-02`) |
| Workspace | one synthetic enterprise, two synthetic workspaces, in-memory SQLite |
| Active lessons | 10 in the drilled workspace, 1 in the isolated workspace |
| Candidate items | 1 benign (class B activation), 1 forbidden-injection probe |
| Golden set | 20 human-curated synthetic cases |
| Holdout set | 20 hidden synthetic cases; content is represented only by a SHA-256 digest |
| Canary evidence | 356 synthetic task records read through the real `createTaskRunOutcomes` adapter |
| Baseline policy | version 1, hash `8dd1f42da87c6aacc0f9a4d4c2ce28f45b8772df3e0c19921eafe22307f6f5c2` |

## Run it

```sh
cd node
npm install
npm run typecheck
npm run lint
npm run format:check
npx vitest run test/rsi-drill.test.ts
npm run drill:rsi > rsi-drill-report.json
```

`npm run drill:rsi` builds the package, executes the drill twice in fresh
in-memory databases, writes one JSON report to stdout, and exits `0` only when
every governance check passes. `--repeat N` changes the repetition count:

```sh
npm run drill:rsi -- --repeat 3 > rsi-drill-report.json
```

The report contains `summary`, the per-act `checks`, the normalized
`reproducibility.normalized_sha256`, and an explicit `not_verified` list.
Random row ids and wall-clock timestamps are excluded from the digest, so two
executions of the same code produce the same digest. `test/rsi-drill.test.ts`
runs the drill twice as part of `npm test` and fails if a check fails or the
digests differ.

## What the drill executes

Every act uses the production service and store implementation. The only
synthetic seam is the input data and the run outcomes, which are inserted as
task records in the real in-memory task projection.

| Act | What it proves |
| --- | --- |
| `risk_ladder` | Class D targets (`capability_grant`, approval rules, evidence schema, evaluation definitions, policy, merge/deploy) are refused before a row exists; risk comes from the target, not the caller. |
| `holdout_isolation` | Holdout content is readable only through the replay capability; forged capability objects are refused; neither the service surface nor the 10 documented RSI HTTP paths reads or provisions cases; the observation endpoint accepts no sample body; another workspace cannot read the proposal; proposal/evaluation/list/status payloads contain the aggregate count only. |
| `independent_evaluation` | A golden-only replay leaves the gate `missing`; the proposer cannot evaluate its own proposal; a member cannot evaluate; an independent owner replay passes golden **and** holdout; the recorded verifier is the authenticated evaluator with a server-derived `replay:<proposal>:v<version>:<dataset>` reference. |
| `named_human_approval` | Class A still requires a named human while automatic promotion is off; the proposer cannot approve; a member cannot approve; the named approval is recorded with key, approver, and note. |
| `canary_promotion` | Three passing observations advance 10% → 50% → 100% on enough terminal pinned runs; promotion publishes exactly one new immutable policy version; samples are computed from the pin set and run-level task evidence, not request fields. |
| `post_promotion_rollback` | Manual rollback publishes the baseline content as a new version; every historical pin keeps its policy identity, memory version, and created-at. |
| `class_b_named_human_activation` | A candidate lesson activates only after offline pass, a named admin approval distinct from the proposer, and a canary; the exact reviewed version is stamped with that approver. |
| `regression_gate` | A below-minimum sample is `inconclusive`, not a pass; a recorded success regression rolls back automatically and leaves the stored policy unchanged. |
| `forbidden_injection` | In an isolated workspace, a case that forbids the candidate fails both datasets with a recorded safety event and blocks the canary. |
| `version_drift` | A baseline that moved after evaluation refuses the canary start; a baseline that moves during a canary rolls the canary back instead of promoting a stale comparison. |
| `budget_exhaustion` | An exhausted weekly change budget blocks the canary even with a passing replay and approval; an exhausted reflection-token budget refuses before any evaluation row is written. |
| `kill_switch` | Engaging the kill switch rolls back the active canary in the same call, keeps the candidate unpublished, preserves existing pins, pins new runs to the baseline, and refuses proposals/evaluations/approvals/canaries; release restores operation. |
| `run_pin_traceability` | Every one of the 356 runs has one fixed memory version, policy version, and policy hash; repeated resolution is stable; pins taken under different stored policy/corpus versions carry different memory versions; the final proposal statuses match the gates that fired. |
| `report_self_check` | The drill's own transcript contains no holdout text. |

## Observed result

```text
$ npm run drill:rsi > rsi-drill-report.json
$ echo $?
0
```

- 41 of 41 checks pass across 15 acts.
- Two fresh in-memory executions produce one digest:
  `bc9ad117c8db5c0bcfbce221c64acb182a959e34d08f075748f3fdd52f4fd34e`.
- 356 run pins were taken; all carry a policy version, 64-hex policy hash, and
  `m1.` memory version, and all remain stable across retries and rollbacks.
- Policy versions moved `1 → 2` on promotion, `2 → 3` on post-promotion
  rollback, then `3 → 4` and `4 → 5` as deliberate external drift; the canary
  never published its candidate against a moved baseline.
- Final proposal statuses: 1 proposed, 2 ready, 1 blocked, 1 promoted,
  4 rolled back.

## Finding fixed with this drill

The first execution failed one check: while the kill switch was engaged,
`approve()` still recorded an approval for a proposal whose offline replay had
already passed. The contract says proposals, evaluations, approvals, and
canaries are refused until release, and an approval recorded during an
incident must not survive as pre-authorized progress. The service now refuses
approvals under the kill switch, with a focused regression test in
`node/test/memory-rsi.test.ts` and the drill check
`kill_switch_refuses_rsi_actions`.

## Not verified

The report repeats this list so a reader cannot mistake the drill for a
production acceptance:

- A real model, gateway, or provider call: none exists in this drill.
- Memory distillation from real runs: covered by DAT-270 and the distillation
  suites, not here.
- HTTP session authentication and role enforcement for the RSI routes: covered
  by the `memory-rsi-api` suite; this drill exercises the service and the
  documented OpenAPI shape.
- A live dsh execution writing the task projection: the drill inserts
  synthetic task records into the real adapter, which is not a live run.
- Holdout curation, rotation, and case provenance: the drill uses a fixed
  synthetic set; case management is out of band and a class D change.
- Production deployment, PostgreSQL row-level tenancy, and provider
  credentials: the drill runs in memory with synthetic identities.
