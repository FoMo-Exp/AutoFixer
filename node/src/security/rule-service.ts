/**
 * Versioned rule-correction lifecycle (DAT-211, ADR-0005 §4).
 *
 * One lineage per (detector, enterprise, workspace) holds an append-only
 * version history: propose → independent review → administrator activation,
 * with versioned rollback and expiry. The separation-of-duties rules are the
 * point of the whole module:
 *
 * - the handler who proposes never reviews their own correction
 *   (`assertIndependentReview`);
 * - activation and rollback require an enterprise security administrator who
 *   is a principal separate from author *and* reviewer
 *   (`assertSeparateAdministrator`) — handling, review, and policy
 *   administration stay three principals;
 * - activation needs valid regression evidence and a live approval;
 * - an approval is consumed by activation and superseded for good by a newer
 *   activation — a rollback deactivates and re-activates nothing, so a
 *   superseded approval can never be restored;
 * - propose, review, activate, and rollback (and their denials) all append
 *   non-secret audit events before anything throws.
 *
 * Activated corrections are consumed by the scanner as narrowing constraints
 * (see `rules.ts` / `pattern-scanner.ts`); they are policy changes, not run
 * grants, and never exempt any request from the complete-request checks.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scrubSecrets } from "../gateway/redact.js";
import {
  assertIndependentReview,
  assertSeparateAdministrator,
  requireDuty,
  requireScope,
} from "./duties.js";
import type { SecurityDutyDirectory } from "./duties.js";
import { correctionLineage, validateRuleCorrection } from "./rules.js";
import type {
  ActiveRuleCorrection,
  RegressionEvidence,
  RuleCorrectionDraft,
  RuleEvent,
  RuleEventType,
  RuleRevision,
} from "./rules.js";
import { SecurityError, requireNonEmpty } from "./types.js";
import type { SecurityActor } from "./types.js";

export interface RuleServiceDeps {
  directory: SecurityDutyDirectory;
  /** JSON state file; every mutation persists atomically when set. */
  persistencePath?: string;
  now?: () => Date;
}

const SCHEMA_VERSION = 1;

interface PersistedState {
  schema_version: number;
  revisions: RuleRevision[];
  events: RuleEvent[];
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
 * The rule-correction service. Revisions mutate only their lifecycle status
 * fields; every step appends an immutable audit event that never rewrites.
 */
export class RuleCorrectionService {
  private readonly revisions = new Map<string, RuleRevision[]>();
  private readonly events = new Map<string, RuleEvent[]>();
  private readonly deps: RuleServiceDeps;
  private readonly now: () => Date;

  constructor(deps: RuleServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.load();
  }

  /**
   * Propose one bounded rule correction. The raw draft is validated as
   * untyped input so disguised exemptions can be *identified* and rejected by
   * name (`RULE_TARGETED_EXEMPTION`, `RULE_BLANKET_EXEMPTION`); a rejected
   * proposal is itself an audited event. A valid proposal becomes the next
   * version of its lineage in status `proposed`.
   */
  propose(author: SecurityActor, raw: unknown): RuleRevision {
    const at = this.timestamp();
    let draft: RuleCorrectionDraft;
    try {
      draft = validateRuleCorrection(raw, this.now());
    } catch (error) {
      const lineage = correctionLineage(raw);
      if (lineage !== undefined) {
        const paths =
          error instanceof SecurityError && Array.isArray(error.details["paths"])
            ? error.details["paths"].join(",")
            : "";
        this.appendEvent(lineage, "rule.proposal_rejected", author, "security_handler", {
          code: error instanceof SecurityError ? error.code : "RULE_PROPOSAL_INVALID",
          ...(paths.length > 0 ? { paths } : {}),
        });
      }
      throw error;
    }
    const scope = requireScope(draft.scope);
    requireDuty("rule.propose", author, this.deps.directory, scope);
    const lineage = [draft.detectorId, scope.enterpriseId, scope.workspaceId].join("|");
    const revision: RuleRevision = {
      lineage,
      version: this.nextVersion(lineage),
      kind: "correction",
      status: "proposed",
      detectorId: draft.detectorId,
      scope,
      constraints: draft.constraints,
      reason: scrubSecrets(draft.reason),
      expiresAt: draft.expiresAt,
      ...(draft.reviewAt !== undefined ? { reviewAt: draft.reviewAt } : {}),
      regressionEvidence: draft.regressionEvidence,
      authorId: requireNonEmpty(author.actorId, "author.actorId"),
      proposedAt: at,
    };
    this.lineageOf(lineage).push(revision);
    this.appendEvent(lineage, "rule.proposed", author, "security_handler", {
      version: revision.version,
      authorId: revision.authorId,
      detectorId: revision.detectorId,
      reason: revision.reason,
      expiresAt: revision.expiresAt,
    });
    this.persist();
    return { ...revision };
  }

