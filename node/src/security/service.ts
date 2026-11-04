/**
 * Security case service (DAT-210, ADR-0005 §2).
 *
 * The post-block intake and disposition entry point. `recordBlock` turns one
 * blocked gateway invocation into exactly the handling machinery ADR-0005 §2
 * requires: an idempotently associated scoped case, a precise pause of the
 * affected run's dependent work, encrypted quarantine for raw retained
 * context, and redacted notification to the designated handlers with
 * escalation. It never retries or replays the quarantined request — a later
 * recovery is DAT-212's full re-check of a freshly built request — and the
 * paused run is released only by human/service disposition, never by itself.
 */

import { scrubSecrets } from "../gateway/redact.js";
import type { SecurityCaseStore } from "./case-store.js";
import { requireDuty, requireScope } from "./duties.js";
import type { SecurityAction, SecurityDutyDirectory } from "./duties.js";
import { mintCaseReference } from "./notify.js";
import type { NotifyResult, SecurityNotifier } from "./notify.js";
import type { DependentWorkPauseLedger, RunPause } from "./pause.js";
import type { EncryptedQuarantine, QuarantineAccessGrant } from "./quarantine.js";
import { SecurityError, requireNonEmpty } from "./types.js";
import type { BlockIdentity, CaseState, SecurityActor, SecurityCase } from "./types.js";

/** The service itself acts on cases; runs never do. */
const SERVICE_ACTOR: SecurityActor = { actorId: "security-case-service", actorKind: "service" };

export interface RecordBlockInput {
  identity: BlockIdentity;
  /** Redacted machine reason (e.g. `SENSITIVE_DATA_UNCERTAIN`). */
  reason: string;
  /** Content-free handler summary; scrubbed at intake. */
  safeDetail?: string;
  /**
   * Raw blocked-request context to retain ("if needed", ADR-0005 §2). Sealed
   * into encrypted quarantine; never copied into events or notifications.
   */
  rawContent?: string;
}

export interface RecordBlockResult {
  case: SecurityCase;
  /** True when this block opened a new case; false when it joined an open one. */
  created: boolean;
  /** The affected run's dependent-work hold (existing one on duplicate blocks). */
  pause: RunPause;
  /** Notifications sent for this outcome; empty on duplicate blocks. */
  notifications: NotifyResult;
  /** Quarantine record for this block's raw content, when one was sealed. */
  quarantineId?: string;
  /** Audience-bound case reference for the blocked run; non-transferable. */
  runCaseReference: string;
}

/**
 * The gateway's post-block seam (structurally satisfied by this service):
 * map one blocked invocation onto its disposal case and hand back only
 * correlation identifiers plus the run's authenticated case reference.
 */
export interface SecurityCaseIntake {
  recordGatewayBlock(input: {
    identity: BlockIdentity;
    reason: string;
    safeDetail: string;
    rawContent?: string;
  }): Promise<{ caseId: string; caseReference: string }>;
}

export interface CaseServiceDeps {
  caseStore: SecurityCaseStore;
  pauses: DependentWorkPauseLedger;
  notifier: SecurityNotifier;
  quarantine: EncryptedQuarantine;
  /** Service secret for minting audience-bound case references. */
  referenceSecret: Buffer;
  /** ADR-0006 seam behind the duty matrix (DAT-211). */
  duties: SecurityDutyDirectory;
  onIncident?: (message: string) => void;
}

/**
 * Which matrix action each case-state edge requires (DAT-211, ADR-0005 §3).
 * Handling and submission are handler work, review edges are reviewer work,
 * and termination is handler/administrator work — never the paused run.
 */
const TRANSITION_ACTIONS: Record<string, SecurityAction> = {
  "pending>handling": "case.handle",
  "handling>awaiting_review": "case.submit_for_review",
  "awaiting_review>resolved": "case.review_decide",
  "awaiting_review>handling": "case.review_decide",
  "pending>terminated": "case.terminate",
  "handling>terminated": "case.terminate",
  "awaiting_review>terminated": "case.terminate",
};

export class SecurityCaseService implements SecurityCaseIntake {
  private readonly deps: CaseServiceDeps;

  constructor(deps: CaseServiceDeps) {
    this.deps = deps;
  }

