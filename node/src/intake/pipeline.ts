import { randomUUID } from "node:crypto";

import type { CreateIssueInput } from "../collab/machine.js";
import type { IssueRecord } from "../collab/types.js";
import type {
  ConnectorBatch,
  ConnectorCursor,
  LogSourceConnector,
  ProviderLogEvent,
} from "./connector.js";
import { ConnectorProtocolError, ConnectorUnavailableError } from "./connector.js";
import { IntakeError } from "./errors.js";
import {
  errorSignature,
  normalizeErrorClass,
  normalizeMessage,
  signalFingerprint,
} from "./fingerprint.js";
import type { ErrorShape, SignalIdentity } from "./fingerprint.js";
import { evaluateRules } from "./rules.js";
import type {
  CanonicalSeverity,
  RepositoryCandidate,
  RepositoryMapping,
  RuleConfig,
  RuleEvaluationInput,
  SignalDecision,
} from "./rules.js";
import type { BudgetConfig, BudgetStatusView, IntakeStore } from "./store.js";
import type {
  DeferredSignal,
  EventOutcomeKind,
  GapRecord,
  SignalRecord,
  SourceConnection,
  SourceCounts,
  SourceState,
  TriageReason,
  WorkspaceScope,
} from "./types.js";

/**
 * Log intake pipeline (DAT-216, ADR-0007 "Log intake and issue creation").
 *
 * One service-owned pipeline turns provider alerts into product issues:
 *
 * - Events are deduplicated by `(source, provider event id)`; incidents are
 *   deduplicated by the versioned signal fingerprint, so replayed, overlapping
 *   or out-of-order alerts never create duplicate issues — a repeated alert
 *   updates the signal's evidence instead.
 * - The source checkpoint advances only in the same durable write that
 *   records the batch ("persist before ack"); a crash before that write
 *   replays cleanly because every step is idempotent against durable state.
 * - Backpressure, outages, retention gaps and out-of-order arrivals all have
 *   explicit outcomes and are visible in source status.
 * - Deterministic rules (never a model) select severity, service/environment,
 *   the error signature, rate/window policy, suppression and repository
 *   mapping; an unresolved or ambiguous mapping queues triage and is never
 *   guessed.
 * - New-issue creation is gated by source/workspace budgets and cooldowns,
 *   with an explicit bounded deferred backlog, all observable via status.
 */

/** Source identity used for human submissions. */
export const MANUAL_SOURCE_ID = "manual";

export interface EventOutcome {
  kind: EventOutcomeKind;
  /** Provider event id, manual submission id, or `invalid:<index>`. */
  event_ref: string;
  signal_key: string | null;
  issue_id: string | null;
  triage_id: string | null;
  severity: CanonicalSeverity | null;
  /** Signal occurrence count after this event, for evidence updates. */
  occurrences: number | null;
  out_of_order: boolean;
  /** Denial reason, suppression reason, or validation error detail. */
  reason: string | null;
}

export interface BatchReport {
  source_id: string;
  checkpoint: ConnectorCursor | null;
  events_seen: number;
  outcomes: EventOutcome[];
  out_of_order: number;
  replayed: number;
  gap: GapRecord | null;
  connection: "connected" | "reconnected";
  /** Always true on return: the batch is durably recorded before reporting. */
  persisted: true;
}

export type PollReport =
  | { source_id: string; status: "polled"; batch: BatchReport }
  | {
      source_id: string;
      status: "backpressure";
      deferred_count: number;
      high_water: number;
    }
  | { source_id: string; status: "disconnected"; error: string }
  | { source_id: string; status: "failed"; error: string };

export interface SourceStatus {
  source_id: string;
  workspace: WorkspaceScope | null;
  checkpoint: ConnectorCursor | null;
  connection: SourceConnection;
  last_error: string | null;
  last_event_time: string | null;
  last_poll_at: string | null;
  counts: SourceCounts;
  gaps: GapRecord[];
  budget: BudgetStatusView;
}

