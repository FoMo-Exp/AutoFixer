import type { TaskEvent } from "../../src/api/task-store.js";

/**
 * Bearer token injected into every request. Each orchestrator mints its own
 * per-process token; tests run sequentially, so startApp sets the current
 * one before any request is issued.
 */
let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token;
}

function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

/** Poll until the predicate holds; fails the test on timeout. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting until: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(), ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** Raw POST with full control over headers/body — for auth/CSRF negative tests. */
export async function postRaw(
  url: string,
  init: { headers?: Record<string, string>; body?: string },
): Promise<JsonResponse<unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), ...init.headers },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

export async function getJson<T = unknown>(url: string): Promise<JsonResponse<T>> {
  const response = await fetch(url, { headers: authHeaders() });
  return { status: response.status, body: (await response.json()) as T };
}

export interface SseFrame {
  id?: string;
  event?: string;
  data: TaskEvent | undefined;
}

export interface SseReadResult {
  frames: SseFrame[];
  /**
   * True when the server ended the stream; false when the client gave up
   * (untilType matched, or the deadline hit a dangling connection).
   */
  closedByServer: boolean;
}

/**
 * Read an SSE stream and also report whether the server closed it. A stream
 * that only ends by aborting the fetch is a dangling connection — the failure
 * mode of subscribing a client to a task that can never emit again.
 */
export async function readSseResult(
  url: string,
  options: { lastEventId?: string; untilType?: string; timeoutMs?: number } = {},
): Promise<SseReadResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  const frames: SseFrame[] = [];
  try {
    const response = await fetch(url, {
      headers: {
        ...authHeaders(),
        ...(options.lastEventId ? { "Last-Event-ID": options.lastEventId } : {}),
      },
      signal: controller.signal,
    });
    if (response.status !== 200 || response.body === null) {
      throw new Error(`SSE stream returned ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        // The response body ended without an abort: the server closed it.
        return { frames, closedByServer: true };
      }
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const frame: SseFrame = { data: undefined };
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) {
            frame.id = line.slice(4);
          } else if (line.startsWith("event: ")) {
            frame.event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            frame.data = JSON.parse(line.slice(6));
          }
        }
        if (frame.event !== undefined) {
          frames.push(frame);
          if (options.untilType && frame.event === options.untilType) {
            controller.abort();
            return { frames, closedByServer: false };
          }
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { frames, closedByServer: false };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read an SSE stream, optionally replaying after Last-Event-ID, and collect
 * frames until `untilType` is seen (or the stream ends / timeout elapses).
 */
export async function readSse(
  url: string,
  options: { lastEventId?: string; untilType?: string; timeoutMs?: number } = {},
): Promise<SseFrame[]> {
  const { frames } = await readSseResult(url, options);
  return frames;
}
