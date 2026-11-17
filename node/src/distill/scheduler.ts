/**
 * Recoverable outcome-capture scheduling (DAT-264).
 *
 * The capture write path is driven by the durable outbox in
 * `capture-store.ts`: terminal dsh runs are enqueued from the server-side task
 * projection, and a worker claims each job, re-reads the **authoritative** run
 * evidence, builds the DAT-233 envelope, and captures it in one transaction
 * with the job's completion.
 *
 * Invariants:
 *
 * - Only a terminal dsh state is capturable; a Node-only stop is never
 *   evidence.
 * - The workspace scope is the job's persisted server-side scope, never a
 *   payload: cross-workspace evidence cannot be redirected into another
 *   workspace.
 * - Re-enqueueing, restarting, or running two workers never captures the same
 *   terminal snapshot twice: the unique job key and the claim lease decide,
 *   and capture + `captured` commit together or not at all.
 * - A failed delivery (dsh read, evidence gap, or memory write) leaves the job
 *   retryable and records a stable error code; it is never reported as
 *   captured and never turned into a fabricated outcome.
 * - Attempts are bounded; exhausting them marks the job `failed`, visible to
 *   operators, rather than retrying forever or silently dropping the outcome.
 */

import { DshError } from "../dsh/client.js";
import type { ControlPlaneDb } from "../control-plane/db.js";
import { ValidationError } from "../control-plane/errors.js";
import type { WorkspaceScope } from "../control-plane/types.js";
import type { MemoryRepositories } from "../memory/index.js";
import { captureOutcome } from "./capture.js";
import { createCaptureJobStore } from "./capture-store.js";
import type { CaptureJob, CaptureJobStore } from "./capture-store.js";
import {
  buildOutcomeEnvelope,
  CaptureEvidenceError,
  isCaptureTerminalState,
  readTerminalRunEvidence,
} from "./run-evidence.js";
import type { RunEvidenceSource } from "./run-evidence.js";
import type { CapturedOutcome } from "./types.js";

/** Default claim lease: long enough for two dsh reads, short enough to recover. */
export const DEFAULT_CAPTURE_LEASE_MS = 60_000;
/** Default retry backoff after a failed attempt. */
export const DEFAULT_CAPTURE_RETRY_MS = 30_000;
/** Attempt budget per terminal snapshot before it is marked failed. */
export const DEFAULT_CAPTURE_MAX_ATTEMPTS = 5;
/** Default recovery/retry cadence for pending rows. */
export const DEFAULT_CAPTURE_INTERVAL_MS = 60_000;
/** Bound on one drain pass so a large backlog cannot starve the process. */
export const DEFAULT_CAPTURE_BATCH = 100;

export interface OutcomeCaptureSchedulerOptions {
  db: ControlPlaneDb;
  memory: MemoryRepositories;
  dsh: RunEvidenceSource;
  /** Actor recorded on the captured episode (the deployment operator). */
  actorId: string;
  now?: () => Date;
  leaseMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  intervalMs?: number;
  batchSize?: number;
  /** One successfully captured snapshot, for operator logs. */
  onCapture?: (job: CaptureJob, outcome: CapturedOutcome) => void;
  /** A failed attempt or a failed drain pass; the schedule survives either. */
  onError?: (error: unknown) => void;
}

/** One terminal run the server-side projection wants captured. */
export interface TerminalRunRegistration {
  enterprise_id: string;
  workspace_id: string;
  task_id: string;
  run_id: string;
  /** The dsh state the projection observed; non-terminal states are ignored. */
  state: string;
}

export interface CaptureDrainReport {
  claimed: number;
  captured: number;
  retried: number;
  failed: number;
}

export interface OutcomeCaptureScheduler {
  /** Enqueue one terminal snapshot; non-terminal states are ignored. */
  enqueue(run: TerminalRunRegistration): CaptureJob | null;
  /** Enqueue recovered terminal runs, then drain the outbox. */
  recover(runs: readonly TerminalRunRegistration[]): Promise<CaptureDrainReport>;
  /** Process every due job in bounded batches. */
  drain(): Promise<CaptureDrainReport>;
  /** Start the retry/recovery cadence; idempotent. */
  start(): void;
  /** Stop the cadence; idempotent, pending rows stay durable. */
  stop(): void;
  /** The outbox, for operator surface and tests. */
  jobs: CaptureJobStore;
}

