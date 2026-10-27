import type { AgentTool, StreamFn } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import type { Api, Model, UserMessage } from "@mariozechner/pi-ai";

/** Events the session forwards to the owning task's timeline. */
export type PiSessionEvent =
  | { type: "run_started" }
  | { type: "text_delta"; delta: string }
  | { type: "tool_started"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_finished"; toolCallId: string; toolName: string; isError: boolean }
  /**
   * `agent_settled` is ForgePilot's mapping of the Pi run lifecycle: pi's
   * `agent_end` plus settlement of every awaited listener, i.e. the point
   * `waitForIdle()` resolves. The task layer treats it as "this turn is
   * complete; project the next task state".
   */
  | { type: "agent_settled" }
  | { type: "agent_error"; message: string };

export type PiSessionEventListener = (event: PiSessionEvent) => void;

export interface PiSessionOptions {
  sessionId: string;
  systemPrompt: string;
  model: Model<Api>;
  /** Only the provided tools exist for the session; no Pi defaults are loaded. */
  tools: AgentTool[];
  listener: PiSessionEventListener;
  /**
   * Injectable stream function. Defaults to pi-ai's live `streamSimple`;
   * tests inject a deterministic script instead of a model.
   */
  streamFn?: StreamFn;
  /**
   * Resolves the provider API key at call time (pi-ai's `getEnvApiKey` in
   * production). Unset means no key: live streaming will fail closed.
   */
  getApiKey?: (provider: string) => string | undefined;
}

function userMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

/**
 * One Pi agent session bound to one remediation run.
 *
 * Wraps pi-agent-core's Agent with the ForgePilot event mapping. The session
 * never loads Pi's terminal, file-edit, or any other default tool: the caller
 * registers exactly the tools the run may exercise, and in this milestone that
 * is only `dsh_request_action`.
 */
export class PiSession {
  readonly sessionId: string;
  private readonly agent: Agent;
  private readonly listener: PiSessionEventListener;
  private turnId = 0;
  private disposed = false;

  constructor(options: PiSessionOptions) {
    this.sessionId = options.sessionId;
    this.listener = options.listener;
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        tools: options.tools,
      },
      ...(options.streamFn ? { streamFn: options.streamFn } : {}),
      ...(options.getApiKey ? { getApiKey: options.getApiKey } : {}),
    });
    this.agent.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent.type === "text_delta") {
            this.listener({ type: "text_delta", delta: assistantEvent.delta });
          }
          break;
        }
        case "tool_execution_start":
          this.listener({
            type: "tool_started",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          break;
        case "tool_execution_end":
          this.listener({
            type: "tool_finished",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
          });
          break;
        default:
          break;
      }
    });
  }

  /** Current turn identifier, recorded on submitted action intents. */
  currentTurnId(): string {
    return `turn_${this.turnId}`;
  }

  get running(): boolean {
    return this.agent.state.isStreaming;
  }

  /**
   * Run one prompt to settlement. Resolves after the Pi run fully settles
   * (agent_end plus awaited listeners), which the listener observes as
   * `agent_settled`; a failed run resolves too, with `agent_error` emitted.
   */
  async runPrompt(content: string): Promise<void> {
    if (this.disposed) {
      throw new Error(`Pi session ${this.sessionId} is disposed`);
    }
    if (this.agent.state.isStreaming) {
      throw new Error(`Pi session ${this.sessionId} is already running; use steer or followUp`);
    }
    this.turnId += 1;
    this.listener({ type: "run_started" });
    try {
      await this.agent.prompt(content);
      await this.agent.waitForIdle();
    } catch (error) {
      this.listener({
        type: "agent_error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.agent.state.errorMessage) {
      this.listener({ type: "agent_error", message: this.agent.state.errorMessage });
    }
    this.listener({ type: "agent_settled" });
  }

  /** Queue a steering message: delivered after the current assistant turn. */
  async steer(content: string): Promise<void> {
    this.agent.steer(userMessage(content));
  }

  /** Queue a follow-up message: delivered only after the agent would stop. */
  async followUp(content: string): Promise<void> {
    this.agent.followUp(userMessage(content));
  }

  /** Abort any in-flight run; queued messages stay queued. */
  abort(): void {
    this.agent.abort();
  }

  dispose(): void {
    this.abort();
    this.agent.clearAllQueues();
    this.disposed = true;
  }
}
