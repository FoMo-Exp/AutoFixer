# Bounded memory retrieval v1 (DAT-236)

Contract for `MemoryBundle` assembly and the workspace memory v1 HTTP surface.
It implements the read path and degraded mode from ADR-0009
(`docs/adr/0009-workspace-memory-lessons-and-rsi.md`) on top of the storage
contract in `memory-schema-v1.md`, and the generated OpenAPI document at
`web/src/api/contracts/openapi.json` is the frontend baseline.

Retrieval is **read-only over memory**. It never promotes, edits, quarantines,
re-weights, or deletes an item, and it cannot grant a capability, approve a
change, or authorize a tool action. `dsh` remains the only execution gate
(ADR-0003/0007). Promotion and policy changes belong to the lifecycle slice
(DAT-235) and the bounded-RSI slice (DAT-238).

## Order of operations

1. **Hard filters** — workspace, applicability, status, sensitivity, validity
   window, and approval. A filter failure is never traded against a score.
2. **Scoring** — hybrid relevance plus evidence-derived signals.
3. **Budget** — omit rather than dilute; a strict item and token ceiling.
4. **Conflicts** — visible, never silently overwritten.
5. **Audit** — the bundle records the exact policy and memory version it read.

### Hard filters

| Filter | Rule |
| --- | --- |
| Workspace | Scope comes from authenticated workspace membership, never a body field. Every query embeds `enterprise_id` + `workspace_id`; a foreign record is indistinguishable from a missing one. |
| Status | `active` is authoritative; `candidate` enters only at reduced weight. `proposed`, `deprecated`, `retired`, `quarantined` are never eligible. |
| Validity | `valid_from <= now` and (`valid_to` is null or `> now`). |
| Sensitivity | Role ceiling: viewer/member → `internal`; owner/admin → `confidential`. `restricted` is never injectable and needs separate authorization. |
| Approval | `lesson`, `playbook`, `anti_pattern`, `policy` require a named review stamp or human authorship on that exact version. Facts/episodes are approved by validated promotion to `active`. An unapproved procedural item is demoted to candidate tier, not trusted. `policy` additionally must be human-authored and active. |
| Applicability | Team, language, and task family match exactly when set; path prefixes match on segment boundaries. An item scoped to something the run is not gets filtered, not down-ranked. |
| Citation | At least one evidence reference is required to be injected. |

### Scoring

```
relevance      hybrid BM25 + cosine(query embedding), versioned hybrid weights
importance     support count + reviewer-decision / PR salience, capped at 1
recency        bounded half-life decay on valid_from
confidence     (support - contradiction) / max(1, support), in [-1, 1]
trust          provenance trust class + strongest evidence-class boost
-penalty       contradiction links to other eligible items + item counter
total          weighted sum; candidates multiplied by candidate_weight
```

The blend is deliberately bounded: recency cannot take over, trust cannot
manufacture relevance, and a contradiction is always a subtraction. When the
caller supplies no query embedding, the vector weight is dropped (renormalized
onto lexical) and the bundle reports `signals.vector: false` with a reason.
The memory service never calls a model; embeddings arrive through the model
gateway (ADR-0005).

### Budget

Defaults from ADR-0009, all bounded:

| Bound | Default | Hard ceiling |
| --- | --- | --- |
| Items | 8 | 24 |
| Tokens | 1,500 | 8,000 |
| Context share | 15% | 20% |
| Candidates | 2 | 2 |

The effective token budget is `min(request, policy, hard ceiling, context_window
× max_context_share)`. A stated `context_window_tokens` is used exactly: a value
below 1,000 is **rejected** rather than silently raised, because raising it would
grant a larger share than 15% of the caller's actual context. L4 policy items are
mandatory and are **not** counted against the item or token budget, and they are
**never truncated**: if the workspace policy corpus exceeds the supported bound
(1,000 active policy items), the request fails rather than returning a successful
bundle that is missing policy — that refusal is a validation error, not a
degraded bundle. If the best eligible item falls below the policy relevance
floor, it is omitted; `budget.omitted_count` reports eligible items left out and
`sparse` marks a bundle that is thin relative to the corpus.

