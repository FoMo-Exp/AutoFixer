import { createHash } from "node:crypto";

import type { CollabMachine } from "../collab/machine.js";
import type {
  ProviderInstanceRepository,
  WorkspaceRepository,
} from "../control-plane/repositories.js";
import type { ServiceIntegrationRepository } from "../control-plane/provider-access-repositories.js";
import type { ServiceIntegration } from "../control-plane/provider-access-types.js";
import type { EnterpriseId } from "../control-plane/types.js";
import type { WorkspaceRunBindingResolver } from "../api/task-service.js";
import type { ServiceCredentialStore } from "../provider-access/credentials.js";
import { createProviderIssueApi } from "./provider-api.js";
import { IssueSyncStore } from "./store.js";
import {
  applyIssueChange,
  createIssueVersionHistory,
  rollbackIssueContent,
  type IssueSyncSource,
  type SyncedIssueComment,
  type SyncedIssueContent,
} from "./versions.js";

const OWN_MARKER = "<!-- forgepilot-sync-issue:";

export interface CreateSyncedIssueInput {
  summary: string;
  description: string;
  source_reference?: string | null;
  labels?: string[];
}

export interface UpdateSyncedIssueInput {
  title?: string;
  description?: string;
  state?: "open" | "closed";
  labels?: string[];
}

export interface SyncedIssueView {
  issue_id: string;
  workspace: { enterprise_id: string; workspace_id: string };
  repository: { repository_id: string; url: string; base_ref: string; base_sha: string };
  dedupe_key: string;
  summary: string;
  description: string;
  source_reference: string | null;
  product_state: string;
  state_reason: string | null;
  created_at: string;
  updated_at: string;
  provider: null | {
    provider_type: "github" | "gitlab";
    issue_id: string;
    issue_number: string;
    url: string;
    state: "open" | "closed";
    last_synced_at: string;
  };
  labels: string[];
  sync_state: "pending" | "processing" | "synced" | "failed";
}

export interface IssueSyncServiceOptions {
  enterprise_id: EnterpriseId;
  actor_id: string;
  workspaces: WorkspaceRepository;
  providerInstances: ProviderInstanceRepository;
  integrations: ServiceIntegrationRepository;
  bindings: WorkspaceRunBindingResolver;
  machine: CollabMachine;
  store: IssueSyncStore;
  credentials: ServiceCredentialStore;
  now?: () => Date;
}

export class IssueSyncService {
  private readonly now: () => Date;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight = false;