  /**
   * Post-block intake. One case and one pause per affected run scope, one
   * notification per case; a replay of an already-recorded invocation is a
   * pure no-op, while a newly blocked invocation — including one joining an
   * open case — always quarantines its own raw request. Failure of quarantine
   * or notification never reopens the block — the denial stands — but is
   * recorded and raised as an incident.
   */
  async recordBlock(input: RecordBlockInput): Promise<RecordBlockResult> {
    const identity = input.identity;
    const {
      case: caseRecord,
      created,
      duplicate,
    } = this.deps.caseStore.openForBlock({
      identity,
      reason: input.reason,
      ...(input.safeDetail !== undefined ? { safeDetail: input.safeDetail } : {}),
      actor: SERVICE_ACTOR,
    });
    const runCaseReference = mintCaseReference(
      this.deps.referenceSecret,
      caseRecord.caseId,
      `run:${identity.runId}`,
    );
    const existingPause = this.deps.pauses.pauseFor(identity.runId);
    const pause =
      existingPause ??
      this.deps.pauses.pauseDependentWork(caseRecord.caseId, caseRecord.scope, input.reason);
    if (duplicate) {
      // A pure replay of an already-recorded block: nothing new is
      // quarantined, notified, or appended — true idempotency.
      return {
        case: caseRecord,
        created,
        pause,
        notifications: { notifications: [], escalated: false, undeliverable: false },
        runCaseReference,
      };
    }
    if (created) {
      // Precise pause: only the affected run's dependent work is held.
      this.deps.caseStore.appendEvent(
        caseRecord.caseId,
        "run.dependent_work_paused",
        SERVICE_ACTOR,
        {
          pauseId: pause.pauseId,
          runId: identity.runId,
        },
      );
    }

    // Every newly blocked request is sealed into quarantine — including a
    // later invocation joining an already-open case. Each blocked request's
    // raw context is retained encrypted or not at all; never silently dropped.
    let quarantineId: string | undefined;
    if (input.rawContent !== undefined) {
      const sealed = this.deps.quarantine.seal(caseRecord.caseId, input.rawContent);
      if ("quarantineId" in sealed) {
        quarantineId = sealed.quarantineId;
        this.deps.caseStore.addQuarantine(caseRecord.caseId, sealed.quarantineId);
        this.deps.caseStore.appendEvent(caseRecord.caseId, "quarantine.sealed", SERVICE_ACTOR, {
          quarantineId: sealed.quarantineId,
          expiresAt: sealed.expiresAt,
        });
      } else {
        // Fail closed on retention: nothing is stored unencrypted. The block,
        // case, and pause stand unchanged.
        this.deps.caseStore.appendEvent(
          caseRecord.caseId,
          "quarantine.seal_failed",
          SERVICE_ACTOR,
          { detail: sealed.detail },
        );
        this.incident(`quarantine seal failed closed for case ${caseRecord.caseId}`);
      }
    }

    // One notification per case: handlers are alerted when the case opens,
    // and later blocks attach evidence to the case they already track.
    const notifications = created
      ? await this.dispatchNotifications(caseRecord, input)
      : { notifications: [], escalated: false, undeliverable: false };
    return {
      case: caseRecord,
      created,
      pause,
      notifications,
      ...(quarantineId !== undefined ? { quarantineId } : {}),
      runCaseReference,
    };
  }

  /** Gateway seam: one blocked invocation in, case id + reference out. */
  async recordGatewayBlock(input: {
    identity: BlockIdentity;
    reason: string;
    safeDetail: string;
    rawContent?: string;
  }): Promise<{ caseId: string; caseReference: string }> {
    const result = await this.recordBlock(input);
    return { caseId: result.case.caseId, caseReference: result.runCaseReference };
  }

