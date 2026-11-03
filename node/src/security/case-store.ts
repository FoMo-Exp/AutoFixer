/**
 * Durable, append-only security disposal case store (DAT-210, ADR-0005 §2).
 *
 * Blocking a gateway invocation on uncertain secret material associates it
 * with exactly one open case per enterprise/workspace/issue/run scope —
 * duplicate blocking is idempotent by invocation id — and every state
 * transition appends to a history that is never rewritten. Optional JSON
 * persistence uses the same atomic tmp-and-rename write as the other stores.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scrubSecrets } from "../gateway/redact.js";
import {
  SecurityError,
  canTransitionCase,
  isHumanOrService,
  isRunItself,
  isTerminalCaseState,
  requireNonEmpty,
} from "./types.js";
import type {
  BlockAssociation,
  BlockIdentity,
  CaseEvent,
  CaseEventType,
  CaseScope,
  CaseState,
  SecurityActor,
  SecurityCase,
} from "./types.js";

export interface OpenBlockInput {
  identity: BlockIdentity;
  /** Redacted machine reason (e.g. `SENSITIVE_DATA_UNCERTAIN`). */
  reason: string;
  /** Content-free handler summary; scrubbed at intake. */
  safeDetail?: string;
  actor: SecurityActor;
}

export interface CaseStoreOptions {
  /** JSON state file; every mutation persists atomically when set. */
  persistencePath?: string;
  now?: () => Date;
  newCaseId?: () => string;
}

export interface OpenBlockResult {
  case: SecurityCase;
  /** True when this block opened a new case; false when it joined an open one. */
  created: boolean;
  /**
   * True when this exact invocation id was already recorded on the case:
   * the call was a pure idempotent replay. A different invocation joining
   * the same open case is NOT a duplicate — it records its own block.
   */
  duplicate: boolean;
}

const SCHEMA_VERSION = 1;

interface PersistedState {
  schema_version: number;
  cases: SecurityCase[];
  events: CaseEvent[];
}

function scopeKey(scope: CaseScope): string {
  return [scope.enterpriseId, scope.workspaceId, scope.issueId, scope.runId].join(" ");
}

function scrubDetail(
  detail: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(detail)) {
    out[key] = typeof value === "string" ? scrubSecrets(value) : value;
  }
  return out;
}

/**
 * The case store. Holds one open case per affected run scope, an append-only
 * per-case event history, and nothing that is secret: block text is scrubbed
 * at intake and events carry identifiers, codes, and enum words only.
 */
export class SecurityCaseStore {
  private readonly cases = new Map<string, SecurityCase>();
  private readonly history = new Map<string, CaseEvent[]>();
  private readonly openByScope = new Map<string, string>();
  private readonly persistencePath: string | undefined;
  private readonly now: () => Date;
  private readonly newCaseId: () => string;

  constructor(options: CaseStoreOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.now = options.now ?? (() => new Date());
    this.newCaseId = options.newCaseId ?? (() => randomUUID());
    this.load();
  }

  /**
   * Associate one blocked invocation with the scope's open case, opening a
   * new case when none is open. Repeating the same invocation id is a no-op
   * beyond returning the same case — duplicate blocking never duplicates
   * history. A terminal case is never reopened; a later block opens a new one.
   */
  openForBlock(input: OpenBlockInput): OpenBlockResult {
    const identity = input.identity;
    requireNonEmpty(identity.enterpriseId, "identity.enterpriseId");
    requireNonEmpty(identity.workspaceId, "identity.workspaceId");
    requireNonEmpty(identity.issueId, "identity.issueId");
    requireNonEmpty(identity.runId, "identity.runId");
    requireNonEmpty(identity.invocationId, "identity.invocationId");
    requireNonEmpty(identity.traceId, "identity.traceId");
    this.assertActor(identity, input.actor);
    const reason = scrubSecrets(requireNonEmpty(input.reason, "reason"));
    const safeDetail = scrubSecrets(input.safeDetail ?? "");

    const scope: CaseScope = {
      enterpriseId: identity.enterpriseId,
      workspaceId: identity.workspaceId,
      issueId: identity.issueId,
      runId: identity.runId,
    };
    const existingId = this.openByScope.get(scopeKey(scope));
    const existing = existingId ? this.cases.get(existingId) : undefined;
    // A terminal case is final: it never absorbs a later block.
    if (existing && !isTerminalCaseState(existing.state)) {
      if (existing.blocks.some((block) => block.invocationId === identity.invocationId)) {
        return { case: existing, created: false, duplicate: true };
      }
      existing.blocks.push(this.blockOf(identity, reason, safeDetail));
      existing.updatedAt = this.timestamp();
      this.appendEvent(existing.caseId, "block.recorded", input.actor, {
        invocationId: identity.invocationId,
        traceId: identity.traceId,
        reason,
      });
      return { case: existing, created: false, duplicate: false };
    }

    const opened: SecurityCase = {
      caseId: this.newCaseId(),
      scope,
      state: "pending",
      createdAt: this.timestamp(),
      updatedAt: this.timestamp(),
      blocks: [this.blockOf(identity, reason, safeDetail)],
      quarantineIds: [],
    };
    this.cases.set(opened.caseId, opened);
    this.openByScope.set(scopeKey(scope), opened.caseId);
    this.appendEvent(opened.caseId, "case.opened", input.actor, {
      enterpriseId: scope.enterpriseId,
      workspaceId: scope.workspaceId,
      issueId: scope.issueId,
      runId: scope.runId,
      reason,
    });
    this.appendEvent(opened.caseId, "block.recorded", input.actor, {
      invocationId: identity.invocationId,
      traceId: identity.traceId,
      reason,
    });
    return { case: opened, created: true, duplicate: false };
  }

