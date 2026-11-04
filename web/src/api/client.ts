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
export type Candidate = components["schemas"]["Candidate"];
export type Approval = components["schemas"]["Approval"];
export type Delivery = components["schemas"]["Delivery"];
export type Digest = components["schemas"]["Digest"];
export type ChangeRiskClass = Candidate["risk"]["class"];
export type ApprovalState = Approval["state"];
export type DeliveryState = Delivery["state"];
export type ApprovalInvalidationReason = NonNullable<Approval["invalidated_reason"]>;
export type IssueApprovalDecision =
  operations["decideIssueApproval"]["requestBody"]["content"]["application/json"];
export type IssueDeliveryReconcile = NonNullable<
  operations["reconcileIssueDelivery"]["requestBody"]
>["content"]["application/json"];
export type IssueCandidatePage =
  operations["listIssueCandidates"]["responses"][200]["content"]["application/json"];
export type IssueApprovalPage =
  operations["listIssueApprovals"]["responses"][200]["content"]["application/json"];
export type IssueDeliveryPage =
  operations["listIssueDeliveries"]["responses"][200]["content"]["application/json"];

export type MemoryItem = components["schemas"]["MemoryItemView"];
export type MemoryItemPage =
  operations["listMemoryItems"]["responses"][200]["content"]["application/json"];
export type MemoryKind = MemoryItem["kind"];
export type MemoryStatus = MemoryItem["status"];
export type MemoryTier = MemoryItem["tier"];
export type MemoryTrust = MemoryItem["trust"];
export type MemorySensitivity = MemoryItem["sensitivity"];
export type MemoryApplicability = components["schemas"]["MemoryApplicability"];
export type MemoryEvidence = components["schemas"]["MemoryEvidence"];
export type MemoryItemVersions = components["schemas"]["MemoryItemVersions"];
export type MemoryItemVersion = components["schemas"]["MemoryItemVersion"];
export type MemoryItemEvents = components["schemas"]["MemoryItemEvents"];
export type MemoryItemEvent = components["schemas"]["MemoryItemEvent"];
export type MemoryProvenance = components["schemas"]["MemoryProvenance"];
export type MemoryReview = components["schemas"]["MemoryReview"];
export type MemoryGovernanceResult = components["schemas"]["MemoryGovernanceResult"];
export type MemoryGovernanceAction = MemoryGovernanceResult["action"];
export type MemoryReasonCode = components["schemas"]["MemoryDeprecateRequest"]["reason_code"];
export type MemoryRestoreTarget = components["schemas"]["MemoryRestoreRequest"]["target_status"];
export type MemoryPromoteRequest =
  operations["promoteMemoryItem"]["requestBody"]["content"]["application/json"];
export type MemoryDeprecateRequest =
  operations["deprecateMemoryItem"]["requestBody"]["content"]["application/json"];
export type MemoryQuarantineRequest =
  operations["quarantineMemoryItem"]["requestBody"]["content"]["application/json"];
export type MemoryRestoreRequest =
  operations["restoreMemoryItem"]["requestBody"]["content"]["application/json"];

export type RsiProposal = components["schemas"]["RsiProposal"];
export type RsiProposalStatus = RsiProposal["status"];
export type RsiRisk = RsiProposal["risk"];
export type RsiTarget = RsiProposal["target"];
export type RsiEvaluation = components["schemas"]["RsiEvaluation"];
export type RsiApproval = components["schemas"]["RsiApproval"];
export type RsiRollout = components["schemas"]["RsiRollout"];
export type RsiCanaryObservation = components["schemas"]["RsiCanaryObservation"];
export type RsiStatus = components["schemas"]["RsiStatus"];
export type RsiProposalList = components["schemas"]["RsiProposalList"];
export type RsiControls = components["schemas"]["RsiControls"];
export type RsiControlsResponse = components["schemas"]["RsiControlsResponse"];
export type RsiDataset = RsiEvaluation["dataset"];
export type RsiControlsPatch =
  operations["updateRsiControls"]["requestBody"]["content"]["application/json"];

