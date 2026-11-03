# Trace content, retention, and exporter boundary v1

**Contract version:** `1.0.0`

**Status:** implementation contract
**Normative source:** `docs/adr/0008-observability-errors-and-model-cost-accounting.md`
**Implementation:** `node/src/trace/` (content, retention, access, exporter) with tests in
`node/test/trace-content.test.ts`, `node/test/trace-retention.test.ts`,
`node/test/trace-access.test.ts`, `node/test/trace-exporter.test.ts`,
`node/test/trace-secret-leak.test.ts`

This document defines how trace material is handled before ordinary
persistence (DAT-225): scanning and redaction, content classification,
finite enterprise retention, and the boundaries around content access,
quarantine access, and external exporters. It is documentation of the
shipped contract, not a grant of authority. The words **MUST**, **MUST
NOT**, and **MAY** are normative.

## 1. Pre-persistence scanning and redaction

Request, response, tool, and SDK-error material MUST only reach ordinary
persistence through the content capture gate (`ContentCapture`), which scans
and redacts it first. The scan is unconditional: material from model calls
that never leave the internal environment is treated exactly like material
bound for external endpoints — there is no egress-based skip.

Detection reuses the shared DAT-209 seam (the `SecretScanner` interface and
the built-in pattern scanner, rule version `2026-11-03.1`); redaction reuses
the shared DAT-226 blunt pass plus caller-declared literal secrets, so
dispatch-time and persistence-time handling cannot drift into different
secret vocabularies. Scanner-matched spans are replaced first, then the
blunt pattern pass runs, then literal secrets. The placeholder is always
`[redacted]`.

The persistence path is synchronous. A scanner that throws, hangs off the
sync path (returns a promise), or returns a report the gate cannot validate
— unsafe detector/rule identities, an unknown classification, malformed
findings — is an unavailable scanner: the material is refused with
`CONTENT_SCAN_UNAVAILABLE` and never stored. Detector and rule identities in
evidence MUST stay token-shaped (`[A-Za-z0-9._-]{1,64}`) so evidence can
never carry matched material.

## 2. Content classification and scan evidence

Material carries data classes from the closed DAT-209 vocabulary (`system`,
`user_input`, `history`, `code`, `logs`, `diffs`, `tool_results`,
`derived_summaries`); at least one class MUST be declared and unknown classes
are refused. Every captured record keeps non-secret scan evidence: scanner
identity, rule version, the DAT-209 secret classification
(`clean`/`secret_suspected`/`secret_confirmed`/`unknown`), sorted detector
identities that fired, and finding counts — never matched material and never
content hashes.

## 3. Raw content capture and explicit counters

Raw content capture is opt-in and **default-off**. With it off, the capture
keeps metadata (kind, data classes, character counts, scan evidence) and no
content text at all: metadata and event continuity remain available, full
content replay is not. With it on, the persisted text is the redacted text,
truncated at the configured `max_material_chars` bound.

Every truncation and every drop is counted explicitly
(`ContentCapture.counters()`): `scanned`, `redactions`, `truncated`, and
`dropped` (materials whose text policy withheld from persistence). Nothing
is silently discarded.

## 4. Finite enterprise retention

The enterprise configures finite retention separately for `evidence`,
`trace`, `content`, `usage`, and `backup` records
(`RetentionConfig`, whole days, each class its own value). There is no
silent "retain forever" default: a missing, infinite, zero, negative, or
fractional value is refused (`RETENTION_CONFIG_INVALID`), and capture cannot
be enabled without a valid retention configuration.

- Expiry runs per record class. A record expires exactly when its class
  window has elapsed; backup copies are records of class `backup` and expire
  on the backup window.
- Deletion, expiry, and tombstones never rewrite historical audit evidence.
  The audit trail is append-only; reads return defensive copies. Each
  destructive outcome leaves a minimal tombstone — opaque id, record class,
  reason (`expired`/`deleted`), time, actor — with no content, hashes, or
  provenance. A tombstoned id is never reused.
- Legal hold (exceptional retention) and deletion require explicit enterprise
  policy: a `RetentionAdminGrant` minted by a `RetentionAuthority` after its
  server-side policy check, bound to the actor and the exact action
  (`place_legal_hold`, `release_legal_hold`, `delete`). The default policy
  denies every action. A held record is never expired and never deleted
  (`LEGAL_HOLD_ACTIVE`); releasing the hold restores ordinary expiry.

