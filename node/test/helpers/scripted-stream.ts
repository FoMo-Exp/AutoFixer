import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent, ToolCall } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

/** Deterministic stand-in for a live model; good enough for Agent state. */
export const TEST_MODEL: Model<Api> = {
  id: "scripted",
  name: "scripted",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface Gate {
  promise: Promise<void>;
  release: () => void;
}

export function makeGate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: resolve };
}

export type ScriptedTurn =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      text?: string;
      toolId: string;
      args: Record<string, unknown>;
      pathScope: string[];
      rationale?: string;
    }
  /** Never completes on its own; finishes only when the session is aborted. */
  | { kind: "hang" }
  /** Completes when the gate is released; lets tests interleave API calls. */
  | { kind: "gate"; text: string; gate: Gate };

export interface ScriptedStream {
  streamFn: StreamFn;
  /** LLM-visible message content per stream call, for delivery assertions. */
  calls: string[][];
}

function assistantBase(): Omit<AssistantMessage, "content" | "stopReason"> {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "scripted",
    usage: EMPTY_USAGE,
    timestamp: Date.now(),
  };
}

function abortedMessage(): AssistantMessage {
  return {
    ...assistantBase(),
    content: [{ type: "text", text: "" }],
    stopReason: "aborted",
    errorMessage: "aborted",
  };
}

/**
 * Build a StreamFn that replays scripted turns instead of calling a model.
 * The real pi-agent-core loop, tool validation, and event subscription run
 * unchanged; only inference is scripted.
 */
export function scriptedStream(turns: ScriptedTurn[]): ScriptedStream {
  const calls: string[][] = [];
  let index = 0;

  const streamFn: StreamFn = (_model, context, options) => {
    calls.push(context.messages.map((message) => JSON.stringify(message.content)));
    const stream = createAssistantMessageEventStream();
    const turn = turns[index];
    index += 1;

    const emitText = (text: string, stopReason: "stop" | "toolUse"): void => {
      const content: TextContent[] = [{ type: "text", text }];
      stream.push({ type: "start", partial: { ...assistantBase(), content: [], stopReason } });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...assistantBase(), content, stopReason },
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial: { ...assistantBase(), content, stopReason },
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: text,
        partial: { ...assistantBase(), content, stopReason },
      });
    };

    if (!turn || turn.kind === "text" || turn.kind === "gate") {
      const text = turn?.text ?? "script exhausted";
      queueMicrotask(() => {
        if (turn?.kind === "gate") {
          const onAbort = (): void => {
            stream.push({ type: "error", reason: "aborted", error: abortedMessage() });
          };
          if (options?.signal?.aborted) {
            onAbort();
            return;
          }
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          void turn.gate.promise.then(() => {
            options?.signal?.removeEventListener("abort", onAbort);
            if (options?.signal?.aborted) {
              return;
            }
            emitText(text, "stop");
            stream.push({
              type: "done",
              reason: "stop",
              message: {
                ...assistantBase(),
                content: [{ type: "text", text }],
                stopReason: "stop",
              },
            });
          });
          return;
        }
        emitText(text, "stop");
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            ...assistantBase(),
            content: [{ type: "text", text }],
            stopReason: "stop",
          },
        });
      });
      return stream;
    }

    if (turn.kind === "hang") {
      const onAbort = (): void => {
        stream.push({ type: "error", reason: "aborted", error: abortedMessage() });
      };
      if (options?.signal?.aborted) {
        onAbort();
        return stream;
      }
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      return stream;
    }

    // Tool turn: optional preamble text, then one dsh_request_action call.
    const toolCall: ToolCall = {
      type: "toolCall",
      id: `call_${index}`,
      name: "dsh_request_action",
      arguments: {
        tool_id: turn.toolId,
        arguments: turn.args,
        path_scope: turn.pathScope,
        rationale: turn.rationale ?? "scripted request",
      },
    };
    const finalContent: (TextContent | ToolCall)[] = [];
    if (turn.text) {
      finalContent.push({ type: "text", text: turn.text });
    }
    finalContent.push(toolCall);
    queueMicrotask(() => {
      if (turn.text) {
        emitText(turn.text, "toolUse");
      } else {
        stream.push({
          type: "start",
          partial: { ...assistantBase(), content: [], stopReason: "toolUse" },
        });
      }
      const contentIndex = finalContent.length - 1;
      const partial = {
        ...assistantBase(),
        content: [...finalContent],
        stopReason: "toolUse" as const,
      };
      stream.push({ type: "toolcall_start", contentIndex, partial });
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
      stream.push({
        type: "done",
        reason: "toolUse",
        message: { ...assistantBase(), content: finalContent, stopReason: "toolUse" },
      });
    });
    return stream;
  };

  return { streamFn, calls };
}