  /**
   * Independent review of a proposed correction. The reviewer must be a
   * different human principal from the author (`assertIndependentReview`).
   * Approval supersedes every earlier un-activated approval in the lineage —
   * the review line moves forward and never back.
   */
  review(
    lineage: string,
    version: number,
    reviewer: SecurityActor,
    approve: boolean,
    reason: string,
  ): RuleRevision {
    const revision = this.requireRevision(lineage, version);
    try {
      if (revision.kind !== "correction" || revision.status !== "proposed") {
        throw new SecurityError(
          "RULE_REVISION_NOT_REVIEWABLE",
          `rule ${lineage} v${version} is not open for review`,
          { lineage, version, status: revision.status },
        );
      }
      if (Date.parse(revision.expiresAt) <= this.now().getTime()) {
        throw new SecurityError(
          "RULE_REVISION_EXPIRED",
          `rule ${lineage} v${version} has expired`,
          {
            lineage,
            version,
          },
        );
      }
      assertIndependentReview(this.deps.directory, {
        authorId: revision.authorId,
        subjectIds: [revision.authorId],
        reviewer,
        action: "rule.review",
        scope: requireScope(revision.scope),
      });
    } catch (error) {
      // A denied review attempt is a review result and belongs in the audit
      // trail before it throws.
      this.appendEvent(lineage, "rule.review_denied", reviewer, "independent_reviewer", {
        version,
        reviewerId: reviewer?.actorId ?? "",
        authorId: revision.authorId,
        code: error instanceof SecurityError ? error.code : "SOD_REVIEW_DENIED",
      });
      this.persist();
      throw error;
    }
    revision.review = {
      reviewerId: reviewer.actorId,
      approved: approve,
      reason: scrubSecrets(reason),
      at: this.timestamp(),
    };
    revision.status = approve ? "approved" : "rejected";
    this.appendEvent(
      lineage,
      approve ? "rule.review_approved" : "rule.review_rejected",
      reviewer,
      "independent_reviewer",
      {
        version,
        reviewerId: reviewer.actorId,
        authorId: revision.authorId,
        reason: revision.review.reason,
      },
    );
    if (approve) {
      for (const earlier of this.lineageOf(lineage)) {
        if (
          earlier.version < version &&
          earlier.kind === "correction" &&
          earlier.status === "approved"
        ) {
          this.supersede(lineage, earlier);
        }
      }
    }
    this.persist();
    return { ...revision };
  }

  /**
   * Administrator activation of a reviewed correction. Requires an approval
   * that is live (never superseded, never consumed), passing regression
   * evidence, and a future expiry — and an administrator who is a principal
   * separate from author and reviewer. Activating supersedes the previously
   * active correction and every earlier approval, permanently.
   */
  activate(lineage: string, version: number, administrator: SecurityActor): RuleRevision {
    const revision = this.requireRevision(lineage, version);
    try {
      if (revision.kind !== "correction") {
        throw new SecurityError(
          "RULE_REVISION_NOT_REVIEWABLE",
          `rule ${lineage} v${version} is not a correction`,
          { lineage, version },
        );
      }
      if (revision.status === "superseded" || revision.status === "rolled_back") {
        // The core rollback invariant: a consumed or superseded approval is
        // never restored — not by rollback, not by re-activation.
        throw new SecurityError(
          "RULE_APPROVAL_SUPERSEDED",
          `the approval for rule ${lineage} v${version} is superseded and cannot be restored`,
          { lineage, version },
        );
      }
      if (revision.status === "expired") {
        throw new SecurityError(
          "RULE_REVISION_EXPIRED",
          `rule ${lineage} v${version} has expired`,
          {
            lineage,
            version,
          },
        );
      }
      if (revision.status !== "approved") {
        throw new SecurityError(
          "RULE_REVISION_NOT_REVIEWABLE",
          `rule ${lineage} v${version} has no live approval to activate`,
          { lineage, version, status: revision.status },
        );
      }
      const evidence: readonly RegressionEvidence[] = revision.regressionEvidence ?? [];
      if (evidence.length === 0) {
        throw new SecurityError(
          "RULE_EVIDENCE_MISSING",
          "activation requires regression evidence that true-secret detection remains effective",
          { lineage, version },
        );
      }
      const failed = evidence.find((entry) => entry.result !== "pass");
      if (failed) {
        throw new SecurityError(
          "RULE_EVIDENCE_FAILED",
          "activation requires passing regression evidence",
          { lineage, version, testRef: failed.testRef },
        );
      }
      if (Date.parse(revision.expiresAt) <= this.now().getTime()) {
        throw new SecurityError(
          "RULE_REVISION_EXPIRED",
          `rule ${lineage} v${version} has expired`,
          {
            lineage,
            version,
          },
        );
      }
      assertSeparateAdministrator(this.deps.directory, {
        subjectIds: [revision.authorId, revision.review?.reviewerId ?? ""],
        administrator,
        action: "rule.activate",
        scope: requireScope(revision.scope),
      });
    } catch (error) {
      this.appendEvent(
        lineage,
        "rule.activation_denied",
        administrator,
        "enterprise_security_admin",
        {
          version,
          code: error instanceof SecurityError ? error.code : "RULE_ACTIVATION_DENIED",
        },
      );
      this.persist();
      throw error;
    }
    for (const other of this.lineageOf(lineage)) {
      if (other.version === version) continue;
      if (
        other.kind === "correction" &&
        (other.status === "activated" || other.status === "approved")
      ) {
        this.supersede(lineage, other);
      }
    }
    revision.status = "activated";
    revision.activatedBy = administrator.actorId;
    revision.activatedAt = this.timestamp();
    this.appendEvent(lineage, "rule.activated", administrator, "enterprise_security_admin", {
      version,
      activatedBy: administrator.actorId,
      authorId: revision.authorId,
      reviewerId: revision.review?.reviewerId ?? "",
    });
    this.persist();
    return { ...revision };
  }

