/**
 * Scoped persistence for retrieval policies, bundle audit rows, feedback, and
 * evaluation records (DAT-236).
 *
 * Every method takes a {@link WorkspaceScope} derived from authenticated
 * membership and embeds `enterprise_id` + `workspace_id` in its SQL, exactly
 * like the memory repositories: a foreign workspace's policy version, bundle,
 * or feedback is indistinguishable from a missing one.
 *
 * Nothing here can mutate a memory item. Policies are immutable per version,
 * and the run/feedback/eval rows are append-only.
 */

import type { ControlPlaneDb } from "../../control-plane/db.js";
import { newId, nowIso } from "../../control-plane/db.js";
import { NotFoundError, ScopeError, ValidationError } from "../../control-plane/errors.js";
import type { WorkspaceScope } from "../../control-plane/types.js";
import { RETRIEVAL_HARD_LIMITS } from "./types.js";
import type { MemorySensitivity } from "../types.js";
import type {
  MemoryEvalRunInput,
  MemoryEvalRunRecord,
  MemoryEvalMetrics,
  MemoryFeedbackInput,
  MemoryFeedbackItem,
  MemoryFeedbackOutcome,
  MemoryFeedbackRecord,
  MemoryVersionSummary,
  RetrievalPolicy,
  RetrievalPolicyRecord,
} from "./types.js";
import { MEMORY_EVAL_KINDS, MEMORY_EVAL_VERDICTS, MEMORY_FEEDBACK_OUTCOMES } from "./types.js";
import {
  DEFAULT_RETRIEVAL_POLICY,
  parseRetrievalPolicy,
  retrievalPolicyHash,
  validateRetrievalPolicy,
} from "./policy.js";

const MAX_NOTE_CHARS = 2_000;
const MAX_QUERY_CHARS = RETRIEVAL_HARD_LIMITS.query_chars;

interface PolicyRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  version: number;
  policy: string;
  policy_hash: string;
  created_at: string;
  created_by: string;
}

interface RunRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  bundle_id: string;
  run_id: string | null;
  purpose: string;
  query: string;
  policy_version: number;
  memory_version: string;
  degraded: number;
  degraded_reason: string | null;
  injected: string;
  omitted_count: number;
  created_at: string;
  created_by: string;
}

export interface RecordRetrievalRunInput {
  bundle_id: string;
  run_id?: string | null;
  purpose: string;
  query: string;
  policy_version: number;
  memory_version: string;
  degraded: boolean;
  degraded_reason: string | null;
  injected: Array<{
    item_id: string;
    item_version: number;
    kind: string;
    tier: string;
    approved: boolean;
  }>;
  omitted_count: number;
  created_at: string;
}

export interface MemoryRetrievalRunRecord {
  bundle_id: string;
  run_id: string | null;
  purpose: string;
  policy_version: number;
  memory_version: string;
  degraded: boolean;
  degraded_reason: string | null;
  injected: RecordRetrievalRunInput["injected"];
  omitted_count: number;
  created_at: string;
  created_by: string;
}

export interface CorpusEntry {
  item_id: string;
  version: number;
  content_hash: string;
}

export interface CorpusSummary {
  items: number;
  active_items: number;
  versions: number;
  last_updated_at: string | null;
}

