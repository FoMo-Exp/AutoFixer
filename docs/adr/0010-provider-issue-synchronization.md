# ADR 0010: Bidirectional provider issue synchronization

**Status:** Accepted

**Date:** 2026-11-14

## Context

The Issues workbench needs to create issues from ForgePilot and synchronize
them with GitHub and GitLab. Provider changes must also appear in ForgePilot.
The workbench currently has no issue creation form, the API contract's
collaboration HTTP/SSE routes are not wired, and provider PATs are held only by
Electron for repository discovery (ADR-0004). Issue synchronization therefore
adds provider read/write network operations and cannot reuse the discovery PAT
as an ambient execution credential.

## Decision

- A workspace issue is linked to at most one external issue by the immutable
  provider instance, repository identity, and provider issue ID. Repository
  renames do not break the link. The link is unique and idempotent.
- Issue creation in ForgePilot creates the provider issue and durable local
  record as one recoverable operation. Provider-created issues are mirrored
  after the integration is connected. Do not backfill historical issues;
  synchronize issues created or changed after connection.
- Synchronize title, description, provider open/closed state, labels, and
  comments in both directions. Comments are append-only, deduplicated by
  provider identity, and retain the source author and timestamp. Internal
  execution events, candidate diffs, approvals, and delivery details are never
  copied into provider issue content.
- Provider open/closed state is stored separately from ForgePilot's product
  lifecycle. Closing a provider issue does not complete, cancel, or stop a
  ForgePilot issue or run.
- For a field changed on both sides since the last common version, the value
  with the later source modification timestamp wins. Every accepted local or
  remote change creates an immutable version. A rollback copies a chosen
  version into a new current version and synchronizes that restored value to
  the provider; it never rewrites history.
- Use a durable outbox for writes and poll canonical provider issue state on a
  bounded schedule for inbound changes. Also reconcile when the Issues workbench
  is opened. Outbound writes use idempotency, bounded retries, and canonical
  reads; never treat provider update order as mutation order.
- Issue-sync credentials are server-side, repository-scoped capabilities,
  distinct from checkout-read and delivery-write credentials. The integration
  advertises the exact issue scopes it holds. Credentials never enter renderer,
  agent, task workspace, issue data, or ordinary audit/log output. GitHub and
  GitLab adapters pin requests to the configured provider origin; webhook
  signatures are verified before payload data is accepted.

## Consequences

- Workspace administrators must install or configure an issue-sync integration
  with the minimum provider permissions needed to read and write issue content.
  Existing Electron PATs remain discovery-only.
- The API contract and durable collaboration model need provider-link,
  field-version, comment-deduplication, sync-status, and rollback records. The
  Issue create UI must report pending/failed provider synchronization rather
  than claiming success before reconciliation.
- GitHub/GitLab do not provide identical pagination, state, and comment
  semantics. Adapters normalize provider differences, and unsupported
  self-hosted origins fail closed until explicitly configured.
- Last-modified wins can replace a newer human edit when source timestamps are
  delayed or tied. Preserve every version and surface the winning source and
  timestamp so an authorized user can restore an earlier version.