## 5. Content access and quarantine access are separately authorized

Workspace access does not imply quarantine access, and content access does
not imply either. Two independent capability seams carry the rule:

- `ContentVault` holds captured content records (already redacted; deposits
  are re-scanned as defense in depth) and only releases them under a
  `ContentGrant` minted by its own `ContentAccessAuthorizer`.
- `QuarantineVault` holds raw, secret-bearing source material required for
  security investigations (the ADR-0005 quarantine — the one place such
  material may live) and only releases it under a `QuarantineGrant` minted by
  its own `QuarantineAccessAuthorizer`. Quarantine material is never redacted
  (that would destroy the evidence) and never exported.

Neither vault accepts the other's grant, a caller-constructed grant, or a
grant from a different authorizer. The authorization check runs before the
record lookup, so an unauthorized caller cannot probe which records or cases
exist. Both default policies deny every read.

## 6. External exporter boundary

External tracing/analytics exporters are an egress path under ADR-0005:

- A destination is only trusted when registered with an ADR-0005 approval
  reference (`approval_ref`); registration without one is refused
  (`EXPORT_DESTINATION_NOT_APPROVED`). An internal service is never its own
  approval.
- Per-record data-class authorization uses the gateway's own
  `authorizeRequestDataClasses`: a record whose classes the destination's
  `permitted_data_classes` do not cover is refused before any byte leaves
  (`DATA_CLASS_NOT_AUTHORIZED`), and missing permitted classes fail closed
  (`AUTHORIZATION_MISSING`). Refused records stay pending for a destination
  approved for them.
- Every exported record's strings are re-scanned and redacted before
  delivery; export can never become a second leak surface.

## 7. Durable local capture, bounded buffer, and capacity exhaustion

- **Durable local capture** (`DurableLocalCapture`) is the lossless local
  layer mandatory records live in while remote exporters are unavailable.
  Records are scanned and redacted before they are written; the file holds
  exactly the live records and is compacted when a debug record is evicted.
  Duplicate delivery is deduplicated by `(source, event_id)`; a redelivery
  with different content is refused (`TRACE_EVENT_CONFLICT`). Delivery marks
  are process-local: after restart, records re-deliver at least once and
  consumers deduplicate by source/event identity.
- **Mandatory records are never lost.** The export batch is the bounded
  buffer plus every undelivered mandatory record read back from durable
  capture, so a record the buffer dropped is still delivered. While the
  transport is down, records stay pending; a failing flush keeps everything
  pending and counts `failed_flushes`.
- **The delivery buffer is bounded** (`ExportBuffer`). High-volume debug
  delivery drops at capacity with an explicit `dropped` counter; the records
  themselves remain in durable capture until retention expiry.
- **Capacity exhaustion blocks.** Mandatory evidence is captured before the
  action it belongs to (`EvidenceGate.requireEvidence`); when capture is
  exhausted and holds no evictable debug record, capture fails with
  `CAPTURE_CAPACITY_EXHAUSTED` and the action needing that evidence MUST
  stop instead of proceeding without it. Mandatory capture evicts the oldest
  debug record first (`evicted` counter); debug capture at capacity is
  dropped (`dropped` counter) — every one of these outcomes is counted.

## 8. Error codes

| Code | Meaning |
| --- | --- |
| `CONTENT_SCAN_UNAVAILABLE` | Scanner failed, is async on the sync path, or returned an untrusted report; material not stored. |
| `RETENTION_CONFIG_INVALID` | Retention values missing or not finite whole days. |
| `RETENTION_RECORD_UNKNOWN` / `RETENTION_RECORD_CONFLICT` / `LEGAL_HOLD_ACTIVE` | Retention record lifecycle refusals. |
| `RETENTION_ADMIN_DENIED` | No valid policy-minted grant for the hold/delete action. |
| `CONTENT_ACCESS_DENIED` / `QUARANTINE_ACCESS_DENIED` | Read without the matching authorizer-minted grant. |
| `QUARANTINE_CONFLICT` | Duplicate or malformed quarantine deposit. |
| `EXPORT_DESTINATION_NOT_APPROVED` | Destination registered or used without ADR-0005 approval. |
| `CAPTURE_CAPACITY_EXHAUSTED` | Mandatory evidence cannot be captured; the action stops. |
| `TRACE_EVENT_CONFLICT` / `TRACE_VALIDATION_FAILED` | From the DAT-224 error family (changed-content redelivery, invalid input). |
