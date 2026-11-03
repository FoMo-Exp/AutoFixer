import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ConnectorCursor } from "./connector.js";
import { IntakeError } from "./errors.js";
import type {
  BudgetDenial,
  DeferredSignal,
  EventRecord,
  EvidenceRecord,
  GapRecord,
  SignalRecord,
  SourceState,
  SuppressionRecord,
  TriageRecord,
  WorkspaceScope,
} from "./types.js";
import { emptySourceCounts } from "./types.js";

/**
 * Durable intake state (DAT-216).
 *
 * Everything the pipeline must remember across restarts lives here and is
 * persisted with the same atomic tmp-and-rename write the other stores use:
 * the event dedup registry, the fingerprint-level signal index, evidence,
 * triage records, the suppression audit, declared gaps, budget bookkeeping,
 * and the deferred backlog. The source checkpoint is written in the same
 * atomic write as the events it covers — a cursor never advances past
 * unrecorded events ("persist before ack").
 */

export interface BudgetConfig {
  source_max_new_issues: number;
  workspace_max_new_issues: number;
  window_seconds: number;
  source_cooldown_seconds: number;
  workspace_cooldown_seconds: number;
  /** Bounded parked backlog; polling applies backpressure before it fills. */
  max_deferred: number;
  backpressure_high_water: number;
}

export interface BudgetStatusView {
  source_id: string;
  window_seconds: number;
  source_used: number;
  source_limit: number;
  workspace_used: number;
  workspace_limit: number;
  source_cooldown_seconds: number;
  workspace_cooldown_seconds: number;
  last_source_creation: string | null;
  last_workspace_creation: string | null;
  deferred_count: number;
}

export interface IntakeStoreOptions {
  /** A private durable state file. Omit for a process-local store in tests. */
  persistencePath?: string;
  /** Clock seam for stamped records. */
  now?: () => Date;
}

interface BudgetBook {
  source_creations: Map<string, string[]>;
  /** Workspace key -> creation stamps; budgets never leak across workspaces. */
  workspace_creations: Map<string, string[]>;
  last_source_creation: Map<string, string>;
  last_workspace_creation: Map<string, string>;
}

interface PersistedState {
  schema_version: number;
  sources: SourceState[];
  events: EventRecord[];
  signals: SignalRecord[];
  triage: TriageRecord[];
  suppressions: SuppressionRecord[];
  gaps: GapRecord[];
  deferred: DeferredSignal[];
  budget: {
    source_creations: [string, string[]][];
    workspace_creations: [string, string[]][];
    last_source_creation: [string, string][];
    last_workspace_creation: [string, string][];
  };
}

const SCHEMA_VERSION = 1;

function workspaceKey(workspace: WorkspaceScope): string {
  return JSON.stringify([workspace.enterprise_id, workspace.workspace_id]);
}

function eventIdentity(
  workspace: WorkspaceScope,
  sourceId: string,
  providerEventId: string,
): string {
  return JSON.stringify([
    workspace.enterprise_id,
    workspace.workspace_id,
    sourceId,
    providerEventId,
  ]);
}

export class IntakeStore {
  private readonly sources = new Map<string, SourceState>();
  private readonly events = new Map<string, EventRecord>();
  private readonly signals = new Map<string, SignalRecord>();
  private readonly triage = new Map<string, TriageRecord>();
  private readonly suppressions: SuppressionRecord[] = [];
  private readonly gapRecords: GapRecord[] = [];
  private readonly deferredQueue: DeferredSignal[] = [];
  private readonly budget: BudgetBook = {
    source_creations: new Map(),
    workspace_creations: new Map(),
    last_source_creation: new Map(),
    last_workspace_creation: new Map(),
  };
  private readonly persistencePath: string | undefined;
  private readonly clock: () => Date;

  constructor(options: IntakeStoreOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.clock = options.now ?? (() => new Date());
    if (this.persistencePath !== undefined && fs.existsSync(this.persistencePath)) {
      this.load();
    }
  }

  // ----------------------------------------------------------------- sources

