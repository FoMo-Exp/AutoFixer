import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

/**
 * The preparation-completion signal (DAT-258).
 *
 * A settled turn is not the end of a task: the same Pi session may be steered
 * or receive follow-up messages, and every turn settles on its own. Completion
 * is therefore the agent's explicit declaration that the requested work is
 * finished, delivered as one model-chosen tool call. The tool itself executes
 * nothing: it asks the orchestrator to stop the run, and dsh remains the only
 * authority that revokes the grant and freezes the prepared revision. Work
 * that was never validated on the frozen tree is not preserved as a reviewable
 * candidate, so a premature declaration cannot manufacture one.
 */

/** Tool name registered on the Pi session alongside the action and report tools. */
export const COMPLETE_PREPARATION_TOOL_NAME = "complete_local_preparation";

/** The authoritative answer dsh gave the orchestrator for this completion. */
export interface PreparationCompletion {
  state: string;
  stopped: boolean;
  /**
   * True only when a validated revision was frozen: the run has a diff,
   * changed paths, and passing test evidence for that exact tree.
   */
  prepared: boolean;
}

export interface CompletePreparationDetails {
  state: string;
  stopped: boolean;
  prepared: boolean;
}

export interface CompletePreparationToolOptions {
  /**
   * Ask the orchestrator to complete local preparation. Resolves with dsh's
   * authoritative stop result; a rejected promise is reported to the model as
   * a failed tool call, never as a completion.
   */
  complete: () => Promise<PreparationCompletion>;
}

/** The tool takes no parameters: completing a run is not argument-shaped. */
export const completePreparationSchema = Type.Object({});

export function createCompletePreparationTool(
  options: CompletePreparationToolOptions,
): AgentTool<typeof completePreparationSchema, CompletePreparationDetails> {
  return {
    name: COMPLETE_PREPARATION_TOOL_NAME,
    label: "Complete local preparation",
    description:
      "Signal that the requested local preparation is finished. Call this once, " +
      "as the final action of the task, only after the change is implemented and " +
      "the required tests have passed against the current tree. The orchestrator " +
      "asks dsh to stop the run and freeze the prepared revision as a candidate " +
      "for human review. This is not a cancel: it preserves validated work, and " +
      "it cannot freeze work that has no passing test evidence.",
    parameters: completePreparationSchema,
    execute: async (): Promise<AgentToolResult<CompletePreparationDetails>> => {
      const result = await options.complete();
      const text = result.prepared
        ? "Local preparation completed: the run is stopped and the validated revision " +
          "is frozen as a candidate for human review. Do not request further actions."
        : "Local preparation stopped without a reviewable candidate: the run had no " +
          "passing validation evidence for a prepared revision, so a human must " +
          "disposition the stop. Do not request further actions.";
      return {
        content: [{ type: "text", text }],
        details: {
          state: result.state,
          stopped: result.stopped,
          prepared: result.prepared,
        },
      };
    },
  };
}
