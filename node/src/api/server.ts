import { randomUUID } from "node:crypto";
import http from "node:http";

import { isAuthorizedBearer } from "./auth.js";
import type { AuthService, SessionContext } from "./auth-service.js";
import { handleAuthRequest, requireSessionActor } from "./auth-http.js";
import { handleDashboardRequest } from "./dashboard-http.js";
import type { DashboardHttpDeps } from "./dashboard-http.js";
import { handleMemoryRequest } from "./memory-http.js";
import type { MemoryHttpDeps } from "./memory-http.js";
import { ApiError, apiErrorFromControlPlane } from "./errors.js";
import { ControlPlaneError } from "../control-plane/errors.js";
import { principalFromSession } from "../control-plane/request-scope.js";
import { handleInvitationRequest } from "./invitation-http.js";
import type { InvitationService } from "./invitation-service.js";
import {
  isApiError,
  optionalStringArray,
  readJsonBody,
  requireString,
  writeJson,
} from "./http-util.js";
import type { TaskEvent, TaskResource } from "./task-store.js";
import type { TaskService } from "./task-service.js";
import { actionForRequest } from "./request-authority.js";
import type { RequestAuthority } from "./request-authority.js";

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
    return { kind: "session", ctx: requireSessionActor(deps.auth, req) };
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
      const created = await service.createTask(
        {
          repository_id: requireString(body, "repository_id"),
          base_ref: requireString(body, "base_ref"),
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
    // workspace, not the deployment default.
    if (actor.kind === "session" && deps.authority !== undefined) {
      const authority = deps.authority;
      const streamUser = actor.ctx.user.id;
      const unsubscribeAuthority = authority.subscribe(() => {
        if (!authority.check(streamUser, "stream", workspaceId).allowed) {
          res.end();
        }
      });
      req.on("close", unsubscribeAuthority);
    }
    const unsubscribe = service.subscribe(
      taskId,
      (event) => {
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

      // Identity, session, and administrator surfaces authenticate themselves.
      if (segments[2] === "auth" || segments[2] === "admin") {
        if (deps.auth === undefined) {
          throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
        }
        await handleAuthRequest(
          {
            auth: deps.auth,
            ...(deps.publicOrigin !== undefined ? { publicOrigin: deps.publicOrigin } : {}),
          },
          { req, res, url, segments, requestId },
        );
        return;
      }

      const method = req.method ?? "GET";

      // GET /api/v1/workspaces — exactly the caller's live memberships.
      if (segments[2] === "workspaces" && segments.length === 3) {
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
        if (workspaceId === undefined || segments[4] !== "tasks") {
          throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
        }
        const actor = authenticateRequest(req, deps);
        const access = scopedWorkspaceAccess(actor, deps, workspaceId);
        if (access.readOnly && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
          throw new ApiError(403, "FORBIDDEN", "this session has read-only access");
        }
        const requestAction = actionForRequest(method, segments);
        if (actor.kind === "session" && requestAction !== null && deps.authority !== undefined) {
          deps.authority.require(actor.ctx.user.id, requestAction, workspaceId);
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
        deps.authority.require(actor.ctx.user.id, requestAction);
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