  /**
   * Bind one source to its workspace scope. Rebinding the same source to a
   * different workspace is a configuration error, never a silent overwrite.
   */
  bindSource(sourceId: string, workspace: WorkspaceScope): SourceState {
    const existing = this.sources.get(sourceId);
    if (existing) {
      if (
        existing.workspace !== null &&
        (existing.workspace.enterprise_id !== workspace.enterprise_id ||
          existing.workspace.workspace_id !== workspace.workspace_id)
      ) {
        throw new IntakeError("SOURCE_WORKSPACE_CONFLICT", `source ${sourceId} is already bound`, {
          source_id: sourceId,
        });
      }
      existing.workspace = workspace;
      return existing;
    }
    const state: SourceState = {
      source_id: sourceId,
      workspace,
      checkpoint: null,
      connection: "never_polled",
      last_error: null,
      last_event_time: null,
      last_poll_at: null,
      counts: emptySourceCounts(),
    };
    this.sources.set(sourceId, state);
    return state;
  }

  source(sourceId: string): SourceState | undefined {
    return this.sources.get(sourceId);
  }

  /** Get-or-create a source state with no workspace binding yet. */
  private ensureSource(sourceId: string): SourceState {
    const existing = this.sources.get(sourceId);
    if (existing) {
      return existing;
    }
    const state: SourceState = {
      source_id: sourceId,
      workspace: null,
      checkpoint: null,
      connection: "never_polled",
      last_error: null,
      last_event_time: null,
      last_poll_at: null,
      counts: emptySourceCounts(),
    };
    this.sources.set(sourceId, state);
    return state;
  }

  checkpoint(sourceId: string): ConnectorCursor | null {
    return this.sources.get(sourceId)?.checkpoint ?? null;
  }

  setCheckpoint(sourceId: string, cursor: ConnectorCursor | null, at: string): void {
    const state = this.ensureSource(sourceId);
    state.checkpoint = cursor;
    state.last_poll_at = at;
  }

  setConnection(
    sourceId: string,
    connection: SourceState["connection"],
    error: string | null,
  ): void {
    const state = this.ensureSource(sourceId);
    state.connection = connection;
    state.last_error = error;
  }

  setLastEventTime(sourceId: string, eventTime: string): void {
    const state = this.ensureSource(sourceId);
    state.last_event_time = eventTime;
  }

  // ------------------------------------------------------------------ events

  findEvent(
    workspace: WorkspaceScope,
    sourceId: string,
    providerEventId: string,
  ): EventRecord | undefined {
    return this.events.get(eventIdentity(workspace, sourceId, providerEventId));
  }

  recordEvent(record: EventRecord): void {
    this.events.set(eventIdentity(record, record.source_id, record.provider_event_id), record);
  }

  // ----------------------------------------------------------------- signals

  getSignal(signalKey: string): SignalRecord | undefined {
    return this.signals.get(signalKey);
  }

  putSignal(record: SignalRecord): void {
    this.signals.set(record.signal_key, record);
  }

  appendEvidence(signalKey: string, evidence: EvidenceRecord): void {
    const signal = this.signals.get(signalKey);
    if (!signal) {
      throw new IntakeError("SIGNAL_NOT_FOUND", `unknown signal ${signalKey}`, {
        signal_key: signalKey,
      });
    }
    signal.evidence.push(evidence);
    signal.occurrences += 1;
    signal.last_seen_at = this.clock().toISOString();
  }

  // ------------------------------------------------------------------- triage

  addTriage(record: TriageRecord): void {
    this.triage.set(record.triage_id, record);
  }

  getTriage(triageId: string): TriageRecord | undefined {
    return this.triage.get(triageId);
  }

  resolveTriage(
    triageId: string,
    resolved: { repository: TriageRecord["resolved_repository"]; issue_id: string; at: string },
  ): TriageRecord {
    const record = this.triage.get(triageId);
    if (!record) {
      throw new IntakeError("TRIAGE_NOT_FOUND", `unknown triage record ${triageId}`, {
        triage_id: triageId,
      });
    }
    record.resolved_at = resolved.at;
    record.resolved_repository = resolved.repository;
    record.resolved_issue_id = resolved.issue_id;
    return record;
  }

  // ------------------------------------------------------------- suppressions

  addSuppression(record: SuppressionRecord): void {
    this.suppressions.push(record);
  }

