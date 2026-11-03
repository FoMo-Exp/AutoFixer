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
  onIncident?: (message: string) => void;
}

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
   * Human/service case disposition. Reaching `resolved` or `terminated`
   * releases the affected run's dependent work under the same actor — the run
   * itself is rejected at the store and the pause ledger, so it can never
   * resume itself. Case states never redefine harness stop-condition or
   * terminal semantics; this only lifts the dependent-work hold.
   */
  transition(caseId: string, to: CaseState, actor: SecurityActor): SecurityCase {
    const record = this.deps.caseStore.transition(caseId, to, actor);
    if (to === "resolved" || to === "terminated") {
      const pause = this.deps.pauses.pauseFor(record.scope.runId);
      if (pause && pause.state === "active") {
        this.deps.pauses.release(pause.pauseId, actor, `case ${to}`);
        this.deps.caseStore.appendEvent(caseId, "run.pause_released", actor, {
          pauseId: pause.pauseId,
          runId: record.scope.runId,
          via: to,
        });
      }
    }
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
   * The grant is not case authority and not a case reference.
   */
  grantQuarantineAccess(
    quarantineId: string,
    subject: string,
    actor: SecurityActor,
  ): QuarantineAccessGrant {
    const grant = this.deps.quarantine.grantAccess(quarantineId, subject, actor);
    const caseId = this.caseOfQuarantine(quarantineId);
    this.deps.caseStore.appendEvent(caseId, "quarantine.access_granted", actor, {
      quarantineId,
      grantId: grant.grantId,
      subject,
    });
    return grant;
  }

  /**
   * Inspect quarantined raw context under the id of a grant the quarantine
   * store actually issued. Denied attempts are audited onto the case as well
   * — every view attempt leaves a trace.
   */
  inspectQuarantine(quarantineId: string, actor: SecurityActor, grantId?: string): string {
    const caseId = this.caseOfQuarantine(quarantineId);
    try {
      const content = this.deps.quarantine.read(quarantineId, grantId ?? "", actor);
      this.deps.caseStore.appendEvent(caseId, "quarantine.accessed", actor, {
        quarantineId,
        ...(grantId !== undefined && grantId !== "" ? { grantId } : {}),
      });
      return content;
    } catch (error) {
      this.deps.caseStore.appendEvent(caseId, "quarantine.access_denied", actor, {
        quarantineId,
      });
      throw error;
    }
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
