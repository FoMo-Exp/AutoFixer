import { randomUUID } from "node:crypto";

import type { ControlPlaneDb } from "../control-plane/db.js";
import type { ProviderType } from "../control-plane/types.js";
import type {
  IssueContentVersion,
  IssueVersionHistory,
  SyncedIssueComment,
} from "./versions.js";

export interface ProviderIssueLink {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  issue_id: string;
  provider_instance_id: string;
  provider_type: ProviderType;
  repository_id: string;
  provider_issue_id: string;
  provider_issue_number: string;
  provider_url: string;
  provider_state: "open" | "closed";
  provider_updated_at: string;
  last_synced_at: string;
}

export type NewProviderIssueLink = Omit<ProviderIssueLink, "id">;

export interface NewIssueSyncOperation {
  enterprise_id: string;
  workspace_id: string;
  issue_id: string;
  idempotency_key: string;
  operation_type: "create" | "update" | "comment" | "rollback";
  payload: Record<string, unknown>;
}

export interface IssueSyncOperation extends NewIssueSyncOperation {
  operation_id: string;
  state: "pending" | "processing" | "synced" | "failed";
  attempt_count: number;
  retry_after: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface LinkRow extends Omit<ProviderIssueLink, "provider_type"> {
  provider_type: string;
}

interface OperationRow extends Omit<IssueSyncOperation, "payload"> {
  payload: string;
}

export class IssueSyncConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueSyncConflict";
  }
}

/** SQLite-backed link, version, inbox, and outbox storage for issue sync. */
export class IssueSyncStore {
  constructor(private readonly db: ControlPlaneDb) {}

