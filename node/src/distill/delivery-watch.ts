/**
 * Bounded delivery-merge watcher (DAT-266).
 *
 * The product may only deliver an approved candidate; merging is a human act
 * on the provider. Nothing tells the service when that happens, so this
 * watcher observes every delivered PR on a bounded cadence and, on a merge at
 * the delivered head, enqueues exactly one terminal capture for that delivery.
 *
 * It is deliberately narrow:
 *
 * - it is read-only against the provider (the delivery provider seam has no
 *   merge operation, and none is added here);
 * - it observes only deliveries the collab record reports as `delivered` with
 *   a PR identity, and only that delivery's own issue-scoped branch;
 * - an open, closed, moved, or unreadable PR enqueues nothing — the merge path
 *   re-verifies the whole identity before capturing, and an unknown answer is
 *   never success;
 * - a delivery that already has a capture row is never observed again, and the
 *   outbox's unique delivery key makes a duplicate enqueue a no-op.
 */

import type { DeliveryProvider } from "../collab/delivery-broker.js";
import type { CollabMachine } from "../collab/machine.js";
import { autofixerBranchFor } from "../collab/types.js";
import type { DeliveryProviderLookup } from "./delivery-outcome.js";
import type { DeliveryTerminalRegistration, OutcomeCaptureScheduler } from "./scheduler.js";

export const DEFAULT_DELIVERY_WATCH_INTERVAL_MS = 120_000;
/** Bound on provider reads per scan; the next scan continues the list. */
export const DEFAULT_DELIVERY_WATCH_BATCH = 25;

export interface DeliveryWatchReport {
  /** Delivered deliveries with a PR identity considered by this scan. */
  scanned: number;
  /** Merges at the delivered head that were enqueued (new captures). */
  enqueued: number;
  /** Not merged, identity drifted, or already captured. */
  skipped: number;
  /** No provider configured, or the provider could not be read: unknown. */
  unreadable: number;
}

export interface DeliveryMergeWatcherOptions {
  machine: CollabMachine;
  providerFor: DeliveryProviderLookup;
  capture: Pick<OutcomeCaptureScheduler, "jobs" | "enqueueDelivery">;
  intervalMs?: number;
  batchSize?: number;
  onObserved?: (deliveryId: string, state: string) => void;
  onError?: (error: unknown) => void;
}

export interface DeliveryMergeWatcher {
  /** One bounded scan; never throws, reports unknown reads separately. */
  scan(): Promise<DeliveryWatchReport>;
  start(): void;
  stop(): void;
}

function emptyReport(): DeliveryWatchReport {
  return { scanned: 0, enqueued: 0, skipped: 0, unreadable: 0 };
}

export function createDeliveryMergeWatcher(
  options: DeliveryMergeWatcherOptions,
): DeliveryMergeWatcher {
  const intervalMs = options.intervalMs ?? DEFAULT_DELIVERY_WATCH_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_DELIVERY_WATCH_BATCH;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<DeliveryWatchReport> | undefined;

  const scanOnce = async (): Promise<DeliveryWatchReport> => {
    const report = emptyReport();
    for (const delivery of options.machine.listAllDeliveries()) {
      if (report.scanned >= batchSize) {
        break;
      }
      // Only a completed provider write has a PR to observe. `partial`,
      // `unknown`, and `failed` deliveries are not merge candidates.
      if (delivery.state !== "delivered" || delivery.pr_id === null) {
        continue;
      }
      if (options.capture.jobs.list({ delivery_id: delivery.delivery_id }).length > 0) {
        // Already captured (or attempted): the outcome outbox owns it now.
        report.skipped += 1;
        continue;
      }
      const candidate = options.machine.getCandidate(delivery.candidate_id);
      const run = candidate === undefined ? undefined : options.machine.getRun(candidate.run_id);
      if (candidate === undefined || run === undefined || run.task_id === null) {
        // The delivery cannot be attributed to a server-side task/workspace;
        // capturing it would invent an owner.
        report.skipped += 1;
        continue;
      }
      report.scanned += 1;
      const provider: DeliveryProvider | undefined = options.providerFor(delivery.provider);
      if (provider === undefined) {
        report.unreadable += 1;
        continue;
      }
      const branch = delivery.branch ?? autofixerBranchFor(delivery.issue_id);
      let observed;
      try {
        observed = await provider.findPullRequest(
          delivery.repository,
          branch,
          delivery.head_sha,
          delivery.target_branch,
        );
      } catch {
        report.unreadable += 1;
        continue;
      }
      const state = observed?.state ?? "unobserved";
      options.onObserved?.(delivery.delivery_id, state);
      if (
        observed === null ||
        observed.state !== "merged" ||
        observed.pr_id !== delivery.pr_id ||
        observed.head_sha !== delivery.head_sha ||
        observed.branch !== branch ||
        observed.base_ref !== delivery.target_branch
      ) {
        report.skipped += 1;
        continue;
      }
      const registration: DeliveryTerminalRegistration = {
        enterprise_id: candidate.workspace.enterprise_id,
        workspace_id: candidate.workspace.workspace_id,
        task_id: run.task_id,
        run_id: candidate.run_id,
        delivery_id: delivery.delivery_id,
      };
      if (options.capture.enqueueDelivery(registration) !== null) {
        report.enqueued += 1;
      } else {
        report.skipped += 1;
      }
    }
    return report;
  };

  const scan = (): Promise<DeliveryWatchReport> => {
    if (active !== undefined) {
      return active;
    }
    active = scanOnce().finally(() => {
      active = undefined;
    });
    return active;
  };

  return {
    scan,
    start() {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void scan().catch((error: unknown) => options.onError?.(error));
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