/** One configured log source, owned and supervised by this service. */
export interface SourceConfig {
  source_id: string;
  workspace: WorkspaceScope;
  connector: LogSourceConnector;
  max_events_per_poll: number;
}

/** The collaboration machine surface intake needs (DAT-215). */
export interface IssueSink {
  createIssue(input: CreateIssueInput): IssueRecord;
  getIssue(issueId: string): IssueRecord | undefined;
}

export interface LogIntakeDeps {
  machine: IssueSink;
  store: IntakeStore;
  rules: RuleConfig;
  budgets: BudgetConfig;
  now?: () => Date;
}

export interface ManualSubmissionInput {
  actor: string;
  workspace: WorkspaceScope;
  /** Idempotency key; omitted means every call is a new occurrence. */
  submission_id?: string | null;
  provider_severity: string;
  provider_service: string;
  provider_environment: string;
  message: string;
  error?: { class?: string | undefined; stack_locations?: string[] | undefined } | undefined;
  labels?: Record<string, string> | undefined;
  /** Human-declared repository; overrides ambiguous rule mapping. */
  repository?: RepositoryCandidate | null;
  reference?: string | null;
}

export interface ResolveTriageInput {
  triage_id: string;
  repository: RepositoryCandidate;
  actor: string;
}

export interface ResolveTriageResult {
  triage_id: string;
  issue_id: string;
  issue: IssueRecord;
}

export interface DrainReport {
  drained: { deferred_id: string; outcome: EventOutcome }[];
  remaining: number;
}

interface SignalContext {
  sourceId: string;
  workspace: WorkspaceScope;
  at: string;
  sourceState: SourceState | null;
  repositoryOverride: RepositoryCandidate | null;
}

interface SignalInput {
  providerEventId: string;
  eventIdentity: string;
  eventTime: string;
  providerSeverity: string;
  providerService: string;
  providerEnvironment: string;
  message: string;
  error?: { class?: string | undefined; stack_locations?: string[] | undefined } | undefined;
  labels: Record<string, string>;
}

function outcome(kind: EventOutcomeKind, fields: Partial<EventOutcome> = {}): EventOutcome {
  return {
    kind,
    event_ref: fields.event_ref ?? "",
    signal_key: fields.signal_key ?? null,
    issue_id: fields.issue_id ?? null,
    triage_id: fields.triage_id ?? null,
    severity: fields.severity ?? null,
    occurrences: fields.occurrences ?? null,
    out_of_order: fields.out_of_order ?? false,
    reason: fields.reason ?? null,
  };
}

/**
 * Structural validation of one provider event. A missing or malformed field
 * is an explicit `invalid_event` outcome, never a defaulted value.
 */
export function validateProviderEvent(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return "event must be an object";
  }
  const event = raw as Record<string, unknown>;
  const id = event["provider_event_id"];
  if (typeof id !== "string" || id.length === 0) {
    return "provider_event_id must be a non-empty string";
  }
  const time = event["event_time"];
  if (typeof time !== "string" || Number.isNaN(Date.parse(time))) {
    return "event_time must be an RFC 3339 timestamp";
  }
  const version = event["schema_version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return "schema_version must be an integer >= 1";
  }
  for (const field of [
    "provider_severity",
    "provider_service",
    "provider_environment",
    "message",
  ]) {
    const value = event[field];
    if (typeof value !== "string" || value.length === 0) {
      return `${field} must be a non-empty string`;
    }
  }
  const error = event["error"];
  if (error !== undefined && error !== null) {
    if (typeof error !== "object" || Array.isArray(error)) {
      return "error must be an object";
    }
    const shape = error as Record<string, unknown>;
    if (shape["class"] !== undefined && typeof shape["class"] !== "string") {
      return "error.class must be a string";
    }
    const stack = shape["stack_locations"];
    if (
      stack !== undefined &&
      (!Array.isArray(stack) || stack.some((entry) => typeof entry !== "string"))
    ) {
      return "error.stack_locations must be a string array";
    }
  }
  const labels = event["labels"];
  if (labels !== undefined && labels !== null) {
    if (typeof labels !== "object" || Array.isArray(labels)) {
      return "labels must be an object";
    }
    for (const value of Object.values(labels)) {
      if (typeof value !== "string") {
        return "labels values must be strings";
      }
    }
  }
  return null;
}

