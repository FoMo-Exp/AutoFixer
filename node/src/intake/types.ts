import type { ConnectorCursor } from "./connector.js";
import type { SignalIdentity } from "./fingerprint.js";
import type {
  CanonicalSeverity,
  RepositoryCandidate,
  RepositoryMapping,
  SignalDecision,
} from "./rules.js";

/**
 * Durable intake domain records (DAT-216).
 *
 * The intake store keeps the evidence a log pipeline must survive: the
 * per-event dedup registry, the fingerprint-level signal index that binds one
 * incident to at most one issue, suppression audit records, declared
 * retention gaps, budget bookkeeping, and the bounded deferred backlog. None
 * of this grants authority — issues themselves live in the collaboration
 * machine (DAT-215).
 */

export interface WorkspaceScope {
  enterprise_id: string;
  workspace_id: string;
}

/** Explicit outcome recorded for every processed provider event. */
export type EventOutcomeKind =
  | "issue_created"
  | "evidence_updated"
  | "triage_queued"
  | "duplicate_event"
  | "suppressed"
  | "budget_deferred"
  | "invalid_event";

/** Event-level dedup registry entry: one row per (source, provider event id). */
export interface EventRecord {
  source_id: string;
  provider_event_id: string;
  event_time: string;
  signal_key: string | null;
  outcome: EventOutcomeKind;
}

/** One observed alert occurrence attached to a signal. */
export interface EvidenceRecord {
  event_identity: string;
  provider_event_id: string;
  event_time: string;
  severity: CanonicalSeverity;
  rate_count: number;
  rule_ids: string[];
}

/**
 * One incident signal: the fingerprint-level index entry. A repeated alert
 * for a known fingerprint updates this record's evidence and never creates
 * another issue or task.
 */
export interface SignalRecord {
  signal_key: string;
  source_id: string;
  identity: SignalIdentity;
  summary: string;
  issue_id: string | null;
  triage_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrences: number;
  current_severity: CanonicalSeverity;
  evidence: EvidenceRecord[];
}

export type TriageReason = "repository_unmapped" | "repository_ambiguous";

/**
 * A signal whose repository mapping is unresolved or ambiguous. It waits for
 * explicit human resolution; the intake layer never guesses a repository.
 */
export interface TriageRecord {
  triage_id: string;
  signal_key: string;
  source_id: string;
  workspace: WorkspaceScope;
  reason: TriageReason;
  repository_mapping: RepositoryMapping;
  summary: string;
  created_at: string;
  resolved_at: string | null;
  resolved_repository: RepositoryCandidate | null;
  resolved_issue_id: string | null;
}

/** Append-only suppression audit entry; every suppression is recorded. */
export interface SuppressionRecord {
  suppression_id: string;
  source_id: string;
  signal_key: string;
  rule_id: string;
  reason: string;
  policy_version: string;
  provider_event_id: string;
  event_time: string;
  at: string;
}

/** A provider-declared retention gap: these events will never be available. */
export interface GapRecord {
  gap_id: string;
  source_id: string;
  from: string;
  to: string;
  reason: string;
  recorded_at: string;
}

export type BudgetDenialReason =
  | "source_window_exhausted"
  | "workspace_window_exhausted"
  | "source_cooldown"
  | "workspace_cooldown";

export interface BudgetDenial {
  reason: BudgetDenialReason;
  source_id: string;
}

/** A new-issue request parked by a budget or cooldown, awaiting the window. */
export interface DeferredSignal {
  deferred_id: string;
  signal_key: string;
  source_id: string;
  identity: SignalIdentity;
  summary: string;
  decision: SignalDecision;
  workspace: WorkspaceScope;
  requested_at: string;
  occurrences: number;
  reason: BudgetDenialReason;
}

export interface SourceCounts {
  events: number;
  duplicates: number;
  invalid: number;
  out_of_order: number;
  issues_created: number;
  evidence_updates: number;
  triaged: number;
  suppressed: number;
  deferred: number;
}

export type SourceConnection = "never_polled" | "connected" | "disconnected";

/** Per-source runtime state; workspace is bound on first use. */
export interface SourceState {
  source_id: string;
  workspace: WorkspaceScope | null;
  checkpoint: ConnectorCursor | null;
  connection: SourceConnection;
  last_error: string | null;
  /** High-water event time; anything older is out-of-order, still processed. */
  last_event_time: string | null;
  last_poll_at: string | null;
  counts: SourceCounts;
}

export function emptySourceCounts(): SourceCounts {
  return {
    events: 0,
    duplicates: 0,
    invalid: 0,
    out_of_order: 0,
    issues_created: 0,
    evidence_updates: 0,
    triaged: 0,
    suppressed: 0,
    deferred: 0,
  };
}
