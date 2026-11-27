import { randomUUID } from "node:crypto";
import http from "node:http";

import { isAuthorizedBearer } from "./auth.js";
import type { AuthService, SessionContext } from "./auth-service.js";
import { handleAuthRequest, requireEnterpriseSessionActor } from "./auth-http.js";
import { handleDashboardRequest } from "./dashboard-http.js";
import type { DashboardHttpDeps } from "./dashboard-http.js";
import { handleMemoryRequest } from "./memory-http.js";
import type { MemoryHttpDeps } from "./memory-http.js";
import { ApiError, apiErrorFromControlPlane } from "./errors.js";
import { ControlPlaneError } from "../control-plane/errors.js";
import { principalFromSession } from "../control-plane/request-scope.js";
import { handleInvitationRequest } from "./invitation-http.js";
import type { InvitationService } from "./invitation-service.js";
import { handleWorkspaceMemberRequest, isWorkspaceMemberRoute } from "./workspace-member-http.js";
import type { WorkspaceMemberService } from "./workspace-member-service.js";
import {
  handleRepositorySetChangeRequest,
  isRepositorySetChangeRoute,
} from "./repository-set-change-http.js";
import type { WorkspaceRepositorySetChangeService } from "./repository-set-change-service.js";
import { handleCollabRequest } from "./collab-http.js";
import type { CollabHttpDeps } from "./collab-http.js";
import {
  isApiError,
  optionalStringArray,
  readJsonBody,
  requireString,
  writeJson,
} from "./http-util.js";
import type { TaskEvent, TaskResource } from "./task-store.js";
import type { TaskService } from "./task-service.js";
import type { TaskTargetSelection, TaskTargetService } from "./task-targets.js";
import { actionForRequest } from "./request-authority.js";
import type { RequestAuthority, RequestAuthorityScope } from "./request-authority.js";
import type { ActionKind } from "../provider-access/types.js";
import { computeEnterpriseCapabilityProjection } from "./enterprise-capability.js";
import type { IssueSyncService } from "../issue-sync/service.js";
import type { RuntimeDiagnostics } from "../diagnostics/runtime.js";
import {
  handleServiceIntegrationRequest,
  isServiceIntegrationRoute,
} from "./service-integration-http.js";
import type { ServiceIntegrationService } from "./service-integration-service.js";

export interface ApiServerDeps {
  service: TaskService;
  /** Per-process bearer token callers must present (401 otherwise). */
  apiToken: string;
  /**
   * The deployment's configured workspace. The legacy `/api/v1/tasks...`
   * family is a local-operator compatibility seam bound to it; a task in any
   * other workspace is not reachable through that family.
   */
  legacyWorkspaceId: string;
  /**
   * Provider-authority request boundary (DAT-203). When present, session
   * requests are checked against the effective-access gate for their action
   * class (read, stream, artifact, approval, write) whenever provider
   * authority is in play — a revoked provider subject loses every one of
   * them at the request boundary. Workspace-scoped requests are evaluated in
   * their path workspace's scope.
   */
  authority?: RequestAuthority;
  /**
   * Identity/session subsystem. When set, /api/v1/auth and /api/v1/admin are
   * served and requests may authenticate with a web session cookie or a
   * desktop session token instead of the operator bearer token. When unset,
   * the local-operator bearer surface is unchanged.
   */
  auth?: AuthService;
  /**
   * Owner-created invitation surface (DAT-204). Served together with the
   * identity subsystem; unset keeps /api/v1/workspaces and /api/v1/invitations
   * unrouted.
   */
  invitations?: InvitationService;
  /**
   * Workspace member and member-candidate surface (DAT-277). Served with the
   * identity subsystem; unset keeps the member routes and the legacy
   * administrator membership entry nonexistent rather than unaudited.
   */
  members?: WorkspaceMemberService;
  /**
   * Workspace repository-addition preview/confirm/commit (DAT-286). Served
   * with the identity surface because every request is membership-scoped and
   * every decision revalidates the caller's verified provider authority.
   * Unset keeps the routes nonexistent rather than unaudited.
   */
  repositorySetChanges?: WorkspaceRepositorySetChangeService;
  /**
   * Selectable task targets (DAT-292). Served with the identity surface,
   * because the list is scoped to one workspace and every request is checked
   * against live membership and the repository authority gate. Unset keeps
   * the route nonexistent rather than unauthenticated.
   */
  taskTargets?: TaskTargetService;
  /** Workspace-scoped issue creation/list/detail and provider synchronization. */
  issues?: IssueSyncService;
  /**
   * Collaboration delivery surface (DAT-259): the issue's immutable candidates,
   * candidate-bound human approvals, and broker-controlled deliveries. Served
   * below the existing issue family only when the identity surface exists, so
   * every request is membership-scoped; unset keeps those routes nonexistent.
   */
  collab?: CollabHttpDeps;
  /**
   * Administrator-controlled service integrations (DAT-267). Served in the
   * `/api/v1/admin` family and outside the provider authority gate, so an
   * administrator can install or replace the workspace's integration even
   * after deactivation made every ordinary workspace request fail closed.
   */
  serviceIntegrations?: ServiceIntegrationService;
  /** External origin override for OAuth redirects; loopback derives per request. */
  publicOrigin?: string;
  /**
   * Workspace memory v1 surface (DAT-236). Session-authenticated and scoped by
   * workspace membership; unset keeps the memory routes nonexistent.
   */
  memory?: MemoryHttpDeps;
  /**
   * Workspace dashboard v1 surface (DAT-230). Read-only, session-authenticated,
   * and scoped by live membership; unset keeps the dashboard routes
   * nonexistent.
   */
  dashboard?: DashboardHttpDeps;
  /**
   * Runtime configuration diagnostics (DAT-257). Operator-only: the report
   * exposes deployment state paths (basenames) and subsystem readiness, which
   * are not enterprise-user data. Unset keeps the route nonexistent.
   */
  runtimeDiagnostics?: () => Promise<RuntimeDiagnostics>;
}

