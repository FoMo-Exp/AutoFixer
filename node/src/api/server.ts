import { randomUUID } from "node:crypto";
import http from "node:http";

import { isAuthorizedBearer } from "./auth.js";
import type { AuthService, SessionContext } from "./auth-service.js";
import { handleAuthRequest, requireSessionActor } from "./auth-http.js";
import { ApiError, apiErrorFromControlPlane } from "./errors.js";
import { ControlPlaneError } from "../control-plane/errors.js";
import {
  isApiError,
  optionalStringArray,
  readJsonBody,
  requireString,
  writeJson,
} from "./http-util.js";
import type { TaskEvent } from "./task-store.js";
import type { TaskService } from "./task-service.js";

export interface ApiServerDeps {
  service: TaskService;
  /** Per-process bearer token callers must present (401 otherwise). */
  apiToken: string;
  /**
   * Identity/session subsystem. When set, /api/v1/auth and /api/v1/admin are
   * served and requests may authenticate with a web session cookie or a
   * desktop session token instead of the operator bearer token. When unset,
   * the local-operator bearer surface is unchanged.
   */
  auth?: AuthService;
  /** External origin override for OAuth redirects; loopback derives per request. */
  publicOrigin?: string;
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
    const allowed = new Set(
      ["127.0.0.1", "localhost", "[::1]"].map((host) => `http://${host}:${localPort ?? 0}`),
    );
    if (!allowed.has(origin)) {
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

/**
 * forgepilot-api/v1 HTTP surface.
 *
 * Binds loopback only: the contract has the UI talk to Node at an ephemeral
 * loopback address, never to dsh sockets or Pi credentials directly.
 */
export function createApiServer(deps: ApiServerDeps): http.Server {
  const { service } = deps;

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

      if (segments[2] !== "tasks") {
        throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
      }
      const actor = authenticateRequest(req, deps);
      // Session authority is bounded by the workspace membership: a revoked
      // membership or a viewer role loses writes immediately; a lost
      // membership loses reads as well.
      const method = req.method ?? "GET";
      const isWrite = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
      if (actor.kind === "session" && deps.auth !== undefined) {
        const role = deps.auth.workspaceRole(actor.ctx.user.id);
        if (role === undefined) {
          throw new ApiError(403, "FORBIDDEN", "an active workspace membership is required");
        }
        if (role === "viewer" && isWrite) {
          throw new ApiError(403, "FORBIDDEN", "this session has read-only access");
        }
      }
      const taskId = segments[3];

      // POST /api/v1/tasks
      if (req.method === "POST" && segments.length === 3) {
        const body = await readJsonBody(req);
        const idempotencyKey = req.headers["idempotency-key"];
        // The contract caps the key at 256 characters; enforce it here so the
        // documented maxLength is real rather than aspirational.
        if (typeof idempotencyKey === "string" && idempotencyKey.length > 256) {
          throw new ApiError(
            400,
            "INVALID_REQUEST",
            "Idempotency-Key must be at most 256 characters",
            { length: idempotencyKey.length },
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
          typeof idempotencyKey === "string" && idempotencyKey.length > 0 ? { idempotencyKey } : {},
        );
        writeJson(res, 201, created);
        return;
      }

      // GET /api/v1/tasks
      if (req.method === "GET" && segments.length === 3) {
        const cursor = url.searchParams.get("cursor");
        const status = url.searchParams.get("status");
        writeJson(res, 200, service.listTasks(cursor, status));
        return;
      }

      if (taskId === undefined) {
        throw new ApiError(404, "TASK_NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
      }

      // GET /api/v1/tasks/{task_id}
      if (req.method === "GET" && segments.length === 4) {
        writeJson(res, 200, service.getTask(taskId));
        return;
      }

      const sub = segments[4];
      if (segments.length === 5 && req.method === "POST" && sub === "messages") {
        const body = await readJsonBody(req);
        const mode = requireString(body, "mode");
        if (mode !== "steer" && mode !== "follow_up") {
          throw new ApiError(400, "INVALID_REQUEST", 'mode must be "steer" or "follow_up"');
        }
        const content = requireString(body, "content");
        await service.sendMessage(taskId, mode, content);
        writeJson(res, 202, { task_id: taskId, queued: true });
        return;
      }

      if (segments.length === 5 && req.method === "POST" && sub === "approvals") {
        const body = await readJsonBody(req);
        const decision = requireString(body, "decision");
        if (decision !== "approve" && decision !== "reject") {
          throw new ApiError(400, "INVALID_REQUEST", 'decision must be "approve" or "reject"');
        }
        const approved = await service.approveTask(taskId, {
          decision,
          scope_digest: requireString(body, "scope_digest"),
        });
        writeJson(res, 200, approved);
        return;
      }

      if (segments.length === 5 && req.method === "POST" && sub === "cancel") {
        const body = await readJsonBody(req);
        const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
        writeJson(res, 202, await service.cancelTask(taskId, reason));
        return;
      }

      if (
        segments.length === 5 &&
        req.method === "POST" &&
        (sub === "archive" || sub === "recover")
      ) {
        writeJson(res, 200, service.setTaskArchived(taskId, sub === "archive"));
        return;
      }

      if (segments.length === 5 && req.method === "GET" && sub === "runs") {
        writeJson(res, 200, { items: service.getRunSummaries(taskId) });
        return;
      }

      if (segments.length === 5 && req.method === "GET" && sub === "timeline") {
        writeJson(res, 200, { items: service.getTimeline(taskId) });
        return;
      }

      if (
        segments.length === 6 &&
        req.method === "GET" &&
        sub === "artifacts" &&
        segments[5] !== undefined
      ) {
        writeJson(res, 200, await service.getArtifact(taskId, segments[5]));
        return;
      }

      if (segments.length === 5 && req.method === "GET" && sub === "stream") {
        service.getTask(taskId); // 404 before headers are committed
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const timeline = service.getTimeline(taskId);
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
        if (service.isTerminal(taskId)) {
          res.end();
          return;
        }
        // A session stream dies the moment its authority dies: logout,
        // suspension, or revoked membership ends the subscription instead of
        // leaving a zombie stream behind.
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
                auth.workspaceRole(sessionCtx.user.id) === undefined);
            if (losesAccess) {
              res.end();
            }
          });
          req.on("close", unsubscribeAuth);
        }
        const unsubscribe = service.subscribe(taskId, (event) => {
          writeSseEvent(res, event);
          if (event.type === "task.terminal") {
            res.end();
          }
        });
        req.on("close", unsubscribe);
        return;
      }

      throw new ApiError(404, "TASK_NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
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
      writeJson(res, 500, {
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
          request_id: requestId,
          retryable: false,
          details: {},
        },
      });
    }
  };

  return http.createServer((req, res) => {
    void handler(req, res);
  });
}