  /**
   * Duty-gated case disposition (DAT-211). Each edge requires its matrix
   * duty — handler work for handling/submission, reviewer work for review
   * decisions, handler/admin work for termination — and the store enforces
   * the independent-review relationship on the review edges. Reaching
   * `resolved` or `terminated` releases the affected run's dependent work
   * under the same actor: the run itself is rejected at the store and the
   * pause ledger, so it can never resume itself. Case states never redefine
   * harness stop-condition or terminal semantics; this only lifts the
   * dependent-work hold.
   */
  transition(caseId: string, to: CaseState, actor: SecurityActor): SecurityCase {
    const record = this.requireCase(caseId);
    const action = TRANSITION_ACTIONS[`${record.state}>${to}`];
    if (action === undefined) {
      // Let the store produce the canonical forbidden-edge error.
      return this.deps.caseStore.transition(caseId, to, actor);
    }
    try {
      requireDuty(action, actor, this.deps.duties, requireScope(record.scope));
    } catch (error) {
      // A denied review attempt is a review result and belongs in the audit
      // trail whether the duty gate or the independence gate refused it.
      if (action === "case.review_decide") {
        this.deps.caseStore.appendEvent(caseId, "case.review_denied", actor, {
          code: error instanceof SecurityError ? error.code : "SOD_REVIEW_DENIED",
        });
      }
      throw error;
    }
    const updated = this.deps.caseStore.transition(caseId, to, actor);
    if (to === "awaiting_review") {
      // No independent reviewer available: the case stays blocked in review
      // and escalates — unavailability is never a waiver (ADR-0005 §3).
      const reviewers = this.deps.duties.reviewersIn(requireScope(updated.scope)) ?? [];
      if (reviewers.length === 0) {
        this.deps.caseStore.appendEvent(caseId, "case.reviewer_unavailable", actor, {
          runId: updated.scope.runId,
        });
        this.incident(
          `no independent reviewer available for case ${caseId}; it remains blocked and escalates`,
        );
      }
    }
    if (to === "resolved" || to === "terminated") {
      const pause = this.deps.pauses.pauseFor(updated.scope.runId);
      if (pause && pause.state === "active") {
        this.deps.pauses.release(pause.pauseId, actor, `case ${to}`);
        this.deps.caseStore.appendEvent(caseId, "run.pause_released", actor, {
          pauseId: pause.pauseId,
          runId: updated.scope.runId,
          via: to,
        });
      }
    }
    return updated;
  }

  /**
   * A task owner *requests* termination — ownership alone never dispositions
   * a case (ADR-0005 §3). The request is recorded; handler or enterprise
   * administrator work executes it via {@link transition}.
   */
  requestTermination(caseId: string, actor: SecurityActor): void {
    this.recordOwnerRequest(
      caseId,
      actor,
      "case.request_termination",
      "case.termination_requested",
    );
  }

  /** A task owner requests reassignment of the handling; recorded only. */
  requestReassignment(caseId: string, actor: SecurityActor): void {
    this.recordOwnerRequest(
      caseId,
      actor,
      "case.request_reassignment",
      "case.reassignment_requested",
    );
  }

  /**
   * Redacted case status for any duty holder. The record is non-secret by
   * construction; quarantined values stay behind their own grant boundary.
   */
  redactedStatus(caseId: string, actor: SecurityActor): SecurityCase {
    const record = this.requireCase(caseId);
    requireDuty("case.read_redacted_status", actor, this.deps.duties, requireScope(record.scope));
    return record;
  }

  /** True while the run's dependent work is held pending disposition. */
  isRunHeld(runId: string): boolean {
    return this.deps.pauses.isHeld(runId);
  }

  /**
   * The open security case holding this run's dependent work, if any — the
   * admission-boundary seam (`DependentWorkHold`) that work admission
   * boundaries consult so a held run's dependent work never proceeds.
   */
  heldCaseFor(runId: string): { caseId: string; caseReference: string } | undefined {
    const pause = this.deps.pauses.pauseFor(runId);
    if (!pause || pause.state !== "active") return undefined;
    return {
      caseId: pause.caseId,
      caseReference: mintCaseReference(this.deps.referenceSecret, pause.caseId, `run:${runId}`),
    };
  }

  /**
   * Grant one subject separately scoped, time-limited quarantine inspection.
   * The grant is not case authority and not a case reference. Issuing grants
   * is enterprise-security-administrator work; the subject must hold handler
   * or reviewer duties — a task owner is never granted quarantined values.
   */
  grantQuarantineAccess(
    quarantineId: string,
    subject: string,
    actor: SecurityActor,
  ): QuarantineAccessGrant {
    const caseRecord = this.requireCase(this.caseOfQuarantine(quarantineId));
    const scope = requireScope(caseRecord.scope);
    requireDuty("quarantine.grant_access", actor, this.deps.duties, scope);
    const subjectDuties =
      this.deps.duties.dutiesOf(requireNonEmpty(subject, "subject"), scope) ?? [];
    if (
      !subjectDuties.includes("security_handler") &&
      !subjectDuties.includes("independent_reviewer")
    ) {
      throw new SecurityError(
        "SOD_DUTY_REQUIRED",
        "quarantine inspection is granted only to handlers or independent reviewers",
        { quarantineId, subject },
      );
    }
    const grant = this.deps.quarantine.grantAccess(quarantineId, subject, actor);
    this.deps.caseStore.appendEvent(caseRecord.caseId, "quarantine.access_granted", actor, {
      quarantineId,
      grantId: grant.grantId,
      subject,
    });
    return grant;
  }

