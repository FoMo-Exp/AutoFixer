import { randomUUID } from "node:crypto";

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";

import type { DshClient } from "../dsh/client.js";
import { DshError } from "../dsh/client.js";
import type { DshState } from "../dsh/types.js";

export const dshRequestActionSchema = Type.Object({
  tool_id: Type.String({
    description:
      'Registered dsh tool identity to request, for example "echo" or "sleep". Never a shell or command name.',
  }),
  arguments: Type.Record(Type.String(), Type.Unknown(), {
    description:
      "Structured arguments for the requested tool; each value must be an allowed enum member.",
  }),
  path_scope: Type.Array(Type.String(), {
    minItems: 1,
    description: "Repository-relative paths this action touches. Missing scope means denied.",
  }),
  network_destinations: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Network destinations this action needs. Normally empty; anything outside the grant is denied.",
    }),
  ),
  rationale: Type.String({
    description: "Why this action is needed for the task.",
  }),
});

export type DshRequestActionParams = Static<typeof dshRequestActionSchema>;

export interface DshRequestActionDetails {
  action_id: string;
  state?: DshState;
  audit_event_reference?: string;
}

/** One observed dsh decision for a requested action, forwarded to the task timeline. */
export interface ActionObservation {
  toolCallId: string;
  toolId: string;
  pathScope: string[];
  outcome: "accepted" | "denied";
  actionId: string;
  state?: DshState;
  errorCode?: string;
  errorMessage?: string;
}

export type ActionObserver = (observation: ActionObservation) => void;

export interface DshRequestActionToolOptions {
  client: DshClient;
  runId: string;
  /** Pi session identifier recorded on every submitted intent. */
  sessionId: string;
  /** Turn identifier recorded on every submitted intent. */
  getTurnId: () => string;
  /** Sink for accepted/denied observations; DI boundary for the task event log. */
  observe: ActionObserver;
}

/**
 * The single Pi tool: an intent forwarder to dsh-control/v1.
 *
 * Pi holds no executor with this tool — no shell, no file edits, no network.
 * Every call becomes a structured action intent that dsh re-checks against the
 * run's allow-list and capability grant before anything runs. A dsh refusal is
 * returned to the model as an error result and observed by the task timeline,
 * so refusals surface in Node task state instead of silently disappearing.
 */
export function createDshRequestActionTool(
  options: DshRequestActionToolOptions,
): AgentTool<typeof dshRequestActionSchema, DshRequestActionDetails> {
  return {
    name: "dsh_request_action",
    label: "Request a dsh action",
    description:
      "Request one allow-listed remediation action through the dsh control plane. " +
      "This is the only capability you have: you cannot run commands, edit files, or " +
      "reach the network directly. dsh independently checks the run's allow-list and " +
      "capability grant, then executes the action in an isolated sandbox. A denied " +
      "request is final for that intent; adapt and continue or stop.",
    parameters: dshRequestActionSchema,
    execute: async (
      toolCallId: string,
      params: DshRequestActionParams,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<DshRequestActionDetails>> => {
      const actionId = `act_${randomUUID().replace(/-/g, "")}`;
      const networkDestinations = params.network_destinations ?? [];
      try {
        const response = await options.client.submitAction(
          options.runId,
          {
            action_id: actionId,
            agent: {
              runtime: "pi",
              session_id: options.sessionId,
              turn_id: options.getTurnId(),
            },
            intent: {
              tool_id: params.tool_id,
              arguments: params.arguments,
              path_scope: params.path_scope,
              network_destinations: networkDestinations,
              rationale: params.rationale,
            },
          },
          actionId,
        );
        options.observe({
          toolCallId,
          toolId: params.tool_id,
          pathScope: params.path_scope,
          outcome: "accepted",
          actionId,
          state: response.state,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `dsh accepted action ${actionId} for tool "${params.tool_id}" (run state: ${response.state}). ` +
                `Execution evidence: ${response.audit_event_reference}.`,
            },
          ],
          details: {
            action_id: response.action_id,
            state: response.state,
            audit_event_reference: response.audit_event_reference,
          },
        };
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        if (!(error instanceof DshError)) {
          throw error;
        }
        options.observe({
          toolCallId,
          toolId: params.tool_id,
          pathScope: params.path_scope,
          outcome: "denied",
          actionId,
          errorCode: error.code,
          errorMessage: error.message,
        });
        // Denied intents are thrown so the agent loop records an error tool
        // result: the model must see the refusal, and the task timeline has
        // already recorded it through observe().
        throw new Error(
          `dsh denied action ${actionId} for tool "${params.tool_id}": ${error.code} — ${error.message}`,
        );
      }
    },
  };
}