  constructor(private readonly options: IssueSyncServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  startPolling(intervalMs = 60_000): void {
    if (this.pollTimer) return;
    const tick = async (): Promise<void> => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        const scope = { enterprise_id: this.options.enterprise_id, actor_id: this.options.actor_id };
        for (const workspace of this.options.workspaces.list(scope, "active")) {
          const integrations = this.options.integrations.listByWorkspace({
            enterprise_id: this.options.enterprise_id,
            workspace_id: workspace.id,
            actor_id: this.options.actor_id,
          });
          if (!integrations.some((item) => item.install_status === "active" && item.issue_sync_credential_ref)) continue;
          await this.processOutbox(workspace.id);
          await this.syncWorkspace(workspace.id).catch(() => undefined);
        }
      } finally {
        this.pollInFlight = false;
      }
    };
    void tick();
    this.pollTimer = setInterval(() => void tick(), Math.max(5_000, intervalMs));
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async processOutbox(workspaceId: string): Promise<void> {
    for (const operation of this.options.store.claimPending(20, this.now().toISOString())) {
      try {
        const { integration, binding, providerOrigin } = this.context(workspaceId);
        const api = createProviderIssueApi({ repository_id: binding.repositoryId,
          issue_sync_credential_ref: requireIssueCredential(integration), credentials: this.options.credentials, provider_origin: providerOrigin });
        const history = this.options.store.loadHistory(workspaceId, operation.issue_id);
        if (!history) throw new Error("issue version history is unavailable for retry");
        if (operation.operation_type === "create") {
          const marker = `${OWN_MARKER}${operation.issue_id} -->`;
          const existing = await api.listIssues(integration.issue_sync_connected_at ?? integration.created_at);
          const remote = existing.find((item) => item.description.includes(marker)) ?? await api.createIssue({
            title: history.content.title, description: appendMarker(history.content.description, marker), labels: history.content.labels,
          });
          if (!this.options.store.getLinkByIssue(workspaceId, operation.issue_id)) {
            this.options.store.linkIssue({ enterprise_id: this.options.enterprise_id, workspace_id: workspaceId,
              issue_id: operation.issue_id, provider_instance_id: integration.provider_instance_id, provider_type: api.provider,
              repository_id: binding.repositoryId, provider_issue_id: remote.id, provider_issue_number: remote.number,
              provider_url: remote.url, provider_state: remote.state, provider_updated_at: remote.updated_at, last_synced_at: this.now().toISOString() });
          }
        } else {
          const link = this.options.store.getLinkByIssue(workspaceId, operation.issue_id);
          if (!link) throw new Error("provider issue link is unavailable for retry");
          if (operation.operation_type === "comment") {
            const commentMarker = `<!-- forgepilot-sync-comment:${digest(operation.operation_id)} -->`;
            const comments = await api.listComments(link.provider_issue_id);
            if (!comments.some((comment) => comment.body.includes(commentMarker))) {
              const body = (operation.payload["body"] as string) ?? "";
              await api.createComment(link.provider_issue_id, `${body}${body ? "\n\n" : ""}${commentMarker}`);
            }
          } else {
            const fields = operation.payload["fields"] as Partial<SyncedIssueContent> | undefined;
            if (fields) {
              const remote = await api.updateIssue(link.provider_issue_id, fields);
              this.options.store.updateLinkState(workspaceId, operation.issue_id, remote.state, remote.updated_at, this.now().toISOString());
            }
          }
        }
        this.options.store.finishOperation(operation.operation_id, { state: "synced" });
      } catch (error) {
        const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(operation.attempt_count, 7));
        this.options.store.finishOperation(operation.operation_id, {
          state: "failed", retry_after: new Date(this.now().getTime() + delay).toISOString(), error_code: safeErrorCode(error),
        });
      }
    }
  }

  list(workspaceId: string): SyncedIssueView[] {
    const scope = { enterprise_id: this.options.enterprise_id, actor_id: this.options.actor_id };
    this.options.workspaces.getById(scope, workspaceId);
    return this.options.machine
      .listIssues()
      .filter((issue) => issue.workspace.enterprise_id === this.options.enterprise_id)
      .filter((issue) => issue.workspace.workspace_id === workspaceId)
      .map((issue) => this.view(issue));
  }

  get(workspaceId: string, issueId: string): SyncedIssueView | undefined {
    return this.list(workspaceId).find((issue) => issue.issue_id === issueId);
  }

  async create(
    workspaceId: string,
    input: CreateSyncedIssueInput,
    idempotencyKey: string,
    actorId = this.options.actor_id,
  ): Promise<SyncedIssueView> {
    const { binding, integration, providerOrigin } = this.context(workspaceId, actorId);
    const summary = input.summary.trim();
    if (!summary) throw new Error("issue summary is required");
    if (!idempotencyKey.trim() || idempotencyKey.length > 256) {
      throw new Error("a 1–256 character Idempotency-Key is required");
    }
    const operationId = `issue-create-${digest(`${workspaceId}\0${idempotencyKey}`)}`;
    const dedupeKey = `manual:${digest(`${workspaceId}\0${idempotencyKey}`)}`;
    const issue = this.options.machine.createIssue({
      operation_id: operationId,
      actor: actorId,
      workspace: { enterprise_id: this.options.enterprise_id, workspace_id: workspaceId },
      repository: {
        repository_id: binding.repositoryId,
        url: binding.repositoryUrl,
        base_ref: binding.baseRef,
        base_sha: binding.baseSha,
      },
      dedupe_key: dedupeKey,
      summary,
      source_reference: input.source_reference?.trim() || null,
    });
    const content: SyncedIssueContent = {
      title: summary,
      description: input.description,
      state: "open",
      labels: normalizeLabels(input.labels ?? []),
    };
    const at = this.now().toISOString();
    const history = createIssueVersionHistory(issue.issue_id, content, "forgepilot", at, at);
    if (!this.options.store.loadHistory(workspaceId, issue.issue_id)) {
      this.options.store.saveHistory(history, workspaceId, 0);
    }
    const idempotency = `${workspaceId}:${idempotencyKey}`;
    const outbox = this.options.store.enqueue({
      enterprise_id: this.options.enterprise_id,
      workspace_id: workspaceId,
      issue_id: issue.issue_id,
      idempotency_key: idempotency,
      operation_type: "create",
      payload: { content },
    });

    try {
      const api = createProviderIssueApi({
        repository_id: binding.repositoryId,
        issue_sync_credential_ref: requireIssueCredential(integration),
        credentials: this.options.credentials,
        provider_origin: providerOrigin,
      });
      const marker = `${OWN_MARKER}${issue.issue_id} -->`;
      const issueList = await api.listIssues(integration.issue_sync_connected_at ?? integration.created_at);
      const existing = issueList.find((item) => item.description.includes(marker));
      const remote =
        existing ??
        (await api.createIssue({
          title: content.title,
          description: appendMarker(content.description, marker),
          labels: content.labels,
        }));
      if (!this.options.store.getLinkByIssue(workspaceId, issue.issue_id)) {
        this.options.store.linkIssue({
          enterprise_id: this.options.enterprise_id,
          workspace_id: workspaceId,
          issue_id: issue.issue_id,
          provider_instance_id: integration.provider_instance_id,
          provider_type: api.provider,
          repository_id: binding.repositoryId,
          provider_issue_id: remote.id,
          provider_issue_number: remote.number,
          provider_url: remote.url,
          provider_state: remote.state,
          provider_updated_at: remote.updated_at,
          last_synced_at: this.now().toISOString(),
        });
      }
      this.options.store.finishOperation(outbox.operation_id, { state: "synced" });
    } catch (error) {
      this.options.store.finishOperation(outbox.operation_id, {
        state: "failed",
        retry_after: new Date(this.now().getTime() + 30_000).toISOString(),
        error_code: safeErrorCode(error),
      });
      throw error;
    }
    return this.view(issue);
  }

  /** Import or update issues changed since this repository integration connected. */
  async syncWorkspace(workspaceId: string): Promise<number> {
    const { binding, integration, providerOrigin } = this.context(workspaceId);
    const api = createProviderIssueApi({
      repository_id: binding.repositoryId,
      issue_sync_credential_ref: requireIssueCredential(integration),
      credentials: this.options.credentials,
      provider_origin: providerOrigin,
    });
    const connectedAt = integration.issue_sync_connected_at ?? integration.created_at;
    const cursor = this.options.store.getUpdatedAfter(integration.id, connectedAt);
    const remoteIssues = await api.listIssues(cursor);
    let importedOrUpdated = 0;
    let newest = cursor;
    for (const remote of remoteIssues) {
      if (Date.parse(remote.updated_at) <= Date.parse(connectedAt)) continue;
      const existingLink = this.options.store.getLinkByProvider(
        integration.provider_instance_id,
        binding.repositoryId,
        remote.id,
      );
      if (!existingLink) {
        const markerId = readMarker(remote.description);
        if (markerId) {
          const own = this.options.store.getLinkByIssue(workspaceId, markerId);
          if (own) continue;
        }
        const operationId = `issue-import-${digest(`${integration.provider_instance_id}\0${remote.id}`)}`;
        const issue = this.options.machine.createIssue({
          operation_id: operationId,
          actor: `provider:${api.provider}`,
          workspace: { enterprise_id: this.options.enterprise_id, workspace_id: workspaceId },
          repository: {
            repository_id: binding.repositoryId,
            url: binding.repositoryUrl,
            base_ref: binding.baseRef,
            base_sha: binding.baseSha,
          },
          dedupe_key: `external:${api.provider}:${digest(`${binding.repositoryId}\0${remote.id}`)}`,
          summary: remote.title,
          source_reference: remote.url,
        });
        const importedContent: SyncedIssueContent = {
          title: remote.title,
          description: stripMarker(remote.description),
          state: remote.state,
          labels: normalizeLabels(remote.labels),
        };
        const history = createIssueVersionHistory(
          issue.issue_id,
          importedContent,
          api.provider,
          remote.updated_at,
          this.now().toISOString(),
        );
        const remoteComments = await api.listComments(remote.number);
        const withComments = applyIssueChange(history, {
          source: api.provider,
          source_modified_at: remote.updated_at,
          recorded_at: this.now().toISOString(),
          fields: {},
          comments: remoteComments.filter((comment) => !comment.body.includes("<!-- forgepilot-sync-comment:")).map((comment) => ({
            id: `${api.provider}:${comment.id}`,
            source: api.provider,
            source_comment_id: comment.id,
            author: comment.author,
            body: stripCommentMarker(comment.body),
            created_at: comment.created_at,
          })),
        });
        this.options.store.saveHistory(withComments, workspaceId, 0);
        this.options.store.linkIssue({
          enterprise_id: this.options.enterprise_id,
          workspace_id: workspaceId,
          issue_id: issue.issue_id,
          provider_instance_id: integration.provider_instance_id,
          provider_type: api.provider,
          repository_id: binding.repositoryId,
          provider_issue_id: remote.id,
          provider_issue_number: remote.number,
          provider_url: remote.url,
          provider_state: remote.state,
          provider_updated_at: remote.updated_at,
          last_synced_at: this.now().toISOString(),
        });
        importedOrUpdated += 1;
      } else {
        const history = this.options.store.loadHistory(workspaceId, existingLink.issue_id);
        if (!history) continue;
        const incomingContent: SyncedIssueContent = {
          title: remote.title,
          description: stripMarker(remote.description),
          state: remote.state,
          labels: normalizeLabels(remote.labels),
        };
        const fields: Partial<SyncedIssueContent> = {};
        if (!same(history.content.title, incomingContent.title)) fields.title = incomingContent.title;
        if (!same(history.content.description, incomingContent.description))
          fields.description = incomingContent.description;
        if (!same(history.content.state, incomingContent.state)) fields.state = incomingContent.state;
        if (!same(history.content.labels, incomingContent.labels)) fields.labels = incomingContent.labels;
        const remoteComments = await api.listComments(remote.number);
        const comments: SyncedIssueComment[] = remoteComments.filter((comment) => !comment.body.includes("<!-- forgepilot-sync-comment:")).map((comment) => ({
          id: `${api.provider}:${comment.id}`,
          source: api.provider as IssueSyncSource,
          source_comment_id: comment.id,
          author: comment.author,
            body: stripCommentMarker(comment.body),
          created_at: comment.created_at,
        }));
        const updatedHistory = applyIssueChange(history, {
          source: api.provider as IssueSyncSource,
          source_modified_at: remote.updated_at,
          recorded_at: this.now().toISOString(),
          fields,
          comments,
        });
        if (updatedHistory !== history) {
          this.options.store.saveHistory(
            updatedHistory,
            workspaceId,
            history.versions.length,
          );
          importedOrUpdated += 1;
        }
        const winningFields: Partial<SyncedIssueContent> = {};
        if (updatedHistory.content.title !== incomingContent.title) winningFields.title = updatedHistory.content.title;
        if (updatedHistory.content.description !== incomingContent.description)
          winningFields.description = updatedHistory.content.description;
        if (updatedHistory.content.state !== incomingContent.state) winningFields.state = updatedHistory.content.state;
        if (!same(updatedHistory.content.labels, incomingContent.labels)) winningFields.labels = updatedHistory.content.labels;
        if (Object.keys(winningFields).length > 0) {
          const winner = await api.updateIssue(remote.id, winningFields);
          this.options.store.updateLinkState(workspaceId, existingLink.issue_id, winner.state, winner.updated_at, this.now().toISOString());
          if (winner.updated_at > newest) newest = winner.updated_at;
          continue;
        }
        this.options.store.updateLinkState(
          workspaceId,
          existingLink.issue_id,
          remote.state,
          remote.updated_at,
          this.now().toISOString(),
        );
      }
      if (remote.updated_at > newest) newest = remote.updated_at;
    }
    this.options.store.advanceUpdatedAfter(integration.id, newest);
    return importedOrUpdated;
  }

  async update(
    workspaceId: string,
    issueId: string,
    patch: UpdateSyncedIssueInput,
    idempotencyKey: string,
    actorId = this.options.actor_id,
  ): Promise<SyncedIssueView> {
    const { integration, binding, providerOrigin } = this.context(workspaceId, actorId);
    const link = this.options.store.getLinkByIssue(workspaceId, issueId);
    const history = this.options.store.loadHistory(workspaceId, issueId);
    if (!link || !history) throw new Error("issue is not connected to a provider issue");
    const fields: Partial<SyncedIssueContent> = {
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.labels !== undefined ? { labels: normalizeLabels(patch.labels) } : {}),
    };
    if (fields.title !== undefined && !fields.title) throw new Error("issue title is required");
    const at = this.now().toISOString();
    const next = applyIssueChange(history, {
      source: "forgepilot", source_modified_at: at, recorded_at: at, fields,
    });
    if (next === history) return this.get(workspaceId, issueId)!;
    const outbox = this.options.store.enqueue({
      enterprise_id: this.options.enterprise_id, workspace_id: workspaceId, issue_id: issueId,
      idempotency_key: `${workspaceId}:${idempotencyKey}`, operation_type: "update", payload: { fields },
    });
    this.options.store.saveHistory(next, workspaceId, history.versions.length);
    try {
      const api = createProviderIssueApi({
        repository_id: binding.repositoryId,
        issue_sync_credential_ref: requireIssueCredential(integration),
        credentials: this.options.credentials, provider_origin: providerOrigin,
      });
      const remote = await api.updateIssue(link.provider_issue_id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
        ...(fields.state !== undefined ? { state: fields.state } : {}),
        ...(fields.labels !== undefined ? { labels: fields.labels } : {}),
      });
      this.options.store.updateLinkState(workspaceId, issueId, remote.state, remote.updated_at, at);
      this.options.store.finishOperation(outbox.operation_id, { state: "synced" });
    } catch (error) {
      this.options.store.finishOperation(outbox.operation_id, {
        state: "failed", retry_after: new Date(this.now().getTime() + 30_000).toISOString(), error_code: safeErrorCode(error),
      });
      throw error;
    }
    return this.get(workspaceId, issueId)!;
  }

  async addComment(workspaceId: string, issueId: string, body: string, idempotencyKey: string, actorId = this.options.actor_id): Promise<SyncedIssueView> {
    const { integration, binding, providerOrigin } = this.context(workspaceId, actorId);
    const link = this.options.store.getLinkByIssue(workspaceId, issueId);
    const history = this.options.store.loadHistory(workspaceId, issueId);
    if (!link || !history) throw new Error("issue is not connected to a provider issue");
    if (!body.trim()) throw new Error("comment body is required");
    const at = this.now().toISOString();
    const localComment: SyncedIssueComment = {
      id: `forgepilot:${idempotencyKey}`, source: "forgepilot", source_comment_id: idempotencyKey,
      author: actorId, body: body.trim(), created_at: at,
    };
    const next = applyIssueChange(history, { source: "forgepilot", source_modified_at: at, recorded_at: at, fields: {}, comments: [localComment] });
    const outbox = this.options.store.enqueue({ enterprise_id: this.options.enterprise_id, workspace_id: workspaceId,
      issue_id: issueId, idempotency_key: `${workspaceId}:${idempotencyKey}`, operation_type: "comment", payload: { body: body.trim() } });
    this.options.store.saveHistory(next, workspaceId, history.versions.length);
    try {
      const api = createProviderIssueApi({ repository_id: binding.repositoryId,
        issue_sync_credential_ref: requireIssueCredential(integration), credentials: this.options.credentials, provider_origin: providerOrigin });
      const commentMarker = `<!-- forgepilot-sync-comment:${digest(outbox.operation_id)} -->`;
      const existing = await api.listComments(link.provider_issue_id);
      if (!existing.some((item) => item.body.includes(commentMarker))) {
        await api.createComment(link.provider_issue_id, `${body.trim()}\n\n${commentMarker}`);
      }
      this.options.store.finishOperation(outbox.operation_id, { state: "synced" });
    } catch (error) {
      this.options.store.finishOperation(outbox.operation_id, { state: "failed", retry_after: new Date(this.now().getTime() + 30_000).toISOString(), error_code: safeErrorCode(error) });
      throw error;
    }
    return this.get(workspaceId, issueId)!;
  }

  async rollback(workspaceId: string, issueId: string, versionId: string, idempotencyKey: string, actorId = this.options.actor_id): Promise<SyncedIssueView> {
    const { integration, binding, providerOrigin } = this.context(workspaceId, actorId);
    const link = this.options.store.getLinkByIssue(workspaceId, issueId);
    const history = this.options.store.loadHistory(workspaceId, issueId);
    if (!link || !history) throw new Error("issue is not connected to a provider issue");
    const next = rollbackIssueContent(history, versionId, this.now().toISOString());
    if (next === history) return this.get(workspaceId, issueId)!;
    const fields = Object.fromEntries(next.versions.at(-1)!.changed_fields.map((field) => [field, next.content[field]]));
    const outbox = this.options.store.enqueue({ enterprise_id: this.options.enterprise_id, workspace_id: workspaceId,
      issue_id: issueId, idempotency_key: `${workspaceId}:${idempotencyKey}`, operation_type: "rollback", payload: { fields, rollback_of: versionId } });
    this.options.store.saveHistory(next, workspaceId, history.versions.length);
    try {
      const api = createProviderIssueApi({ repository_id: binding.repositoryId,
        issue_sync_credential_ref: requireIssueCredential(integration), credentials: this.options.credentials, provider_origin: providerOrigin });
      const remote = await api.updateIssue(link.provider_issue_id, fields);
      this.options.store.updateLinkState(workspaceId, issueId, remote.state, remote.updated_at, this.now().toISOString());
      this.options.store.finishOperation(outbox.operation_id, { state: "synced" });
    } catch (error) {
      this.options.store.finishOperation(outbox.operation_id, { state: "failed", retry_after: new Date(this.now().getTime() + 30_000).toISOString(), error_code: safeErrorCode(error) });
      throw error;
    }
    return this.get(workspaceId, issueId)!;
  }

  versions(workspaceId: string, issueId: string) {
    this.options.workspaces.getById({ enterprise_id: this.options.enterprise_id, actor_id: this.options.actor_id }, workspaceId);
    return this.options.store.loadHistory(workspaceId, issueId)?.versions ?? [];
  }

  comments(workspaceId: string, issueId: string): SyncedIssueComment[] {
    this.options.workspaces.getById({ enterprise_id: this.options.enterprise_id, actor_id: this.options.actor_id }, workspaceId);
    return this.options.store.listComments(workspaceId, issueId);
  }

  private view(issue: ReturnType<CollabMachine["listIssues"]>[number]): SyncedIssueView {
    const history = this.options.store.loadHistory(issue.workspace.workspace_id, issue.issue_id);
    const link = this.options.store.getLinkByIssue(issue.workspace.workspace_id, issue.issue_id);
    return {
      ...issue,
      summary: history?.content.title ?? issue.summary,
      description: history?.content.description ?? "",
      labels: history?.content.labels ?? [],
      provider: link
        ? {
            provider_type: link.provider_type,
            issue_id: link.provider_issue_id,
            issue_number: link.provider_issue_number,
            url: link.provider_url,
            state: link.provider_state,
            last_synced_at: link.last_synced_at,
          }
        : null,
      sync_state: this.options.store.latestOperation(issue.workspace.workspace_id, issue.issue_id)?.state ??
        (link ? "synced" : "pending"),
    };
  }

  private context(workspaceId: string, actorId = this.options.actor_id): {
    binding: ReturnType<WorkspaceRunBindingResolver["resolve"]>;
    integration: ServiceIntegration;
    providerOrigin: string;
  } {
    const scope = { enterprise_id: this.options.enterprise_id, actor_id: actorId };
    const workspace = this.options.workspaces.getById(scope, workspaceId);
    if (!workspace || workspace.status !== "active") throw new Error("workspace is unavailable");
    const binding = this.options.bindings.resolve(workspaceId);
    const integration = this.options.integrations
      .listByWorkspace({
        enterprise_id: this.options.enterprise_id,
        workspace_id: workspaceId,
        actor_id: actorId,
      })
      .find((item) => item.install_status === "active");
    if (!integration) throw new Error("provider issue sync is not connected for this workspace");
    if (integration.repository_id !== binding.repositoryId) {
      throw new Error("provider integration does not match the workspace repository");
    }
    const provider = this.options.providerInstances.getById(scope, integration.provider_instance_id);
    if (!provider) throw new Error("provider instance is unavailable");
    return { binding, integration, providerOrigin: provider.origin_url };
  }
}

function requireIssueCredential(integration: ServiceIntegration): string {
  if (!integration.issue_sync_credential_ref) {
    throw new Error("provider integration has no issue-sync credential configured");
  }
  return integration.issue_sync_credential_ref;
}

function normalizeLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function appendMarker(description: string, marker: string): string {
  return `${description}${description ? "\n\n" : ""}${marker}`;
}

function stripMarker(description: string): string {
  return description.replace(/\n*<!-- forgepilot-sync-issue:[^>]+ -->\s*$/u, "");
}

function stripCommentMarker(body: string): string {
  return body.replace(/\n*<!-- forgepilot-sync-comment:[^>]+ -->\s*$/u, "");
}

function readMarker(description: string): string | undefined {
  return /<!-- forgepilot-sync-issue:([A-Za-z0-9_-]+) -->/u.exec(description)?.[1];
}

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  return "PROVIDER_UNAVAILABLE";
}
