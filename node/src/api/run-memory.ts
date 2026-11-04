/**
 * Run-start memory assembly (DAT-238).
 *
 * Before a remediation run plans, the orchestrator resolves the run's pinned
 * memory and retrieval-policy identity, assembles a bounded, cited bundle, and
 * renders it as untrusted reference data in the system prompt. A run selected
 * for a canary receives the unpublished candidate policy as an overlay; the
 * baseline arm names the stored policy version explicitly.
 *
 * This is the only production consumer of `RsiService.resolveRunVersions`.
 * Memory is advisory: a failure here degrades the run to policy-only and is
 * recorded on the task, it never blocks or invents lessons.
 */

import type { WorkspaceScope } from "../control-plane/types.js";
import type { MemoryBundle, MemoryRetrievalService, RsiService } from "../memory/index.js";
import type { TaskMemoryRef, TaskRecord } from "./task-store.js";

export interface RunMemoryDeps {
  memory: MemoryRetrievalService;
  rsi: RsiService;
}

export interface RunMemoryContext {
  /** Rendered memory fence; empty when memory is unavailable or unconfigured. */
  system_prompt: string;
  ref: TaskMemoryRef | null;
}

function degradedRef(runId: string): TaskMemoryRef {
  return {
    run_id: runId,
    memory_version: null,
    policy_version: null,
    policy_hash: null,
    canary: false,
    rollout_id: null,
    bundle_id: null,
    degraded: true,
    item_ids: [],
  };
}

function citedIds(bundle: MemoryBundle): string[] {
  return [
    ...bundle.policy_items,
    ...bundle.lessons,
    ...bundle.episodes,
    ...bundle.facts,
    ...bundle.candidates,
  ].map((item) => item.item_id);
}

/**
 * Resolve and render memory for one run. Returns a null ref when memory is not
 * configured for this process; a degraded ref when the memory service fails.
 */
export function assembleRunMemory(
  deps: RunMemoryDeps,
  scope: WorkspaceScope,
  record: TaskRecord,
): RunMemoryContext {
  if (record.runId === null) {
    return { system_prompt: "", ref: null };
  }
  const runId = record.runId;
  try {
    const pin = deps.rsi.resolveRunVersions(scope, runId);
    const request = {
      purpose: "run_plan" as const,
      query: [record.summary, ...record.acceptanceCriteria].join("\n"),
      run_id: runId,
      role: "member" as const,
      policy_version: pin.policy_version,
    };
    const bundle =
      pin.policy !== null
        ? deps.memory.previewBundle(scope, request, pin.policy)
        : deps.memory.search(scope, request);
    return {
      system_prompt: deps.memory.renderPrompt(bundle),
      ref: {
        run_id: runId,
        memory_version: bundle.version.memory_version,
        policy_version: bundle.version.policy_version,
        policy_hash: bundle.version.policy_hash,
        canary: pin.canary,
        rollout_id: pin.rollout_id,
        bundle_id: bundle.bundle_id,
        degraded: bundle.degraded,
        item_ids: citedIds(bundle),
      },
    };
  } catch {
    // Memory outage degrades the run; dsh and the grant are unchanged.
    return { system_prompt: "", ref: degradedRef(runId) };
  }
}