function writeSseEvent(res: http.ServerResponse, event: TaskEvent): void {
  res.write(`id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * Who an authenticated API request acts as.
 *
 * `local_operator` is the legacy per-process bearer token. A `session` actor
 * is an enterprise user; their authority is bounded by their workspace
 * membership and is invalidated live (logout, suspension, revocation).
 */
type RequestActor = { kind: "local_operator" } | { kind: "session"; ctx: SessionContext };

function authenticateRequest(req: http.IncomingMessage, deps: ApiServerDeps): RequestActor {
  if (isAuthorizedBearer(req.headers.authorization, deps.apiToken)) {
    return { kind: "local_operator" };
  }
  if (deps.auth !== undefined) {
    return { kind: "session", ctx: requireEnterpriseSessionActor(deps.auth, req) };
  }
  throw new ApiError(
    401,
    "UNAUTHENTICATED",
    "A valid Authorization: Bearer <token> header is required (see the API token file).",
  );
}

/**
 * Origin-pin and content-type checks for one API request. Browser-originated
 * calls are pinned to this server's own loopback origin, and bodies must be
 * JSON, so a cross-site page cannot ride a simple request.
 */
function checkRequestBasics(req: http.IncomingMessage, localPort: number | undefined): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "null" && origin.length > 0) {
    const allowed = ["127.0.0.1", "localhost", "[::1]"].map(
      (host) => `http://${host}:${localPort ?? 0}`,
    );
    if (!allowed.includes(origin)) {
      throw new ApiError(403, "FORBIDDEN", `Origin ${origin} is not this API's loopback origin`);
    }
  }
  const contentLength = Number(req.headers["content-length"] ?? "0");
  const chunked = req.headers["transfer-encoding"] !== undefined;
  if ((contentLength > 0 || chunked) && req.method !== "GET") {
    const contentType = req.headers["content-type"] ?? "";
    if (!/^application\/(json|.*\+json)\b/.test(contentType)) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `request bodies must use application/json, got ${JSON.stringify(contentType)}`,
      );
    }
  }
}

interface TaskRequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: ApiServerDeps;
  actor: RequestActor;
  /** Authoritative workspace for this route family (path or legacy binding). */
  workspaceId: string;
  /** Whether this request arrived on the workspace-scoped route family. */
  scoped: boolean;
}

/**
 * The repository a task resource is authorized against (DAT-294).
 *
 * A task, its stream and its artifacts are decided with the immutable target
 * the task was created with, so the complete-set evaluation names that one
 * repository instead of authorizing a workspace-wide action. A live stream
 * also asserts the set version it was opened against: a set change closes it
 * rather than letting it keep emitting under a newer set. A record without a
 * target (pre-DAT-292) or an unknown task contributes no scope and stays
 * bounded by the workspace-level decision; the route's own 404 decides.
 */
function taskAuthorityScope(
  deps: ApiServerDeps,
  taskId: string | undefined,
  workspaceId: string,
  action: ActionKind | null,
): RequestAuthorityScope | undefined {
  if (taskId === undefined || taskId.length === 0) {
    return undefined;
  }
  const facts = deps.service.authorityScope(taskId, workspaceId);
  const scope: RequestAuthorityScope = {};
  if (facts.target !== null) {
    scope.target = facts.target;
  }
  if (action === "stream" && facts.repository_set_version !== null) {
    scope.expected_set_version = facts.repository_set_version;
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
}

/**
 * The repository an issue resource belongs to, for the request decision
 * (DAT-294). The identity comes from the server-side record — never a body or
 * query field — and is resolved to its active binding by the authority. An
 * unknown issue contributes no scope and the route's own 404 decides.
 */
function issueRepositoryId(
  deps: ApiServerDeps,
  workspaceId: string,
  issueId: string | undefined,
): string | undefined {
  if (issueId === undefined || issueId.length === 0) {
    return undefined;
  }
  const collaborative = deps.collab?.machine.getIssue(issueId);
  if (collaborative !== undefined && collaborative.workspace.workspace_id === workspaceId) {
    return collaborative.repository.repository_id;
  }
  return deps.issues?.get(workspaceId, issueId)?.repository.repository_id;
}

/**
 * Present a task on the route family that served it. The scoped family links
 * to its own workspace's run history, so following `run_history_url` cannot
 * fall through to the configured-workspace compatibility seam and 404. The
 * legacy family keeps its historical URL.
 */
function presentTask(ctx: TaskRequestContext, task: TaskResource): TaskResource {
  if (!ctx.scoped) {
    return task;
  }
  return {
    ...task,
    run_history_url: `/api/v1/workspaces/${ctx.workspaceId}/tasks/${task.id}/runs`,
  };
}

/**
 * Parse the explicit target selection (DAT-292).
 *
 * Shape validation only: whether the named immutable identity belongs to this
 * workspace's active set, whether the observed version is current and whether
 * a trusted baseline exists are decided by the workspace resolver against
 * durable state. A malformed body never reaches authority resolution.
 */
function optionalTaskTarget(body: Record<string, unknown>): TaskTargetSelection | undefined {
  const raw = body["target"];
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "INVALID_REQUEST", "target must be an object");
  }
  const value = raw as Record<string, unknown>;
  const requireNonEmpty = (field: string): string => {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new ApiError(400, "INVALID_REQUEST", `target.${field} is required`);
    }
    return candidate;
  };
  const expectedSetVersion = value["expected_set_version"];
  if (
    typeof expectedSetVersion !== "number" ||
    !Number.isInteger(expectedSetVersion) ||
    expectedSetVersion < 1
  ) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "target.expected_set_version must be a positive integer",
    );
  }
  const installationRef = value["installation_ref"];
  if (
    installationRef !== undefined &&
    installationRef !== null &&
    typeof installationRef !== "string"
  ) {
    throw new ApiError(400, "INVALID_REQUEST", "target.installation_ref must be a string or null");
  }
  const expectedBaseSha = value["expected_base_sha"];
  if (expectedBaseSha !== undefined && typeof expectedBaseSha !== "string") {
    throw new ApiError(400, "INVALID_REQUEST", "target.expected_base_sha must be a string");
  }
  return {
    repository_id: requireNonEmpty("repository_id"),
    provider_instance_id: requireNonEmpty("provider_instance_id"),
    installation_ref: (installationRef as string | null | undefined) ?? null,
    base_ref: requireNonEmpty("base_ref"),
    expected_set_version: expectedSetVersion,
    ...(expectedBaseSha !== undefined ? { expected_base_sha: expectedBaseSha as string } : {}),
  };
}