export type DashboardSummary = components["schemas"]["DashboardSummary"];
type DashboardPeriod = components["schemas"]["DashboardPeriod"];
export type DashboardSourceState = components["schemas"]["DashboardSourceState"];
export type DashboardTotals = components["schemas"]["DashboardTotals"];
export type DashboardLatencyMetric = components["schemas"]["DashboardLatencyMetric"];
export type DashboardNotMeasuredMetric = components["schemas"]["DashboardNotMeasuredMetric"];
export type DashboardTokenMetric = components["schemas"]["DashboardTokenMetric"];
export type DashboardTokenTotals = components["schemas"]["DashboardTokenTotals"];
export type DashboardCostMetric = components["schemas"]["DashboardCostMetric"];
export type DashboardBudgetMetric = components["schemas"]["DashboardBudgetMetric"];
export type DashboardValidationMetric = components["schemas"]["DashboardValidationMetric"];
export type DashboardDeliveryMetric = components["schemas"]["DashboardDeliveryMetric"];
type DashboardBreakdown = components["schemas"]["DashboardBreakdown"];
export type DashboardBreakdownRow = components["schemas"]["DashboardBreakdownRow"];
export type DashboardCostItemPage = components["schemas"]["DashboardCostItemPage"];
export type DashboardCostItem = components["schemas"]["DashboardCostItem"];
export type DashboardCostComponent = components["schemas"]["DashboardCostComponent"];
export type DashboardIssueDrilldown = components["schemas"]["DashboardIssueDrilldown"];
export type DashboardTraceEvent = components["schemas"]["DashboardTraceEvent"];
export type DashboardMetricStatus = components["schemas"]["DashboardCountMetric"]["status"];
export type DashboardBreakdownDimension = DashboardBreakdown["dimension"];
export type DashboardBucket = DashboardPeriod["bucket"];
export type DashboardCompleteness = DashboardCostItem["completeness"];

/**
 * Query surface shared by the dashboard reads. Every field is a contract
 * parameter; an absent field is never sent, so the service owns its default.
 */
export interface DashboardRangeOptions {
  from?: string;
  to?: string;
  timezone?: string;
  bucket?: DashboardBucket;
  limit?: number;
  cursor?: string;
}

export interface DashboardSummaryOptions extends DashboardRangeOptions {
  breakdown?: DashboardBreakdownDimension;
}

export type SecurityCase = components["schemas"]["SecurityCase"];
export type SecurityCasePage =
  operations["listSecurityCases"]["responses"][200]["content"]["application/json"];
export type SecurityCaseState = SecurityCase["state"];
export type SecurityCaseTransition =
  operations["transitionSecurityCase"]["requestBody"]["content"]["application/json"];
export type SecurityBlock = components["schemas"]["SecurityBlock"];
export type SecurityQuarantineGrant = components["schemas"]["SecurityQuarantineGrant"];
export type SecurityQuarantineView = components["schemas"]["SecurityQuarantineView"];
export type SecurityRuleRevision = components["schemas"]["SecurityRuleRevision"];
export type SecurityRulePage =
  operations["listSecurityRuleRevisions"]["responses"][200]["content"]["application/json"];
export type SecurityRuleStatus = SecurityRuleRevision["status"];
export type SecurityRuleConstraints = components["schemas"]["SecurityRuleConstraints"];
export type SecurityRuleProposal =
  operations["proposeSecurityRuleCorrection"]["requestBody"]["content"]["application/json"];
export type SecurityRuleReview =
  operations["reviewSecurityRuleCorrection"]["requestBody"]["content"]["application/json"];
export type SecurityRecoveryApproval = components["schemas"]["SecurityRecoveryApproval"];
export type SecurityRecoveryApprovalRequest =
  operations["approveSecurityRecovery"]["requestBody"]["content"]["application/json"];
export type SecurityRecoveryDispatch = components["schemas"]["SecurityRecoveryDispatch"];
export type SecurityAuditEntry = components["schemas"]["SecurityAuditEntry"];
export type SecurityAuditEvent = components["schemas"]["SecurityAuditEvent"];
export type SecurityAuditEventType = SecurityAuditEvent["event"];
export type SecurityAuditPage =
  operations["readSecurityAuditTrail"]["responses"][200]["content"]["application/json"];