function buildSummary(decision: SignalDecision, message: string, errorShape: ErrorShape): string {
  return `${decision.service}/${decision.environment}: ${normalizeErrorClass(errorShape)} ${normalizeMessage(message)}`;
}

function effectiveMapping(
  decision: SignalDecision,
  override: RepositoryCandidate | null,
): RepositoryMapping {
  if (override !== null) {
    return {
      status: "mapped",
      repository: override,
      candidates: [override],
      rule_ids: [...decision.repository_mapping.rule_ids, "manual"],
    };
  }
  return decision.repository_mapping;
}

export class LogIntake {
  private readonly deps: LogIntakeDeps;
  private readonly sources = new Map<string, SourceConfig>();
  private readonly clock: () => Date;

  constructor(deps: LogIntakeDeps) {
    if (deps.budgets.backpressure_high_water > deps.budgets.max_deferred) {
      throw new IntakeError(
        "INVALID_CONFIG",
        "backpressure high water exceeds the deferred bound",
        {
          backpressure_high_water: deps.budgets.backpressure_high_water,
          max_deferred: deps.budgets.max_deferred,
        },
      );
    }
    this.deps = deps;
    this.clock = deps.now ?? (() => new Date());
  }

  /** Register one configured source; re-registering with another workspace fails. */
  registerSource(config: SourceConfig): void {
    if (config.max_events_per_poll < 1) {
      throw new IntakeError("INVALID_CONFIG", "max_events_per_poll must be >= 1", {
        source_id: config.source_id,
      });
    }
    this.sources.set(config.source_id, config);
    this.deps.store.bindSource(config.source_id, config.workspace);
  }

  // ------------------------------------------------------------------- polling

  /**
   * One supervised poll cycle for a source. Polling stops with an explicit
   * `backpressure` report while the deferred backlog is at its high-water
   * mark, so the pipeline drains before accepting more work.
   */
  async pollSource(sourceId: string): Promise<PollReport> {
    const config = this.requireSource(sourceId);
    const deferredCount = this.deps.store.deferredCount();
    if (deferredCount >= this.deps.budgets.backpressure_high_water) {
      return {
        source_id: sourceId,
        status: "backpressure",
        deferred_count: deferredCount,
        high_water: this.deps.budgets.backpressure_high_water,
      };
    }
    let batch: ConnectorBatch;
    try {
      batch = await config.connector.poll(
        this.deps.store.checkpoint(sourceId),
        config.max_events_per_poll,
      );
    } catch (error) {
      if (error instanceof ConnectorUnavailableError) {
        this.deps.store.setConnection(sourceId, "disconnected", error.message);
        this.deps.store.flushSync();
        return { source_id: sourceId, status: "disconnected", error: error.message };
      }
      if (error instanceof ConnectorProtocolError) {
        this.deps.store.setConnection(sourceId, "disconnected", error.message);
        this.deps.store.flushSync();
        return { source_id: sourceId, status: "failed", error: error.message };
      }
      throw error;
    }
    return { source_id: sourceId, status: "polled", batch: this.applyBatch(sourceId, batch) };
  }