/**
 * Serve one task request. `tail` is the route suffix after the workspace
 * prefix (`[]` for a list, `[task_id, sub, artifact_id?]` otherwise), which
 * makes the legacy and workspace-scoped families share one implementation
 * and therefore one isolation rule.
 */
async function handleTaskRequest(ctx: TaskRequestContext, tail: string[]): Promise<void> {
  const { req, res, url, deps, actor, workspaceId } = ctx;
  const { service } = deps;
  const taskId = tail[0];

  if (tail.length === 0) {
    // POST /api/v1/tasks (legacy local-operator seam) and
    // POST /api/v1/workspaces/{workspace_id}/tasks (DAT-245) share one
    // handler: the latter passes the path workspace as the locator, and the
    // service resolves the workspace's own repository/base/gateway binding.
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const idempotencyKey = req.headers["idempotency-key"];
      // The contract caps the key at 256 characters; enforce it here so the
      // documented maxLength is real rather than aspirational.
      if (typeof idempotencyKey === "string" && idempotencyKey.length > 256) {
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "Idempotency-Key must be at most 256 characters",
          {
            length: idempotencyKey.length,
          },
        );
      }
      const target = optionalTaskTarget(body);
      const repositoryId =
        typeof body["repository_id"] === "string" ? body["repository_id"] : undefined;
      const baseRef = typeof body["base_ref"] === "string" ? body["base_ref"] : undefined;
      if (target === undefined) {
        if (repositoryId === undefined || repositoryId.length === 0) {
          throw new ApiError(400, "INVALID_REQUEST", "repository_id is required");
        }
        if (baseRef === undefined || baseRef.length === 0) {
          throw new ApiError(400, "INVALID_REQUEST", "base_ref is required");
        }
      }
      const created = await service.createTask(
        {
          ...(repositoryId !== undefined ? { repository_id: repositoryId } : {}),
          ...(baseRef !== undefined ? { base_ref: baseRef } : {}),
          ...(target !== undefined ? { target } : {}),
          summary: requireString(body, "summary"),
          ...(typeof body["source_reference"] === "string"
            ? { source_reference: body["source_reference"] }
            : {}),
          acceptance_criteria: optionalStringArray(body, "acceptance_criteria"),
        },
        {
          ...(typeof idempotencyKey === "string" && idempotencyKey.length > 0
            ? { idempotencyKey }
            : {}),
          ...(ctx.scoped ? { workspaceId } : {}),
          // The run's gateway scope binds to this authenticated request
          // (DAT-242); a request without a session carries no scope and its
          // model dispatches fail closed.
          principal: actor.kind === "session" ? principalFromSession(actor.ctx) : null,
        },
      );
      writeJson(res, 201, presentTask(ctx, created));
      return;
    }
    if (req.method === "GET") {
      const cursor = url.searchParams.get("cursor");
      const status = url.searchParams.get("status");
      const page = service.listTasks(cursor, status, workspaceId);
      writeJson(res, 200, {
        ...page,
        items: page.items.map((task) => presentTask(ctx, task)),
      });
      return;
    }
  }

  if (taskId === undefined) {
    throw new ApiError(404, "TASK_NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
  }

  // GET .../tasks/{task_id}
  if (req.method === "GET" && tail.length === 1) {
    writeJson(res, 200, presentTask(ctx, service.getTask(taskId, workspaceId)));
    return;
  }

  const sub = tail[1];
  if (tail.length === 2 && req.method === "POST" && sub === "messages") {
    const body = await readJsonBody(req);
    const mode = requireString(body, "mode");
    if (mode !== "steer" && mode !== "follow_up") {
      throw new ApiError(400, "INVALID_REQUEST", 'mode must be "steer" or "follow_up"');
    }
    const content = requireString(body, "content");
    await service.sendMessage(taskId, mode, content, workspaceId);
    writeJson(res, 202, { task_id: taskId, queued: true });
    return;
  }

  if (tail.length === 2 && req.method === "POST" && sub === "approvals") {
    const body = await readJsonBody(req);
    const decision = requireString(body, "decision");
    if (decision !== "approve" && decision !== "reject") {
      throw new ApiError(400, "INVALID_REQUEST", 'decision must be "approve" or "reject"');
    }
    const approved = await service.approveTask(
      taskId,
      {
        decision,
        scope_digest: requireString(body, "scope_digest"),
        principal: actor.kind === "session" ? principalFromSession(actor.ctx) : null,
      },
      workspaceId,
    );
    writeJson(res, 200, presentTask(ctx, approved));
    return;
  }

  if (tail.length === 2 && req.method === "POST" && sub === "cancel") {
    const body = await readJsonBody(req);
    const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
    writeJson(res, 202, presentTask(ctx, await service.cancelTask(taskId, reason, workspaceId)));
    return;
  }

  if (tail.length === 2 && req.method === "POST" && (sub === "archive" || sub === "recover")) {
    writeJson(
      res,
      200,
      presentTask(ctx, service.setTaskArchived(taskId, sub === "archive", workspaceId)),
    );
    return;
  }

  if (tail.length === 2 && req.method === "GET" && sub === "runs") {
    writeJson(res, 200, { items: service.getRunSummaries(taskId, workspaceId) });
    return;
  }

  if (tail.length === 2 && req.method === "GET" && sub === "timeline") {
    writeJson(res, 200, { items: service.getTimeline(taskId, workspaceId) });
    return;
  }

  if (tail.length === 3 && req.method === "GET" && sub === "artifacts" && tail[2] !== undefined) {
    writeJson(res, 200, await service.getArtifact(taskId, tail[2], workspaceId));
    return;
  }

  if (tail.length === 2 && req.method === "GET" && sub === "stream") {
    service.getTask(taskId, workspaceId); // 404 before headers are committed

    // The in-process epoch is only a *hint*: another process may observe and
    // persist a capability reduction (DAT-276) without this process bumping
    // anything, and that may happen between the request-boundary decision and
    // the history replay below. Every write — including each replayed event —
    // is therefore re-authorized against the shared persisted store first, so
    // a stream can never deliver history to a member whose ceiling no longer
    // permits `stream`. The check is cheap (one scoped read plus the ceiling
    // evaluation) and fails closed on any denial.
    const streamAuthority =
      actor.kind === "session" && deps.authority !== undefined ? deps.authority : undefined;
    const streamUser = actor.kind === "session" ? actor.ctx.user.id : null;
    // The subscription is bound to the task's target and to the set version it
    // was opened against (DAT-294): a removal, a transfer or any set change
    // makes the next re-authorization fail, so the stream stops instead of
    // replaying or emitting history under a scope it no longer holds.
    const streamScope = taskAuthorityScope(deps, taskId, workspaceId, "stream");
    const streamStillAllowed = (): boolean => {
      if (streamAuthority === undefined || streamUser === null) {
        return true;
      }
      try {
        return streamAuthority.check(streamUser, "stream", workspaceId, streamScope).allowed;
      } catch {
        // A failed re-authorization is a denial: never keep emitting on an
        // authority state that could not be evaluated.
        return false;
      }
    };
    if (streamAuthority !== undefined && streamUser !== null) {
      // Re-check before committing any history. A denial here is still a real
      // 403 envelope (headers are not sent yet), which is better than an empty
      // 200 stream; the per-event check below covers the remaining window.
      streamAuthority.require(streamUser, "stream", workspaceId, streamScope);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const timeline = service.getTimeline(taskId, workspaceId);
    const lastEventId = req.headers["last-event-id"];
    let lastSequence = 0;
    if (typeof lastEventId === "string" && lastEventId.length > 0) {
      const known = timeline.find((item) => item.event_id === lastEventId);
      // Unknown ids replay from the start: safer than silently skipping
      // history for a reconnecting client.
      lastSequence = known?.sequence ?? 0;
    }
    for (const item of timeline) {
      if (item.sequence > lastSequence) {
        // Cross-process safety for the replay itself: if authority was lost
        // while this request was being served, send no history at all.
        if (!streamStillAllowed()) {
          res.end();
          return;
        }
        writeSseEvent(res, item);
      }
    }
    // A terminal task has no future events, so never subscribe to one.
    // The replay above already covered whatever the client was missing;
    // closing here handles every terminal shape — the browser EventSource
    // auto-reconnect whose Last-Event-ID is anchored at task.terminal
    // (nothing left to write), a record that predates the closing-frame
    // invariant, and the fresh replay that just delivered the frame.
    // Subscribing in any of these would dangle forever.
    if (service.isTerminal(taskId, workspaceId)) {
      res.end();
      return;
    }
    // A session stream dies the moment its authority dies: logout,
    // suspension, or revoked workspace membership ends the subscription
    // instead of leaving a zombie stream behind. The workspace check is the
    // one bound to this stream's own scope, so losing membership in another
    // workspace cannot disturb it, and losing it here always does.
    let unsubscribeAuth: (() => void) | undefined;
    if (actor.kind === "session" && deps.auth !== undefined) {
      const auth = deps.auth;
      const sessionCtx = actor.ctx;
      unsubscribeAuth = auth.hub.subscribe((event) => {
        const losesAccess =
          (event.type === "session.revoked" && event.session_id === sessionCtx.session.id) ||
          (event.type === "user.suspended" && event.user_id === sessionCtx.user.id) ||
          (event.type === "membership.revoked" &&
            event.user_id === sessionCtx.user.id &&
            event.workspace_id === workspaceId &&
            auth.workspaceAccess(sessionCtx.user.id, workspaceId) === undefined) ||
          (event.type === "membership.changed" &&
            event.user_id === sessionCtx.user.id &&
            event.workspace_id === workspaceId &&
            event.downgraded) ||
          (event.type === "enterprise_user.status_changed" &&
            event.user_id === sessionCtx.user.id &&
            event.status !== "active" &&
            auth.workspaceAccess(sessionCtx.user.id, workspaceId) === undefined);
        if (losesAccess) {
          res.end();
        }
      });
      req.on("close", unsubscribeAuth);
    }
    // A provider revocation cuts live streams the same way: the stream
    // re-checks its stream action on every authority change and closes the
    // moment the gate denies it (DAT-203) — evaluated in this stream's
    // workspace, not the deployment default. The local epoch is a fast close
    // signal only; the shared-store check above is the actual boundary.
    if (streamAuthority !== undefined && streamUser !== null) {
      const unsubscribeAuthority = streamAuthority.subscribe(() => {
        if (!streamStillAllowed()) {
          res.end();
        }
      });
      req.on("close", unsubscribeAuthority);
    }
    const unsubscribe = service.subscribe(
      taskId,
      (event) => {
        // Cross-process safety: another process's persisted reduction (or an
        // expired verification) denies here even though this process never
        // received a local change signal. Deny before writing anything.
        if (!streamStillAllowed()) {
          res.end();
          return;
        }
        writeSseEvent(res, event);
        if (event.type === "task.terminal") {
          res.end();
        }
      },
      workspaceId,
    );
    req.on("close", unsubscribe);
    return;
  }

  throw new ApiError(404, "TASK_NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
}

/**
 * Authorize the workspace-scoped task family. The `{workspace_id}` segment is
 * a locator: it only selects which live membership to evaluate. Anything but
 * a live membership in this deployment's enterprise — unknown, revoked,
 * cross-enterprise, foreign to the caller — is one indistinguishable 404, so
 * the route cannot be used to enumerate workspaces or task ownership.
 */
function scopedWorkspaceAccess(
  actor: RequestActor,
  deps: ApiServerDeps,
  workspaceId: string,
): { readOnly: boolean } {
  if (actor.kind === "local_operator") {
    // The operator bearer is the deployment credential, scoped to the
    // deployment's configured workspace exactly as the legacy family is.
    if (workspaceId !== deps.legacyWorkspaceId) {
      throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
    }
    return { readOnly: false };
  }
  if (deps.auth === undefined) {
    throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
  }
  const access = deps.auth.workspaceAccess(actor.ctx.user.id, workspaceId);
  if (access === undefined) {
    throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
  }
  return { readOnly: access.membership.role === "viewer" };
}

/**
 * forgepilot-api/v1 HTTP surface.
 *
 * Binds loopback only: the contract has the UI talk to Node at an ephemeral
 * loopback address, never to dsh sockets or Pi credentials directly.
 */
export function createApiServer(deps: ApiServerDeps): http.Server {
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const requestId = `req_${randomUUID().replaceAll("-", "")}`;
    res.setHeader("X-Request-Id", requestId);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    try {
      if (segments[0] !== "api" || segments[1] !== "v1") {
        throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
      }
      checkRequestBasics(req, res.socket?.localPort);

      // Administrator-controlled service integration (DAT-267). This is the
      // surface that installs the workspace's authority marker, so it is
      // dispatched ahead of the generic admin family and outside the provider
      // authority gate: after deactivation every ordinary workspace request
      // fails closed, and an administrator must still be able to reinstall.
      if (isServiceIntegrationRoute(segments)) {
        if (deps.serviceIntegrations === undefined || deps.auth === undefined) {
          throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
        }
        await handleServiceIntegrationRequest(
          { auth: deps.auth, service: deps.serviceIntegrations },
          { req, res, url, segments },
        );
        return;
      }

      // Identity, session, and administrator surfaces authenticate themselves.
      if (segments[2] === "auth" || segments[2] === "admin") {
        if (deps.auth === undefined) {
          throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
        }
        await handleAuthRequest(
          {
            auth: deps.auth,
            ...(deps.publicOrigin !== undefined ? { publicOrigin: deps.publicOrigin } : {}),
            ...(deps.members !== undefined ? { members: deps.members } : {}),
          },
          { req, res, url, segments, requestId },
        );
        return;
      }

      const method = req.method ?? "GET";

      // Runtime diagnostics (DAT-257) are deployment-operator data: the local
      // bearer is the only accepted credential, never a workspace session.
      if (segments[2] === "runtime") {
        if (
          deps.runtimeDiagnostics === undefined ||
          segments.length !== 4 ||
          segments[3] !== "diagnostics" ||
          method !== "GET"
        ) {
          throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
        }
        const actor = authenticateRequest(req, deps);
        if (actor.kind !== "local_operator") {
          throw new ApiError(
            403,
            "FORBIDDEN",
            "runtime diagnostics are available only to the local operator",
          );
        }
        writeJson(res, 200, await deps.runtimeDiagnostics());
        return;
      }

      // GET /api/v1/workspaces — exactly the caller's live memberships.
      if (segments[2] === "workspaces" && segments.length === 3) {
        if (method === "POST") {
          if (deps.auth === undefined) {
            throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
          }
          const session = requireEnterpriseSessionActor(deps.auth, req);
          const body = await readJsonBody(req);
          if (
            typeof body !== "object" ||
            body === null ||
            typeof (body as Record<string, unknown>).name !== "string" ||
            typeof (body as Record<string, unknown>).repository_id !== "string" ||
            typeof (body as Record<string, unknown>).provider_instance_id !== "string"
          ) {
            throw new ApiError(
              400,
              "INVALID_REQUEST",
              "name, repository_id and provider_instance_id are required",
            );
          }
          writeJson(
            res,
            201,
            deps.auth.createWorkspace(session.user.id, {
              name: (body as { name: string }).name,
              repository_id: (body as { repository_id: string }).repository_id,
              provider_instance_id: (body as { provider_instance_id: string }).provider_instance_id,
            }),
          );
          return;
        }
        if (method !== "GET") {
          throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
        }
        const actor = authenticateRequest(req, deps);
        // The deployment operator holds no enterprise membership, so its
        // honest answer is an empty page — not a fabricated workspace and not
        // an error the contract does not define.
        if (actor.kind !== "session" || deps.auth === undefined) {
          writeJson(res, 200, { items: [], next_cursor: null });
          return;
        }
        writeJson(
          res,
          200,
          deps.auth.listWorkspaces(actor.ctx.user.id, url.searchParams.get("cursor")),
        );
        return;
      }

      // Workspace members and provider-roster candidates (DAT-277). The path
      // workspace is a locator: the service resolves the caller's live
      // membership and the verifiable provider facts before anything else, so
      // this family is dispatched ahead of the task-plane actor logic.
      if (isWorkspaceMemberRoute(segments)) {
        if (deps.auth === undefined || deps.members === undefined) {
          throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
        }
        await handleWorkspaceMemberRequest(
          { auth: deps.auth, members: deps.members },
          { req, res, url, segments, requestId },
        );
        return;
      }

      // Workspace repository-addition preview/confirm/commit (DAT-286). The
      // path workspace is a locator: the service resolves the caller's live
      // membership and the domain layer re-derives every fact before it
      // records a confirmation or commits a change.
      if (isRepositorySetChangeRoute(segments)) {
        if (deps.auth === undefined || deps.repositorySetChanges === undefined) {
          throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
        }
        await handleRepositorySetChangeRequest(
          { auth: deps.auth, changes: deps.repositorySetChanges },
          { req, res, url, segments, requestId },
        );
        return;
      }

      // Owner-created invitations (DAT-204): workspace owner/admin surface
      // plus the authenticated join-confirmation surface. The path's
      // workspace id is only a locator; authority is the authenticated
      // session plus its live membership (resolved inside the handler).
      const isInvitationRoute =
        segments[2] === "invitations" ||
        (segments[2] === "workspaces" && segments[4] === "invitations");
      if (isInvitationRoute) {
        if (deps.auth === undefined || deps.invitations === undefined) {
          throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
        }
        await handleInvitationRequest(
          {
            auth: deps.auth,
            invitations: deps.invitations,
            ...(deps.publicOrigin !== undefined ? { publicOrigin: deps.publicOrigin } : {}),
          },
          { req, res, url, segments, requestId },
        );
        return;
      }

      // Enterprise-scoped capability projection (DAT-278, ADR-0011). It exists
      // so an enterprise administrator without a workspace membership can see
      // the enterprise surfaces their grant covers, and it states explicitly
      // that enterprise administration is not repository data access. The path
      // enterprise is a locator only; the session's active membership decides.
      if (
        segments[2] === "enterprises" &&
        segments.length === 5 &&
        segments[4] === "capabilities"
      ) {
        const method = req.method ?? "GET";
        if (method !== "GET" && method !== "HEAD") {
          throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
        }
        if (deps.auth === undefined || deps.authority === undefined) {
          throw new ApiError(404, "NOT_FOUND", "Enterprise was not found");
        }
        const session = requireEnterpriseSessionActor(deps.auth, req);
        const info = deps.auth.sessionInfo(session);
        const membership = info.enterprise_membership;
        if (membership === undefined || membership === null) {
          throw new ApiError(
            403,
            "ENTERPRISE_MEMBERSHIP_REQUIRED",
            "an active enterprise membership is required",
          );
        }
        if (segments[3] !== membership.enterprise_id) {
          throw new ApiError(404, "NOT_FOUND", "Enterprise was not found");
        }
        const freshness = deps.authority.freshness();
        writeJson(
          res,
          200,
          computeEnterpriseCapabilityProjection({
            enterprise_id: membership.enterprise_id,
            // requireEnterpriseSessionActor already refused every non-active
            // status; the projection only models the active states.
            status: membership.status === "active" ? "active" : "suspended",
            role: membership.role,
            now: new Date(),
            fresh_window_ms: freshness.fresh_window_ms,
            stale_after_ms: freshness.stale_after_ms,
          }),
        );
        return;
      }

      // Workspace capability projection (DAT-278, ADR-0011). A session-scoped,
      // workspace-scoped snapshot of module/action permissions, the verified
      // repository capability intersection, and authority freshness. It is
      // advisory: every request is still checked object by object. A caller
      // without a live membership in the path workspace gets the same
      // indistinguishable 404 as every other workspace route.
      if (segments[2] === "workspaces" && segments[4] === "capabilities" && segments.length === 5) {
        const method = req.method ?? "GET";
        if (method !== "GET") {
          throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
        }
        const actor = authenticateRequest(req, deps);
        if (actor.kind !== "session" || deps.auth === undefined || deps.authority === undefined) {
          throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
        }
        const workspaceId = segments[3];
        if (workspaceId === undefined) {
          throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
        }
        scopedWorkspaceAccess(actor, deps, workspaceId);
        writeJson(res, 200, deps.authority.projection(actor.ctx.user.id, workspaceId));
        return;
      }

      // Workspace dashboard (DAT-230): read-only aggregate surface with its
      // own session scope resolution (DAT-241). Dispatched before the
      // task-plane actor logic below.
      if (segments[2] === "workspaces" && segments[4] === "dashboard") {
        if (deps.dashboard === undefined) {
          throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
        }
        await handleDashboardRequest(deps.dashboard, {
          req,
          res,
          url,
          segments,
          requestId,
        });
        return;
      }

      // Workspace memory (DAT-236): authenticated by session and scoped by
      // workspace membership. It has its own scope resolution, so it is
      // dispatched before the task-plane actor logic below.
      if (segments[2] === "workspaces" && segments[4] === "memory") {
        if (deps.memory === undefined) {
          throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
        }
        await handleMemoryRequest(deps.memory, { req, res, url, segments, requestId });
        return;
      }

      // Workspace-scoped task family (DAT-244).
      if (segments[2] === "workspaces") {
        const workspaceId = segments[3];
        if (workspaceId === undefined) {
          throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
        }
        if (segments[4] === "issues") {
          const actor = authenticateRequest(req, deps);
          const issueActorId = actor.kind === "session" ? actor.ctx.user.id : undefined;
          const access = scopedWorkspaceAccess(actor, deps, workspaceId);
          if (access.readOnly && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
            throw new ApiError(403, "FORBIDDEN", "this session has read-only access");
          }
          const requestAction = actionForRequest(method, segments);
          const tail = segments.slice(5);
          // An issue resource is decided with the repository it belongs to
          // (DAT-294): the complete-set evaluation names that target, so a
          // repository removed from the set can no longer authorize its
          // issues, deliveries or approvals.
          const issueRepository = issueRepositoryId(deps, workspaceId, tail[0]);
          const issueScope =
            issueRepository !== undefined ? { repository_id: issueRepository } : undefined;
          if (actor.kind === "session" && requestAction !== null && deps.authority !== undefined) {
            deps.authority.require(actor.ctx.user.id, requestAction, workspaceId, issueScope);
          }
          // Candidate review, candidate-bound approval, and broker-controlled
          // delivery (DAT-259). The path workspace is already resolved against
          // live membership and, for session actors, the action class against
          // the effective-access gate above. This surface does not depend on
          // provider issue sync, so it is served whenever the identity surface
          // (and therefore membership) exists.
          if (deps.collab !== undefined && tail.length >= 2) {
            const handled = await handleCollabRequest(deps.collab, {
              req,
              res,
              url,
              requestId,
              workspaceId,
              issueId: tail[0]!,
              tail: tail.slice(1),
              actor:
                actor.kind === "session"
                  ? {
                      kind: "session",
                      user_id: actor.ctx.user.id,
                      display_name: actor.ctx.user.display_name,
                    }
                  : { kind: "local_operator", user_id: null, display_name: null },
              requesterAuthorized:
                actor.kind === "local_operator"
                  ? true
                  : deps.authority === undefined ||
                    deps.authority.check(actor.ctx.user.id, "delivery", workspaceId, issueScope)
                      .allowed,
            });
            if (handled) {
              return;
            }
          }
          if (deps.issues === undefined) {
            throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
          }
          if (tail.length === 0 && method === "GET") {
            await deps.issues.syncWorkspace(workspaceId).catch(() => undefined);
            const items = deps.issues.list(workspaceId);
            writeJson(res, 200, { items, next_cursor: null });
            return;
          }
          if (tail.length === 0 && method === "POST") {
            const body = await readJsonBody(req);
            const idempotencyKey = req.headers["idempotency-key"];
            if (
              typeof idempotencyKey !== "string" ||
              idempotencyKey.length === 0 ||
              idempotencyKey.length > 256
            ) {
              throw new ApiError(
                400,
                "INVALID_REQUEST",
                "a 1–256 character Idempotency-Key is required",
              );
            }
            const created = await deps.issues.create(
              workspaceId,
              {
                summary: requireString(body, "summary"),
                description: typeof body["description"] === "string" ? body["description"] : "",
                ...(typeof body["source_reference"] === "string"
                  ? { source_reference: body["source_reference"] }
                  : {}),
                labels: optionalStringArray(body, "labels"),
              },
              idempotencyKey,
              issueActorId,
            );
            writeJson(res, 201, created);
            return;
          }
          if (tail.length === 1 && (method === "GET" || method === "HEAD")) {
            await deps.issues.syncWorkspace(workspaceId).catch(() => undefined);
            const issue = deps.issues.get(workspaceId, tail[0]!);
            if (!issue) throw new ApiError(404, "NOT_FOUND", "Issue was not found");
            writeJson(res, 200, issue);
            return;
          }
          if (tail.length === 1 && method === "PATCH") {
            const body = await readJsonBody(req);
            const key = req.headers["idempotency-key"];
            if (typeof key !== "string" || !key)
              throw new ApiError(400, "INVALID_REQUEST", "Idempotency-Key is required");
            const result = await deps.issues.update(
              workspaceId,
              tail[0]!,
              {
                ...(typeof body["title"] === "string" ? { title: body["title"] } : {}),
                ...(typeof body["description"] === "string"
                  ? { description: body["description"] }
                  : {}),
                ...(body["state"] === "open" || body["state"] === "closed"
                  ? { state: body["state"] }
                  : {}),
                ...(Array.isArray(body["labels"])
                  ? { labels: optionalStringArray(body, "labels") }
                  : {}),
              },
              key,
              issueActorId,
            );
            writeJson(res, 200, result);
            return;
          }
          if (tail.length === 2 && tail[1] === "versions" && method === "GET") {
            writeJson(res, 200, { items: deps.issues.versions(workspaceId, tail[0]!) });
            return;
          }
          if (tail.length === 2 && tail[1] === "comments" && method === "GET") {
            writeJson(res, 200, { items: deps.issues.comments(workspaceId, tail[0]!) });
            return;
          }
          if (tail.length === 2 && tail[1] === "comments" && method === "POST") {
            const body = await readJsonBody(req);
            const key = req.headers["idempotency-key"];
            if (typeof key !== "string" || !key)
              throw new ApiError(400, "INVALID_REQUEST", "Idempotency-Key is required");
            const result = await deps.issues.addComment(
              workspaceId,
              tail[0]!,
              requireString(body, "body"),
              key,
              issueActorId,
            );
            writeJson(res, 201, result);
            return;
          }
          if (tail.length === 2 && tail[1] === "rollback" && method === "POST") {
            const body = await readJsonBody(req);
            const key = req.headers["idempotency-key"];
            if (typeof key !== "string" || !key)
              throw new ApiError(400, "INVALID_REQUEST", "Idempotency-Key is required");
            const result = await deps.issues.rollback(
              workspaceId,
              tail[0]!,
              requireString(body, "version_id"),
              key,
              issueActorId,
            );
            writeJson(res, 200, result);
            return;
          }
          throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
        }
        // Selectable targets for an explicit task selection (DAT-292). The
        // workspace locator is resolved against live membership below; the
        // list names immutable binding identities and the trusted baseline,
        // never credentials or another tenant's repositories.
        if (segments[4] === "task-targets") {
          if (method !== "GET" || segments.length !== 5) {
            throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
          }
          const actor = authenticateRequest(req, deps);
          scopedWorkspaceAccess(actor, deps, workspaceId);
          if (actor.kind === "session" && deps.authority !== undefined) {
            deps.authority.require(actor.ctx.user.id, "read", workspaceId);
          }
          if (deps.taskTargets === undefined) {
            throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
          }
          writeJson(res, 200, await deps.taskTargets.list(workspaceId));
          return;
        }
        if (segments[4] !== "tasks") {
          throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
        }
        const actor = authenticateRequest(req, deps);
        const access = scopedWorkspaceAccess(actor, deps, workspaceId);
        if (access.readOnly && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
          throw new ApiError(403, "FORBIDDEN", "this session has read-only access");
        }
        const requestAction = actionForRequest(method, segments);
        if (actor.kind === "session" && requestAction !== null && deps.authority !== undefined) {
          // A task, its stream and its artifacts are decided against the
          // task's immutable target; a stream also asserts the set version it
          // opened against (DAT-294).
          deps.authority.require(
            actor.ctx.user.id,
            requestAction,
            workspaceId,
            taskAuthorityScope(deps, segments[5], workspaceId, requestAction),
          );
        }
        await handleTaskRequest(
          {
            req,
            res,
            url,
            deps,
            actor,
            workspaceId,
            scoped: true,
          },
          segments.slice(5),
        );
        return;
      }

      if (segments[2] !== "tasks") {
        throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
      }
      const actor = authenticateRequest(req, deps);
      // Legacy seam: a session is still gated on the configured workspace's
      // membership, and a viewer is read-only there exactly as before.
      let readOnly = false;
      if (actor.kind === "session" && deps.auth !== undefined) {
        const role = deps.auth.workspaceRole(actor.ctx.user.id);
        if (role === undefined) {
          throw new ApiError(403, "FORBIDDEN", "an active workspace membership is required");
        }
        readOnly = role === "viewer";
        if (readOnly && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
          throw new ApiError(403, "FORBIDDEN", "this session has read-only access");
        }
      }
      // Provider authority (DAT-203): the effective-access gate runs at the
      // request boundary for every action class. Provider member removal,
      // revoked authority, and lost capability grants deny here — before any
      // route body runs — with no decision cache to outlive the revocation.
      // The legacy family is bound to the configured workspace.
      const requestAction = actionForRequest(method, segments);
      if (actor.kind === "session" && requestAction !== null && deps.authority !== undefined) {
        // The legacy seam is the same protected path: it names the task's
        // target instead of authorizing from the deployment's default
        // repository (DAT-294).
        deps.authority.require(
          actor.ctx.user.id,
          requestAction,
          deps.legacyWorkspaceId,
          taskAuthorityScope(deps, segments[3], deps.legacyWorkspaceId, requestAction),
        );
      }
      await handleTaskRequest(
        {
          req,
          res,
          url,
          deps,
          actor,
          workspaceId: deps.legacyWorkspaceId,
          scoped: false,
        },
        segments.slice(3),
      );
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (isApiError(error)) {
        writeJson(res, error.status, error.toBody(requestId));
        return;
      }
      if (error instanceof ControlPlaneError) {
        const mapped = apiErrorFromControlPlane(error);
        writeJson(res, mapped.status, mapped.toBody(requestId));
        return;
      }
      writeJson(
        res,
        500,
        // Unexpected failures serve one fixed safe message: the cause may
        // carry internal diagnostics (paths, payloads, provider text) and
        // stays in server-side logs only — never in the shared envelope
        // (ADR-0008: messages and details never expose sensitive diagnostics).
        new ApiError(500, "INTERNAL_ERROR", "An unexpected internal error occurred.").toBody(
          requestId,
        ),
      );
      console.error(`unhandled API error on request ${requestId}:`, error);
    }
  };

  return http.createServer((req, res) => {
    void handler(req, res);
  });
}
