/**
 * Precise dependent-work pause (DAT-210, ADR-0005 §2).
 *
 * Blocking pauses exactly the affected run's dependent work — the work that
 * would continue from the quarantined request — and nothing else: unrelated
 * runs keep going. The hold is released only through human/service case
 * disposition; the paused run itself can never release or resume it ("no
 * silent retry or replay of the quarantined request").
 *
 * This ledger is deliberately NOT a harness run-state machine: it carries no
 * `stopped`/terminal state and never redefines dsh stop-condition or terminal
 * semantics (ADR-0007). It is an overlay that says "dependent work of this
 * run is held pending disposition"; the harness's own run lifecycle stays the
 * authority for runs and grants.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scrubSecrets } from "../gateway/redact.js";
import { SecurityError, isRunItself, requireNonEmpty } from "./types.js";
import type { CaseScope, SecurityActor } from "./types.js";

export interface RunPause {
  pauseId: string;
  caseId: string;
  scope: CaseScope;
  /** Scrubbed, content-free reason (e.g. a redacted deny code). */
  reason: string;
  state: "active" | "released";
  createdAt: string;
  releasedAt?: string;
  /** Actor id that released the hold through disposition; never the run. */
  releasedBy?: string;
  /** Scrubbed disposition note. */
  releaseReason?: string;
}

export interface PauseLedgerOptions {
  /** JSON state file; every mutation persists atomically when set. Holds are
   * durable: a restart must not forget that a run is held. */
  persistencePath?: string;
  now?: () => Date;
  newPauseId?: () => string;
}

const SCHEMA_VERSION = 1;

interface PersistedPauseState {
  schema_version: number;
  pauses: RunPause[];
}

export class DependentWorkPauseLedger {
  private readonly pauses = new Map<string, RunPause>();
  private readonly activeByRun = new Map<string, string>();
  private readonly persistencePath: string | undefined;
  private readonly now: () => Date;
  private readonly newPauseId: () => string;

  constructor(options: PauseLedgerOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.now = options.now ?? (() => new Date());
    this.newPauseId = options.newPauseId ?? (() => randomUUID());
    this.load();
  }

  /**
   * Hold the affected run's dependent work for one case. Idempotent per run:
   * an already-held run keeps its single active pause. Only the run named in
   * `scope` is paused — no other run is ever touched.
   */
  pauseDependentWork(caseId: string, scope: CaseScope, reason: string): RunPause {
    requireNonEmpty(caseId, "caseId");
    requireNonEmpty(scope.runId, "scope.runId");
    const existingId = this.activeByRun.get(scope.runId);
    const existing = existingId ? this.pauses.get(existingId) : undefined;
    if (existing && existing.state === "active") {
      return existing;
    }
    const pause: RunPause = {
      pauseId: this.newPauseId(),
      caseId,
      scope: { ...scope },
      reason: scrubSecrets(requireNonEmpty(reason, "reason")),
      state: "active",
      createdAt: this.timestamp(),
    };
    this.pauses.set(pause.pauseId, pause);
    this.activeByRun.set(scope.runId, pause.pauseId);
    this.persist();
    return pause;
  }

  /** True while the run's dependent work is held pending disposition. */
  isHeld(runId: string): boolean {
    const pause = this.pauseFor(runId);
    return pause !== undefined && pause.state === "active";
  }

  /** The run's pause record, active or released; never another run's. */
  pauseFor(runId: string): RunPause | undefined {
    const pauseId = this.activeByRun.get(runId);
    return pauseId ? this.pauses.get(pauseId) : undefined;
  }

  /**
   * Release one hold after case disposition. Human/service actors only: the
   * paused run — `run` actors and any actor id equal to the run id — never
   * resumes itself. A hold releases exactly once.
   */
  release(pauseId: string, actor: SecurityActor, reason: string): RunPause {
    const pause = this.pauses.get(pauseId);
    if (!pause) {
      throw new SecurityError("PAUSE_NOT_FOUND", `no run pause ${pauseId}`, { pauseId });
    }
    if (isRunItself(actor, pause.scope)) {
      throw new SecurityError(
        "PAUSE_RELEASE_FORBIDDEN",
        "a paused run never releases or resumes its own dependent work",
        { pauseId, runId: pause.scope.runId },
      );
    }
    if (pause.state !== "active") {
      throw new SecurityError("PAUSE_NOT_ACTIVE", `run pause ${pauseId} is not active`, {
        pauseId,
      });
    }
    pause.state = "released";
    pause.releasedAt = this.timestamp();
    pause.releasedBy = actor.actorId;
    pause.releaseReason = scrubSecrets(reason);
    this.persist();
    return pause;
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
      throw new SecurityError("PAUSE_STORE_INVALID", "pause state file is not valid JSON");
    }
    const state = parsed as Partial<PersistedPauseState>;
    if (state.schema_version !== SCHEMA_VERSION || !Array.isArray(state.pauses)) {
      throw new SecurityError("PAUSE_STORE_INVALID", "pause state file has an unsupported shape");
    }
    for (const pause of state.pauses) {
      this.pauses.set(pause.pauseId, pause);
      // Latest pause per run wins: it is the one `pauseFor` observes.
      this.activeByRun.set(pause.scope.runId, pause.pauseId);
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    const state: PersistedPauseState = {
      schema_version: SCHEMA_VERSION,
      pauses: [...this.pauses.values()],
    };
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.persistencePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.persistencePath);
  }
}