  /**
   * Process one fetched batch and persist it — events, evidence, issue links,
   * gaps and the new checkpoint in one durable write. The report is only
   * produced after that write succeeds: the checkpoint never advances past
   * unrecorded events.
   */
  applyBatch(sourceId: string, batch: ConnectorBatch): BatchReport {
    const config = this.requireSource(sourceId);
    const state = this.deps.store.bindSource(sourceId, config.workspace);
    const outcomes: EventOutcome[] = [];
    for (const [index, raw] of batch.events.entries()) {
      outcomes.push(this.applySourceEvent(sourceId, raw, index, state));
    }
    const gap = batch.gap ? this.deps.store.recordGap(sourceId, batch.gap) : null;
    const wasDisconnected = state.connection === "disconnected" || state.last_error !== null;
    const at = this.clock().toISOString();
    this.deps.store.setConnection(sourceId, "connected", null);
    this.deps.store.setCheckpoint(sourceId, batch.cursor, at);
    this.deps.store.flushSync();
    return {
      source_id: sourceId,
      checkpoint: batch.cursor,
      events_seen: batch.events.length,
      outcomes,
      out_of_order: outcomes.filter((entry) => entry.out_of_order).length,
      replayed: outcomes.filter((entry) => entry.kind === "duplicate_event").length,
      gap,
      connection: wasDisconnected ? "reconnected" : "connected",
      persisted: true,
    };
  }

  // --------------------------------------------------------------- submissions

