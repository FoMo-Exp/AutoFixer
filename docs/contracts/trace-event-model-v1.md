# Trace event model v1

**Contract version:** `1.0.0`

**Status:** implementation contract
**Normative source:** `docs/adr/0008-observability-errors-and-model-cost-accounting.md`
**Implementation:** `node/src/trace/` (schema, labels, store, projection) with tests in
`node/test/trace-*.test.ts`

This document defines the trace/event envelope that correlates one issue across
queues, workers, the gateway, dsh, sandbox, and delivery (DAT-224). It is
documentation of the shipped model, not a grant of authority. The words
**MUST**, **MUST NOT**, and **MAY** are normative.

## 1. Record classes and authority

| `record_class` | Authoritative writer | Rule |
| --- | --- | --- |
| `control_plane_audit` | dsh and control-plane services | Written by its own authoritative writer; never rewritten or reordered by Node or a projection. |
| `worker_evidence` | Workers and executors | Same rule: the writer owns its stream; a redelivery cannot change content. |
| `operational_trace` | Queues, gateway, sandbox, delivery, tooling | Observability records that reference evidence (`evidence_refs`) instead of copying it. |

Correlation does not imply one globally ordered chain. Each writer owns its
`sequence`; views merge for display only. Evidence referenced by
`evidence_refs` stays with its authority — the trace store never copies,
edits, or reorders it.

## 2. Envelope and identifiers

Every event carries `source`, `event_id`, `version`, `sequence`, `event_time`,
`ingest_time`, `record_class`, `kind`, and the correlation chain
`enterprise_id`, `workspace_id`, `issue_id`, `task_id`, `run_id`, `attempt_id`,
`agent_id`, `agent_config_revision`, `invocation_id`, `tool_id`, `artifact_id`,
`delivery_id`, `trace_id`, `span_id`, `parent_span_id`, plus `causation_id`
(`source/event_id` of the cause), `evidence_refs`, `labels`, `payload`, and
`truncated`.

- Times are UTC RFC 3339. `event_time` is when the writer says it happened;
  `ingest_time` is when the store first recorded it. They are never conflated.
- Nullable IDs are explicitly `null` or a non-empty string; absence is never a
  substitute for a known empty value.
- `payload` is free-form detail for humans under the content policy of
  DAT-225 (`docs/contracts/trace-content-retention-v1.md`). It is not
  evidence, not a label, and not metric-readable.

## 3. Identity, deduplication, and immutability

The dedup identity is the pair `(source, event_id)`. Duplicate delivery is
recorded once; the second delivery is acknowledged as `duplicate` and notifies
nobody. A redelivery whose content differs from what is recorded is a
`TraceConflictError` — recorded evidence is never overwritten through the
delivery path. The store has no update or delete operation; reads return
defensive copies.

## 4. Ordering

`sequence` is per source and is the only ordering authority. There is no
global sequence number. Projections sort a display merge by
`(event_time, source, sequence)`; that order is explicitly not authoritative.
A record is **late** when it arrives after its source had already recorded a
higher `sequence`. A **missing** range is a run of unseen sequences for one
source, counting from 1: both a leading run below the first observation and
interior gaps are reported, so a view holding only sequence 5 reports 1–4 as
missing instead of claiming completeness. A **truncated** record carries the
writer's `truncated: true` marker. Late and truncated records are referenced
by `source/event_id` (the dedup identity), never by bare `event_id`.

## 5. Metric labels

`labels` is the only event content a metric may read. Keys come from the
closed vocabulary (`status`, `outcome`, `reason_code`, `queue`, `phase`,
`provider`, `model`); the store refuses anything else. Values are non-empty
printable ASCII of at most 96 characters. Payloads, file contents, credentials,
and raw error text MUST NOT appear in labels; metrics may group only by
`source`, `kind`, `record_class`, or a label key.

## 6. Access scoping

Every query, stream, export, and aggregate runs inside an authenticated
`AccessScope` (`enterprise_id`, `workspace_id`, `subject`). Reads are confined
to that enterprise and workspace even without an explicit filter. A filter that
targets another workspace or enterprise is refused with `TraceAccessError` —
including same-enterprise workspace boundaries (ADR-0006). Scope fields MUST
be non-empty, and malformed `since`/`until` bounds are refused with
`TraceValidationError` instead of silently matching nothing.

## 7. Schema versioning and migration strategy

`version` is the event schema version; `TRACE_SCHEMA_VERSION` is current.

- Writers emit the current version.
- `migrateTraceEvent` upgrades stored records forward: an unversioned (v0)
  record receives explicit defaults — `record_class: "operational_trace"`,
  empty `evidence_refs`/`labels`, `payload: null`, `truncated: false`, and
  `ingest_time` falling back to `event_time` — and is stamped current. Future
  revisions extend this chain; they never rewrite earlier steps.
- Defaults live only in that v0 migration path. A record that already claims
  the current version is validated strictly: a missing field is rejected, so
  corruption cannot masquerade as known-empty data.
- A record or store envelope with a **newer** version is refused loudly
  (`TraceValidationError` / startup failure) instead of being misread.
  Corrupt or future-versioned state fails startup rather than dropping
  history.
- The persisted envelope carries its own `schema_version` and migrates the
  same way (v0 = unversioned).

Migrations are additive; a shipped migration is never modified in place.
