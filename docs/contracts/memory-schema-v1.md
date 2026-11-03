# Workspace memory schema v1 (DAT-232)

Contract for the workspace-memory persistence layer: tables, immutability and
supersession rules, scope isolation, and erasure semantics. The invariants here
are enforced at the storage layer; upper slices (capture, retrieval, templates,
RSI) build on them and cannot weaken them.

Storage lives in the control-plane SQLite database (`node/src/control-plane`,
migration version 2) and is accessed only through the scoped repositories in
`node/src/memory/`. No handler or service writes SQL directly, and there is no
unscoped read surface.

## Tables

| Table | Purpose | Scope columns |
| --- | --- | --- |
| `memory_items` | Stable identity + lifecycle (status, current version, confidence counters) | `enterprise_id`, `workspace_id` |
| `memory_item_versions` | Immutable content versions (memory-item contract fields) | `enterprise_id`, `workspace_id` |
| `memory_evidence` | Run / issue / PR / commit / test / reviewer-decision / incident references | `enterprise_id`, `workspace_id` |
| `memory_links` | `supersedes` / `contradicts` / `related` / `derived_from`, always inside one workspace | `enterprise_id`, `workspace_id` |
| `memory_events` | Append-only audit trail; survives deletion and erasure (no foreign keys) | `enterprise_id`, `workspace_id` |
| `memory_embeddings` | Derived vectors, keyed to an exact source version | `enterprise_id`, `workspace_id` |
| `memory_tombstones` | Minimal non-sensitive remnant kept after a purge | `enterprise_id`, `workspace_id` |

Every content row carries `enterprise_id` and `workspace_id`; every query
embeds both in its WHERE clause. A record outside the caller's workspace is
indistinguishable from a missing one. A scope that lacks `enterprise_id`,
`workspace_id`, or `actor_id` fails closed with `SCOPE_DENIED` before any SQL
runs.

## Memory-item contract (per version)

Each `memory_item_versions` row is self-contained: `kind`, applicability
`scope`, `statement`, `preconditions`, `provenance`, `trust`, `sensitivity`,
`valid_from`/`valid_to`, `content_hash`, `source_run_id`, and `review`. Any
historical run's memory can be rebuilt exactly from the version table:
`source_run_id` correlates versions to runs, and the validity windows answer
"which version was effective at time T" with exactly one answer.

- `kind`: `fact`, `lesson`, `playbook`, `anti_pattern`, `episode`, `policy`.
- `trust`: `human`, `agent`, `enterprise_template`, `system`.
- `sensitivity`: `internal`, `confidential`, `restricted`.
- Immutability: content fields never change after creation. `valid_to` is the
  one exception and is set at most once, when a successor version or a
  supersession closes the window. Validity windows inside one item never
  overlap and never move backwards.
- `content_hash`: SHA-256 over the canonical form of
  `{kind, scope, statement, preconditions, sensitivity}` (sorted keys,
  sorted preconditions). A write whose hash matches an existing version of the
  item is an idempotent no-op. Provenance, trust, and temporal metadata are not
  content.
- `review` (`{approver_id, approved_at}`) is set-once and stamps the exact
  version approved.

## Lifecycle

Status lives on the item row; every transition is audited with the version it
applies to. The ADR-0009 state machine:

```
proposed   → candidate | deprecated | quarantined
candidate  → active | deprecated | quarantined
active     → deprecated | quarantined
deprecated → active | retired | quarantined
quarantined→ candidate | retired
retired    → (terminal)
```

Reaching `active` requires at least one evidence reference. Transitions are
guarded by the exact content version the actor reviewed (optimistic
concurrency); a stale version raises `VERSION_CONFLICT`.

Supersession records a `supersedes` link with a reason, closes the previous
item's open validity window, and deprecates it — except a `quarantined` or
`retired` item keeps its status. Content is never destructively overwritten.

## Isolation guarantees

- Reads (`getById`, `getVersion`, `listVersions`, `getEffectiveVersion`,
  `listVersionsBySourceRun`, `list`, `search`, `exportWorkspace`, evidence,
  links, embeddings, events, tombstones) return nothing across a workspace or
  enterprise boundary.
- Writes (`create`, `addVersion`, `setStatus`, `reviewVersion`, `supersede`,
  `deleteItem`, evidence/link/embedding writes) raise `NOT_FOUND` for foreign
  IDs. Substituting an enterprise or workspace ID in the scope grants nothing.
- Enterprise templates and external retrieval have no bypass: these
  repositories are the only path to the memory tables and every method takes a
  `WorkspaceScope`. Embeddings are derived sensitive data and are not part of
  the export surface.

## Deletion and erasure

- `deleteItem` purges the item with its versions, evidence, links, and
  embeddings (FK cascade), keeps one `item_deleted` tombstone, and audits the
  purge.
- `eraseWorkspace` purges every memory content row of the workspace, writes one
  `workspace_erased` tombstone per purged item, and audits the result. It is
  idempotent in content: a second call purges nothing but is still audited.
- Deleting the workspace row cascades all memory content rows, so a deleted
  workspace can never leave items or embeddings behind.
- Tombstones and audit events contain opaque IDs, reasons, and actor/time
  metadata only — never statements, hashes, or provenance. They outlive the
  rows they describe.

## Migrations

Control-plane migrations are versioned in an ordered list and recorded in
`schema_migrations`; version 2 creates the memory tables. Re-running on an
existing database is a no-op and preserves data.

## Bounds

Every list, search, audit read, and export takes a limit: positive integer,
default 100, hard cap 1000. Nothing is unbounded.