  /**
   * Versioned rollback: deactivate the active correction and record a new
   * lineage version for the rollback itself. Rollback restores nothing —
   * especially not a superseded approval (re-establishing the old correction
   * needs a fresh proposal, review, and activation). The administrator must
   * be a principal separate from the author and reviewer of what is rolled
   * back.
   */
  rollback(lineage: string, administrator: SecurityActor): RuleRevision {
    const active = this.lineageOf(lineage).find(
      (revision) => revision.kind === "correction" && revision.status === "activated",
    );
    if (!active) {
      this.appendEvent(
        lineage,
        "rule.rollback_denied",
        administrator,
        "enterprise_security_admin",
        {
          code: "RULE_NOTHING_TO_ROLL_BACK",
        },
      );
      this.persist();
      throw new SecurityError("RULE_NOTHING_TO_ROLL_BACK", `no active correction on ${lineage}`, {
        lineage,
      });
    }
    try {
      assertSeparateAdministrator(this.deps.directory, {
        subjectIds: [active.authorId, active.review?.reviewerId ?? ""],
        administrator,
        action: "rule.rollback",
        scope: requireScope(active.scope),
      });
    } catch (error) {
      this.appendEvent(
        lineage,
        "rule.rollback_denied",
        administrator,
        "enterprise_security_admin",
        {
          version: active.version,
          code: error instanceof SecurityError ? error.code : "RULE_ROLLBACK_DENIED",
        },
      );
      this.persist();
      throw error;
    }
    const at = this.timestamp();
    const entry: RuleRevision = {
      lineage,
      version: this.nextVersion(lineage),
      kind: "rollback",
      status: "applied",
      detectorId: active.detectorId,
      scope: active.scope,
      constraints: {},
      reason: scrubSecrets(`rollback of version ${active.version}`),
      expiresAt: active.expiresAt,
      regressionEvidence: [],
      authorId: administrator.actorId,
      proposedAt: at,
      rollsBackVersion: active.version,
      rolledBackBy: administrator.actorId,
      rolledBackAt: at,
    };
    active.status = "rolled_back";
    active.rolledBackBy = administrator.actorId;
    active.rolledBackAt = at;
    this.lineageOf(lineage).push(entry);
    this.appendEvent(lineage, "rule.rolled_back", administrator, "enterprise_security_admin", {
      version: entry.version,
      rollsBackVersion: active.version,
      rolledBackBy: administrator.actorId,
    });
    this.persist();
    return { ...entry };
  }