  /**
   * Append one case-state transition. Valid edges only (a failed review goes
   * back to `handling`), human/service actors only — a run never dispositions
   * its own case — and the history keeps every step.
   *
   * Separation of duties (DAT-211): the edges leaving `awaiting_review` are
   * review decisions, so the acting principal is the reviewer. The store
   * rejects — before any state change — a review by the handler who submitted
   * the case (`SOD_SELF_REVIEW_FORBIDDEN`), a review by any other handling
   * principal of the case (`SOD_SAME_PRINCIPAL_FORBIDDEN`), a non-human
   * reviewer (`SOD_HUMAN_PRINCIPAL_REQUIRED`), and a case with no handling
   * principal of record (`SOD_INDEPENDENT_REVIEWER_REQUIRED`). Every review
   * decision appends its own event carrying the independent-review
   * relationship.
   */
  transition(caseId: string, to: CaseState, actor: SecurityActor): SecurityCase {
    const record = this.requireCase(caseId);
    this.assertActor(record.scope, actor);
    if (!canTransitionCase(record.state, to)) {
      throw new SecurityError(
        "CASE_TRANSITION_FORBIDDEN",
        `case ${caseId} cannot move from ${record.state} to ${to}`,
        { caseId, from: record.state, to },
      );
    }
    const from = record.state;
    // Review decisions are exactly the two review edges out of
    // `awaiting_review`; terminating a case is disposition work, not review.
    const reviewEdge = from === "awaiting_review" && (to === "resolved" || to === "handling");
    const subjects = reviewEdge ? this.handlingPrincipals(caseId) : [];
    const submitter = reviewEdge ? this.submittedBy(caseId) : undefined;
    if (reviewEdge) {
      try {
        this.assertIndependentReviewer(caseId, actor, subjects, submitter);
      } catch (error) {
        // A denied review attempt is part of the audit trail: the rejection
        // is a review result, and the history records it before it throws.
        this.appendEvent(caseId, "case.review_denied", actor, {
          code: error instanceof SecurityError ? error.code : "SOD_REVIEW_DENIED",
          subjects: subjects.join(","),
        });
        throw error;
      }
    }
    record.state = to;
    record.updatedAt = this.timestamp();
    this.appendEvent(caseId, "case.state_changed", actor, { from, to });
    if (reviewEdge) {
      this.appendEvent(
        caseId,
        to === "resolved" ? "case.review_approved" : "case.review_rejected",
        actor,
        { reviewer: actor.actorId, subjects: subjects.join(",") },
      );
    }
    return record;
  }

  /**
   * Every principal that handled or submitted the case, derived from the
   * append-only history. A failed review (`awaiting_review → handling`) is a
   * reviewer action, not handling: the reviewer never joins the set they must
   * stay independent of.
   */
  handlingPrincipals(caseId: string): string[] {
    const subjects: string[] = [];
    for (const event of this.events(caseId)) {
      if (event.type !== "case.state_changed" || !event.actor) continue;
      const to = event.detail["to"];
      const from = event.detail["from"];
      const handling =
        to === "awaiting_review" || (to === "handling" && from !== "awaiting_review");
      if (handling && !subjects.includes(event.actor.actorId)) {
        subjects.push(event.actor.actorId);
      }
    }
    return subjects;
  }

  /** The handler of record for the current review round (last submitter). */
  submittedBy(caseId: string): string | undefined {
    let submitter: string | undefined;
    for (const event of this.events(caseId)) {
      if (event.type === "case.state_changed" && event.detail["to"] === "awaiting_review") {
        submitter = event.actor?.actorId;
      }
    }
    return submitter;
  }

  /** Link a quarantine record to its case (idempotent by quarantine id). */
  addQuarantine(caseId: string, quarantineId: string): void {
    const record = this.requireCase(caseId);
    requireNonEmpty(quarantineId, "quarantineId");
    if (!record.quarantineIds.includes(quarantineId)) {
      record.quarantineIds.push(quarantineId);
      record.updatedAt = this.timestamp();
    }
  }

