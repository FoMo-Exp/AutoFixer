import type { components, operations } from "./contracts/schema";

export type Task = components["schemas"]["Task"];
export type TaskEvent = components["schemas"]["TaskEvent"];
export type PiSummary = components["schemas"]["PiSummary"];
export type RunSummary = components["schemas"]["RunSummary"];
export type ArtifactMetadata = components["schemas"]["ArtifactMetadata"];
export type TaskStatus = Task["status"];
export type TaskPage = operations["listTasks"]["responses"][200]["content"]["application/json"];

export type Workspace = components["schemas"]["Workspace"];
export type Issue = components["schemas"]["Issue"];
export type IssueStage = components["schemas"]["IssueStage"];
export type IssueTask = components["schemas"]["IssueTask"];
export type IssueRun = components["schemas"]["IssueRun"];
export type IssueEvent = components["schemas"]["IssueEvent"];
export type ProductState = Issue["product_state"];
export type IssueTaskState = IssueTask["state"];
export type IssueRunState = IssueRun["state"];
export type IssueStageTransition =
  operations["transitionIssueStage"]["requestBody"]["content"]["application/json"];
export type IssuePage = operations["listIssues"]["responses"][200]["content"]["application/json"];
export type IssueTaskPage =
  operations["listIssueTasks"]["responses"][200]["content"]["application/json"];
export type IssueRunPage =
  operations["listIssueRuns"]["responses"][200]["content"]["application/json"];

type ErrorPayload = components["schemas"]["Error"];
export type JsonFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  /** Trace/case reference from the shared envelope; quote it in support cases. */
  readonly requestId: string | undefined;
  readonly nextAction: string | null | undefined;
  readonly retryAfterSeconds: number | null | undefined;
  readonly details: Record<string, unknown>;

  constructor(status: number, payload: ErrorPayload | undefined, fallback: string) {
    super(payload?.error.message || fallback);
    this.name = "ApiError";
    this.status = status;
    this.code = payload?.error.code || "REQUEST_FAILED";
    this.retryable = payload?.error.retryable ?? status >= 500;
    this.requestId = payload?.error.request_id;
    this.nextAction = payload?.error.next_action;
    this.retryAfterSeconds = payload?.error.retry_after_seconds;
    this.details = payload?.error.details ?? {};
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

export interface ApiTransportOptions {
  baseUrl: string;
  /** Desktop bearer credential. Empty for cookie-authenticated browsers. */
  token: string;
  fetchImpl?: JsonFetch;
  /** Reads the session CSRF token supplied with cookie-authenticated writes. */
  csrfToken?: () => string | undefined;
  /** Refreshes a rejected CSRF token from `GET /api/v1/auth/session`. */
  refreshCsrfToken?: () => Promise<string | undefined>;
  onUnauthorized?: (error: ApiError) => void;
  onForbidden?: (error: ApiError) => void;
}

export type ForgePilotClientOptions = ApiTransportOptions;

/**
 * Loopback-only HTTP transport shared by the task surface and the identity
 * surface: one place enforces the loopback guard, redirect refusal, bearer
 * attachment, the session cookie, CSRF echo/refresh, and the shared error
 * envelope.
 */
export class ApiTransport {
  protected readonly baseUrl: string;
  private readonly token: string;
  private readonly csrfToken?: () => string | undefined;
  private readonly refreshCsrfToken?: () => Promise<string | undefined>;
  private readonly onUnauthorized?: (error: ApiError) => void;
  private readonly onForbidden?: (error: ApiError) => void;
  protected readonly fetchImpl: JsonFetch;

  constructor(options: ApiTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    // Bind the window method: Chromium rejects an unbound `fetch` invoked as an
    // object property ("Illegal invocation").
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.csrfToken = options.csrfToken;
    this.refreshCsrfToken = options.refreshCsrfToken;
    this.onUnauthorized = options.onUnauthorized;
    this.onForbidden = options.onForbidden;
  }

  protected headers(
    extra: Record<string, string> = {},
    method = "GET",
    csrfOverride?: string,
  ): Record<string, string> {
    const mutating = method !== "GET" && method !== "HEAD";
    const csrf = !this.token && mutating ? (csrfOverride ?? this.csrfToken?.()) : undefined;
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...extra,
    };
  }

  protected async raw(
    path: string,
    init: RequestInit = {},
    allowCsrfRetry = true,
    csrfOverride?: string,
  ): Promise<Response> {
    if (!this.baseUrl) throw new ApiConfigurationError();
    if (!isLoopbackApiUrl(this.baseUrl)) {
      throw new ApiConfigurationError("ForgePilot only permits an HTTP loopback Node service.");
    }
    const method = (init.method ?? "GET").toUpperCase();
    const usedCsrf = this.headers({}, method, csrfOverride)["X-CSRF-Token"];
    const headers = {
      ...this.headers({}, method, csrfOverride),
      ...headerRecord(init.headers),
    };
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      // Cookie sessions need cross-origin credentials so a loopback API on a
      // different port still receives fp_session; bearer transports omit
      // cookies entirely. Electron's IPC fetch ignores the field and attaches
      // its own bearer credential in the main process.
      credentials: this.token ? "omit" : "include",
      redirect: "error",
      headers,
    });

    // A cookie session's CSRF token can rotate (for example after another
    // tab signs in again). The contract reports a missing or wrong token as
    // 403 CSRF_TOKEN_INVALID: refresh and retry that mutating request exactly
    // once. A genuine authority denial (FORBIDDEN) never triggers a retry.
    if (
      allowCsrfRetry &&
      !this.token &&
      method !== "GET" &&
      method !== "HEAD" &&
      response.status === 403 &&
      this.refreshCsrfToken !== undefined
    ) {
      const payload = (await response
        .clone()
        .json()
        .catch(() => undefined)) as ErrorPayload | undefined;
      if (payload?.error.code === "CSRF_TOKEN_INVALID") {
        const refreshed = await this.refreshCsrfToken();
        if (refreshed && refreshed !== usedCsrf) {
          return this.raw(path, init, false, refreshed);
        }
      }
    }
    return response;
  }

  protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(path, init);
    if (!response.ok) {
      const error = await errorFromResponse(response, "Node service request failed.");
      this.notifyAuthFailure(error);
      throw error;
    }
    return (await response.json()) as T;
  }

  protected async requestNoContent(path: string, init: RequestInit = {}): Promise<void> {
    const response = await this.raw(path, init);
    if (!response.ok) {
      const error = await errorFromResponse(response, "Node service request failed.");
      this.notifyAuthFailure(error);
      throw error;
    }
  }

  protected notifyAuthFailure(error: ApiError): void {
    if (error.status === 401) this.onUnauthorized?.(error);
    else if (error.status === 403) this.onForbidden?.(error);
  }
}