  /**
   * Expire every correction past its bounded lifetime. An expired correction
   * stops narrowing its detector — the detector returns to its stock shape,
   * which can only detect more, never less. Sweeps are audited per lineage.
   */
  expireOverdue(): RuleRevision[] {
    const now = this.now().getTime();
    const expired: RuleRevision[] = [];
    for (const [lineage, revisions] of this.revisions) {
      for (const revision of revisions) {
        if (
          revision.kind !== "correction" ||
          revision.status === "expired" ||
          revision.status === "rejected" ||
          revision.status === "superseded" ||
          revision.status === "rolled_back"
        ) {
          continue;
        }
        if (Date.parse(revision.expiresAt) > now) continue;
        revision.status = "expired";
        revision.expiredAt = this.timestamp();
        this.appendEvent(lineage, "rule.expired", null, null, {
          version: revision.version,
          expiresAt: revision.expiresAt,
        });
        expired.push({ ...revision });
      }
    }
    if (expired.length > 0) this.persist();
    return expired;
  }

  /**
   * The live corrections the scanner applies: one activated, unexpired
   * correction per lineage. Narrowing only — see `constrainDetector`.
   */
  activeCorrections(): readonly ActiveRuleCorrection[] {
    const now = this.now().getTime();
    const active: ActiveRuleCorrection[] = [];
    for (const revisions of this.revisions.values()) {
      for (const revision of revisions) {
        if (
          revision.kind === "correction" &&
          revision.status === "activated" &&
          Date.parse(revision.expiresAt) > now
        ) {
          active.push({
            lineage: revision.lineage,
            version: revision.version,
            detectorId: revision.detectorId,
            constraints: revision.constraints,
          });
        }
      }
    }
    return active;
  }

  revision(lineage: string, version: number): RuleRevision | undefined {
    const found = this.lineageOf(lineage).find((entry) => entry.version === version);
    return found ? { ...found } : undefined;
  }

  /** One lineage's version history (copies; later mutations never leak). */
  lineage(lineage: string): readonly RuleRevision[] {
    return this.lineageOf(lineage).map((entry) => ({ ...entry }));
  }

  /** One lineage's append-only audit history. */
  history(lineage: string): readonly RuleEvent[] {
    return [...(this.events.get(lineage) ?? [])];
  }

  private supersede(lineage: string, revision: RuleRevision): void {
    revision.status = "superseded";
    revision.supersededAt = this.timestamp();
    this.appendEvent(lineage, "rule.superseded", null, null, { version: revision.version });
  }

  private requireRevision(lineage: string, version: number): RuleRevision {
    const found = this.lineageOf(lineage).find((entry) => entry.version === version);
    if (!found) {
      throw new SecurityError("RULE_REVISION_NOT_FOUND", `no rule ${lineage} v${version}`, {
        lineage,
        version,
      });
    }
    return found;
  }

  private lineageOf(lineage: string): RuleRevision[] {
    requireNonEmpty(lineage, "lineage");
    const existing = this.revisions.get(lineage);
    if (existing) return existing;
    const created: RuleRevision[] = [];
    this.revisions.set(lineage, created);
    return created;
  }

  private nextVersion(lineage: string): number {
    const revisions = this.lineageOf(lineage);
    return revisions.reduce((next, entry) => Math.max(next, entry.version), 0) + 1;
  }

  /**
   * Append one non-secret audit event. Actor duty records the effective role;
   * denials and sweeps carry null. The history only ever grows.
   */
  private appendEvent(
    lineage: string,
    type: RuleEventType,
    actor: SecurityActor | null,
    duty: string | null,
    detail: Record<string, string | number | boolean>,
  ): RuleEvent {
    const history = this.events.get(lineage) ?? [];
    const event: RuleEvent = {
      seq: history.length + 1,
      lineage,
      type,
      at: this.timestamp(),
      actor: actor ? { principalId: actor.actorId, duty: duty ?? "" } : null,
      detail: scrubDetail(detail),
    };
    history.push(event);
    this.events.set(lineage, history);
    return event;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private load(): void {
    const file = this.deps.persistencePath;
    if (!file || !fs.existsSync(file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new SecurityError("RULE_STORE_INVALID", "rule state file is not valid JSON");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as PersistedState).schema_version !== SCHEMA_VERSION ||
      !Array.isArray((parsed as PersistedState).revisions) ||
      !Array.isArray((parsed as PersistedState).events)
    ) {
      throw new SecurityError("RULE_STORE_INVALID", "rule state file has an unsupported shape");
    }
    const state = parsed as PersistedState;
    for (const revision of state.revisions) {
      this.lineageOf(revision.lineage).push(revision);
    }
    for (const event of state.events) {
      const history = this.events.get(event.lineage) ?? [];
      history.push(event);
      this.events.set(event.lineage, history);
    }
  }

  private persist(): void {
    const file = this.deps.persistencePath;
    if (!file) return;
    const state: PersistedState = {
      schema_version: SCHEMA_VERSION,
      revisions: [...this.revisions.values()].flat(),
      events: [...this.events.values()].flat(),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}