/** Stable error token for one failed attempt; never the raw message. */
function attemptErrorCode(error: unknown): string {
  if (error instanceof CaptureEvidenceError) {
    return error.code;
  }
  if (error instanceof DshError) {
    // The dsh contract code is already a stable uppercase token.
    return error.code;
  }
  if (error instanceof ValidationError) {
    return "INVALID_OUTCOME_EVIDENCE";
  }
  return "CAPTURE_DELIVERY_FAILED";
}

function emptyReport(): CaptureDrainReport {
  return { claimed: 0, captured: 0, retried: 0, failed: 0 };
}

export function createOutcomeCaptureScheduler(
  options: OutcomeCaptureSchedulerOptions,
): OutcomeCaptureScheduler {
  const jobs = createCaptureJobStore(options.db);
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? DEFAULT_CAPTURE_LEASE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_CAPTURE_RETRY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_CAPTURE_MAX_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_CAPTURE_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_CAPTURE_BATCH;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<CaptureDrainReport> | undefined;

  const captureOne = async (job: CaptureJob): Promise<CapturedOutcome> => {
    const evidence = await readTerminalRunEvidence(options.dsh, job.run_id);
    if (evidence.run.task_id !== job.task_id) {
      // A run can belong to exactly one task. A mismatch means the job and
      // the evidence disagree; capturing would attribute it to the wrong
      // server-side scope.
      throw new CaptureEvidenceError(
        "TASK_LINK_MISMATCH",
        `run ${job.run_id} belongs to task ${evidence.run.task_id}, not ${job.task_id}`,
      );
    }
    const envelope = buildOutcomeEnvelope(evidence);
    const scope: WorkspaceScope = {
      // The persisted job scope is the only workspace authority here.
      enterprise_id: job.enterprise_id,
      workspace_id: job.workspace_id,
      actor_id: options.actorId,
    };
    // Capture and completion commit together: a crash after the episode
    // insert but before `markCaptured` would otherwise duplicate the episode
    // on the next pass. The outbox shares the memory store's connection, so
    // `runAtomically` covers both writes.
    return options.memory.runAtomically(() => {
      const captured = captureOutcome(options.memory, scope, envelope);
      jobs.markCaptured(job.id, captured.episode.item.id, now());
      return captured;
    });
  };

  const runDrain = async (): Promise<CaptureDrainReport> => {
    const report = emptyReport();
    for (let processed = 0; processed < batchSize; processed += 1) {
      const at = now();
      const job = jobs.claim(at, leaseMs);
      if (job === null) {
        break;
      }
      report.claimed += 1;
      try {
        const captured = await captureOne(job);
        report.captured += 1;
        options.onCapture?.(job, captured);
      } catch (error) {
        const code = attemptErrorCode(error);
        if (job.attempts >= maxAttempts) {
          jobs.markFailed(job.id, code, now());
          report.failed += 1;
        } else {
          const at = now();
          const backoff = retryDelayMs * Math.max(1, job.attempts);
          jobs.markRetry(job.id, code, new Date(at.getTime() + backoff), at);
          report.retried += 1;
        }
        options.onError?.(error);
      }
    }
    return report;
  };

  const enqueue = (run: TerminalRunRegistration): CaptureJob | null => {
    if (!isCaptureTerminalState(run.state)) {
      return null;
    }
    try {
      return jobs.enqueue({
        enterprise_id: run.enterprise_id,
        workspace_id: run.workspace_id,
        task_id: run.task_id,
        run_id: run.run_id,
        terminal_state: run.state,
      });
    } catch (error) {
      // The task path must not fail because the outbox write did. Recovery
      // re-registers every terminal run from the projection.
      options.onError?.(error);
      return null;
    }
  };

  const drain = (): Promise<CaptureDrainReport> => {
    if (active !== undefined) {
      return active;
    }
    active = runDrain().finally(() => {
      active = undefined;
    });
    return active;
  };

  return {
    jobs,
    enqueue,
    async recover(runs) {
      for (const run of runs) {
        enqueue(run);
      }
      return drain();
    },
    drain,
    start() {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void drain().catch((error: unknown) => options.onError?.(error));
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer === undefined) {
        return;
      }
      clearInterval(timer);
      timer = undefined;
    },
  };
}
