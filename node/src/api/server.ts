import { randomUUID } from "node:crypto";
import http from "node:http";

import { isAuthorizedBearer } from "./auth.js";
import { ApiError } from "./errors.js";
import type { TaskEvent } from "./task-store.js";
import type { TaskService } from "./task-service.js";

export interface ApiServerDeps {
  service: TaskService;
  /** Per-process bearer token callers must present (401 otherwise). */
  apiToken: string;
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(400, "INVALID_REQUEST", "request body is too large");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "INVALID_REQUEST", "request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(400, "INVALID_REQUEST", "request body is not valid JSON");
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} is required`);
  }
  return value;
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be an array of strings`);
  }
  return value as string[];
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const encoded = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

function writeSseEvent(res: http.ServerResponse, event: TaskEvent): void {
  res.write(`id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Authenticate and origin-check one API request.
 *
 * Every /api/v1 call must present the per-process bearer token: possessing
 * it — not a statically configured identity string — is what authorizes a
 * caller to act as the local operator, approvals included. Browser-originated
 * calls are additionally pinned to this server's own loopback origin, and
 * bodies must be JSON, so a cross-site page cannot ride a simple request.
 */
function authorizeApiRequest(
  req: http.IncomingMessage,
  apiToken: string,
  localPort: number | undefined,
): void {
  if (!isAuthorizedBearer(req.headers.authorization, apiToken)) {
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      "A valid Authorization: Bearer <token> header is required (see the API token file).",
    );
  }
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
      if (segments[0] !== "api" || segments[1] !== "v1" || segments[2] !== "tasks") {
        throw new ApiError(404, "TASK_NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
      }
      authorizeApiRequest(req, deps.apiToken, res.socket?.localPort);
      const taskId = segments[3];

      // POST /api/v1/tasks
      if (req.method === "POST" && segments.length === 3) {
        const body = await readJsonBody(req);
        const idempotencyKey = req.headers["idempotency-key"];
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
        const lastEventId = req.headers["last-event-id"];
        let lastSequence = 0;
        if (typeof lastEventId === "string" && lastEventId.length > 0) {
          const known = service.getTimeline(taskId).find((item) => item.event_id === lastEventId);
          // Unknown ids replay from the start: safer than silently skipping
          // history for a reconnecting client.
          lastSequence = known?.sequence ?? 0;
        }
        let ended = false;
        for (const item of service.getTimeline(taskId)) {
          if (item.sequence > lastSequence) {
            writeSseEvent(res, item);
            if (item.type === "task.terminal") {
              // The replay itself closed the task: a reconnecting client gets
              // the terminal frame and a completed stream, never a dangling
              // subscription on a dead task.
              ended = true;
            }
          }
        }
        if (ended) {
          res.end();
          return;
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
