import type { components, operations } from "./contracts/schema";

export type Task = components["schemas"]["Task"];
export type TaskEvent = components["schemas"]["TaskEvent"];
export type RunSummary = components["schemas"]["RunSummary"];
export type ArtifactMetadata = components["schemas"]["ArtifactMetadata"];
export type TaskStatus = Task["status"];
export type TaskPage = operations["listTasks"]["responses"][200]["content"]["application/json"];

type ErrorPayload = components["schemas"]["Error"];
type JsonFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, payload: ErrorPayload | undefined, fallback: string) {
    super(payload?.error.message || fallback);
    this.name = "ApiError";
    this.status = status;
    this.code = payload?.error.code || "REQUEST_FAILED";
    this.retryable = payload?.error.retryable ?? status >= 500;
  }
}

export class ApiConfigurationError extends Error {
  constructor(message = "Node service endpoint is not configured for this workbench.") {
    super(message);
    this.name = "ApiConfigurationError";
  }
}

export function isLoopbackApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export interface ForgePilotClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: JsonFetch;
}

export interface CreateTaskInput {
  repository_id: string;
  base_ref: string;
  summary: string;
  source_reference?: string;
  acceptance_criteria?: string[];
}

export interface ApprovalInput {
  decision: "approve" | "reject";
  scope_digest: string;
}

export interface StreamOptions {
  lastEventId?: string;
  signal?: AbortSignal;
  onEvent: (event: TaskEvent) => void;
}

export interface StreamResult {
  lastEventId: string | undefined;
  terminal: boolean;
}

export class ForgePilotClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: JsonFetch;

  constructor(options: ForgePilotClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listTasks(status?: TaskStatus): Promise<TaskPage> {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request<TaskPage>(`/api/v1/tasks${params}`);
  }

  async createTask(input: CreateTaskInput, idempotencyKey: string): Promise<Task> {
    return this.request<Task>("/api/v1/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    });
  }

  async getTask(taskId: string): Promise<Task> {
    return this.request<Task>(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async getRuns(taskId: string): Promise<RunSummary[]> {
    const result = await this.request<
      operations["getTaskRuns"]["responses"][200]["content"]["application/json"]
    >(`/api/v1/tasks/${encodeURIComponent(taskId)}/runs`);
    return result.items;
  }

  async sendMessage(
    taskId: string,
    input: operations["sendMessage"]["requestBody"]["content"]["application/json"],
  ): Promise<{ task_id: string; queued: boolean }> {
    return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async approveTask(taskId: string, input: ApprovalInput): Promise<Task> {
    return this.request<Task>(`/api/v1/tasks/${encodeURIComponent(taskId)}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async cancelTask(taskId: string, reason?: string): Promise<Task> {
    return this.request<Task>(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: reason ? JSON.stringify({ reason }) : undefined,
    });
  }

  async getTimeline(taskId: string): Promise<TaskEvent[]> {
    const result = await this.request<
      operations["getTaskTimeline"]["responses"][200]["content"]["application/json"]
    >(`/api/v1/tasks/${encodeURIComponent(taskId)}/timeline`);
    return result.items;
  }

  async getArtifact(taskId: string, artifactId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
  }

  async streamTaskEvents(taskId: string, options: StreamOptions): Promise<StreamResult> {
    const headers = this.headers({ Accept: "text/event-stream" });
    if (options.lastEventId) headers["Last-Event-ID"] = options.lastEventId;

    const response = await this.raw(`/api/v1/tasks/${encodeURIComponent(taskId)}/stream`, {
      headers,
      signal: options.signal,
    });
    if (!response.ok)
      throw await this.errorFromResponse(response, "Unable to connect to task stream.");
    if (!response.body) throw new Error("Task stream returned no readable body.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastEventId = options.lastEventId;
    let terminal = false;

    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        const parsed = takeSseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          const event = parseSseFrame(frame);
          if (!event) continue;
          lastEventId = event.event_id;
          terminal ||= event.type === "task.terminal";
          options.onEvent(event);
        }
        if (chunk.done) break;
      }
    } finally {
      reader.releaseLock();
    }

    return { lastEventId, terminal };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.baseUrl) throw new ApiConfigurationError();
    if (!isLoopbackApiUrl(this.baseUrl)) {
      throw new ApiConfigurationError("ForgePilot only permits an HTTP loopback Node service.");
    }
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      redirect: "error",
      headers: {
        ...this.headers(),
        ...init.headers,
      },
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(path, init);
    if (!response.ok) throw await this.errorFromResponse(response, "Node service request failed.");
    return (await response.json()) as T;
  }

  private async errorFromResponse(response: Response, fallback: string): Promise<ApiError> {
    let payload: ErrorPayload | undefined;
    try {
      payload = (await response.json()) as ErrorPayload;
    } catch {
      // Keep the status-specific fallback when the server closes without JSON.
    }
    return new ApiError(response.status, payload, fallback);
  }
}

interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

export function takeSseFrames(input: string): { frames: string[]; rest: string } {
  let remainder = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frames: string[] = [];
  let boundary = remainder.indexOf("\n\n");
  while (boundary >= 0) {
    frames.push(remainder.slice(0, boundary));
    remainder = remainder.slice(boundary + 2);
    boundary = remainder.indexOf("\n\n");
  }
  return { frames, rest: remainder };
}

export function parseSseFrame(frame: string): TaskEvent | undefined {
  const parsed: SseFrame = { data: "" };
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "id") parsed.id = value;
    if (field === "event") parsed.event = value;
    if (field === "data") parsed.data = parsed.data ? `${parsed.data}\n${value}` : value;
  }
  if (!parsed.data) return undefined;

  try {
    const event = JSON.parse(parsed.data) as Partial<TaskEvent>;
    if (!event.event_id && parsed.id) event.event_id = parsed.id;
    if (!event.type && parsed.event) event.type = parsed.event as TaskEvent["type"];
    if (
      typeof event.event_id !== "string" ||
      typeof event.sequence !== "number" ||
      typeof event.occurred_at !== "string" ||
      typeof event.task_id !== "string" ||
      typeof event.task_version !== "number" ||
      typeof event.type !== "string" ||
      !event.data
    ) {
      return undefined;
    }
    return event as TaskEvent;
  } catch {
    return undefined;
  }
}
