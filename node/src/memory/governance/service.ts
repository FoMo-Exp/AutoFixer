/**
 * Workspace memory governance service (DAT-251).
 *
 * The named-human half of the ADR-0009 lifecycle. Retrieval (DAT-236) is
 * read-only and DAT-235 automates facts; this service is where a human with
 * standing promotes, deprecates, quarantines, or restores one exact version,
 * and where the governance UI reads item detail, content history, and the
 * audit timeline.
 *
 * Invariants enforced here, not only in HTTP:
 *
 * 1. **State machine.** `promote` is candidate → active only; `deprecate` is
 *    active|candidate → deprecated; `quarantine` is any non-terminal state →
 *    quarantined; `restore` is quarantined → proposed|candidate|deprecated and
 *    never back to active, so a release from quarantine always re-enters the
 *    promotion path. Illegal moves are `INVALID_TRANSITION`, not a silent
 *    no-op.
 * 2. **Authority.** Workspace owner/admin govern anything in the workspace
 *    they can read; a team leader governs only items whose applicability names
 *    a team they lead; members and viewers read only. Authority is resolved
 *    from live membership and team rows, never from a request body.
 * 3. **Sensitivity.** Reads obey the caller's role ceiling per version: a
 *    historical confidential version is absent from `versions` for a member
 *    even when the current version is internal. `restricted` items are not
 *    manageable through this surface at all; they answer 404 like a missing one.
 * 4. **Quarantine.** A quarantined item's statement, preconditions, and
 *    evidence references are never served (see `../redact.js`).
 * 5. **Concurrency and audit.** Every write names `expected_version` and the
 *    exact content `version`; a mismatch is `VERSION_CONFLICT`. Writes only
 *    append audit rows — `memory_events`, promotion decisions, consolidation
 *    ops — and never rewrite history.
 * 6. **No free text.** Reason codes are a fixed vocabulary, and the timeline's
 *    `detail` is normalized to enums, counts, and opaque ids. The
 *    "no free text, no memory content" invariant of `memory_events` holds.
 */

import type { WorkspaceRole, WorkspaceScope } from "../../control-plane/types.js";
import {
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  VersionConflictError,
} from "../../control-plane/errors.js";
import type { MemoryEvent, MemoryItemRecord, MemoryItemVersion, MemoryStatus } from "../types.js";
import { MEMORY_SCHEMA_VERSION } from "../types.js";
import type { MemoryRepositories, MemoryTimelinePosition } from "../repositories.js";
import type {
  ConsolidationOpRecordWithTime,
  MemoryLifecycleStore,
  PromotionDecisionRecord,
} from "../lifecycle/repositories.js";
import { approveAndPromote } from "../lifecycle/promotion.js";
import type { MemoryRetrievalService } from "../retrieval/service.js";
import { tierOf } from "../retrieval/types.js";
import type { MemoryItemView } from "../retrieval/types.js";
import { withinSensitivityCeiling } from "../retrieval/rank.js";
import { servedPreconditions, servedStatement } from "../redact.js";
import type {
  DeprecateMemoryItemRequest,
  MemoryGovernanceAction,
  MemoryGovernanceActor,
  MemoryGovernanceReasonCode,
  MemoryGovernanceResult,
  MemoryItemEventView,
  MemoryItemEventsQuery,
  MemoryItemEventsView,
  MemoryItemVersionView,
  MemoryItemVersionsView,
  PromoteMemoryItemRequest,
  QuarantineMemoryItemRequest,
  RestoreMemoryItemRequest,
} from "./types.js";
import { MEMORY_GOVERNANCE_REASON_CODES, MEMORY_RESTORE_TARGET_STATUSES } from "./types.js";

/**
 * The narrow team directory the governance surface needs: who leads which team
 * in this workspace. A structural interface keeps the service independent of
 * the full control-plane repository.
 */
export interface MemoryTeamDirectory {
  list(scope: WorkspaceScope): Array<{ id: string; leader_user_id: string }>;
}

