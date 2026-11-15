/**
 * Versioned, provider-neutral issue content and last-modified-wins merging.
 *
 * This module owns only the synchronized external fields. ForgePilot's product
 * lifecycle, runs, approvals, candidates, and delivery are deliberately absent.
 */

import { randomUUID } from "node:crypto";

export type ProviderIssueState = "open" | "closed";
export type IssueSyncSource = "forgepilot" | "github" | "gitlab";
export type IssueSyncField = "title" | "description" | "state" | "labels";

export interface SyncedIssueContent {
  title: string;
  description: string;
  state: ProviderIssueState;
  labels: string[];
}

export interface SyncedIssueComment {
  id: string;
  source: IssueSyncSource;
  source_comment_id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface IssueContentVersion {
  version_id: string;
  sequence: number;
  source: IssueSyncSource;
  source_modified_at: string;
  recorded_at: string;
  changed_fields: IssueSyncField[];
  content: SyncedIssueContent;
  rollback_of: string | null;
}

export interface IssueVersionHistory {
  issue_id: string;
  content: SyncedIssueContent;
  field_modified_at: Record<IssueSyncField, string>;
  versions: IssueContentVersion[];
  comments: SyncedIssueComment[];
}

export interface IncomingIssueChange {
  source: IssueSyncSource;
  source_modified_at: string;
  recorded_at: string;
  /** Only fields observed to have changed since the last provider snapshot. */
  fields: Partial<SyncedIssueContent>;
  comments?: SyncedIssueComment[];
}

const FIELDS: readonly IssueSyncField[] = ["title", "description", "state", "labels"];

export function createIssueVersionHistory(
  issueId: string,
  content: SyncedIssueContent,
  source: IssueSyncSource,
  sourceModifiedAt: string,
  recordedAt: string,
): IssueVersionHistory {
  const initial: IssueContentVersion = {
    version_id: randomUUID(),
    sequence: 1,
    source,
    source_modified_at: normalizeInstant(sourceModifiedAt),
    recorded_at: normalizeInstant(recordedAt),
    changed_fields: [...FIELDS],
    content: cloneContent(content),
    rollback_of: null,
  };
  return {
    issue_id: issueId,
    content: cloneContent(content),
    field_modified_at: Object.fromEntries(
      FIELDS.map((field) => [field, initial.source_modified_at]),
    ) as Record<IssueSyncField, string>,
    versions: [initial],
    comments: [],
  };
}

/** Apply one local/provider change; independent fields merge, same-field edits use LWW. */
export function applyIssueChange(
  history: IssueVersionHistory,
  incoming: IncomingIssueChange,
): IssueVersionHistory {
  const sourceAt = normalizeInstant(incoming.source_modified_at);
  const recordedAt = normalizeInstant(incoming.recorded_at);
  const content = cloneContent(history.content);
  const fieldModifiedAt = { ...history.field_modified_at };
  const changedFields: IssueSyncField[] = [];

  for (const field of FIELDS) {
    if (!Object.hasOwn(incoming.fields, field)) continue;
    const nextValue = incoming.fields[field];
    if (nextValue === undefined) continue;
    const currentAt = fieldModifiedAt[field];
    // Equal timestamps retain the accepted value. This stable tie-breaker
    // prevents webhook retries from oscillating two equally-timestamped edits.
    if (sourceAt < currentAt) continue;
    if (sameField(content[field], nextValue)) continue;
    (content[field] as unknown) = Array.isArray(nextValue) ? [...nextValue] : nextValue;
    fieldModifiedAt[field] = sourceAt;
    changedFields.push(field);
  }

  const knownComments = new Set(history.comments.map((comment) => `${comment.source}\0${comment.source_comment_id}`));
  const comments = [...history.comments];
  for (const comment of incoming.comments ?? []) {
    const key = `${comment.source}\0${comment.source_comment_id}`;
    if (knownComments.has(key)) continue;
    knownComments.add(key);
    comments.push({ ...comment, created_at: normalizeInstant(comment.created_at) });
  }
  comments.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

  if (changedFields.length === 0 && comments.length === history.comments.length) return history;

  const version: IssueContentVersion = {
    version_id: randomUUID(),
    sequence: history.versions.length + 1,
    source: incoming.source,
    source_modified_at: sourceAt,
    recorded_at: recordedAt,
    changed_fields: changedFields,
    content: cloneContent(content),
    rollback_of: null,
  };
  return {
    ...history,
    content,
    field_modified_at: fieldModifiedAt,
    versions: [...history.versions, version],
    comments,
  };
}

/** Restore synchronized fields from an immutable version as a new local version. */
export function rollbackIssueContent(
  history: IssueVersionHistory,
  targetVersionId: string,
  modifiedAt: string,
): IssueVersionHistory {
  const target = history.versions.find((version) => version.version_id === targetVersionId);
  if (!target) throw new Error(`unknown issue content version ${targetVersionId}`);
  const at = normalizeInstant(modifiedAt);
  const changedFields = FIELDS.filter((field) => !sameField(history.content[field], target.content[field]));
  if (changedFields.length === 0) return history;
  const content = cloneContent(target.content);
  const version: IssueContentVersion = {
    version_id: randomUUID(),
    sequence: history.versions.length + 1,
    source: "forgepilot",
    source_modified_at: at,
    recorded_at: at,
    changed_fields: changedFields,
    content: cloneContent(content),
    rollback_of: target.version_id,
  };
  return {
    ...history,
    content,
    field_modified_at: Object.fromEntries(
      FIELDS.map((field) => [field, changedFields.includes(field) ? at : history.field_modified_at[field]]),
    ) as Record<IssueSyncField, string>,
    versions: [...history.versions, version],
  };
}

function sameField(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function cloneContent(content: SyncedIssueContent): SyncedIssueContent {
  return { ...content, labels: [...content.labels] };
}

function normalizeInstant(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`invalid issue sync timestamp ${value}`);
  return new Date(millis).toISOString();
}