  /**
   * Append one non-secret history event. String values are scrubbed as a
   * second line of defense; the history only ever grows.
   */
  appendEvent(
    caseId: string,
    type: CaseEventType,
    actor: SecurityActor | null,
    detail: Record<string, string | number | boolean>,
  ): CaseEvent {
    const history = this.history.get(caseId) ?? [];
    const event: CaseEvent = {
      seq: history.length + 1,
      caseId,
      type,
      at: this.timestamp(),
      actor,
      detail: scrubDetail(detail),
    };
    history.push(event);
    this.history.set(caseId, history);
    this.persist();
    return event;
  }

  get(caseId: string): SecurityCase | undefined {
    return this.cases.get(caseId);
  }

  events(caseId: string): readonly CaseEvent[] {
    // A copy: callers snapshot history that later appends never mutate.
    return [...(this.history.get(caseId) ?? [])];
  }

  /** The scope's open (non-terminal) case, if any. */
  findOpen(scope: CaseScope): SecurityCase | undefined {
    const caseId = this.openByScope.get(scopeKey(scope));
    const record = caseId ? this.cases.get(caseId) : undefined;
    return record && !isTerminalCaseState(record.state) ? record : undefined;
  }

  private blockOf(identity: BlockIdentity, reason: string, safeDetail: string): BlockAssociation {
    return {
      invocationId: identity.invocationId,
      traceId: identity.traceId,
      reason,
      safeDetail,
      at: this.timestamp(),
    };
  }

  private requireCase(caseId: string): SecurityCase {
    const record = this.cases.get(caseId);
    if (!record) {
      throw new SecurityError("CASE_NOT_FOUND", `no security case ${caseId}`, { caseId });
    }
    return record;
  }

  /** Case actions are human/service actions; the affected run never acts. */
  private assertActor(scope: CaseScope, actor: SecurityActor): void {
    if (!actor || typeof actor.actorId !== "string" || actor.actorId.length === 0) {
      throw new SecurityError("SECURITY_INPUT_INVALID", "actor must carry a non-empty actorId");
    }
    // Exactly human or service: an unrecognized actorKind is refused here,
    // before any state change, and never defaulted into authority (DAT-210).
    if (!isHumanOrService(actor)) {
      throw new SecurityError(
        "CASE_ACTOR_FORBIDDEN",
        "case actions are restricted to human or service actors",
        { runId: scope.runId },
      );
    }
    if (isRunItself(actor, scope)) {
      throw new SecurityError(
        "CASE_ACTOR_FORBIDDEN",
        "the affected run never handles or resumes its own security case",
        { runId: scope.runId },
      );
    }
  }

  /** Structural separation of duties on the review edges (DAT-211). */
  private assertIndependentReviewer(
    caseId: string,
    actor: SecurityActor,
    subjects: readonly string[],
    submitter: string | undefined,
  ): void {
    if (actor.actorKind !== "human") {
      throw new SecurityError(
        "SOD_HUMAN_PRINCIPAL_REQUIRED",
        "an independent reviewer must be a different human principal",
        { caseId },
      );
    }
    if (subjects.length === 0 || submitter === undefined) {
      throw new SecurityError(
        "SOD_INDEPENDENT_REVIEWER_REQUIRED",
        "a case without a handling principal of record cannot be reviewed",
        { caseId },
      );
    }
    if (actor.actorId === submitter) {
      throw new SecurityError(
        "SOD_SELF_REVIEW_FORBIDDEN",
        "the handler who submitted a case never approves their own disposition",
        { caseId },
      );
    }
    if (subjects.includes(actor.actorId)) {
      throw new SecurityError(
        "SOD_SAME_PRINCIPAL_FORBIDDEN",
        "a review must come from a principal outside the case's handling principals",
        { caseId },
      );
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private load(): void {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.persistencePath, "utf8"));
    } catch {
      throw new SecurityError("CASE_STORE_INVALID", "case state file is not valid JSON");
    }
    const state = parsed as Partial<PersistedState>;
    if (
      state.schema_version !== SCHEMA_VERSION ||
      !Array.isArray(state.cases) ||
      !Array.isArray(state.events)
    ) {
      throw new SecurityError("CASE_STORE_INVALID", "case state file has an unsupported shape");
    }
    for (const record of state.cases) {
      this.cases.set(record.caseId, record);
      if (!isTerminalCaseState(record.state)) {
        this.openByScope.set(scopeKey(record.scope), record.caseId);
      }
    }
    for (const event of state.events) {
      const history = this.history.get(event.caseId) ?? [];
      history.push(event);
      this.history.set(event.caseId, history);
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    const state: PersistedState = {
      schema_version: SCHEMA_VERSION,
      cases: [...this.cases.values()],
      events: [...this.history.values()].flat(),
    };
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.persistencePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.persistencePath);
  }
}
