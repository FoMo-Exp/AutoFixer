# ADR 0008: Observable agent execution and versioned model cost accounting

**Status:** Proposed — detailed design awaiting review; not implemented.

**Date:** 2026-11-03

## Context

The enterprise product needs inspectable Pi collaboration, harness and sandbox
execution, actionable failures, and token/rate/cost dashboards. The requester
identified Multica Analytics as a product reference. Its implementation has
not been inspected for this decision; this ADR defines AutoFixer's own
requirements rather than claiming source compatibility or a copied schema.

Capturing every available model interaction can expose code, logs, secrets,
and employee information. Billing totals can also be misleading if missing
usage becomes zero, retries disappear, or current rates rewrite history.
ADR-0005 already requires non-secret security audits and no per-call exemption.

## Decision

### Separate evidence from projections and sensitive content

Keep three correlated record types:

| Record | Authority and contents | Failure behavior |
| --- | --- | --- |
| Execution/security evidence | dsh's canonical event chain; service-owned identity, approval, gateway and policy audit events | Required pre-action evidence failure blocks the action under ADR-0005/0007 |
| Operational traces | Model calls, tools, harness decisions, sandbox execution, handoffs, queues and errors referencing evidence | Missing export is visible; durable local capture and bounded buffering prevent silent loss |
| Content/financial records | Restricted model interaction artifacts and a separate invocation usage/rate ledger | Content limits/expiry are disclosed; incomplete usage is unknown, not zero |

Do not let Node or a dashboard overwrite/reorder dsh evidence. Control-plane
audit and worker evidence have their own authoritative writers and event IDs;
correlation does not imply a single globally ordered chain. Views identify
source, version, event time, ingestion time, and projection freshness.

Propagate enterprise/workspace, issue, task, run, attempt, agent/config revision,
invocation, tool/action, artifact, delivery operation and trace/span IDs across
queues and workers. Record causal links and sequence per source. Duplicate
delivery is deduplicated by source/event identity. Do not put payloads, file
contents, credentials or high-cardinality raw error text in metric labels.
Scope all queries, streams, exports, and aggregates by authenticated access.

### Capture the available model interaction, not hidden reasoning

Record model/provider and configuration, prompt-template and policy versions,
request/result status, timing, safe content references, tool selection and
structured arguments/results, and actual provider usage fields when available.
Capture model-visible context and exposed output only under enterprise
content-retention policy. Hidden internal reasoning cannot be guaranteed or
reconstructed; absent, truncated, redacted or unavailable fields are labeled.
A recorded model explanation is untrusted output, not a proof or QA result.

Scan and redact request/response/tool material before ordinary persistence,
including data that never leaves the internal environment. Required source
material for a security investigation uses ADR-0005 quarantine, not the trace
viewer. Do not persist provider keys, invitation codes, authorization headers,
or secret values in errors, spans, SDK debug logs, callback URLs, or exports.

The enterprise configures finite retention for evidence, operational traces,
content artifacts, usage records and backups separately. Phase-one onboarding
requires these values before enabling the relevant capture; no silent
"retain forever" default. Raw content capture is opt-in. Metadata and event
continuity remain available without it; full content replay is then unavailable.
Record deletion/expiry/tombstones without rewriting historical audit evidence.
Legal holds, key access and exceptional retention need explicit enterprise
policy; this ADR does not invent a legal retention period.

### Make errors actionable without revealing secrets or escalating access

Define a versioned shared error envelope with stable code, stage, category,
safe user message, retryability, retry-after where applicable, trace/case
reference, and an authorized next action. Keep sensitive diagnostics behind
separate access checks. Localize display text without changing machine codes.

| Example | Agent/service action | Human guidance |
| --- | --- | --- |
| MODEL_RATE_LIMITED | Bounded retry within grant, policy and budget; rescan each invocation | Retry timing and provider status |
| MODEL_USAGE_UNKNOWN | Keep cost estimate/provenance distinct; reconcile usage | Explain missing metering and provisional totals |
| TOOL_SCOPE_DENIED | Stop; no argument-guessing loop to evade policy | Show denied capability category and request review |
| VALIDATION_FAILED | Stop current run under ADR-0001; preserve test evidence | Show failing checks and human disposition options |
| SANDBOX_UNAVAILABLE | Block execution; bounded infrastructure retry only when no uncertain mutation exists | Identify environment and operator action |
| SENSITIVE_DATA_UNCERTAIN | Follow ADR-0005; no automatic retry/bypass | Authenticated security-case entry |
| DELIVERY_OUTCOME_UNKNOWN | Reconcile the existing operation before further writes | Show known side effects and reconciliation state |

