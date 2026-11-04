/**
 * Production consolidation trigger (DAT-235).
 *
 * The bounded consolidation job is only useful if something runs it: this
 * module is that something. It enumerates the enterprise's active workspaces,
 * runs one bounded consolidation pass per workspace under its own
 * {@link WorkspaceScope}, and repeats on a fixed interval — the ADR-0009
 * "sleep-time" phase, running outside any remediation run.
 *
 * Lifecycle contract:
 *
 * - `start()` begins the schedule; it is idempotent and a tick that lands
 *   while a pass is still in flight is dropped, never queued.
 * - `stop()` ends the schedule; the timer never holds the process open, so a
 *   forgotten `stop()` cannot keep a deployment alive either.
 * - Failures are isolated twice: one workspace's failed pass never blocks the
 *   remaining workspaces, and a failed tick never ends the schedule. Every
 *   failure reaches `onError`; nothing is swallowed silently.
 *
 * The runner touches only the memory store's own tables (through the scoped
 * repositories) and never promotes, approves, or advances delivery.
 */

import type { ControlPlaneDb } from "../../control-plane/db.js";
import { createRepositories } from "../../control-plane/repositories.js";
import type { WorkspaceScope } from "../../control-plane/types.js";
import type { MemoryRepositories } from "../repositories.js";
import { createMemoryRepositories } from "../repositories.js";
import type { ConsolidationScheduleHandle } from "./consolidation.js";
import { runConsolidation, scheduleMemoryConsolidation } from "./consolidation.js";
import { createMemoryLifecycleStore } from "./repositories.js";
import type { ConsolidationOptions, ConsolidationReport } from "./types.js";

/** Default sleep-time cadence: once every six hours. */
export const DEFAULT_MEMORY_CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface MemoryConsolidationRunnerOptions {
  /** Control-plane database shared with the identity subsystem. */
  db: ControlPlaneDb;
  /** Enterprise whose workspaces this deployment consolidates. */
  enterpriseId: string;
  /** Operator identity recorded as the actor of scheduled runs. */
  actorId: string;
  /** Fixed interval between passes; defaults to six hours. */
  intervalMs?: number;
  /**
   * Per-workspace run options: bounds, staleness verifier, usage stats, and
   * proposals. Deployments resolve these per workspace; absent, the ADR
   * defaults apply and nothing is reported stale or decayed on usage grounds.
   */
  optionsFor?: (workspaceId: string) => ConsolidationOptions;
  /** One consolidated workspace, for metering and operator logs. */
  onReport?: (workspaceId: string, report: ConsolidationReport) => void;
  /** A failed pass or a failed workspace; the schedule survives. */
  onError?: (error: unknown) => void;
}

export interface MemoryConsolidationRunner {
  /** One pass over every active workspace of the enterprise, right now. */
  tick(): void;
  /** Start the fixed-interval schedule; idempotent. */
  start(): void;
  /** Stop the schedule; idempotent, pending ticks are dropped. */
  stop(): void;
}

export function createMemoryConsolidationRunner(
  options: MemoryConsolidationRunnerOptions,
): MemoryConsolidationRunner {
  const memory: MemoryRepositories = createMemoryRepositories(options.db);
  const lifecycle = createMemoryLifecycleStore(options.db);
  const controlPlane = createRepositories(options.db);
  const enterpriseScope = { enterprise_id: options.enterpriseId, actor_id: options.actorId };
  let schedule: ConsolidationScheduleHandle | undefined;

  const tick = (): void => {
    const workspaces = controlPlane.workspaces.list(enterpriseScope, "active");
    for (const workspace of workspaces) {
      const scope: WorkspaceScope = {
        enterprise_id: workspace.enterprise_id,
        workspace_id: workspace.id,
        actor_id: options.actorId,
      };
      try {
        const report = runConsolidation(
          scope,
          { memory, lifecycle },
          options.optionsFor?.(workspace.id) ?? {},
        );
        options.onReport?.(workspace.id, report);
      } catch (error) {
        // One workspace's failed pass must not stop the pass for the others.
        options.onError?.(error);
      }
    }
  };

  return {
    tick,
    start: () => {
      if (schedule !== undefined) {
        return;
      }
      schedule = scheduleMemoryConsolidation({
        intervalMs: options.intervalMs ?? DEFAULT_MEMORY_CONSOLIDATION_INTERVAL_MS,
        run: tick,
        // Enumeration failures (listing workspaces) reach the same handler;
        // the schedule survives either way.
        ...(options.onError !== undefined ? { onError: options.onError } : {}),
      });
    },
    stop: () => {
      schedule?.stop();
      schedule = undefined;
    },
  };
}