export interface RetrievalStore {
  /** The workspace's policy at `version`, or the latest when unset. */
  getPolicy(scope: WorkspaceScope, version?: number): RetrievalPolicyRecord | undefined;
  /** All policy versions, newest first. */
  listPolicies(scope: WorkspaceScope, limit?: number): RetrievalPolicyRecord[];
  /** The current policy, creating the default version 1 on first use. */
  ensurePolicy(scope: WorkspaceScope): RetrievalPolicyRecord;
  /** Append a new immutable policy version; versions only ever increase. */
  createPolicyVersion(scope: WorkspaceScope, policy: RetrievalPolicy): RetrievalPolicyRecord;
  recordRun(scope: WorkspaceScope, input: RecordRetrievalRunInput): MemoryRetrievalRunRecord;
  getRun(scope: WorkspaceScope, bundleId: string): MemoryRetrievalRunRecord | undefined;
  recordFeedback(scope: WorkspaceScope, input: MemoryFeedbackInput): MemoryFeedbackRecord;
  recordEvalRun(scope: WorkspaceScope, input: MemoryEvalRunInput): MemoryEvalRunRecord;
  /** Current version + content hash of every stored item (bounded). */
  corpusEntries(scope: WorkspaceScope, limit?: number): CorpusEntry[];
  /**
   * Corpus counts. `allowedSensitivities` restricts counts to what the caller
   * may read so the governance surface cannot enumerate hidden items.
   */
  corpusSummary(
    scope: WorkspaceScope,
    allowedSensitivities?: readonly MemorySensitivity[],
  ): CorpusSummary;
  /**
   * Bounded per-item version index. `allowedSensitivities` is applied to the
   * item selection (via its current version) and to every historical version
   * row: a version's sensitivity can differ from the current one.
   */
  itemVersionIndex(
    scope: WorkspaceScope,
    allowedSensitivities?: readonly MemorySensitivity[],
    limit?: number,
  ): MemoryVersionSummary[];
}

function requireScope(scope: WorkspaceScope): WorkspaceScope {
  const missing: string[] = [];
  if (typeof scope.enterprise_id !== "string" || scope.enterprise_id.length === 0) {
    missing.push("enterprise_id");
  }
  if (typeof scope.workspace_id !== "string" || scope.workspace_id.length === 0) {
    missing.push("workspace_id");
  }
  if (typeof scope.actor_id !== "string" || scope.actor_id.length === 0) {
    missing.push("actor_id");
  }
  if (missing.length > 0) {
    throw new ScopeError(`retrieval scope must carry ${missing.join(", ")}`);
  }
  return scope;
}

function boundedLimit(limit: number | undefined, fallback: number, cap: number): number {
  const resolved = limit ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new ValidationError("limit must be a positive integer");
  }
  return Math.min(resolved, cap);
}