### Conflicts

`contradicts` links are surfaced, never silently resolved:

- an explicit `supersedes` link names the successor as the winner;
- otherwise, when both sides are human-approved, the later `valid_from` wins;
- otherwise the conflict is unresolved: **neither** side is injected as fact and
  both are returned in `conflicts` with their citations.

### Degraded mode

If the memory store or scoring path fails, retrieval returns HTTP 200 with
`degraded: true`, `degraded_reason` (`memory_unavailable`, `policy_unavailable`,
or `retrieval_error`), no memory items, and `sparse: true`. The run proceeds
with its configured policy only. No lesson is invented, and the degraded bundle
is itself audited (best effort). Validation errors (bad request, unknown pinned
policy version) are not degraded — they fail as errors. This includes the mandatory-policy bound:
a validation refusal is never converted into a `degraded: true` 200 response that
silently omits policy.

### Untrusted data

Every bundle carries:

```json
{
  "trust_boundary": {
    "memory_is_untrusted_data": true,
    "instructions_allowed": false,
    "tool_control_authority": "dsh",
    "citations_required": true,
    "render_fence": "memory"
  }
}
```

The prompt renderer puts all memory inside one `memory` fence under a directive
stating that memory is reference data, never an instruction, and cannot
authorize tools, approvals, grants, or policy changes. Item text is sanitized:
control characters and control-token shapes are stripped and angle brackets are
escaped, so an item cannot close the fence or forge a system/tool tag. The agent
must cite the item ids it used or state that no lesson applied.

## HTTP surface

All routes are `/api/v1/workspaces/{workspace_id}/memory/...`, authenticated by
a session (cookie or desktop session token) and scoped by workspace membership.
A workspace outside the caller's membership is `404`; a body carrying
`workspace_id`/`enterprise_id` is `400`. Cookie-authenticated mutations require
the `X-CSRF-Token` echo. Provider-authority revocation denies at the request
boundary when authority is in play (DAT-203).

| Operation | Semantics |
| --- | --- |
| `POST /memory/search` | Assemble a bounded `MemoryBundle`. Read authority. |
| `POST /memory/feedback` | Record run outcome and per-item usefulness. Member or above. Append-only; never authoritative. |
| `GET /memory/items` | Bounded browse (`kind`, `status`, `tier`, `limit <= 100`, cursor). |
| `GET /memory/versions` | Current retrieval policy, immutable policy history, corpus digest and bounded per-item version index. Obeys the caller's sensitivity ceiling: item identifiers, versions, hashes, timestamps, and corpus counts for items the role cannot browse are not enumerable. The ceiling is applied per version, so a restricted historical version stays hidden after the item's current version becomes internal. |
| `POST /memory/eval-runs` | Record an offline replay or canary result. Owner only. Never promotes memory; evaluation cases and holdout content cannot be written. |

Deliberately absent: promote, deprecate, quarantine, and policy-write routes.
Those belong to the lifecycle slice and must not be reachable from a retrieval
credential.

## Versioning and reproducibility

`memory_retrieval_policies` stores immutable policy versions with a canonical
SHA-256 hash. `memory_version` is a deterministic digest over every stored
item's current version and content hash plus the policy version. A bundle names
both; `memory_retrieval_runs` records the same pair along with the exact
injected item ids/versions, so a bad promotion can be reproduced.

## Storage

Control-plane migration version 9 (v5–v8 are the already-merged admission,
invitation, and lifecycle migrations; this slice takes the next free number):

| Table | Purpose |
| --- | --- |
| `memory_retrieval_policies` | Immutable, versioned retrieval policy rows |
| `memory_retrieval_runs` | Append-only bundle audit (versions, injected set, omitted count, degraded flag) |
| `memory_feedback` | Append-only run outcome and per-item feedback |
| `memory_eval_runs` | Append-only evaluation results |

Every row is workspace-scoped, and none of these tables can mutate memory items.