export type SecurityAuditExport =
  operations["exportSecurityAuditTrail"]["responses"][200]["content"]["application/json"];
export type SecurityAuditExportRequest =
  operations["exportSecurityAuditTrail"]["requestBody"]["content"]["application/json"];

export interface SecurityCaseQuery {
  state?: SecurityCaseState;
  run_id?: string;
  cursor?: string;
}

export interface SecurityRuleQuery {
  detector_id?: string;
  status?: SecurityRuleStatus;
  cursor?: string;
}

export interface SecurityAuditQuery {
  /** Required by the contract; recorded with the `audit.trail_read` event. */
  purpose: string;
  case_id?: string;
  run_id?: string;
  trace_id?: string;
  invocation_id?: string;
  event_type?: SecurityAuditEventType;
  from?: string;
  to?: string;
  cursor?: string;
}

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

function memoryPath(workspaceId: string, suffix: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/memory/${suffix}`;
}

function dashboardPath(workspaceId: string, suffix: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/dashboard/${suffix}`;
}

function dashboardQuery(
  options: DashboardRangeOptions & { breakdown?: DashboardBreakdownDimension },
): string {
  const params = new URLSearchParams();
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.timezone) params.set("timezone", options.timezone);
  if (options.bucket) params.set("bucket", options.bucket);
  if (options.breakdown) params.set("breakdown", options.breakdown);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  return params.size > 0 ? `?${params.toString()}` : "";
}

function memoryItemPath(workspaceId: string, itemId: string, suffix?: string): string {
  const base = `items/${encodeURIComponent(itemId)}`;
  return memoryPath(workspaceId, suffix ? `${base}/${suffix}` : base);
}