  suppressionLog(): SuppressionRecord[] {
    return structuredClone(this.suppressions);
  }

  // --------------------------------------------------------------------- gaps

  /** Record a declared retention gap once; replays of the same gap return null. */
  recordGap(sourceId: string, gap: { from: string; to: string; reason: string }): GapRecord | null {
    const duplicate = this.gapRecords.find(
      (entry) => entry.source_id === sourceId && entry.from === gap.from && entry.to === gap.to,
    );
    if (duplicate) {
      return null;
    }
    const record: GapRecord = {
      gap_id: `gap_${randomUUID().replaceAll("-", "")}`,
      source_id: sourceId,
      from: gap.from,
      to: gap.to,
      reason: gap.reason,
      recorded_at: this.clock().toISOString(),
    };
    this.gapRecords.push(record);
    return record;
  }

  gaps(sourceId: string): GapRecord[] {
    return this.gapRecords
      .filter((entry) => entry.source_id === sourceId)
      .map((entry) => structuredClone(entry));
  }

  // ------------------------------------------------------------------ budgets

  recordCreation(sourceId: string, workspace: WorkspaceScope, at: string): void {
    const perSource = this.budget.source_creations.get(sourceId) ?? [];
    perSource.push(at);
    this.budget.source_creations.set(sourceId, perSource);
    const key = workspaceKey(workspace);
    const perWorkspace = this.budget.workspace_creations.get(key) ?? [];
    perWorkspace.push(at);
    this.budget.workspace_creations.set(key, perWorkspace);
    this.budget.last_source_creation.set(sourceId, at);
    this.budget.last_workspace_creation.set(key, at);
  }

  /**
   * Deterministic budget gate for one new-issue request at time `at`: sliding
   * window limits first (source, then the owning workspace), then cooldowns.
   * Counters are per workspace — one tenant's traffic never consumes another
   * tenant's budget. A denial names exactly one reason so operators can see
   * which gate held.
   */
  budgetCheck(
    sourceId: string,
    workspace: WorkspaceScope,
    config: BudgetConfig,
    at?: string,
  ): BudgetDenial | null {
    const point = at ?? this.clock().toISOString();
    const windowStart = Date.parse(point) - config.window_seconds * 1000;
    const inWindow = (stamp: string): boolean => Date.parse(stamp) > windowStart;
    const key = workspaceKey(workspace);

    const sourceUsed = (this.budget.source_creations.get(sourceId) ?? []).filter(inWindow).length;
    if (sourceUsed >= config.source_max_new_issues) {
      return { reason: "source_window_exhausted", source_id: sourceId };
    }
    const workspaceUsed = (this.budget.workspace_creations.get(key) ?? []).filter(inWindow).length;
    if (workspaceUsed >= config.workspace_max_new_issues) {
      return { reason: "workspace_window_exhausted", source_id: sourceId };
    }
    const lastSource = this.budget.last_source_creation.get(sourceId);
    if (
      config.source_cooldown_seconds > 0 &&
      lastSource !== undefined &&
      Date.parse(point) - Date.parse(lastSource) < config.source_cooldown_seconds * 1000
    ) {
      return { reason: "source_cooldown", source_id: sourceId };
    }
    const lastWorkspace = this.budget.last_workspace_creation.get(key);
    if (
      config.workspace_cooldown_seconds > 0 &&
      lastWorkspace !== undefined &&
      Date.parse(point) - Date.parse(lastWorkspace) < config.workspace_cooldown_seconds * 1000
    ) {
      return { reason: "workspace_cooldown", source_id: sourceId };
    }
    return null;
  }

  budgetStatus(
    sourceId: string,
    workspace: WorkspaceScope,
    config: BudgetConfig,
    at?: string,
  ): BudgetStatusView {
    const point = at ?? this.clock().toISOString();
    const windowStart = Date.parse(point) - config.window_seconds * 1000;
    const inWindow = (stamp: string): boolean => Date.parse(stamp) > windowStart;
    const key = workspaceKey(workspace);
    return {
      source_id: sourceId,
      window_seconds: config.window_seconds,
      source_used: (this.budget.source_creations.get(sourceId) ?? []).filter(inWindow).length,
      source_limit: config.source_max_new_issues,
      workspace_used: (this.budget.workspace_creations.get(key) ?? []).filter(inWindow).length,
      workspace_limit: config.workspace_max_new_issues,
      source_cooldown_seconds: config.source_cooldown_seconds,
      workspace_cooldown_seconds: config.workspace_cooldown_seconds,
      last_source_creation: this.budget.last_source_creation.get(sourceId) ?? null,
      last_workspace_creation: this.budget.last_workspace_creation.get(key) ?? null,
      deferred_count: this.deferredQueue.length,
    };
  }