  /**
   * Manual issue submission through the same rules, dedup, and budget path as
   * source alerts. A known fingerprint updates evidence; a human-declared
   * repository overrides ambiguous rule mapping; an explicit `submission_id`
   * makes retries idempotent.
   */
  submitManual(input: ManualSubmissionInput): EventOutcome {
    if (typeof input.actor !== "string" || input.actor.length === 0) {
      throw new IntakeError("INVALID_INPUT", "actor must be a non-empty string", {
        field: "actor",
      });
    }
    const submissionId =
      typeof input.submission_id === "string" && input.submission_id.trim().length > 0
        ? input.submission_id.trim()
        : `msub_${randomUUID().replaceAll("-", "")}`;
    if (this.deps.store.findEvent(input.workspace, MANUAL_SOURCE_ID, submissionId)) {
      return outcome("duplicate_event", { event_ref: submissionId });
    }
    const at = this.clock().toISOString();
    const synthetic: ProviderLogEvent = {
      provider_event_id: submissionId,
      event_time: at,
      schema_version: 1,
      provider_severity: input.provider_severity,
      provider_service: input.provider_service,
      provider_environment: input.provider_environment,
      message: input.message,
      ...(input.error ? { error: input.error } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
    };
    const invalid = validateProviderEvent(synthetic);
    if (invalid !== null) {
      this.deps.store.recordEvent({
        enterprise_id: input.workspace.enterprise_id,
        workspace_id: input.workspace.workspace_id,
        source_id: MANUAL_SOURCE_ID,
        provider_event_id: submissionId,
        event_time: at,
        signal_key: null,
        outcome: "invalid_event",
      });
      return outcome("invalid_event", { event_ref: submissionId, reason: invalid });
    }
    const result = this.processSignal(
      {
        providerEventId: submissionId,
        eventIdentity: JSON.stringify([
          input.workspace.enterprise_id,
          input.workspace.workspace_id,
          MANUAL_SOURCE_ID,
          submissionId,
        ]),
        eventTime: at,
        providerSeverity: input.provider_severity,
        providerService: input.provider_service,
        providerEnvironment: input.provider_environment,
        message: input.message,
        ...(input.error ? { error: input.error } : {}),
        labels: input.labels ?? {},
      },
      {
        sourceId: MANUAL_SOURCE_ID,
        workspace: input.workspace,
        at,
        sourceState: null,
        repositoryOverride: input.repository ?? null,
      },
    );
    this.deps.store.recordEvent({
      enterprise_id: input.workspace.enterprise_id,
      workspace_id: input.workspace.workspace_id,
      source_id: MANUAL_SOURCE_ID,
      provider_event_id: submissionId,
      event_time: at,
      signal_key: result.signal_key,
      outcome: result.kind,
    });
    return result;
  }

  /** Human resolution of a triage record: name the repository, open the issue. */
  resolveTriage(input: ResolveTriageInput): ResolveTriageResult {
    const record = this.deps.store.getTriage(input.triage_id);
    if (!record) {
      throw new IntakeError("TRIAGE_NOT_FOUND", `unknown triage record ${input.triage_id}`, {
        triage_id: input.triage_id,
      });
    }
    if (record.resolved_at !== null) {
      throw new IntakeError("TRIAGE_ALREADY_RESOLVED", `triage ${input.triage_id} is resolved`, {
        triage_id: input.triage_id,
      });
    }
    const signal = this.deps.store.getSignal(record.signal_key);
    const issue = this.deps.machine.createIssue({
      operation_id: `intake-issue:${record.signal_key}`,
      actor: input.actor,
      workspace: record.workspace,
      repository: input.repository,
      dedupe_key: record.signal_key,
      summary: signal?.summary ?? record.summary,
      source_reference: `signal:${record.source_id}:${record.signal_key}`,
    });
    this.deps.store.resolveTriage(input.triage_id, {
      repository: input.repository,
      issue_id: issue.issue_id,
      at: this.clock().toISOString(),
    });
    if (signal) {
      signal.issue_id = issue.issue_id;
      this.deps.store.putSignal(signal);
    }
    return { triage_id: input.triage_id, issue_id: issue.issue_id, issue };
  }

  /**
   * Retry deferred new-issue requests whose budget window or cooldown has
   * passed. Denied entries stay parked; nothing is dropped silently.
   */
  drainDeferred(): DrainReport {
    const drained: { deferred_id: string; outcome: EventOutcome }[] = [];
    for (const entry of this.deps.store.deferred()) {
      const at = this.clock().toISOString();
      const denial = this.deps.store.budgetCheck(
        entry.source_id,
        entry.workspace,
        this.deps.budgets,
        at,
      );
      if (denial !== null) {
        continue;
      }
      const result = this.applyDeferred(entry, at);
      this.deps.store.removeDeferred(entry.deferred_id);
      drained.push({ deferred_id: entry.deferred_id, outcome: result });
    }
    return { drained, remaining: this.deps.store.deferredCount() };
  }

  // ------------------------------------------------------------ observability

  sourceStatus(sourceId: string): SourceStatus {
    const state = this.deps.store.source(sourceId);
    if (!state) {
      throw new IntakeError("SOURCE_NOT_FOUND", `unknown source ${sourceId}`, {
        source_id: sourceId,
      });
    }
    return {
      source_id: state.source_id,
      workspace: state.workspace,
      checkpoint: state.checkpoint,
      connection: state.connection,
      last_error: state.last_error,
      last_event_time: state.last_event_time,
      last_poll_at: state.last_poll_at,
      counts: structuredClone(state.counts),
      gaps: this.deps.store.gaps(sourceId),
      budget: this.deps.store.budgetStatus(
        sourceId,
        state.workspace ?? this.requireSource(sourceId).workspace,
        this.deps.budgets,
      ),
    };
  }

  budgetStatus(sourceId: string): BudgetStatusView {
    const workspace =
      this.deps.store.source(sourceId)?.workspace ?? this.requireSource(sourceId).workspace;
    return this.deps.store.budgetStatus(sourceId, workspace, this.deps.budgets);
  }

  suppressionLog(): ReturnType<IntakeStore["suppressionLog"]> {
    return this.deps.store.suppressionLog();
  }

  // ---------------------------------------------------------------- internals

  private requireSource(sourceId: string): SourceConfig {
    const config = this.sources.get(sourceId);
    if (!config) {
      throw new IntakeError("SOURCE_NOT_REGISTERED", `source ${sourceId} is not registered`, {
        source_id: sourceId,
      });
    }
    return config;
  }

  private applySourceEvent(
    sourceId: string,
    raw: unknown,
    index: number,
    state: SourceState,
  ): EventOutcome {
    const workspace = state.workspace ?? { enterprise_id: "", workspace_id: "" };
    const invalid = validateProviderEvent(raw);
    const record = (raw ?? {}) as Record<string, unknown>;
    const usableId =
      typeof record["provider_event_id"] === "string" && record["provider_event_id"].length > 0
        ? (record["provider_event_id"] as string)
        : null;

    if (invalid !== null) {
      if (
        usableId !== null &&
        this.deps.store.findEvent(workspace, sourceId, usableId) === undefined
      ) {
        this.deps.store.recordEvent({
          enterprise_id: workspace.enterprise_id,
          workspace_id: workspace.workspace_id,
          source_id: sourceId,
          provider_event_id: usableId,
          event_time: typeof record["event_time"] === "string" ? record["event_time"] : "",
          signal_key: null,
          outcome: "invalid_event",
        });
      }
      state.counts.events += 1;
      state.counts.invalid += 1;
      return outcome("invalid_event", {
        event_ref: usableId ?? `invalid:${index}`,
        reason: invalid,
      });
    }

    const event = raw as ProviderLogEvent;
    if (this.deps.store.findEvent(workspace, sourceId, event.provider_event_id) !== undefined) {
      state.counts.events += 1;
      state.counts.duplicates += 1;
      return outcome("duplicate_event", { event_ref: event.provider_event_id });
    }

    let outOfOrder = false;
    if (
      state.last_event_time !== null &&
      Date.parse(event.event_time) < Date.parse(state.last_event_time)
    ) {
      outOfOrder = true;
      state.counts.out_of_order += 1;
    }
    if (
      state.last_event_time === null ||
      Date.parse(event.event_time) > Date.parse(state.last_event_time)
    ) {
      this.deps.store.setLastEventTime(sourceId, event.event_time);
    }
    state.counts.events += 1;

    const at = this.clock().toISOString();
    const result = this.processSignal(
      {
        providerEventId: event.provider_event_id,
        eventIdentity: JSON.stringify([
          workspace.enterprise_id,
          workspace.workspace_id,
          sourceId,
          event.provider_event_id,
        ]),
        eventTime: event.event_time,
        providerSeverity: event.provider_severity,
        providerService: event.provider_service,
        providerEnvironment: event.provider_environment,
        message: event.message,
        ...(event.error ? { error: event.error } : {}),
        labels: event.labels ?? {},
      },
      {
        sourceId,
        workspace,
        at,
        sourceState: state,
        repositoryOverride: null,
      },
    );
    this.deps.store.recordEvent({
      enterprise_id: workspace.enterprise_id,
      workspace_id: workspace.workspace_id,
      source_id: sourceId,
      provider_event_id: event.provider_event_id,
      event_time: event.event_time,
      signal_key: result.signal_key,
      outcome: result.kind,
    });
    return { ...result, out_of_order: outOfOrder };
  }

  private processSignal(input: SignalInput, ctx: SignalContext): EventOutcome {
    const errorShape: ErrorShape = {
      ...(input.error?.class !== undefined ? { class: input.error.class } : {}),
      message: input.message,
      ...(input.error?.stack_locations !== undefined
        ? { stack_locations: input.error.stack_locations }
        : {}),
    };
    const signature = errorSignature(errorShape);
    const evaluation: RuleEvaluationInput = {
      provider_severity: input.providerSeverity,
      provider_service: input.providerService,
      provider_environment: input.providerEnvironment,
      error_class: normalizeErrorClass(errorShape),
      error_signature: signature,
      labels: input.labels,
    };

    // First pass selects the rule-configured window; the second compares the
    // observed count in that window for severity escalation. Both passes are
    // pure, so the two-step evaluation stays deterministic.
    const probe = evaluateRules(this.deps.rules, evaluation, { count_in_window: 0 });
    const signalKey = signalFingerprint({
      enterprise_id: ctx.workspace.enterprise_id,
      workspace_id: ctx.workspace.workspace_id,
      service: probe.service,
      environment: probe.environment,
      error_signature: signature,
    });
    const known = this.deps.store.getSignal(signalKey);
    const priorCount = countPriorOccurrences(known, input.eventTime, probe.rate_window_seconds);
    const decision = evaluateRules(this.deps.rules, evaluation, {
      count_in_window: priorCount + 1,
    });

    if (decision.suppression !== null) {
      this.deps.store.addSuppression({
        suppression_id: `sup_${randomUUID().replaceAll("-", "")}`,
        source_id: ctx.sourceId,
        signal_key: signalKey,
        rule_id: decision.suppression.rule_id,
        reason: decision.suppression.reason,
        policy_version: decision.policy_version,
        provider_event_id: input.providerEventId,
        event_time: input.eventTime,
        at: ctx.at,
      });
      if (ctx.sourceState) {
        ctx.sourceState.counts.suppressed += 1;
      }
      return outcome("suppressed", {
        event_ref: input.providerEventId,
        signal_key: signalKey,
        severity: decision.severity,
        reason: decision.suppression.reason,
      });
    }

    const summary = buildSummary(decision, input.message, errorShape);
    const identity: SignalIdentity = {
      enterprise_id: ctx.workspace.enterprise_id,
      workspace_id: ctx.workspace.workspace_id,
      service: decision.service,
      environment: decision.environment,
      error_signature: signature,
    };
    const evidence = {
      event_identity: input.eventIdentity,
      provider_event_id: input.providerEventId,
      event_time: input.eventTime,
      severity: decision.severity,
      rate_count: decision.rate_count,
      rule_ids: decision.rule_ids,
    };

    if (known) {
      this.deps.store.appendEvidence(signalKey, evidence);
      known.current_severity = decision.severity;
      if (ctx.sourceState) {
        ctx.sourceState.counts.evidence_updates += 1;
      }
      return outcome("evidence_updated", {
        event_ref: input.providerEventId,
        signal_key: signalKey,
        issue_id: known.issue_id,
        triage_id: known.triage_id,
        severity: decision.severity,
        occurrences: known.occurrences,
      });
    }

    const denial = this.deps.store.budgetCheck(
      ctx.sourceId,
      ctx.workspace,
      this.deps.budgets,
      ctx.at,
    );
    if (denial !== null) {
      this.deps.store.putSignal({
        signal_key: signalKey,
        source_id: ctx.sourceId,
        identity,
        summary,
        issue_id: null,
        triage_id: null,
        first_seen_at: ctx.at,
        last_seen_at: ctx.at,
        occurrences: 1,
        current_severity: decision.severity,
        evidence: [evidence],
      });
      const backlogFull = this.deps.store.deferredCount() >= this.deps.budgets.max_deferred;
      if (!backlogFull) {
        this.deps.store.addDeferred({
          deferred_id: `def_${randomUUID().replaceAll("-", "")}`,
          signal_key: signalKey,
          source_id: ctx.sourceId,
          identity,
          summary,
          decision,
          workspace: ctx.workspace,
          requested_at: ctx.at,
          occurrences: 1,
          reason: denial.reason,
        });
      }
      if (ctx.sourceState) {
        ctx.sourceState.counts.deferred += 1;
      }
      return outcome("budget_deferred", {
        event_ref: input.providerEventId,
        signal_key: signalKey,
        severity: decision.severity,
        reason: backlogFull ? "deferred_backlog_full" : denial.reason,
      });
    }

    return this.openSignal(
      {
        signalKey,
        identity,
        summary,
        evidence,
        decision,
        mapping: effectiveMapping(decision, ctx.repositoryOverride),
      },
      ctx,
      input.providerEventId,
    );
  }

  /** Create the issue or queue triage for one new, budget-approved signal. */
  private openSignal(
    signal: {
      signalKey: string;
      identity: SignalIdentity;
      summary: string;
      evidence: SignalRecord["evidence"][number];
      decision: SignalDecision;
      mapping: RepositoryMapping;
    },
    ctx: SignalContext,
    eventRef: string,
    existing: SignalRecord | null = null,
  ): EventOutcome {
    const at = ctx.at;
    const link = (issueId: string | null, triageId: string | null): number => {
      if (existing) {
        existing.issue_id = issueId;
        existing.triage_id = triageId;
        this.deps.store.putSignal(existing);
        return existing.occurrences;
      }
      this.deps.store.putSignal({
        signal_key: signal.signalKey,
        source_id: ctx.sourceId,
        identity: signal.identity,
        summary: signal.summary,
        issue_id: issueId,
        triage_id: triageId,
        first_seen_at: at,
        last_seen_at: at,
        occurrences: 1,
        current_severity: signal.decision.severity,
        evidence: [signal.evidence],
      });
      return 1;
    };
    if (signal.mapping.status === "mapped" && signal.mapping.repository !== null) {
      const issue = this.deps.machine.createIssue({
        operation_id: `intake-issue:${signal.signalKey}`,
        actor: `log-intake:${ctx.sourceId}`,
        workspace: ctx.workspace,
        repository: signal.mapping.repository,
        dedupe_key: signal.signalKey,
        summary: signal.summary,
        source_reference: `signal:${ctx.sourceId}:${signal.signalKey}`,
      });
      const occurrences = link(issue.issue_id, null);
      this.deps.store.recordCreation(ctx.sourceId, ctx.workspace, at);
      if (ctx.sourceState) {
        ctx.sourceState.counts.issues_created += 1;
      }
      return outcome("issue_created", {
        event_ref: eventRef,
        signal_key: signal.signalKey,
        issue_id: issue.issue_id,
        severity: signal.decision.severity,
        occurrences,
      });
    }

    const reason: TriageReason =
      signal.mapping.status === "ambiguous" ? "repository_ambiguous" : "repository_unmapped";
    const triageId = `tri_${randomUUID().replaceAll("-", "")}`;
    this.deps.store.addTriage({
      triage_id: triageId,
      signal_key: signal.signalKey,
      source_id: ctx.sourceId,
      workspace: ctx.workspace,
      reason,
      repository_mapping: signal.mapping,
      summary: signal.summary,
      created_at: at,
      resolved_at: null,
      resolved_repository: null,
      resolved_issue_id: null,
    });
    const occurrences = link(null, triageId);
    this.deps.store.recordCreation(ctx.sourceId, ctx.workspace, at);
    if (ctx.sourceState) {
      ctx.sourceState.counts.triaged += 1;
    }
    return outcome("triage_queued", {
      event_ref: eventRef,
      signal_key: signal.signalKey,
      triage_id: triageId,
      severity: signal.decision.severity,
      occurrences,
      reason,
    });
  }

  /** Apply one parked new-issue request after its budget window has passed. */
  private applyDeferred(entry: DeferredSignal, at: string): EventOutcome {
    const existing = this.deps.store.getSignal(entry.signal_key) ?? null;
    return this.openSignal(
      {
        signalKey: entry.signal_key,
        identity: entry.identity,
        summary: entry.summary,
        evidence: {
          event_identity: JSON.stringify([entry.source_id, entry.deferred_id]),
          provider_event_id: entry.deferred_id,
          event_time: entry.requested_at,
          severity: entry.decision.severity,
          rate_count: entry.decision.rate_count,
          rule_ids: entry.decision.rule_ids,
        },
        decision: entry.decision,
        mapping: entry.decision.repository_mapping,
      },
      {
        sourceId: entry.source_id,
        workspace: entry.workspace,
        at,
        sourceState: this.deps.store.source(entry.source_id) ?? null,
        repositoryOverride: null,
      },
      entry.deferred_id,
      existing,
    );
  }
}

/** Prior occurrences of the signal inside the window ending at `eventTime`. */
function countPriorOccurrences(
  signal: SignalRecord | undefined,
  eventTime: string,
  windowSeconds: number,
): number {
  if (signal === undefined) {
    return 0;
  }
  const end = Date.parse(eventTime);
  const start = end - windowSeconds * 1000;
  return signal.evidence.filter((entry) => {
    const at = Date.parse(entry.event_time);
    return at > start && at <= end;
  }).length;
}
