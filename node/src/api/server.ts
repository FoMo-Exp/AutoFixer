import { randomUUID } from "node:crypto";
import http from "node:http";

import type { ApiError } from "./errors.js";
import { ApiError as ApiErrorClass } from "./errors.js";
import type { TaskEvent } from "./task-store.js";
import type { TaskService } from "./task-service.js";

export interface ApiServerDeps {
  service: TaskService;
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new ApiErrorClass(400, "INVALID_REQUEST", "request body is too large");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiErrorClass(400, "INVALID_REQUEST", "request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiErrorClass) {
      throw error;
    }
    throw new ApiErrorClass(400, "INVALID_REQUEST", "request body is not valid JSON");
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiErrorClass(400, "INVALID_REQUEST", `${field} is required`);
  }
  return value;
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ApiErrorClass(400, "INVALID_REQUEST", `${field} must be an array of strings`);
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
  return value instanceof ApiErrorClass;
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
        throw new ApiErrorClass(
          404,
          "TASK_NOT_FOUND",
          `No route for ${req.method} ${url.pathname}`,
        );
      }
      const taskId = segments[3];

      // POST /api/v1/tasks
      if (req.method === "POST" && segments.length === 3) {
        const body = await readJsonBody(req);
        const created = await service.createTask({
          repository_id: requireString(body, "repository_id"),
          base_ref: requireString(body, "base_ref"),
          summary: requireString(body, "summary"),
          ...(typeof body["source_reference"] === "string"
            ? { source_reference: body["source_reference"] }
            : {}),
          acceptance_criteria: optionalStringArray(body, "acceptance_criteria"),
        });
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
        throw new ApiErrorClass(
          404,
          "TASK_NOT_FOUND",
          `No route for ${req.method} ${url.pathname}`,
        );
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
          throw new ApiErrorClass(400, "INVALID_REQUEST", 'mode must be "steer" or "follow_up"');
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
          throw new ApiErrorClass(400, "INVALID_REQUEST", 'decision must be "approve" or "reject"');
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
        for (const item of service.getTimeline(taskId)) {
          if (item.sequence > lastSequence) {
            writeSseEvent(res, item);
          }
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

      throw new ApiErrorClass(404, "TASK_NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
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
