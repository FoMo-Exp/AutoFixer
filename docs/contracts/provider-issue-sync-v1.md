# Provider issue synchronization v1

**Status:** Approved product scope; initial implementation in progress.

## Connection setup

Provision the service integration with a separate
`issue_sync_credential_ref`. Store its token in the protected service
credential file selected by `FORGEPILOT_SERVICE_CREDENTIAL_FILE`; the file is
keyed by credential reference. The token needs permission to read and write
issues, labels, and comments for the bound repository. Setting the reference
records `issue_sync_connected_at`, which is the lower bound for provider
polling. The app never reads this token from the renderer or from agent task
credentials. Polling runs every minute while the orchestrator is running and
also reconciles when the Issues list or a specific issue is opened.

## Scope

Synchronize ForgePilot issues with one linked issue in the workspace's bound
GitHub or GitLab repository. A workspace selects one provider instance and one
immutable repository identity. GitHub.com, GitLab.com, and explicitly
administrator-approved compatible instances use provider-specific adapters.

Do not backfill issues that existed before the repository integration was
connected. From connection time onward, mirror provider issues when they are
created or changed. ForgePilot-created issues are created in both systems.
Use `(provider instance, immutable repository ID, provider issue ID)` as the
unique external identity. Repeated webhook delivery or retry must never create
a duplicate.

## Synchronized fields

| Field | Direction | Rules |
|---|---|---|
| Title | Both | The ForgePilot summary is the synchronized title. |
| Description | Both | External issue body is the synchronized description. |
| Open/closed | Both | Store provider state separately from ForgePilot `product_state`; a close/reopen never completes, cancels, or stops execution. |
| Labels | Both | Synchronize the complete label set, preserving provider identity and normalized display value. |
| Comments | Both | Append and deduplicate by provider comment ID; preserve source author and time. Do not copy internal run, candidate, approval, or delivery data into comments. |

Comments are append-only synchronization records. A rollback restores title,
description, state, or labels from a selected version; it does not delete a
comment. Comment correction is a new comment.

## Conflict resolution and history

Track the last common version and modification timestamp for every synchronized
field. If only one side changed a field, apply that value to the other side. If
both sides changed it, the value with the later source modification timestamp
wins. Apply fields independently so non-overlapping edits merge.

Every accepted local or provider change creates an immutable version containing
the synchronized snapshot, source, actor where available, source timestamp,
receipt timestamp, and changed-field set. Comments are represented as
append-only version events. Provider timestamps are normalized to UTC; retries
and out-of-order webhooks reconcile against canonical provider state. Equal
timestamps retain the most recently accepted canonical version and are shown
in the audit history.

Rollback is a new versioned operation: copy the selected snapshot's
rollback-capable fields into the current version, then push those values to the
provider. Never rewrite or delete prior versions. A rollback fails closed if
the provider cannot be updated; retain the current version and show the retry
state.

## Reliability and API behavior

- Poll the provider on a bounded schedule and when the workbench is opened;
  begin from the issue-sync connection timestamp and never backfill older
  issues. Keep the cursor per repository integration.
- Persist outbound mutations in a transactional outbox with an idempotency
  key. Retry bounded transient failures; expose permanent errors and
  rate-limit retry times in the workbench.
- Use canonical provider reads to reconcile ambiguous or out-of-order events.
  Suppress echo loops by operation ID and resulting provider version/ETag.
- A create request must return a durable operation state (`pending`, `synced`,
  or `failed`) and the local issue identity. Do not report provider success
  until the external identity is durably linked.
- The workbench shows the external issue link, provider open/closed state, last
  successful sync, pending/error status, version history, and rollback action.

## Authorization

Use a repository-scoped server integration with only the permissions required
to read/write issues, labels, and comments. Keep it separate from checkout and
delivery grants. Verify the authenticated actor's current workspace role
before create, update, or rollback. Agent runs never receive provider tokens.
Do not synchronize private execution evidence, candidate diffs, approvals, or
delivery records.

## Acceptance

1. A member can create an issue in the workbench; one local record and one
   provider issue are linked idempotently.
2. New and changed provider issues after connection appear locally; historical
   issues are not imported unless a post-connection change is observed.
3. Title, description, open/closed, labels, and comments propagate in both
   directions for GitHub and GitLab.
4. Concurrent changes to different fields merge; concurrent changes to the
   same field follow last-modified-wins and leave immutable versions on both
   sides.
5. A user can restore a prior synchronized field snapshot; restoration creates
   a new version and updates the provider.
6. Provider closure never completes or cancels ForgePilot execution state.
7. Duplicate, replayed, out-of-order, rate-limited, and unavailable-provider
   scenarios do not duplicate records or lose the retry/audit state.
8. No provider secret appears in the renderer, issue records, agent context,
   artifacts, or ordinary logs.