  /**
   * Inspect quarantined raw context under the id of a grant the quarantine
   * store actually issued — and only as a handler or independent reviewer.
   * Denied attempts are audited onto the case as well — every view attempt
   * leaves a trace.
   */
  inspectQuarantine(quarantineId: string, actor: SecurityActor, grantId?: string): string {
    const caseRecord = this.requireCase(this.caseOfQuarantine(quarantineId));
    try {
      requireDuty("quarantine.view", actor, this.deps.duties, requireScope(caseRecord.scope));
      const content = this.deps.quarantine.read(quarantineId, grantId ?? "", actor);
      this.deps.caseStore.appendEvent(caseRecord.caseId, "quarantine.accessed", actor, {
        quarantineId,
        ...(grantId !== undefined && grantId !== "" ? { grantId } : {}),
      });
      return content;
    } catch (error) {
      // Duty denials and grant failures alike leave a trace: every view
      // attempt is auditable.
      this.deps.caseStore.appendEvent(caseRecord.caseId, "quarantine.access_denied", actor, {
        quarantineId,
      });
      throw error;
    }
  }

  /** Task-owner requests are recorded and never execute the disposition. */
  private recordOwnerRequest(
    caseId: string,
    actor: SecurityActor,
    action: SecurityAction,
    event: "case.termination_requested" | "case.reassignment_requested",
  ): void {
    const record = this.requireCase(caseId);
    requireDuty(action, actor, this.deps.duties, requireScope(record.scope));
    this.deps.caseStore.appendEvent(caseId, event, actor, { requestedBy: actor.actorId });
  }

  private requireCase(caseId: string): SecurityCase {
    const record = this.deps.caseStore.get(caseId);
    if (!record) {
      throw new SecurityError("CASE_NOT_FOUND", `no security case ${caseId}`, { caseId });
    }
    return record;
  }

  private async dispatchNotifications(
    caseRecord: SecurityCase,
    input: RecordBlockInput,
  ): Promise<NotifyResult> {
    try {
      const result = await this.deps.notifier.notifyOpenCase(
        caseRecord,
        input.reason,
        input.safeDetail ?? "",
      );
      for (const notification of result.notifications) {
        this.deps.caseStore.appendEvent(
          caseRecord.caseId,
          notification.escalated ? "notification.escalated" : "notification.dispatched",
          SERVICE_ACTOR,
          {
            notificationId: notification.notificationId,
            recipientId: notification.recipientId,
            role: notification.role,
          },
        );
      }
      if (result.undeliverable) {
        this.deps.caseStore.appendEvent(
          caseRecord.caseId,
          "notification.undeliverable",
          SERVICE_ACTOR,
          { reason: scrubSecrets(requireNonEmpty(input.reason, "reason")) },
        );
        this.incident(`security notification undeliverable for case ${caseRecord.caseId}`);
      }
      return result;
    } catch (error) {
      // Transport failure is explicit, never silent: the case history records
      // it and an incident is raised; the block and case still stand.
      this.deps.caseStore.appendEvent(
        caseRecord.caseId,
        "notification.undeliverable",
        SERVICE_ACTOR,
        {
          reason: scrubSecrets(requireNonEmpty(input.reason, "reason")),
        },
      );
      this.incident(
        `security notification failed for case ${caseRecord.caseId}: ${
          error instanceof Error ? error.name : "error"
        }`,
      );
      return { notifications: [], escalated: false, undeliverable: true };
    }
  }

  private caseOfQuarantine(quarantineId: string): string {
    const meta = this.deps.quarantine.get(quarantineId);
    if (!meta) {
      throw new SecurityError("QUARANTINE_NOT_FOUND", `no quarantine record ${quarantineId}`, {
        quarantineId,
      });
    }
    return meta.caseId;
  }

  private incident(message: string): void {
    if (this.deps.onIncident) {
      this.deps.onIncident(message);
      return;
    }
    console.error(message);
  }
}