  linkIssue(link: NewProviderIssueLink): ProviderIssueLink {
    const id = `islink_${randomUUID().replaceAll("-", "")}`;
    const at = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO issue_provider_link (
             id, enterprise_id, workspace_id, issue_id, provider_instance_id,
             provider_type, repository_id, provider_issue_id, provider_issue_number,
             provider_url, provider_state, provider_updated_at, last_synced_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          link.enterprise_id,
          link.workspace_id,
          link.issue_id,
          link.provider_instance_id,
          link.provider_type,
          link.repository_id,
          link.provider_issue_id,
          link.provider_issue_number,
          link.provider_url,
          link.provider_state,
          link.provider_updated_at,
          link.last_synced_at,
          at,
          at,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new IssueSyncConflict("provider issue is already linked to a ForgePilot issue");
      }
      throw error;
    }
    return { ...link, id };
  }

  getLinkByIssue(workspaceId: string, issueId: string): ProviderIssueLink | undefined {
    const row = this.db
      .prepare("SELECT * FROM issue_provider_link WHERE workspace_id = ? AND issue_id = ?")
      .get(workspaceId, issueId) as LinkRow | undefined;
    return row ? toLink(row) : undefined;
  }

  getLinkByProvider(
    providerInstanceId: string,
    repositoryId: string,
    providerIssueId: string,
  ): ProviderIssueLink | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM issue_provider_link
         WHERE provider_instance_id = ? AND repository_id = ? AND provider_issue_id = ?`,
      )
      .get(providerInstanceId, repositoryId, providerIssueId) as LinkRow | undefined;
    return row ? toLink(row) : undefined;
  }

  updateLinkState(
    workspaceId: string,
    issueId: string,
    state: ProviderIssueLink["provider_state"],
    providerUpdatedAt: string,
    lastSyncedAt: string,
  ): void {
    this.db
      .prepare(
        `UPDATE issue_provider_link
         SET provider_state = ?, provider_updated_at = ?, last_synced_at = ?, updated_at = ?
         WHERE workspace_id = ? AND issue_id = ?`,
      )
      .run(state, providerUpdatedAt, lastSyncedAt, lastSyncedAt, workspaceId, issueId);
  }

  appendVersion(workspaceId: string, issueId: string, version: IssueContentVersion): void {
    this.db
      .prepare(
        `INSERT INTO issue_content_version (
           issue_id, workspace_id, sequence, version_id, source, source_modified_at,
           recorded_at, changed_fields, content_snapshot, rollback_of
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        issueId,
        workspaceId,
        version.sequence,
        version.version_id,
        version.source,
        version.source_modified_at,
        version.recorded_at,
        JSON.stringify(version.changed_fields),
        JSON.stringify(version.content),
        version.rollback_of,
      );
  }

  listVersions(workspaceId: string, issueId: string): IssueContentVersion[] {
    const rows = this.db
      .prepare(
        `SELECT version_id, sequence, source, source_modified_at, recorded_at,
                changed_fields, content_snapshot, rollback_of
         FROM issue_content_version WHERE workspace_id = ? AND issue_id = ? ORDER BY sequence`,
      )
      .all(workspaceId, issueId) as Array<{
      version_id: string;
      sequence: number;
      source: IssueContentVersion["source"];
      source_modified_at: string;
      recorded_at: string;
      changed_fields: string;
      content_snapshot: string;
      rollback_of: string | null;
    }>;
    return rows.map((row) => ({
      version_id: row.version_id,
      sequence: row.sequence,
      source: row.source,
      source_modified_at: row.source_modified_at,
      recorded_at: row.recorded_at,
      changed_fields: JSON.parse(row.changed_fields) as IssueContentVersion["changed_fields"],
      content: JSON.parse(row.content_snapshot) as IssueContentVersion["content"],
      rollback_of: row.rollback_of,
    }));
  }

  loadHistory(workspaceId: string, issueId: string): IssueVersionHistory | undefined {
    const versions = this.listVersions(workspaceId, issueId);
    const latest = versions.at(-1);
    if (!latest) return undefined;
    const initial = versions[0]!;
    const fieldModifiedAt = Object.fromEntries(
      ( ["title", "description", "state", "labels"] as const).map((field) => [
        field,
        initial.source_modified_at,
      ]),
    ) as IssueVersionHistory["field_modified_at"];
    for (const version of versions) {
      for (const field of version.changed_fields) fieldModifiedAt[field] = version.source_modified_at;
    }
    return {
      issue_id: issueId,
      content: latest.content,
      field_modified_at: fieldModifiedAt,
      versions,
      comments: this.listComments(workspaceId, issueId),
    };
  }

  appendComments(workspaceId: string, issueId: string, comments: readonly SyncedIssueComment[]): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO issue_sync_comment (
         id, workspace_id, issue_id, source, source_comment_id, author, body, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    for (const comment of comments) {
      const result = insert.run(
        comment.id,
        workspaceId,
        issueId,
        comment.source,
        comment.source_comment_id,
        comment.author,
        comment.body,
        comment.created_at,
        comment.created_at,
      );
      added += Number(result.changes);
    }
    return added;
  }

  listComments(workspaceId: string, issueId: string): SyncedIssueComment[] {
    return this.db
      .prepare(
        `SELECT id, source, source_comment_id, author, body, created_at
         FROM issue_sync_comment WHERE workspace_id = ? AND issue_id = ? ORDER BY created_at, id`,
      )
      .all(workspaceId, issueId) as unknown as SyncedIssueComment[];
  }

  enqueue(input: NewIssueSyncOperation): IssueSyncOperation {
    const existing = this.db
      .prepare("SELECT * FROM issue_sync_outbox WHERE idempotency_key = ?")
      .get(input.idempotency_key) as OperationRow | undefined;
    if (existing) {
      if (
        existing.workspace_id !== input.workspace_id ||
        existing.issue_id !== input.issue_id ||
        existing.operation_type !== input.operation_type ||
        existing.payload !== JSON.stringify(input.payload)
      ) {
        throw new IssueSyncConflict("idempotency key was reused for a different issue sync operation");
      }
      return toOperation(existing);
    }
    const operationId = `isop_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO issue_sync_outbox (
           operation_id, enterprise_id, workspace_id, issue_id, idempotency_key,
           operation_type, payload, state, attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        operationId,
        input.enterprise_id,
        input.workspace_id,
        input.issue_id,
        input.idempotency_key,
        input.operation_type,
        JSON.stringify(input.payload),
        now,
        now,
      );
    return {
      ...input,
      operation_id: operationId,
      state: "pending",
      attempt_count: 0,
      retry_after: null,
      error_code: null,
      created_at: now,
      updated_at: now,
    };
  }

  latestOperation(workspaceId: string, issueId: string): IssueSyncOperation | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM issue_sync_outbox WHERE workspace_id = ? AND issue_id = ?
         ORDER BY created_at DESC, operation_id DESC LIMIT 1`,
      )
      .get(workspaceId, issueId) as OperationRow | undefined;
    return row ? toOperation(row) : undefined;
  }

  claimPending(limit = 20, now = new Date().toISOString()): IssueSyncOperation[] {
    const staleBefore = new Date(Date.parse(now) - 2 * 60_000).toISOString();
    this.db.prepare(
      `UPDATE issue_sync_outbox SET state = 'failed', retry_after = ?, error_code = 'WORKER_RESTARTED', updated_at = ?
       WHERE state = 'processing' AND updated_at < ?`,
    ).run(now, now, staleBefore);
    const rows = this.db
      .prepare(
        `SELECT * FROM issue_sync_outbox
         WHERE ((state = 'pending' AND created_at < ?) OR
                (state = 'failed' AND (retry_after IS NULL OR retry_after <= ?)))
         ORDER BY created_at, operation_id LIMIT ?`,
      )
      .all(new Date(Date.parse(now) - 60_000).toISOString(), now, Math.max(1, Math.min(limit, 100))) as unknown as OperationRow[];
    const claimed: IssueSyncOperation[] = [];
    for (const row of rows) {
      const update = this.db
        .prepare(
          `UPDATE issue_sync_outbox SET state = 'processing', attempt_count = attempt_count + 1,
             updated_at = ? WHERE operation_id = ? AND state IN ('pending', 'failed')`,
        )
        .run(now, row.operation_id);
      if (Number(update.changes) > 0) {
        claimed.push({ ...toOperation(row), state: "processing", attempt_count: row.attempt_count + 1 });
      }
    }
    return claimed;
  }

  finishOperation(
    operationId: string,
    result: { state: "synced" | "failed"; retry_after?: string | null; error_code?: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE issue_sync_outbox SET state = ?, retry_after = ?, error_code = ?, updated_at = ?
         WHERE operation_id = ?`,
      )
      .run(
        result.state,
        result.retry_after ?? null,
        result.error_code ?? null,
        new Date().toISOString(),
        operationId,
      );
  }

  receiveWebhook(providerInstanceId: string, deliveryId: string, workspaceId: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO issue_sync_inbox
           (provider_instance_id, delivery_id, workspace_id, received_at, outcome)
         VALUES (?, ?, ?, ?, 'received')`,
      )
      .run(providerInstanceId, deliveryId, workspaceId, new Date().toISOString());
    return Number(result.changes) > 0;
  }

  getUpdatedAfter(integrationId: string, connectedAt: string): string {
    const row = this.db
      .prepare("SELECT updated_after FROM issue_sync_cursor WHERE integration_id = ?")
      .get(integrationId) as { updated_after: string } | undefined;
    if (row) return row.updated_after;
    this.db
      .prepare(
        `INSERT INTO issue_sync_cursor (integration_id, connected_at, updated_after, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(integrationId, connectedAt, connectedAt, new Date().toISOString());
    return connectedAt;
  }

  advanceUpdatedAfter(integrationId: string, updatedAfter: string): void {
    this.db
      .prepare(
        `UPDATE issue_sync_cursor SET updated_after = CASE
           WHEN updated_after < ? THEN ? ELSE updated_after END, updated_at = ?
         WHERE integration_id = ?`,
      )
      .run(updatedAfter, updatedAfter, new Date().toISOString(), integrationId);
  }

  finishWebhook(
    providerInstanceId: string,
    deliveryId: string,
    outcome: "processed" | "ignored" | "failed",
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE issue_sync_inbox SET outcome = ?, processed_at = ?
         WHERE provider_instance_id = ? AND delivery_id = ?`,
      )
      .run(outcome, now, providerInstanceId, deliveryId);
  }

  saveHistory(history: IssueVersionHistory, workspaceId: string, previousSequence: number): void {
    const addedVersions = history.versions.filter((version) => version.sequence > previousSequence);
    this.db.exec("BEGIN");
    try {
      for (const version of addedVersions) this.appendVersion(workspaceId, history.issue_id, version);
      this.appendComments(workspaceId, history.issue_id, history.comments);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function toLink(row: LinkRow): ProviderIssueLink {
  return { ...row, provider_type: row.provider_type as ProviderType };
}

function toOperation(row: OperationRow): IssueSyncOperation {
  return {
    ...row,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    state: row.state as IssueSyncOperation["state"],
  };
}