async function errorFromResponse(response: Response, fallback: string): Promise<ApiError> {
  let payload: ErrorPayload | undefined;
  try {
    payload = (await response.json()) as ErrorPayload;
  } catch {
    // Keep the status-specific fallback when the server closes without JSON.
  }
  return new ApiError(response.status, payload, fallback);
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
  /** Called once the service accepted the stream, before the first frame. */
  onOpen?: () => void;
  onEvent: (event: TaskEvent) => void;
}

export interface IssueStreamOptions {
  lastEventId?: string;
  signal?: AbortSignal;
  onOpen?: () => void;
  onEvent: (event: IssueEvent) => void;
}

function issuePath(workspaceId: string, issueId?: string, suffix?: string): string {
  let path = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/issues`;
  if (issueId) path += `/${encodeURIComponent(issueId)}`;
  if (suffix) path += `/${suffix}`;
  return path;
}

export interface StreamResult {
  lastEventId: string | undefined;
  terminal: boolean;
}

export class ForgePilotClient extends ApiTransport {
  async listTasks(status?: TaskStatus, cursor?: string): Promise<TaskPage> {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<TaskPage>(`/api/v1/tasks${query}`);
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

  async archiveTask(taskId: string): Promise<Task> {
    return this.request<Task>(`/api/v1/tasks/${encodeURIComponent(taskId)}/archive`, {
      method: "POST",
    });
  }

  async recoverTask(taskId: string): Promise<Task> {
    return this.request<Task>(`/api/v1/tasks/${encodeURIComponent(taskId)}/recover`, {
      method: "POST",
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

  async listWorkspaces(): Promise<Workspace[]> {
    const workspaces: Workspace[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page = await this.request<
        operations["listWorkspaces"]["responses"][200]["content"]["application/json"]
      >(`/api/v1/workspaces${query}`);
      workspaces.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return workspaces;
  }

  async listIssues(
    workspaceId: string,
    options: { productState?: ProductState; cursor?: string } = {},
  ): Promise<IssuePage> {
    const params = new URLSearchParams();
    if (options.productState) params.set("product_state", options.productState);
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<IssuePage>(`${issuePath(workspaceId)}${query}`);
  }

  async getIssue(workspaceId: string, issueId: string): Promise<Issue> {
    return this.request<Issue>(issuePath(workspaceId, issueId));
  }

  async getIssueStage(workspaceId: string, issueId: string): Promise<IssueStage> {
    return this.request<IssueStage>(issuePath(workspaceId, issueId, "stage"));
  }

  async transitionIssueStage(
    workspaceId: string,
    issueId: string,
    input: IssueStageTransition,
    idempotencyKey?: string,
  ): Promise<IssueStage> {
    return this.request<IssueStage>(issuePath(workspaceId, issueId, "stage"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(input),
    });
  }

  async listIssueTasks(
    workspaceId: string,
    issueId: string,
    cursor?: string,
  ): Promise<IssueTaskPage> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request<IssueTaskPage>(`${issuePath(workspaceId, issueId, "tasks")}${query}`);
  }

  async setIssueTaskState(
    workspaceId: string,
    issueId: string,
    taskId: string,
    to: IssueTaskState,
    idempotencyKey?: string,
  ): Promise<IssueTask> {
    return this.request<IssueTask>(
      `${issuePath(workspaceId, issueId, "tasks")}/${encodeURIComponent(taskId)}/state`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({ to }),
      },
    );
  }

  async listIssueRuns(
    workspaceId: string,
    issueId: string,
    cursor?: string,
  ): Promise<IssueRunPage> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request<IssueRunPage>(`${issuePath(workspaceId, issueId, "runs")}${query}`);
  }

  async getIssueRun(workspaceId: string, issueId: string, runId: string): Promise<IssueRun> {
    return this.request<IssueRun>(
      `${issuePath(workspaceId, issueId, "runs")}/${encodeURIComponent(runId)}`,
    );
  }

  async streamTaskEvents(taskId: string, options: StreamOptions): Promise<StreamResult> {
    return this.readEventStream(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/stream`,
      options,
      parseSseFrame,
      (event) => event.type === "task.terminal",
      "Unable to connect to task stream.",
    );
  }

  async streamIssueEvents(
    workspaceId: string,
    issueId: string,
    options: IssueStreamOptions,
  ): Promise<StreamResult> {
    return this.readEventStream(
      issuePath(workspaceId, issueId, "stream"),
      options,
      parseIssueSseFrame,
      (event) => event.type === "issue.terminal",
      "Unable to connect to issue stream.",
    );
  }

  private async readEventStream<T extends { event_id: string }>(
    path: string,
    options: {
      lastEventId?: string;
      signal?: AbortSignal;
      onOpen?: () => void;
      onEvent: (event: T) => void;
    },
    parse: (frame: string) => T | undefined,
    isTerminal: (event: T) => boolean,
    failureMessage: string,
  ): Promise<StreamResult> {
    const headers = this.headers({ Accept: "text/event-stream" });
    if (options.lastEventId) headers["Last-Event-ID"] = options.lastEventId;

    const response = await this.raw(path, { headers, signal: options.signal });
    if (!response.ok) {
      const error = await errorFromResponse(response, failureMessage);
      this.notifyAuthFailure(error);
      throw error;
    }
    if (!response.body) throw new Error("Event stream returned no readable body.");
    options.onOpen?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastEventId = options.lastEventId;
    let terminal = false;

    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        const parsed = takeSseFrames(buffer, chunk.done);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          const event = parse(frame);
          if (!event) continue;
          lastEventId = event.event_id;
          terminal ||= isTerminal(event);
          options.onEvent(event);
        }
        if (chunk.done) break;
      }
    } finally {
      reader.releaseLock();
    }

    return { lastEventId, terminal };
  }
}

