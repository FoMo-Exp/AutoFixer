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
import type { MemoryItemRecord, MemoryItemVersion, MemoryStatus } from "../types.js";
import { MEMORY_SCHEMA_VERSION } from "../types.js";
import type { MemoryRepositories } from "../repositories.js";
import type { MemoryLifecycleStore } from "../lifecycle/repositories.js";
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
  events(scope: WorkspaceScope, role: WorkspaceRole, itemId: string): MemoryItemEventsView;
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

  events(scope: WorkspaceScope, role: WorkspaceRole, itemId: string): MemoryItemEventsView {
    const record = this.visibleRecord(scope, role, itemId);
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

    const events: MemoryItemEventView[] = [];
    for (const event of this.deps.memory.audit.list(scope, {
      item_id: record.item.id,
      limit: 500,
    })) {
      if (!visibleVersion(event.item_version)) {
        continue;
      }
      const detail = sanitizedDetail(event.detail);
      const from = statusOrUndefined(detail?.["from"]);
      const to = statusOrUndefined(detail?.["to"]);
      const reason =
        typeof detail?.["reason_code"] === "string" ? detail["reason_code"] : undefined;
      events.push({
        at: event.created_at,
        source: "memory_event",
        action: event.event_type,
        actor: { type: "user", id: event.actor_id },
        item_version: event.item_version,
        ...(from !== undefined ? { from_status: from } : {}),
        ...(to !== undefined ? { to_status: to } : {}),
        ...(reason !== undefined ? { reason_code: reason } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    }

    for (const decision of this.deps.lifecycle.listPromotionDecisions(scope, {
      item_id: record.item.id,
      limit: 500,
    })) {
      if (!visibleVersion(decision.item_version)) {
        continue;
      }
      events.push({
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
      });
    }

    for (const op of this.deps.lifecycle.listConsolidationOpsForItem(scope, record.item.id, 500)) {
      if (!visibleVersion(op.item_version)) {
        continue;
      }
      events.push({
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
      });
    }

    // Ascending: a timeline reads forward. Ties keep a stable source order.
    const sourceOrder: Record<MemoryItemEventView["source"], number> = {
      memory_event: 0,
      promotion_decision: 1,
      consolidation_op: 2,
    };
    events.sort((left, right) => {
      if (left.at !== right.at) {
        return left.at.localeCompare(right.at);
      }
      const bySource = sourceOrder[left.source] - sourceOrder[right.source];
      if (bySource !== 0) {
        return bySource;
      }
      return left.action.localeCompare(right.action);
    });

    return { item_id: record.item.id, events };
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