function toPolicy(row: PolicyRow): RetrievalPolicyRecord {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    version: row.version,
    policy: parseRetrievalPolicy(row.policy),
    policy_hash: row.policy_hash,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

function toRun(row: RunRow): MemoryRetrievalRunRecord {
  let injected: RecordRetrievalRunInput["injected"] = [];
  try {
    const parsed: unknown = JSON.parse(row.injected);
    if (Array.isArray(parsed)) {
      injected = parsed as RecordRetrievalRunInput["injected"];
    }
  } catch {
    injected = [];
  }
  return {
    bundle_id: row.bundle_id,
    run_id: row.run_id,
    purpose: row.purpose,
    policy_version: row.policy_version,
    memory_version: row.memory_version,
    degraded: row.degraded !== 0,
    degraded_reason: row.degraded_reason,
    injected,
    omitted_count: row.omitted_count,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

function assertNote(value: string | undefined, label: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE_CHARS) {
    throw new ValidationError(`${label} must be at most ${MAX_NOTE_CHARS} characters`);
  }
  return trimmed.length > 0 ? trimmed : null;
}

function validateMetrics(metrics: MemoryEvalMetrics): MemoryEvalMetrics {
  const numeric = ["success_rate_delta", "rework_rate_delta", "cost_delta", "safety_events"];
  const output: MemoryEvalMetrics = { sample_size: metrics.sample_size };
  for (const field of numeric) {
    const value = (metrics as unknown as Record<string, unknown>)[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      // A non-finite metric is not "unknown", it is unusable: reject it rather
      // than record NaN/Infinity as an evaluation result.
      throw new ValidationError(`metrics.${field} must be a finite number`);
    }
    (output as unknown as Record<string, number>)[field] = value;
  }
  return output;
}

class SqliteRetrievalStore implements RetrievalStore {
  constructor(private readonly db: ControlPlaneDb) {}

  getPolicy(scope: WorkspaceScope, version?: number): RetrievalPolicyRecord | undefined {
    requireScope(scope);
    const row =
      version === undefined
        ? (this.db
            .prepare(
              `SELECT * FROM memory_retrieval_policies
                WHERE enterprise_id = ? AND workspace_id = ?
                ORDER BY version DESC LIMIT 1`,
            )
            .get(scope.enterprise_id, scope.workspace_id) as PolicyRow | undefined)
        : (this.db
            .prepare(
              `SELECT * FROM memory_retrieval_policies
                WHERE enterprise_id = ? AND workspace_id = ? AND version = ?`,
            )
            .get(scope.enterprise_id, scope.workspace_id, version) as PolicyRow | undefined);
    return row ? toPolicy(row) : undefined;
  }

  listPolicies(scope: WorkspaceScope, limit?: number): RetrievalPolicyRecord[] {
    requireScope(scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_retrieval_policies
          WHERE enterprise_id = ? AND workspace_id = ?
          ORDER BY version DESC LIMIT ?`,
      )
      .all(
        scope.enterprise_id,
        scope.workspace_id,
        boundedLimit(limit, 50, 200),
      ) as unknown as PolicyRow[];
    return rows.map(toPolicy);
  }

  ensurePolicy(scope: WorkspaceScope): RetrievalPolicyRecord {
    requireScope(scope);
    const existing = this.getPolicy(scope);
    if (existing !== undefined) {
      return existing;
    }
    const now = nowIso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_retrieval_policies
           (id, enterprise_id, workspace_id, version, policy, policy_hash, created_at, created_by)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        newId("mrp"),
        scope.enterprise_id,
        scope.workspace_id,
        JSON.stringify(DEFAULT_RETRIEVAL_POLICY),
        retrievalPolicyHash(DEFAULT_RETRIEVAL_POLICY),
        now,
        scope.actor_id,
      );
    const created = this.getPolicy(scope);
    if (created === undefined) {
      throw new ValidationError("retrieval policy could not be initialized");
    }
    return created;
  }

  createPolicyVersion(scope: WorkspaceScope, policy: RetrievalPolicy): RetrievalPolicyRecord {
    requireScope(scope);
    const validated = validateRetrievalPolicy(policy);
    // The workspace always has a version 1 before a change: a policy history
    // starts at the default, never at an arbitrary first change.
    this.ensurePolicy(scope);
    const current = this.getPolicy(scope);
    const nextVersion = (current?.version ?? 0) + 1;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO memory_retrieval_policies
           (id, enterprise_id, workspace_id, version, policy, policy_hash, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("mrp"),
        scope.enterprise_id,
        scope.workspace_id,
        nextVersion,
        JSON.stringify(validated),
        retrievalPolicyHash(validated),
        now,
        scope.actor_id,
      );
    const created = this.getPolicy(scope, nextVersion);
    if (created === undefined) {
      throw new ValidationError("retrieval policy version was not persisted");
    }
    return created;
  }

  recordRun(scope: WorkspaceScope, input: RecordRetrievalRunInput): MemoryRetrievalRunRecord {
    requireScope(scope);
    if (typeof input.bundle_id !== "string" || input.bundle_id.length === 0) {
      throw new ValidationError("bundle_id is required");
    }
    if (input.query.length > MAX_QUERY_CHARS) {
      throw new ValidationError(`query must be at most ${MAX_QUERY_CHARS} characters`);
    }
    const degradedReason = input.degraded ? (input.degraded_reason ?? "retrieval_error") : null;
    this.db
      .prepare(
        `INSERT INTO memory_retrieval_runs
           (id, enterprise_id, workspace_id, bundle_id, run_id, purpose, query, policy_version,
            memory_version, degraded, degraded_reason, injected, omitted_count, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("mrr"),
        scope.enterprise_id,
        scope.workspace_id,
        input.bundle_id,
        input.run_id ?? null,
        input.purpose,
        input.query,
        input.policy_version,
        input.memory_version,
        input.degraded ? 1 : 0,
        degradedReason,
        JSON.stringify(input.injected),
        input.omitted_count,
        input.created_at,
        scope.actor_id,
      );
    const row = this.db
      .prepare(
        `SELECT * FROM memory_retrieval_runs
          WHERE enterprise_id = ? AND workspace_id = ? AND bundle_id = ?`,
      )
      .get(scope.enterprise_id, scope.workspace_id, input.bundle_id) as RunRow | undefined;
    if (row === undefined) {
      throw new ValidationError("retrieval run was not persisted");
    }
    return toRun(row);
  }

  getRun(scope: WorkspaceScope, bundleId: string): MemoryRetrievalRunRecord | undefined {
    requireScope(scope);
    const row = this.db
      .prepare(
        `SELECT * FROM memory_retrieval_runs
          WHERE enterprise_id = ? AND workspace_id = ? AND bundle_id = ?`,
      )
      .get(scope.enterprise_id, scope.workspace_id, bundleId) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  recordFeedback(scope: WorkspaceScope, input: MemoryFeedbackInput): MemoryFeedbackRecord {
    requireScope(scope);
    if (!MEMORY_FEEDBACK_OUTCOMES.includes(input.outcome)) {
      throw new ValidationError(`unsupported feedback outcome: ${String(input.outcome)}`);
    }
    if (typeof input.run_id !== "string" || input.run_id.length === 0) {
      throw new ValidationError("run_id is required");
    }
    const run = this.getRun(scope, input.bundle_id);
    if (run === undefined) {
      throw new NotFoundError("MemoryBundle", input.bundle_id);
    }
    const injected = new Set(run.injected.map((entry) => `${entry.item_id}#${entry.item_version}`));
    const items: MemoryFeedbackItem[] = [];
    for (const item of input.items ?? []) {
      if (typeof item.item_id !== "string" || !Number.isInteger(item.item_version)) {
        throw new ValidationError("feedback items require item_id and integer item_version");
      }
      if (!injected.has(`${item.item_id}#${item.item_version}`)) {
        // Feedback is only meaningful for items the bundle actually injected;
        // accepting anything else would let a client attribute an outcome to
        // memory it never read.
        throw new ValidationError(`item ${item.item_id}#${item.item_version} was not injected`);
      }
      if (item.useful !== undefined && item.useful !== null && typeof item.useful !== "boolean") {
        throw new ValidationError("feedback items' useful flag must be a boolean or null");
      }
      if (item.contradicted !== undefined && typeof item.contradicted !== "boolean") {
        throw new ValidationError("feedback items' contradicted flag must be a boolean");
      }
      items.push({
        item_id: item.item_id,
        item_version: item.item_version,
        useful: item.useful ?? null,
        contradicted: item.contradicted ?? false,
      });
    }
    if (items.length > 50) {
      throw new ValidationError("at most 50 items may be reported per feedback record");
    }
    const note = assertNote(input.note, "note");
    const id = newId("mfb");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO memory_feedback
           (id, enterprise_id, workspace_id, bundle_id, run_id, outcome, details, note,
            created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        input.bundle_id,
        input.run_id,
        input.outcome,
        JSON.stringify({ items }),
        note,
        now,
        scope.actor_id,
      );
    return {
      feedback_id: id,
      bundle_id: input.bundle_id,
      run_id: input.run_id,
      outcome: input.outcome as MemoryFeedbackOutcome,
      items,
      created_at: now,
      created_by: scope.actor_id,
    };
  }

  recordEvalRun(scope: WorkspaceScope, input: MemoryEvalRunInput): MemoryEvalRunRecord {
    requireScope(scope);
    if (!MEMORY_EVAL_KINDS.includes(input.kind)) {
      throw new ValidationError(`unsupported eval kind: ${String(input.kind)}`);
    }
    if (!MEMORY_EVAL_VERDICTS.includes(input.verdict)) {
      throw new ValidationError(`unsupported eval verdict: ${String(input.verdict)}`);
    }
    const datasetName = input.dataset?.name;
    if (typeof datasetName !== "string" || datasetName.trim().length === 0) {
      throw new ValidationError("dataset.name is required");
    }
    if (datasetName.length > 200) {
      throw new ValidationError("dataset.name must be at most 200 characters");
    }
    if (typeof input.dataset.holdout !== "boolean") {
      throw new ValidationError("dataset.holdout must be a boolean");
    }
    if (
      !Number.isInteger(input.dataset.sample_size) ||
      input.dataset.sample_size <= 0 ||
      input.dataset.sample_size > 100_000
    ) {
      throw new ValidationError("dataset.sample_size must be a positive integer");
    }
    if (input.metrics === null || typeof input.metrics !== "object") {
      throw new ValidationError("metrics is required");
    }
    if (
      !Number.isInteger(input.metrics.sample_size) ||
      input.metrics.sample_size <= 0 ||
      input.metrics.sample_size > 100_000
    ) {
      throw new ValidationError("metrics.sample_size must be a positive integer");
    }
    if (!Number.isInteger(input.policy_version) || input.policy_version <= 0) {
      throw new ValidationError("policy_version must be a positive integer");
    }
    if (typeof input.memory_version !== "string" || input.memory_version.length === 0) {
      throw new ValidationError("memory_version is required");
    }
    if (this.getPolicy(scope, input.policy_version) === undefined) {
      throw new ValidationError(`retrieval policy version ${input.policy_version} does not exist`);
    }
    const metrics = validateMetrics(input.metrics);
    const note = assertNote(input.notes, "notes");
    const id = newId("mer");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO memory_eval_runs
           (id, enterprise_id, workspace_id, kind, dataset_name, sample_size, holdout,
            policy_version, memory_version, metrics, verdict, notes, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        input.kind,
        datasetName.trim(),
        input.dataset.sample_size,
        input.dataset.holdout ? 1 : 0,
        input.policy_version,
        input.memory_version,
        JSON.stringify(metrics),
        input.verdict,
        note,
        now,
        scope.actor_id,
      );
    return {
      eval_run_id: id,
      kind: input.kind,
      dataset: {
        name: datasetName.trim(),
        sample_size: input.dataset.sample_size,
        holdout: input.dataset.holdout,
      },
      policy_version: input.policy_version,
      memory_version: input.memory_version,
      metrics,
      verdict: input.verdict,
      ...(note !== null ? { notes: note } : {}),
      created_at: now,
      created_by: scope.actor_id,
    };
  }

  corpusEntries(scope: WorkspaceScope, limit?: number): CorpusEntry[] {
    requireScope(scope);
    // Current versions only: the digest names the exact memory a run read, not
    // every historical revision the workspace ever stored.
    const rows = this.db
      .prepare(
        `SELECT i.id AS item_id, v.version AS version, v.content_hash AS content_hash
           FROM memory_items i
           JOIN memory_item_versions v
             ON v.item_id = i.id AND v.version = i.current_version
          WHERE i.enterprise_id = ? AND i.workspace_id = ?
          ORDER BY i.id
          LIMIT ?`,
      )
      .all(
        scope.enterprise_id,
        scope.workspace_id,
        boundedLimit(limit, 5_000, 10_000),
      ) as unknown as CorpusEntry[];
    return rows.map((row) => ({
      item_id: row.item_id,
      version: row.version,
      content_hash: row.content_hash,
    }));
  }

  corpusSummary(
    scope: WorkspaceScope,
    allowedSensitivities?: readonly MemorySensitivity[],
  ): CorpusSummary {
    requireScope(scope);
    const filtered = allowedSensitivities !== undefined && allowedSensitivities.length > 0;
    // Counts join the current version so the sensitivity filter cannot be
    // bypassed by an aggregate query.
    const sensitivityFilter = filtered
      ? ` AND v.sensitivity IN (${allowedSensitivities.map(() => "?").join(", ")})`
      : "";
    const sensitivityParams: string[] = filtered ? [...allowedSensitivities] : [];
    const itemRow = this.db
      .prepare(
        `SELECT COUNT(*) AS items,
                SUM(CASE WHEN i.status = 'active' THEN 1 ELSE 0 END) AS active_items,
                MAX(i.updated_at) AS last_updated_at
           FROM memory_items i
           JOIN memory_item_versions v ON v.item_id = i.id AND v.version = i.current_version
          WHERE i.enterprise_id = ? AND i.workspace_id = ?${sensitivityFilter}`,
      )
      .get(scope.enterprise_id, scope.workspace_id, ...sensitivityParams) as
      { items: number; active_items: number | null; last_updated_at: string | null } | undefined;
    const versionRow = this.db
      .prepare(
        `SELECT COUNT(*) AS versions
           FROM memory_item_versions v
          WHERE v.enterprise_id = ? AND v.workspace_id = ?${sensitivityFilter}`,
      )
      .get(scope.enterprise_id, scope.workspace_id, ...sensitivityParams) as
      { versions: number } | undefined;
    return {
      items: Number(itemRow?.items ?? 0),
      active_items: Number(itemRow?.active_items ?? 0),
      versions: Number(versionRow?.versions ?? 0),
      last_updated_at: itemRow?.last_updated_at ?? null,
    };
  }

  itemVersionIndex(
    scope: WorkspaceScope,
    allowedSensitivities?: readonly MemorySensitivity[],
    limit?: number,
  ): MemoryVersionSummary[] {
    requireScope(scope);
    const bounded = boundedLimit(limit, 100, 500);
    const filtered = allowedSensitivities !== undefined && allowedSensitivities.length > 0;
    const sensitivityFilter = filtered
      ? ` AND v.sensitivity IN (${allowedSensitivities.map(() => "?").join(", ")})`
      : "";
    const sensitivityParams: string[] = filtered ? [...allowedSensitivities] : [];
    const items = this.db
      .prepare(
        `SELECT i.id AS item_id, i.current_version AS current_version
           FROM memory_items i
           JOIN memory_item_versions v ON v.item_id = i.id AND v.version = i.current_version
          WHERE i.enterprise_id = ? AND i.workspace_id = ?${sensitivityFilter}
          ORDER BY i.updated_at DESC, i.id
          LIMIT ?`,
      )
      .all(
        scope.enterprise_id,
        scope.workspace_id,
        ...sensitivityParams,
        bounded,
      ) as unknown as Array<{
      item_id: string;
      current_version: number;
    }>;
    // Historical versions carry their own sensitivity: a restricted v1 must not
    // become visible just because v2 is internal.
    const versionStatement = this.db.prepare(
      `SELECT version, content_hash, created_at FROM memory_item_versions v
        WHERE v.enterprise_id = ? AND v.workspace_id = ? AND v.item_id = ?${sensitivityFilter}
        ORDER BY v.version`,
    );
    return items.map((item) => ({
      item_id: item.item_id,
      current_version: item.current_version,
      versions: (
        versionStatement.all(
          scope.enterprise_id,
          scope.workspace_id,
          item.item_id,
          ...sensitivityParams,
        ) as unknown as Array<{ version: number; content_hash: string; created_at: string }>
      ).map((row) => ({
        version: row.version,
        content_hash: row.content_hash,
        created_at: row.created_at,
      })),
    }));
  }
}

export function createRetrievalStore(db: ControlPlaneDb): RetrievalStore {
  return new SqliteRetrievalStore(db);
}
