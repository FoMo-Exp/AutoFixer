import { signalFingerprint } from "./fingerprint.js";
import type {
  DeferredSignal,
  EventRecord,
  GapRecord,
  SignalRecord,
  SourceState,
  SuppressionRecord,
  TriageRecord,
  WorkspaceScope,
} from "./types.js";

/**
 * Intake state schema normalization (DAT-216).
 *
 * The persisted format is versioned because it really does change: schema 1
 * existed in two shapes (an early shape with unscoped event keys, flat
 * workspace-budget stamps and 3-field signal identities, and an intermediate
 * shape with scoped keys and pair-shaped counters), and schema 2 is the
 * current one. This module converts whatever schema-1 shape it is handed into
 * the current normalized form — filling workspace scope where the data allows
 * (source binding, triage or deferred linkage), rekeying signals to the
 * workspace-scoped fingerprint, keeping unattributable records reachable
 * under their legacy keys, and rebuilding the workspace budget conservatively
 * from per-source stamps. Nothing is silently reinterpreted and nothing newer
 * is read.
 */

export const CURRENT_SCHEMA_VERSION = 2;

/** Fully normalized state; the store ingests only this shape. */
export interface NormalizedState {
  sources: SourceState[];
  events: EventRecord[];
  /**
   * Schema-1 events that no workspace attribution exists for. They are kept
   * for audit only: quarantined out of the dedup index entirely, never
   * queried at runtime. Replaying one is processed as a new submission — at
   * most one extra issue — and never reuses the original workspace's signal,
   * issue or triage (workspace isolation outranks replay idempotency; the
   * Architect ruling on DAT-216 records the trade-off).
   */
  legacy_quarantined_events: EventRecord[];
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
    /** Creation stamps that no workspace attribution exists for. Counted
     *  conservatively against every workspace until their window passes. */
    legacy_workspace_creations: string[];
    /** Cooldown floor from schema 1's single global cooldown stamp. */
    legacy_last_workspace_creation: string | null;
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scopeOf(value: Record<string, unknown>): WorkspaceScope | null {
  const enterprise = value["enterprise_id"];
  const workspace = value["workspace_id"];
  return typeof enterprise === "string" && typeof workspace === "string"
    ? { enterprise_id: enterprise, workspace_id: workspace }
    : null;
}

function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * Normalize one persisted state file to the current schema. Schema 1 is
 * migrated; schema 2 passes through with defaults filled; anything newer is
 * refused instead of misread.
 */
export function normalizePersistedState(raw: unknown, version: number): NormalizedState {
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`intake state schema ${version} is not supported (${CURRENT_SCHEMA_VERSION})`);
  }
  const value = asRecord(raw);
  return version === 1 ? migrateSchema1(value) : readSchema2(value);
}

function readSchema2(value: Record<string, unknown>): NormalizedState {
  const budget = asRecord(value["budget"]);
  // Strict load, with one defensive normalization: schema 2 is revised in
  // place (it never shipped), and an earlier build mixed unscoped legacy
  // events into `events`. They belong in the quarantine set — an unscoped
  // record inside the dedup index is exactly how a cross-workspace fallback
  // gets resurrected.
  const events: EventRecord[] = [];
  const legacy_quarantined_events: EventRecord[] = [];
  for (const record of [
    ...(asArray(value["events"]) as EventRecord[]),
    ...(asArray(value["legacy_quarantined_events"]) as EventRecord[]),
  ]) {
    if (record.enterprise_id === "" && record.workspace_id === "") {
      legacy_quarantined_events.push(record);
    } else {
      events.push(record);
    }
  }
  return {
    sources: asArray(value["sources"]) as SourceState[],
    events,
    legacy_quarantined_events,
    signals: asArray(value["signals"]) as SignalRecord[],
    triage: asArray(value["triage"]) as TriageRecord[],
    suppressions: asArray(value["suppressions"]) as SuppressionRecord[],
    gaps: asArray(value["gaps"]) as GapRecord[],
    deferred: asArray(value["deferred"]) as DeferredSignal[],
    budget: {
      source_creations: (asArray(budget["source_creations"]) as [string, string[]][]).map(
        ([key, stamps]) => [key, [...stamps]],
      ),
      workspace_creations: (asArray(budget["workspace_creations"]) as [string, string[]][]).map(
        ([key, stamps]) => [key, [...stamps]],
      ),
      last_source_creation: (asArray(budget["last_source_creation"]) as [string, string][]).map(
        ([key, stamp]) => [key, stamp],
      ),
      last_workspace_creation: (
        asArray(budget["last_workspace_creation"]) as [string, string][]
      ).map(([key, stamp]) => [key, stamp]),
      legacy_workspace_creations: [...(asArray(budget["legacy_workspace_creations"]) as string[])],
      legacy_last_workspace_creation:
        typeof budget["legacy_last_workspace_creation"] === "string"
          ? budget["legacy_last_workspace_creation"]
          : null,
    },
  };
}