Recoverable transport errors are distinguished from harness stop conditions.
The service, not the LLM, decides retry eligibility and enforces attempt/time/
cost limits. It must not rewrite a policy denial as a generic server error or
automatically widen a grant. User-facing details explain what failed and what
can be done; a trace ID alone is insufficient guidance.

### Invocation ledger, rate cards, and budgets

Meter at the gateway per actual invocation attempt, including failures,
retries and fallbacks. Record provider request ID where exposed, requested
and returned model identity, start/end time, finish status, token categories,
usage provenance, and known/estimated/unknown completeness. Keep input/output,
cache reads/writes, and provider-exposed reasoning categories distinct without
double-counting categories already included in totals. Adapters define the
provider's metering semantics and currency/units explicitly.

Use immutable effective-dated rate-card revisions with endpoint/model,
currency, category, unit, source, and applicable time. Compute cost per category
as chargeable units times its bound rate and unit divisor. Snapshot the rate
revision on the invocation; later configuration never silently reprices it.
Provider corrections produce linked adjustment entries, not overwritten
historical charges. Unknown rates or usage yield unknown components;
estimates are labeled and never shown as an invoiced amount.

Do not assign zero rates to newly discovered models. Self-hosted usage can
show tokens and administrator-entered allocation rates separately from
measured infrastructure cost. Cross-currency totals remain separated unless
an explicit versioned FX source/time is supplied. Token cost is not total
worker/infrastructure cost. Store fixed-precision monetary quantities.

Enterprise/workspace/run budgets have a common authority at the gateway:
reserve a conservative bound before dispatch and settle against observed
usage, accounting for concurrent calls. Enforce model token ceilings. If no
finite safe reservation is available for a monetary cap, block or require a
configured bounded token-only policy, rather than assume zero cost. Unknown
provider outcomes retain a conservative reservation for reconciliation; they
do not silently release all budget or trigger a duplicate invocation. Retries
and fallbacks consume budget too. Internal limits bound authorized estimates;
they cannot guarantee a provider invoice cap when metering is delayed or
the provider violates stated limits.

### Dashboards, access, and operational signals

Provide enterprise/workspace/task/agent/model/date breakdowns with request
counts, known and estimated tokens/cost, unknown counts, latency, denial/error
rates, retries, queue age, connector lag, validation outcomes, approval waiting
time, delivery results, and worker utilization where measured. Define metric
denominators and timezone explicitly; distinguish an empty period from missing
telemetry. Cost charts show currency, rate revision, completeness and update time.

Drill down from an issue to its execution/causal trace, allowed artifacts,
approvals and delivery evidence, and from a cost item to an invocation ledger
entry. Financial access does not imply prompt-content access; workspace access
does not imply quarantine access. Restrict employee-identifying analytics and
audit exports under enterprise roles; export/read operations are audited.

Phase one captures all required action/decision/error metadata without
sampling away failures or security events. High-volume debug content may be
limited, with explicit truncation/dropped-record counters. Durable capture
protects mandatory records while remote exporters are unavailable; exhaustion
stops actions needing that evidence. Observability destination approval and
data classification apply to exporters too: external tracing/analytics cannot
be used as an unapproved code/log egress path. Model providers' own retention
and telemetry are included when approving an external endpoint.

## Consequences and rejected alternatives

This enables diagnosis and cost accountability with explicit privacy and
completeness limits. It adds protected storage, versioned metering adapters,
budget concurrency and retention work. Reject always-on raw prompt dumps,
claims of complete hidden reasoning, zero-filled missing usage, double-counted
cached/reasoning tokens, current-price historical repricing, unrestricted
employee dashboards, and exported traces that bypass ADR-0005.

## Implementation acceptance

1. One issue can be followed across queue retries, Pi agents, gateway, dsh,
   sandbox and delivery without rewriting execution evidence or duplicating
   business events. Missing/late/truncated records are visible.
2. Secret-bearing prompts, responses, tools, SDK errors and exports pass
   leakage tests; content and quarantine access stay separately authorized.
3. Error contracts distinguish denial/stop/retry/unknown outcomes and give
   actionable safe guidance. An LLM cannot override retry/grant policies.
4. Ledger tests cover stream interruption, missing usage, caches, reasoning
   categories, model discovery, multiple currencies, rate changes, corrections,
   time boundaries and concurrent budget reservations without fake zero totals.
5. Workspace substitution, restricted financial/content roles, retention,
   backup/expiry, exporter failure and capacity exhaustion have tested outcomes.
6. Generated API contracts merge before dependent frontend work. Delivery
   uses main-based linked PRs, applicable checks and the new-head in_review/QA
   gate; done requires QA pass. This ADR creates no implemented dashboard.
