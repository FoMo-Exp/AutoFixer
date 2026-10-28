import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

import { TURN_REPORT_TOOL_NAME, turnReportSchema, validateTurnReport } from "./turn-report.js";
import type { TurnReport, TurnReportParams } from "./turn-report.js";

export interface TurnReportDetails {
  recorded: boolean;
}

export interface TurnSummaryReportToolOptions {
  /**
   * Receives one validated report for the currently open turn. The tracker
   * records it as the turn's display source; an invalid report never
   * reaches this callback.
   */
  onReport: (report: TurnReport) => void;
}

/**
 * The Pi session's reporting tool: a Node-local recorder, not an action.
 *
 * It executes nothing — no dsh call, no filesystem, no network, no widened
 * grant. Its only effect is validating the model's closed-vocabulary
 * report of the current turn and handing it to the summary tracker, which
 * becomes the turn's display source (DAT-193). A report that fails
 * validation throws, so the model sees the refusal and the turn settles
 * without a report: unknown or invalid reports fail closed.
 */
export function createTurnSummaryReportTool(
  options: TurnSummaryReportToolOptions,
): AgentTool<typeof turnReportSchema, TurnReportDetails> {
  return {
    name: TURN_REPORT_TOOL_NAME,
    label: "Report the turn summary",
    description:
      "Record a structured report of this turn's work for display. This tool " +
      "executes nothing: it has no effect on the repository or the run. Every " +
      "parameter is a closed enum — there is no free-text field — and only a " +
      "report that follows the vocabulary exactly is recorded. Call it once per " +
      "turn, describing the specific work of that turn; free text you write is " +
      "never displayed, and a turn without a valid report shows no summary.",
    parameters: turnReportSchema,
    execute: async (
      _toolCallId: string,
      params: TurnReportParams,
    ): Promise<AgentToolResult<TurnReportDetails>> => {
      const report = validateTurnReport(params);
      if (report === null) {
        // The provider-side schema is descriptive only; this is the server-
        // side gate. Throwing gives the model an error result it can answer,
        // while the turn still settles without a recorded report.
        throw new Error(
          `${TURN_REPORT_TOOL_NAME}: invalid report; use only the closed vocabulary keys it defines`,
        );
      }
      options.onReport(report);
      return {
        content: [{ type: "text", text: "Report recorded for this turn." }],
        details: { recorded: true },
      };
    },
  };
}