export interface MemoryGovernanceServiceDeps {
  memory: MemoryRepositories;
  retrieval: MemoryRetrievalService;
  lifecycle: MemoryLifecycleStore;
  teams?: MemoryTeamDirectory;
  clock?: () => Date;
}

export interface MemoryGovernanceService {
  getItem(scope: WorkspaceScope, role: WorkspaceRole, itemId: string): MemoryItemView;
  versions(scope: WorkspaceScope, role: WorkspaceRole, itemId: string): MemoryItemVersionsView;
  /**
   * One page of the merged audit timeline. The timeline is traversable: a page
   * returns `next_cursor` while more rows remain, so a client never mistakes a
   * bounded page for the complete audit history.
   */
  events(
    scope: WorkspaceScope,
    role: WorkspaceRole,
    itemId: string,
    query?: MemoryItemEventsQuery,
  ): MemoryItemEventsView;
  promote(
    scope: WorkspaceScope,
    actor: MemoryGovernanceActor,
    itemId: string,
    input: PromoteMemoryItemRequest,
  ): MemoryGovernanceResult;
  deprecate(
    scope: WorkspaceScope,
    actor: MemoryGovernanceActor,
    itemId: string,
    input: DeprecateMemoryItemRequest,
  ): MemoryGovernanceResult;
  quarantine(
    scope: WorkspaceScope,
    actor: MemoryGovernanceActor,
    itemId: string,
    input: QuarantineMemoryItemRequest,
  ): MemoryGovernanceResult;
  restore(
    scope: WorkspaceScope,
    actor: MemoryGovernanceActor,
    itemId: string,
    input: RestoreMemoryItemRequest,
  ): MemoryGovernanceResult;
}

// ---------------------------------------------------------------------------
// Detail sanitizer for the audit timeline
// ---------------------------------------------------------------------------

/**
 * Keys the timeline may expose. Audit rows are written by this module and its
 * siblings, but the reader normalizes defensively: an unknown key, a nested
 * object, or a value with whitespace is dropped rather than echoed.
 */
const SAFE_DETAIL_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_DETAIL_TOKEN = /^[A-Za-z0-9_.:@,/-]{1,200}$/;

function sanitizedDetail(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SAFE_DETAIL_KEY.test(key)) {
      continue;
    }
    if (typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "string" && SAFE_DETAIL_TOKEN.test(value)) {
      out[key] = value;
    }
    // Arrays, objects, null, NaN/Infinity, and any string with whitespace are
    // dropped: a free-text note or pasted memory content cannot ride along.
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const STATUS_VALUES: readonly MemoryStatus[] = [
  "proposed",
  "candidate",
  "active",
  "deprecated",
  "retired",
  "quarantined",
];

function statusOrUndefined(value: unknown): MemoryStatus | undefined {
  return typeof value === "string" && (STATUS_VALUES as readonly string[]).includes(value)
    ? (value as MemoryStatus)
    : undefined;
}

// ---------------------------------------------------------------------------
// Preconditions and vocabulary validation
// ---------------------------------------------------------------------------

function requireReasonCode(value: unknown): MemoryGovernanceReasonCode {
  if (
    typeof value !== "string" ||
    !(MEMORY_GOVERNANCE_REASON_CODES as readonly string[]).includes(value)
  ) {
    throw new ValidationError(
      `reason_code must be one of ${MEMORY_GOVERNANCE_REASON_CODES.join(", ")}; free-text reasons are not accepted`,
    );
  }
  return value as MemoryGovernanceReasonCode;
}

function requirePositiveVersion(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return value;
}