function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  if (!init) return {};
  if (init instanceof Headers) return Object.fromEntries(init.entries());
  if (Array.isArray(init)) return Object.fromEntries(init);
  return init;
}

interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

export function takeSseFrames(input: string, flush = false): { frames: string[]; rest: string } {
  const hasPendingCarriageReturn = !flush && input.endsWith("\r");
  let remainder = input.slice(0, hasPendingCarriageReturn ? -1 : undefined).replace(/\r\n?/g, "\n");
  const frames: string[] = [];
  let boundary = remainder.indexOf("\n\n");
  while (boundary >= 0) {
    frames.push(remainder.slice(0, boundary));
    remainder = remainder.slice(boundary + 2);
    boundary = remainder.indexOf("\n\n");
  }
  return {
    frames,
    rest: remainder + (hasPendingCarriageReturn ? "\r" : ""),
  };
}

function readSseFrame(frame: string): Record<string, unknown> | undefined {
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
    const payload = JSON.parse(parsed.data) as Record<string, unknown>;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    if (!payload["event_id"] && parsed.id) payload["event_id"] = parsed.id;
    if (!payload["type"] && parsed.event) payload["type"] = parsed.event;
    return payload;
  } catch {
    return undefined;
  }
}

export function parseSseFrame(frame: string): TaskEvent | undefined {
  const event = readSseFrame(frame) as Partial<TaskEvent> | undefined;
  if (!event) return undefined;
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
}

export function parseIssueSseFrame(frame: string): IssueEvent | undefined {
  const event = readSseFrame(frame) as Partial<IssueEvent> | undefined;
  if (!event) return undefined;
  if (
    typeof event.event_id !== "string" ||
    typeof event.sequence !== "number" ||
    typeof event.occurred_at !== "string" ||
    typeof event.issue_id !== "string" ||
    typeof event.type !== "string" ||
    typeof event.data !== "object" ||
    event.data === null ||
    Array.isArray(event.data)
  ) {
    return undefined;
  }
  return event as IssueEvent;
}