  // ----------------------------------------------------------------- deferred

  addDeferred(record: DeferredSignal): void {
    this.deferredQueue.push(record);
  }

  deferred(): DeferredSignal[] {
    return structuredClone(this.deferredQueue);
  }

  deferredCount(): number {
    return this.deferredQueue.length;
  }

  removeDeferred(deferredId: string): boolean {
    const index = this.deferredQueue.findIndex((entry) => entry.deferred_id === deferredId);
    if (index < 0) {
      return false;
    }
    this.deferredQueue.splice(index, 1);
    return true;
  }

  // --------------------------------------------------------------- durability

  /** Atomically persist the whole intake state if a path is configured. */
  flushSync(): void {
    if (this.persistencePath === undefined) {
      return;
    }
    const state: PersistedState = {
      schema_version: SCHEMA_VERSION,
      sources: [...this.sources.values()].map((source) => structuredClone(source)),
      events: [...this.events.values()].map((event) => structuredClone(event)),
      signals: [...this.signals.values()].map((signal) => structuredClone(signal)),
      triage: [...this.triage.values()].map((record) => structuredClone(record)),
      suppressions: structuredClone(this.suppressions),
      gaps: structuredClone(this.gapRecords),
      deferred: structuredClone(this.deferredQueue),
      budget: {
        source_creations: [...this.budget.source_creations.entries()].map(([key, stamps]) => [
          key,
          [...stamps],
        ]),
        workspace_creations: [...this.budget.workspace_creations.entries()].map(([key, stamps]) => [
          key,
          [...stamps],
        ]),
        last_source_creation: [...this.budget.last_source_creation.entries()],
        last_workspace_creation: [...this.budget.last_workspace_creation.entries()],
      },
    };
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.persistencePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.persistencePath);
  }

  private load(): void {
    const raw = JSON.parse(fs.readFileSync(this.persistencePath as string, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("intake state is not a JSON object");
    }
    const value = raw as Record<string, unknown>;
    const version = value["schema_version"];
    if (version !== SCHEMA_VERSION) {
      throw new Error(
        `intake state schema ${String(version)} is not supported (${SCHEMA_VERSION})`,
      );
    }
    for (const source of (value["sources"] as SourceState[]) ?? []) {
      this.sources.set(source.source_id, source);
    }
    for (const event of (value["events"] as EventRecord[]) ?? []) {
      this.events.set(eventIdentity(event, event.source_id, event.provider_event_id), event);
    }
    for (const signal of (value["signals"] as SignalRecord[]) ?? []) {
      this.signals.set(signal.signal_key, signal);
    }
    for (const record of (value["triage"] as TriageRecord[]) ?? []) {
      this.triage.set(record.triage_id, record);
    }
    this.suppressions.push(...((value["suppressions"] as SuppressionRecord[]) ?? []));
    this.gapRecords.push(...((value["gaps"] as GapRecord[]) ?? []));
    this.deferredQueue.push(...((value["deferred"] as DeferredSignal[]) ?? []));
    const budget = value["budget"] as PersistedState["budget"] | undefined;
    if (budget) {
      for (const [key, stamps] of budget.source_creations) {
        this.budget.source_creations.set(key, [...stamps]);
      }
      for (const [key, stamps] of budget.workspace_creations) {
        this.budget.workspace_creations.set(key, [...stamps]);
      }
      for (const [key, stamp] of budget.last_source_creation) {
        this.budget.last_source_creation.set(key, stamp);
      }
      for (const [key, stamp] of budget.last_workspace_creation) {
        this.budget.last_workspace_creation.set(key, stamp);
      }
    }
  }
}