function securityPath(workspaceId: string, suffix = ""): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/security${suffix}`;
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

  async listAllIssueTasks(workspaceId: string, issueId: string): Promise<IssueTask[]> {
    const tasks: IssueTask[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listIssueTasks(workspaceId, issueId, cursor);
      tasks.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return tasks;
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

  async listAllIssueRuns(workspaceId: string, issueId: string): Promise<IssueRun[]> {
    const runs: IssueRun[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listIssueRuns(workspaceId, issueId, cursor);
      runs.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return runs;
  }

  async getIssueRun(workspaceId: string, issueId: string, runId: string): Promise<IssueRun> {
    return this.request<IssueRun>(
      `${issuePath(workspaceId, issueId, "runs")}/${encodeURIComponent(runId)}`,
    );
  }

  async listIssueCandidates(
    workspaceId: string,
    issueId: string,
    cursor?: string,
  ): Promise<IssueCandidatePage> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request<IssueCandidatePage>(
      `${issuePath(workspaceId, issueId, "candidates")}${query}`,
    );
  }

  async listAllIssueCandidates(workspaceId: string, issueId: string): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listIssueCandidates(workspaceId, issueId, cursor);
      candidates.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return candidates;
  }

  async getIssueCandidate(
    workspaceId: string,
    issueId: string,
    candidateId: string,
  ): Promise<Candidate> {
    return this.request<Candidate>(
      `${issuePath(workspaceId, issueId, "candidates")}/${encodeURIComponent(candidateId)}`,
    );
  }

  async listIssueApprovals(
    workspaceId: string,
    issueId: string,
    cursor?: string,
  ): Promise<IssueApprovalPage> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request<IssueApprovalPage>(
      `${issuePath(workspaceId, issueId, "approvals")}${query}`,
    );
  }

  async listAllIssueApprovals(workspaceId: string, issueId: string): Promise<Approval[]> {
    const approvals: Approval[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listIssueApprovals(workspaceId, issueId, cursor);
      approvals.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return approvals;
  }

  async getIssueApproval(
    workspaceId: string,
    issueId: string,
    approvalId: string,
  ): Promise<Approval> {
    return this.request<Approval>(
      `${issuePath(workspaceId, issueId, "approvals")}/${encodeURIComponent(approvalId)}`,
    );
  }

  /**
   * Record the authenticated caller's decision on a frozen candidate. The
   * reviewed diff digest is part of the command, so a decision can never drift
   * onto a different revision; the approver is the session, never a body field.
   */
  async decideIssueApproval(
    workspaceId: string,
    issueId: string,
    approvalId: string,
    input: IssueApprovalDecision,
    idempotencyKey?: string,
  ): Promise<Approval> {
    return this.request<Approval>(
      `${issuePath(workspaceId, issueId, "approvals")}/${encodeURIComponent(approvalId)}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(input),
      },
    );
  }

  async listIssueDeliveries(
    workspaceId: string,
    issueId: string,
    cursor?: string,
  ): Promise<IssueDeliveryPage> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request<IssueDeliveryPage>(
      `${issuePath(workspaceId, issueId, "deliveries")}${query}`,
    );
  }

  async listAllIssueDeliveries(workspaceId: string, issueId: string): Promise<Delivery[]> {
    const deliveries: Delivery[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listIssueDeliveries(workspaceId, issueId, cursor);
      deliveries.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return deliveries;
  }

  async getIssueDelivery(
    workspaceId: string,
    issueId: string,
    deliveryId: string,
  ): Promise<Delivery> {
    return this.request<Delivery>(
      `${issuePath(workspaceId, issueId, "deliveries")}/${encodeURIComponent(deliveryId)}`,
    );
  }

  /**
   * Reconcile an ambiguous provider outcome against branch/PR evidence. This
   * is never an automatic retry: `unknown` is only cleared by an explicit
   * reconciliation, and a `partial` delivery stays an explicit outcome.
   */
  async reconcileIssueDelivery(
    workspaceId: string,
    issueId: string,
    deliveryId: string,
    input: IssueDeliveryReconcile,
    idempotencyKey?: string,
  ): Promise<Delivery> {
    return this.request<Delivery>(
      `${issuePath(workspaceId, issueId, "deliveries")}/${encodeURIComponent(deliveryId)}/reconcile`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(input),
      },
    );
  }

  /**
   * Bounded workspace memory browse. Only the filters the contract defines are
   * sent; an unknown filter is a contract change, not a client-side guess.
   */
  async listMemoryItems(
    workspaceId: string,
    options: {
      kind?: MemoryKind;
      status?: MemoryStatus;
      tier?: MemoryTier;
      team_id?: string;
      path_prefix?: string;
      language?: string;
      task_family?: string;
      trust?: MemoryTrust;
      sensitivity?: MemorySensitivity;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<MemoryItemPage> {
    const params = new URLSearchParams();
    if (options.kind) params.set("kind", options.kind);
    if (options.status) params.set("status", options.status);
    if (options.tier) params.set("tier", options.tier);
    if (options.team_id) params.set("team_id", options.team_id);
    if (options.path_prefix) params.set("path_prefix", options.path_prefix);
    if (options.language) params.set("language", options.language);
    if (options.task_family) params.set("task_family", options.task_family);
    if (options.trust) params.set("trust", options.trust);
    if (options.sensitivity) params.set("sensitivity", options.sensitivity);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<MemoryItemPage>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/memory/items${query}`,
    );
  }

  /** One item in the browse view, for deep links and post-conflict refreshes. */
  async getMemoryItem(workspaceId: string, itemId: string): Promise<MemoryItem> {
    return this.request<MemoryItem>(memoryItemPath(workspaceId, itemId));
  }

  /** Per-version content, already filtered by each version's own sensitivity. */
  async listMemoryItemVersions(workspaceId: string, itemId: string): Promise<MemoryItemVersions> {
    return this.request<MemoryItemVersions>(memoryItemPath(workspaceId, itemId, "versions"));
  }

  /** One page of the merged item audit timeline; `next_cursor` reaches the rest. */
  async listMemoryItemEvents(
    workspaceId: string,
    itemId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<MemoryItemEvents> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<MemoryItemEvents>(
      `${memoryItemPath(workspaceId, itemId, "events")}${query}`,
    );
  }

  async promoteMemoryItem(
    workspaceId: string,
    itemId: string,
    body: MemoryPromoteRequest,
  ): Promise<MemoryGovernanceResult> {
    return this.request<MemoryGovernanceResult>(memoryItemPath(workspaceId, itemId, "promote"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async deprecateMemoryItem(
    workspaceId: string,
    itemId: string,
    body: MemoryDeprecateRequest,
  ): Promise<MemoryGovernanceResult> {
    return this.request<MemoryGovernanceResult>(memoryItemPath(workspaceId, itemId, "deprecate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async quarantineMemoryItem(
    workspaceId: string,
    itemId: string,
    body: MemoryQuarantineRequest,
  ): Promise<MemoryGovernanceResult> {
    return this.request<MemoryGovernanceResult>(memoryItemPath(workspaceId, itemId, "quarantine"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async restoreMemoryItem(
    workspaceId: string,
    itemId: string,
    body: MemoryRestoreRequest,
  ): Promise<MemoryGovernanceResult> {
    return this.request<MemoryGovernanceResult>(memoryItemPath(workspaceId, itemId, "restore"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async listRsiProposals(
    workspaceId: string,
    options: { status?: RsiProposalStatus; risk?: RsiRisk; limit?: number } = {},
  ): Promise<RsiProposal[]> {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.risk) params.set("risk", options.risk);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const page = await this.request<components["schemas"]["RsiProposalList"]>(
      `${memoryPath(workspaceId, "proposals")}${query}`,
    );
    return page.proposals;
  }

  async getRsiProposal(workspaceId: string, proposalId: string): Promise<RsiProposal> {
    return this.request<RsiProposal>(
      memoryPath(workspaceId, `proposals/${encodeURIComponent(proposalId)}`),
    );
  }

  /**
   * The server runs the offline replay over the selected datasets. Metrics,
   * a verifier claim, or evidence text are refused; only dataset selection
   * travels.
   */
  async evaluateRsiProposal(
    workspaceId: string,
    proposalId: string,
    datasets: RsiDataset[] = ["golden", "holdout"],
  ): Promise<RsiProposal> {
    return this.request<RsiProposal>(
      memoryPath(workspaceId, `proposals/${encodeURIComponent(proposalId)}/evaluations`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasets }),
      },
    );
  }

  async approveRsiProposal(
    workspaceId: string,
    proposalId: string,
    note?: string,
  ): Promise<RsiProposal> {
    return this.request<RsiProposal>(
      memoryPath(workspaceId, `proposals/${encodeURIComponent(proposalId)}/approvals`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(note?.trim() ? { note: note.trim() } : {}),
      },
    );
  }

  async startRsiCanary(workspaceId: string, proposalId: string): Promise<RsiProposal> {
    return this.request<RsiProposal>(
      memoryPath(workspaceId, `proposals/${encodeURIComponent(proposalId)}/canary`),
      { method: "POST" },
    );
  }

  /** Samples are derived server-side from pinned runs; no body is accepted. */
  async recordRsiCanaryObservation(workspaceId: string, proposalId: string): Promise<RsiProposal> {
    return this.request<RsiProposal>(
      memoryPath(workspaceId, `proposals/${encodeURIComponent(proposalId)}/canary/observations`),
      { method: "POST" },
    );
  }

  async rollbackRsiProposal(
    workspaceId: string,
    proposalId: string,
    reason: string,
  ): Promise<RsiProposal> {
    return this.request<RsiProposal>(
      memoryPath(workspaceId, `proposals/${encodeURIComponent(proposalId)}/rollback`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      },
    );
  }

  async getRsiStatus(workspaceId: string): Promise<RsiStatus> {
    return this.request<RsiStatus>(memoryPath(workspaceId, "rsi/status"));
  }

  async setRsiKillSwitch(
    workspaceId: string,
    enabled: boolean,
    reason?: string,
  ): Promise<RsiControls> {
    const body: { enabled: boolean; reason?: string } = { enabled };
    if (reason?.trim()) body.reason = reason.trim();
    const result = await this.request<RsiControlsResponse>(
      memoryPath(workspaceId, "rsi/kill-switch"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return result.controls;
  }

  async updateRsiControls(workspaceId: string, body: RsiControlsPatch): Promise<RsiControls> {
    const result = await this.request<RsiControlsResponse>(
      memoryPath(workspaceId, "rsi/controls"),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return result.controls;
  }

  /**
   * Workspace dashboard aggregates (DAT-230). The service resolves scope from
   * the live membership; the path workspace is only a locator. Missing
   * telemetry is reported as a status with null figures, never a zero.
   */
  async getDashboardSummary(
    workspaceId: string,
    options: DashboardSummaryOptions = {},
  ): Promise<DashboardSummary> {
    return this.request<DashboardSummary>(
      `${dashboardPath(workspaceId, "summary")}${dashboardQuery(options)}`,
    );
  }

  async listDashboardCostItems(
    workspaceId: string,
    options: DashboardRangeOptions = {},
  ): Promise<DashboardCostItemPage> {
    return this.request<DashboardCostItemPage>(
      `${dashboardPath(workspaceId, "cost-items")}${dashboardQuery(options)}`,
    );
  }

  async getDashboardIssueDrilldown(
    workspaceId: string,
    issueId: string,
    options: DashboardRangeOptions = {},
  ): Promise<DashboardIssueDrilldown> {
    return this.request<DashboardIssueDrilldown>(
      `${dashboardPath(workspaceId, `issues/${encodeURIComponent(issueId)}`)}${dashboardQuery(
        options,
      )}`,
    );
  }

  /*
   * ADR-0005 security surface (DAT-214). Every method below is a direct
   * projection of the merged contract: no per-call bypass route exists, so no
   * client method offers one. Mutating calls carry an Idempotency-Key; raw
   * quarantine content is fetched only through the grant header.
   */

  async listSecurityCases(
    workspaceId: string,
    options: SecurityCaseQuery = {},
  ): Promise<SecurityCasePage> {
    const params = new URLSearchParams();
    if (options.state) params.set("state", options.state);
    if (options.run_id) params.set("run_id", options.run_id);
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<SecurityCasePage>(`${securityPath(workspaceId, "/cases")}${query}`);
  }

  async getSecurityCase(workspaceId: string, caseId: string): Promise<SecurityCase> {
    return this.request<SecurityCase>(
      securityPath(workspaceId, `/cases/${encodeURIComponent(caseId)}`),
    );
  }

  async transitionSecurityCase(
    workspaceId: string,
    caseId: string,
    input: SecurityCaseTransition,
    idempotencyKey: string,
  ): Promise<SecurityCase> {
    return this.request<SecurityCase>(
      securityPath(workspaceId, `/cases/${encodeURIComponent(caseId)}/transitions`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
  }

  async requestSecurityCaseTermination(
    workspaceId: string,
    caseId: string,
    input: { note?: string },
    idempotencyKey: string,
  ): Promise<SecurityCase> {
    return this.request<SecurityCase>(
      securityPath(workspaceId, `/cases/${encodeURIComponent(caseId)}/termination-requests`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
  }

  async requestSecurityCaseReassignment(
    workspaceId: string,
    caseId: string,
    input: { note?: string },
    idempotencyKey: string,
  ): Promise<SecurityCase> {
    return this.request<SecurityCase>(
      securityPath(workspaceId, `/cases/${encodeURIComponent(caseId)}/reassignment-requests`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
  }

  async grantSecurityQuarantineAccess(
    workspaceId: string,
    caseId: string,
    input: { quarantine_id: string; subject: string },
    idempotencyKey: string,
  ): Promise<SecurityQuarantineGrant> {
    return this.request<SecurityQuarantineGrant>(
      securityPath(workspaceId, `/cases/${encodeURIComponent(caseId)}/quarantine-grants`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
  }

  async viewQuarantinedContext(
    workspaceId: string,
    quarantineId: string,
    grantId: string,
  ): Promise<SecurityQuarantineView> {
    return this.request<SecurityQuarantineView>(
      securityPath(workspaceId, `/quarantine/${encodeURIComponent(quarantineId)}/views`),
      {
        method: "POST",
        headers: { "X-Quarantine-Grant": grantId },
      },
    );
  }

  async listSecurityRuleRevisions(
    workspaceId: string,
    options: SecurityRuleQuery = {},
  ): Promise<SecurityRulePage> {
    const params = new URLSearchParams();
    if (options.detector_id) params.set("detector_id", options.detector_id);
    if (options.status) params.set("status", options.status);
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<SecurityRulePage>(`${securityPath(workspaceId, "/rules")}${query}`);
  }

  async proposeSecurityRuleCorrection(
    workspaceId: string,
    input: SecurityRuleProposal,
    idempotencyKey: string,
  ): Promise<SecurityRuleRevision> {
    return this.request<SecurityRuleRevision>(securityPath(workspaceId, "/rules/proposals"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    });
  }

  async reviewSecurityRuleCorrection(
    workspaceId: string,
    lineage: string,
    version: number,
    input: SecurityRuleReview,
    idempotencyKey: string,
  ): Promise<SecurityRuleRevision> {
    return this.request<SecurityRuleRevision>(
      securityPath(
        workspaceId,
        `/rules/${encodeURIComponent(lineage)}/revisions/${version}/reviews`,
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
  }

  async activateSecurityRuleCorrection(
    workspaceId: string,
    lineage: string,
    version: number,
    input: { note?: string },
    idempotencyKey: string,
  ): Promise<SecurityRuleRevision> {
    return this.request<SecurityRuleRevision>(
      securityPath(
        workspaceId,
        `/rules/${encodeURIComponent(lineage)}/revisions/${version}/activation`,
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
  }

  async rollbackSecurityRuleCorrection(
    workspaceId: string,
    lineage: string,
    input: { note?: string },
    idempotencyKey: string,
  ): Promise<SecurityRuleRevision> {
    return this.request<SecurityRuleRevision>(
      securityPath(workspaceId, `/rules/${encodeURIComponent(lineage)}/rollbacks`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
  }

  async approveSecurityRecovery(
    workspaceId: string,
    caseId: string,
    input: SecurityRecoveryApprovalRequest,
    idempotencyKey: string,
  ): Promise<SecurityRecoveryApproval> {
    return this.request<SecurityRecoveryApproval>(
      securityPath(workspaceId, `/cases/${encodeURIComponent(caseId)}/recovery-approvals`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
  }

  async getSecurityRecoveryApproval(
    workspaceId: string,
    authorizationId: string,
  ): Promise<SecurityRecoveryApproval> {
    return this.request<SecurityRecoveryApproval>(
      securityPath(workspaceId, `/recovery-approvals/${encodeURIComponent(authorizationId)}`),
    );
  }

  async revokeSecurityRecoveryApproval(
    workspaceId: string,
    authorizationId: string,
    idempotencyKey: string,
  ): Promise<SecurityRecoveryApproval> {
    return this.request<SecurityRecoveryApproval>(
      securityPath(workspaceId, `/recovery-approvals/${encodeURIComponent(authorizationId)}`),
      { method: "DELETE", headers: { "Idempotency-Key": idempotencyKey } },
    );
  }

  async dispatchSecurityRecovery(
    workspaceId: string,
    authorizationId: string,
    input: { worker_id: string },
    idempotencyKey: string,
  ): Promise<SecurityRecoveryDispatch> {
    return this.request<SecurityRecoveryDispatch>(
      securityPath(
        workspaceId,
        `/recovery-approvals/${encodeURIComponent(authorizationId)}/dispatch`,
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
  }

  async readSecurityAuditTrail(
    workspaceId: string,
    query: SecurityAuditQuery,
  ): Promise<SecurityAuditPage> {
    const params = new URLSearchParams({ purpose: query.purpose });
    if (query.case_id) params.set("case_id", query.case_id);
    if (query.run_id) params.set("run_id", query.run_id);
    if (query.trace_id) params.set("trace_id", query.trace_id);
    if (query.invocation_id) params.set("invocation_id", query.invocation_id);
    if (query.event_type) params.set("event_type", query.event_type);
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    if (query.cursor) params.set("cursor", query.cursor);
    return this.request<SecurityAuditPage>(`${securityPath(workspaceId, "/audit")}?${params}`);
  }

  async exportSecurityAuditTrail(
    workspaceId: string,
    input: SecurityAuditExportRequest,
    idempotencyKey: string,
  ): Promise<SecurityAuditExport> {
    return this.request<SecurityAuditExport>(securityPath(workspaceId, "/audit/exports"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    });
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