/** owner/admin govern the workspace; a team leader governs their own teams. */
function mayGovern(role: WorkspaceRole, ledTeamIds: readonly string[], teamId?: string): boolean {
  if (role === "owner" || role === "admin") {
    return true;
  }
  if (teamId === undefined || teamId.length === 0) {
    return false;
  }
  return ledTeamIds.includes(teamId);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Timeline pagination
// ---------------------------------------------------------------------------

/** Default and maximum page size of the merged audit timeline. */
export const MEMORY_TIMELINE_DEFAULT_LIMIT = 50;
export const MEMORY_TIMELINE_MAX_LIMIT = 200;

/** Rows read per source per merge refill; bounded independently of the page. */
const TIMELINE_CHUNK = 100;

type TimelineStreamSource = MemoryItemEventView["source"];

/** Stable source order for events that share an instant. */
const timelineSourceOrder: Record<TimelineStreamSource, number> = {
  memory_event: 0,
  promotion_decision: 1,
  consolidation_op: 2,
};

interface TimelineRow {
  at: string;
  /** SQLite rowid within the source stream; breaks timestamp/action ties. */
  sequence: number;
  /** False when the row is about a version above the caller's ceiling. */
  visible: boolean;
  view: MemoryItemEventView;
}

interface TimelineStream {
  source: TimelineStreamSource;
  rank: number;
  rows: TimelineRow[];
  index: number;
  done: boolean;
  /** Last consumed row; the exclusive resume point for the next read. */
  position: MemoryTimelinePosition | undefined;
  fetch: (after: MemoryTimelinePosition | undefined, limit: number) => TimelineRow[];
}

type TimelineCursor = Partial<Record<TimelineStreamSource, MemoryTimelinePosition>>;

const TIMELINE_CURSOR_KEY: Record<TimelineStreamSource, string> = {
  memory_event: "e",
  promotion_decision: "p",
  consolidation_op: "c",
};

function timelineLimit(value: number | undefined): number {
  if (value === undefined) {
    return MEMORY_TIMELINE_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(value) || value < 1 || value > MEMORY_TIMELINE_MAX_LIMIT) {
    throw new ValidationError(
      `limit must be an integer between 1 and ${MEMORY_TIMELINE_MAX_LIMIT}`,
    );
  }
  return value;
}

function decodeTimelineCursor(cursor: string | undefined): TimelineCursor {
  if (cursor === undefined || cursor.length === 0) {
    return {};
  }
  if (cursor.length > 512) {
    throw new ValidationError("cursor is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ValidationError("cursor is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("cursor is invalid");
  }
  const source = parsed as Record<string, unknown>;
  const decoded: TimelineCursor = {};
  for (const [streamSource, key] of Object.entries(TIMELINE_CURSOR_KEY) as Array<
    [TimelineStreamSource, string]
  >) {
    const value = source[key];
    if (value === undefined) {
      continue;
    }
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      value[0].length === 0 ||
      value[0].length > 64 ||
      typeof value[1] !== "number" ||
      !Number.isInteger(value[1]) ||
      value[1] < 0
    ) {
      throw new ValidationError("cursor is invalid");
    }
    decoded[streamSource] = { at: value[0], sequence: value[1] };
  }
  if (Object.keys(decoded).length === 0) {
    throw new ValidationError("cursor is invalid");
  }
  return decoded;
}

function encodeTimelineCursor(streams: readonly TimelineStream[]): string | null {
  const encoded: Record<string, [string, number]> = {};
  for (const stream of streams) {
    if (stream.position === undefined) {
      continue;
    }
    encoded[TIMELINE_CURSOR_KEY[stream.source]] = [stream.position.at, stream.position.sequence];
  }
  if (Object.keys(encoded).length === 0) {
    return null;
  }
  return Buffer.from(JSON.stringify(encoded), "utf8").toString("base64url");
}

/** Refill the stream from storage when its buffer is exhausted. */
function peekTimelineRow(stream: TimelineStream): TimelineRow | undefined {
  while (stream.index >= stream.rows.length) {
    if (stream.done) {
      return undefined;
    }
    const fetched = stream.fetch(stream.position, TIMELINE_CHUNK);
    stream.rows = fetched;
    stream.index = 0;
    if (fetched.length < TIMELINE_CHUNK) {
      stream.done = true;
    }
    if (fetched.length === 0) {
      return undefined;
    }
  }
  return stream.rows[stream.index];
}

function consumeTimelineRow(stream: TimelineStream): void {
  const row = stream.rows[stream.index];
  if (row === undefined) {
    return;
  }
  stream.position = { at: row.at, sequence: row.sequence };
  stream.index += 1;
}

function compareTimelineRows(
  left: { stream: TimelineStream; row: TimelineRow },
  right: { stream: TimelineStream; row: TimelineRow },
): number {
  if (left.row.at !== right.row.at) {
    return left.row.at < right.row.at ? -1 : 1;
  }
  if (left.stream.rank !== right.stream.rank) {
    return left.stream.rank - right.stream.rank;
  }
  if (left.row.view.action !== right.row.view.action) {
    return left.row.view.action < right.row.view.action ? -1 : 1;
  }
  return left.row.sequence - right.row.sequence;
}

/** The smallest unconsumed row across the three streams. */
function pickTimelineHead(
  streams: readonly TimelineStream[],
): { stream: TimelineStream; row: TimelineRow } | undefined {
  let best: { stream: TimelineStream; row: TimelineRow } | undefined;
  for (const stream of streams) {
    const row = peekTimelineRow(stream);
    if (row === undefined) {
      continue;
    }
    const candidate = { stream, row };
    if (best === undefined || compareTimelineRows(candidate, best) < 0) {
      best = candidate;
    }
  }
  return best;
}

class SqliteMemoryGovernanceService implements MemoryGovernanceService {
  constructor(private readonly deps: MemoryGovernanceServiceDeps) {}

  getItem(scope: WorkspaceScope, role: WorkspaceRole, itemId: string): MemoryItemView {
    // Reuses the browse view and its ceiling so detail and list can never
    // disagree about what a role may see.
    return this.deps.retrieval.getItem(scope, role, itemId);
  }

  versions(scope: WorkspaceScope, role: WorkspaceRole, itemId: string): MemoryItemVersionsView {
    const record = this.visibleRecord(scope, role, itemId);
    const all = this.deps.memory.items.listVersions(scope, record.item.id);
    const versions = all
      // Every historical row carries its own data class: a restricted v1 stays
      // hidden even when v2 is internal.
      .filter((version) => withinSensitivityCeiling(version.sensitivity, role))
      .map((version) => this.versionView(record.item.status, version));
    return {
      schema_version: MEMORY_SCHEMA_VERSION,
      item_id: record.item.id,
      status: record.item.status,
      current_version: record.item.current_version,
      versions,
    };
  }

  events(
    scope: WorkspaceScope,
    role: WorkspaceRole,
    itemId: string,
    query: MemoryItemEventsQuery = {},
  ): MemoryItemEventsView {
    const record = this.visibleRecord(scope, role, itemId);
    const limit = timelineLimit(query.limit);
    const cursor = decodeTimelineCursor(query.cursor);
    const allVersions = this.deps.memory.items.listVersions(scope, record.item.id);
    const versionSensitivity = new Map<number, MemoryItemVersion>(
      allVersions.map((version) => [version.version, version]),
    );

    // An event about a version the role cannot read is itself hidden, so
    // version history cannot be enumerated through the timeline.
    const visibleVersion = (itemVersion: number | null): boolean => {
      if (itemVersion === null) {
        return true;
      }
      const version = versionSensitivity.get(itemVersion);
      return version !== undefined && withinSensitivityCeiling(version.sensitivity, role);
    };

    const streams: TimelineStream[] = [
      {
        source: "memory_event",
        rank: timelineSourceOrder.memory_event,
        rows: [],
        index: 0,
        done: false,
        position: cursor.memory_event,
        fetch: (after, count) =>
          this.deps.memory.audit
            .listTimelinePage(scope, record.item.id, after, count)
            .map((entry) => this.memoryEventRow(entry.event, entry.sequence, visibleVersion)),
      },
      {
        source: "promotion_decision",
        rank: timelineSourceOrder.promotion_decision,
        rows: [],
        index: 0,
        done: false,
        position: cursor.promotion_decision,
        fetch: (after, count) =>
          this.deps.lifecycle
            .listPromotionDecisionsPage(scope, record.item.id, after, count)
            .map((entry) =>
              this.promotionDecisionRow(entry.decision, entry.sequence, visibleVersion),
            ),
      },
      {
        source: "consolidation_op",
        rank: timelineSourceOrder.consolidation_op,
        rows: [],
        index: 0,
        done: false,
        position: cursor.consolidation_op,
        fetch: (after, count) =>
          this.deps.lifecycle
            .listConsolidationOpsForItem(scope, record.item.id, after, count)
            .map((entry) => this.consolidationOpRow(entry.op, entry.sequence, visibleVersion)),
      },
    ];

    // Merge the three ordered streams. A row the caller may not see still
    // advances that stream's position, so it is never re-read and never stalls
    // traversal — it simply never reaches the response.
    const events: MemoryItemEventView[] = [];
    while (events.length < limit) {
      const best = pickTimelineHead(streams);
      if (best === undefined) {
        break;
      }
      consumeTimelineRow(best.stream);
      if (best.row.visible) {
        events.push(best.row.view);
      }
    }

    // A bounded page is not a complete history: when more rows remain, the
    // caller receives a cursor for the rest.
    const more = streams.some((stream) => peekTimelineRow(stream) !== undefined);
    const next_cursor = events.length === limit && more ? encodeTimelineCursor(streams) : null;
    return { item_id: record.item.id, events, next_cursor };
  }

  private memoryEventRow(
    event: MemoryEvent,
    sequence: number,
    visibleVersion: (itemVersion: number | null) => boolean,
  ): TimelineRow {
    const detail = sanitizedDetail(event.detail);
    const from = statusOrUndefined(detail?.["from"]);
    const to = statusOrUndefined(detail?.["to"]);
    const reason = typeof detail?.["reason_code"] === "string" ? detail["reason_code"] : undefined;
    return {
      at: event.created_at,
      sequence,
      visible: visibleVersion(event.item_version),
      view: {
        at: event.created_at,
        source: "memory_event",
        action: event.event_type,
        actor: { type: "user", id: event.actor_id },
        item_version: event.item_version,
        ...(from !== undefined ? { from_status: from } : {}),
        ...(to !== undefined ? { to_status: to } : {}),
        ...(reason !== undefined ? { reason_code: reason } : {}),
        ...(detail !== undefined ? { detail } : {}),
      },
    };
  }

  private promotionDecisionRow(
    decision: PromotionDecisionRecord,
    sequence: number,
    visibleVersion: (itemVersion: number | null) => boolean,
  ): TimelineRow {
    return {
      at: decision.created_at,
      sequence,
      visible: visibleVersion(decision.item_version),
      view: {
        at: decision.created_at,
        source: "promotion_decision",
        action: "promotion_decision",
        actor: { type: "user", id: decision.created_by },
        item_version: decision.item_version,
        ...(decision.outcome === "promoted" ? { to_status: "active" as MemoryStatus } : {}),
        ...(decision.reasons.length > 0 ? { reason_code: decision.reasons[0] } : {}),
        detail: {
          outcome: decision.outcome,
          reasons: decision.reasons.join(","),
          independent_support_runs: decision.independent_support_runs,
          ...(decision.evaluation_delta !== null
            ? { evaluation_delta: decision.evaluation_delta }
            : {}),
        },
      },
    };
  }

  private consolidationOpRow(
    op: ConsolidationOpRecordWithTime,
    sequence: number,
    visibleVersion: (itemVersion: number | null) => boolean,
  ): TimelineRow {
    return {
      at: op.created_at,
      sequence,
      visible: visibleVersion(op.item_version),
      view: {
        at: op.created_at,
        source: "consolidation_op",
        action: op.op,
        // Consolidation is the scheduled job's act, not a person's.
        actor: { type: "system", id: op.created_by },
        item_version: op.item_version,
        reason_code: op.reason_code,
        detail: {
          applied: op.applied,
          run_id: op.run_id,
          ...(op.target_item_id !== null ? { target_item_id: op.target_item_id } : {}),
          ...op.detail,
        },
      },
    };
  }

  promote(
    scope: WorkspaceScope,
    actor: MemoryGovernanceActor,
    itemId: string,
    input: PromoteMemoryItemRequest,
  ): MemoryGovernanceResult {
    const record = this.writableRecord(scope, actor, itemId, input);
    if (record.item.status !== "candidate") {
      throw new InvalidTransitionError(
        `promote only accepts candidate -> active; this item is ${record.item.status}`,
        { from_status: record.item.status, action: "promote" },
      );
    }
    // Institutional policy is human-authored (ADR-0009); a stored policy that
    // is not cannot be activated by any governance action.
    if (record.current.kind === "policy" && record.current.provenance.author_type !== "human") {
      throw new InvalidTransitionError("policy memory must be human-authored before promotion", {
        action: "promote",
        kind: "policy",
      });
    }
    // An active item needs evidence at all; the storage layer enforces it too,
    // but failing here names the precondition instead of a generic 400.
    if (this.deps.memory.evidence.listByItem(scope, record.item.id).length === 0) {
      throw new PreconditionFailedError(
        "an active memory item requires at least one evidence reference",
        { action: "promote", item_id: record.item.id },
      );
    }
    const promoted = approveAndPromote(scope, this.deps, {
      itemId: record.item.id,
      version: input.version,
      reasonCode: "human_approved",
    });
    return this.result(scope, actor.role, record.item.id, {
      action: "promote",
      from_status: record.item.status,
      to_status: promoted.item.status,
      item_version: input.version,
      reason_code: "human_approved",
    });
  }

  deprecate(
    scope: WorkspaceScope,
    actor: MemoryGovernanceActor,
    itemId: string,
    input: DeprecateMemoryItemRequest,
  ): MemoryGovernanceResult {
    const record = this.writableRecord(scope, actor, itemId, input);
    const reason = requireReasonCode(input.reason_code);
    if (record.item.status !== "active" && record.item.status !== "candidate") {
      throw new InvalidTransitionError(
        `deprecate only accepts active|candidate -> deprecated; this item is ${record.item.status}`,
        { from_status: record.item.status, action: "deprecate" },
      );
    }
    this.deps.memory.items.setStatus(scope, record.item.id, "deprecated", input.version, {
      reason_code: reason,
    });
    return this.result(scope, actor.role, record.item.id, {
      action: "deprecate",
      from_status: record.item.status,
      to_status: "deprecated",
      item_version: input.version,
      reason_code: reason,
    });
  }

  quarantine(
    scope: WorkspaceScope,
    actor: MemoryGovernanceActor,
    itemId: string,
    input: QuarantineMemoryItemRequest,
  ): MemoryGovernanceResult {
    const record = this.writableRecord(scope, actor, itemId, input);
    const reason = requireReasonCode(input.reason_code);
    if (record.item.status === "retired" || record.item.status === "quarantined") {
      throw new InvalidTransitionError(
        `quarantine accepts any non-terminal state; this item is ${record.item.status}`,
        { from_status: record.item.status, action: "quarantine" },
      );
    }
    this.deps.memory.items.setStatus(scope, record.item.id, "quarantined", input.version, {
      reason_code: reason,
    });
    return this.result(scope, actor.role, record.item.id, {
      action: "quarantine",
      from_status: record.item.status,
      to_status: "quarantined",
      item_version: input.version,
      reason_code: reason,
    });
  }

  restore(
    scope: WorkspaceScope,
    actor: MemoryGovernanceActor,
    itemId: string,
    input: RestoreMemoryItemRequest,
  ): MemoryGovernanceResult {
    const record = this.writableRecord(scope, actor, itemId, input);
    const reason = requireReasonCode(input.reason_code);
    if (
      typeof input.target_status !== "string" ||
      !(MEMORY_RESTORE_TARGET_STATUSES as readonly string[]).includes(input.target_status)
    ) {
      throw new ValidationError(
        `target_status must be one of ${MEMORY_RESTORE_TARGET_STATUSES.join(", ")}; ` +
          "restoring to active must go through promote",
      );
    }
    if (record.item.status !== "quarantined") {
      throw new InvalidTransitionError(
        `restore only accepts quarantined items; this item is ${record.item.status}`,
        { from_status: record.item.status, action: "restore" },
      );
    }
    this.deps.memory.items.setStatus(scope, record.item.id, input.target_status, input.version, {
      reason_code: reason,
    });
    return this.result(scope, actor.role, record.item.id, {
      action: "restore",
      from_status: record.item.status,
      to_status: input.target_status,
      item_version: input.version,
      reason_code: reason,
    });
  }

  // -------------------------------------------------------------------------
  // Shared guards
  // -------------------------------------------------------------------------

  /**
   * The record a reader may see: same workspace (the repository is scoped),
   * and the *current* version within the role's ceiling. A restricted item is
   * never manageable here, so it answers like a missing one.
   */
  private visibleRecord(
    scope: WorkspaceScope,
    role: WorkspaceRole,
    itemId: string,
  ): MemoryItemRecord {
    if (typeof itemId !== "string" || itemId.length === 0) {
      throw new ValidationError("item_id is required");
    }
    const record = this.deps.memory.items.getById(scope, itemId);
    if (record === undefined || !withinSensitivityCeiling(record.current.sensitivity, role)) {
      throw new NotFoundError("MemoryItem", itemId);
    }
    return record;
  }

  /**
   * The record a governance actor may act on: visible, and within their
   * authority. Both checks are performed before any transition validation so a
   * caller without authority learns nothing about the item's state.
   */
  private writableRecord(
    scope: WorkspaceScope,
    actor: MemoryGovernanceActor,
    itemId: string,
    input: { version: number; expected_version: number },
  ): MemoryItemRecord {
    const record = this.visibleRecord(scope, actor.role, itemId);
    const ledTeamIds =
      actor.role === "owner" || actor.role === "admin"
        ? []
        : (this.deps.teams?.list(scope) ?? [])
            .filter((team) => team.leader_user_id === actor.user_id)
            .map((team) => team.id);
    if (!mayGovern(actor.role, ledTeamIds, record.current.scope.team_id)) {
      // Forbidden, not missing: the item is visible, the actor lacks standing.
      throw new ForbiddenError(
        "governing workspace memory requires the owner/admin role, or leadership of the item's team",
      );
    }
    const version = requirePositiveVersion(input.version, "version");
    const expected = requirePositiveVersion(input.expected_version, "expected_version");
    if (expected !== record.item.current_version || version !== record.item.current_version) {
      throw new VersionConflictError(
        "MemoryItem",
        record.item.id,
        expected,
        record.item.current_version,
      );
    }
    return record;
  }

  private versionView(status: MemoryStatus, version: MemoryItemVersion): MemoryItemVersionView {
    const served = servedStatement(status, version.statement);
    return {
      version: version.version,
      kind: version.kind,
      tier: tierOf(version.kind),
      statement: served.statement,
      statement_redacted: served.statement_redacted,
      preconditions: servedPreconditions(status, version.preconditions),
      applicability: { ...version.scope },
      trust: version.trust,
      sensitivity: version.sensitivity,
      valid_from: version.valid_from,
      valid_to: version.valid_to,
      content_hash: version.content_hash,
      provenance: { ...version.provenance },
      review: version.review === null ? null : { ...version.review },
      created_at: version.created_at,
      created_by: version.created_by,
    };
  }

  private result(
    scope: WorkspaceScope,
    role: WorkspaceRole,
    itemId: string,
    outcome: {
      action: MemoryGovernanceAction;
      from_status: MemoryStatus;
      to_status: MemoryStatus;
      item_version: number;
      reason_code: MemoryGovernanceReasonCode | "human_approved" | null;
    },
  ): MemoryGovernanceResult {
    return {
      ...outcome,
      item_id: itemId,
      // Same view and ceiling as browse: a transition never returns more than
      // the actor could already read.
      item: this.deps.retrieval.getItem(scope, role, itemId),
    };
  }
}

export function createMemoryGovernanceService(
  deps: MemoryGovernanceServiceDeps,
): MemoryGovernanceService {
  return new SqliteMemoryGovernanceService(deps);
}