/**
 * Migrate a schema-1 state. Both schema-1 shapes are handled field by field:
 * records that already carry workspace scope keep it, unscoped ones are
 * attributed through their source binding, triage record or deferred entry,
 * and anything still unattributable is preserved under its legacy identity
 * (empty scope) instead of being dropped or mis-scoped.
 */
function migrateSchema1(value: Record<string, unknown>): NormalizedState {
  const sources = asArray(value["sources"]) as SourceState[];
  const sourceWorkspace = new Map<string, WorkspaceScope>();
  for (const source of sources) {
    if (source.workspace) {
      sourceWorkspace.set(source.source_id, source.workspace);
    }
  }
  const triage = asArray(value["triage"]) as TriageRecord[];
  const deferred = asArray(value["deferred"]) as DeferredSignal[];

  const triageWorkspace = new Map<string, WorkspaceScope>();
  for (const record of triage) {
    if (!triageWorkspace.has(record.signal_key)) {
      triageWorkspace.set(record.signal_key, record.workspace);
    }
  }
  const deferredWorkspace = new Map<string, WorkspaceScope>();
  for (const entry of deferred) {
    if (!deferredWorkspace.has(entry.signal_key)) {
      deferredWorkspace.set(entry.signal_key, entry.workspace);
    }
  }

  // Signals first: attribute a workspace (own scope, source binding, triage
  // or deferred linkage) and rekey to the workspace-scoped fingerprint so
  // post-upgrade repeats keep updating this signal instead of opening a
  // duplicate issue. The attribution result is kept per legacy key so event
  // records can inherit it below. Unattributable signals stay under their
  // legacy key with empty scope, readable exactly as before.
  const rekey = new Map<string, string>();
  const signalAttribution = new Map<string, WorkspaceScope>();
  const signals: SignalRecord[] = asArray(value["signals"]).map((raw) => {
    const record = asRecord(raw);
    const identity = asRecord(record["identity"]);
    const legacyKey = String(record["signal_key"] ?? "");
    const workspace =
      scopeOf(identity) ??
      sourceWorkspace.get(String(record["source_id"] ?? "")) ??
      triageWorkspace.get(legacyKey) ??
      deferredWorkspace.get(legacyKey) ??
      null;
    const base = {
      service: String(identity["service"] ?? ""),
      environment: String(identity["environment"] ?? ""),
      error_signature: String(identity["error_signature"] ?? ""),
    };
    if (workspace === null) {
      return {
        ...(record as unknown as SignalRecord),
        signal_key: legacyKey,
        identity: { enterprise_id: "", workspace_id: "", ...base },
      };
    }
    signalAttribution.set(legacyKey, workspace);
    const full = {
      enterprise_id: workspace.enterprise_id,
      workspace_id: workspace.workspace_id,
      ...base,
    };
    const key = signalFingerprint(full);
    if (key !== legacyKey) {
      rekey.set(legacyKey, key);
    }
    return { ...(record as unknown as SignalRecord), signal_key: key, identity: full };
  });

  // Events: attribute scope from the record itself, its source binding, or
  // its signal's attribution (computed above). Events that stay unattributed
  // — the historical manual submissions with no linkage chain — are moved
  // into the quarantine set instead of the dedup index: workspace isolation
  // outranks their replay idempotency (see NormalizedState.legacy_quarantined_events).
  const events: EventRecord[] = [];
  const legacy_quarantined_events: EventRecord[] = [];
  for (const raw of asArray(value["events"])) {
    const record = asRecord(raw);
    const legacyKey = (record["signal_key"] as string | null) ?? null;
    const workspace =
      scopeOf(record) ??
      sourceWorkspace.get(String(record["source_id"] ?? "")) ??
      (legacyKey !== null ? signalAttribution.get(legacyKey) : undefined) ??
      null;
    const event: EventRecord = {
      enterprise_id: workspace?.enterprise_id ?? "",
      workspace_id: workspace?.workspace_id ?? "",
      source_id: String(record["source_id"] ?? ""),
      provider_event_id: String(record["provider_event_id"] ?? ""),
      event_time: String(record["event_time"] ?? ""),
      signal_key: legacyKey === null ? null : (rekey.get(legacyKey) ?? legacyKey),
      outcome: record["outcome"] as EventRecord["outcome"],
    };
    if (workspace === null) {
      legacy_quarantined_events.push(event);
    } else {
      events.push(event);
    }
  }
  const mapSignalKey = (key: string): string => rekey.get(key) ?? key;
  const remappedTriage = triage.map((record) => ({
    ...record,
    signal_key: mapSignalKey(record.signal_key),
  }));
  const remappedDeferred = deferred.map((entry) => ({
    ...entry,
    signal_key: mapSignalKey(entry.signal_key),
    identity: {
      enterprise_id: entry.workspace.enterprise_id,
      workspace_id: entry.workspace.workspace_id,
      service: entry.identity.service,
      environment: entry.identity.environment,
      error_signature: entry.identity.error_signature,
    },
  }));
  const suppressions = (asArray(value["suppressions"]) as SuppressionRecord[]).map((record) => ({
    ...record,
    signal_key: mapSignalKey(record.signal_key),
  }));

  // Budget: source-side counters carry over verbatim (their shape never
  // changed); the workspace side is rebuilt from per-source stamps so it is
  // never parsed from the legacy flat/pair shapes. Stamps whose source has no
  // workspace binding (manual submissions) form a conservative legacy bucket
  // counted against every workspace, and the old single global cooldown stamp
  // becomes a cooldown floor — so pre-upgrade constraints are never weakened.
  const budget = asRecord(value["budget"]);
  const source_creations = (asArray(budget["source_creations"]) as [string, string[]][]).map(
    ([key, stamps]) => [key, [...stamps]] as [string, string[]],
  );
  const workspaceStamps = new Map<string, string[]>();
  const legacyWorkspaceCreations: string[] = [];
  let legacyLast: string | null = null;
  for (const [sourceId, stamps] of source_creations) {
    const workspace = sourceWorkspace.get(sourceId);
    for (const stamp of stamps) {
      if (workspace) {
        const key = JSON.stringify([workspace.enterprise_id, workspace.workspace_id]);
        const list = workspaceStamps.get(key) ?? [];
        list.push(stamp);
        workspaceStamps.set(key, list);
      } else {
        legacyWorkspaceCreations.push(stamp);
        legacyLast = laterIso(legacyLast, stamp);
      }
    }
  }
  // Schema 1 kept one global cooldown stamp; honor it as a floor instead of
  // iterating it (its shape differs per schema-1 variant: string or absent).
  const rawLegacyLast = budget["last_workspace_creation"];
  if (typeof rawLegacyLast === "string") {
    legacyLast = laterIso(legacyLast, rawLegacyLast);
  }

  return {
    sources,
    events,
    legacy_quarantined_events,
    signals,
    triage: remappedTriage,
    suppressions,
    gaps: asArray(value["gaps"]) as GapRecord[],
    deferred: remappedDeferred,
    budget: {
      source_creations,
      workspace_creations: [...workspaceStamps.entries()].map(([key, stamps]) => [
        key,
        [...stamps],
      ]),
      last_source_creation: (asArray(budget["last_source_creation"]) as [string, string][]).map(
        ([key, stamp]) => [key, stamp],
      ),
      last_workspace_creation: [...workspaceStamps.entries()]
        .map(([key, stamps]) => [
          key,
          stamps.reduce<string | null>((latest, stamp) => laterIso(latest, stamp), null) ?? "",
        ])
        .filter((entry): entry is [string, string] => entry[1] !== ""),
      legacy_workspace_creations: legacyWorkspaceCreations,
      legacy_last_workspace_creation: legacyLast,
    },
  };
}
