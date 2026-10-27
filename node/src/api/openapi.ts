import { TASK_EVENT_TYPES, UI_STATUSES } from "./task-store.js";
import { DSH_STATES } from "../dsh/types.js";

type JsonObject = Record<string, unknown>;

/** Loosely-typed OpenAPI 3.1 document; schemas stay plain JSON objects. */
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
}

const errorSchema: JsonObject = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "request_id", "retryable", "details"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        request_id: { type: "string" },
        retryable: { type: "boolean" },
        details: { type: "object", additionalProperties: true },
      },
    },
  },
};

const taskSchema: JsonObject = {
  type: "object",
  required: [
    "id",
    "version",
    "created_at",
    "updated_at",
    "current_run_id",
    "run_history_url",
    "repository",
    "request",
    "status",
    "status_reason",
    "risk",
    "progress",
    "artifacts",
  ],
  properties: {
    id: { type: "string" },
    version: { type: "integer" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    current_run_id: { type: ["string", "null"] },
    run_history_url: { type: "string" },
    repository: {
      type: "object",
      required: ["id", "display_name", "base_ref", "base_sha"],
      properties: {
        id: { type: "string" },
        display_name: { type: "string" },
        base_ref: { type: "string" },
        base_sha: { type: "string" },
      },
    },
    request: {
      type: "object",
      required: ["summary", "source_reference"],
      properties: {
        summary: { type: "string" },
        source_reference: { type: ["string", "null"] },
      },
    },
    status: { type: "string", enum: [...UI_STATUSES] },
    status_reason: { type: ["string", "null"] },
    risk: {
      type: ["object", "null"],
      required: ["class", "decision_code", "requires_human_approval"],
      properties: {
        class: { type: "string", enum: ["low", "elevated", "prohibited"] },
        decision_code: { type: "string" },
        requires_human_approval: { type: "boolean" },
      },
    },
    progress: {
      type: "object",
      required: ["phase", "actions_completed", "actions_total"],
      properties: {
        phase: { type: ["string", "null"] },
        actions_completed: { type: "integer" },
        actions_total: { type: ["integer", "null"] },
      },
    },
    artifacts: {
      type: "object",
      required: ["patch", "report", "evidence_bundle_available"],
      properties: {
        patch: { type: "null" },
        report: { type: "null" },
        evidence_bundle_available: { type: "boolean" },
      },
    },
  },
};

const taskEventSchema: JsonObject = {
  type: "object",
  required: ["event_id", "sequence", "occurred_at", "task_id", "task_version", "type", "data"],
  properties: {
    event_id: { type: "string" },
    sequence: { type: "integer" },
    occurred_at: { type: "string", format: "date-time" },
    task_id: { type: "string" },
    task_version: { type: "integer" },
    type: {
      type: "string",
      enum: [...TASK_EVENT_TYPES],
    },
    data: { type: "object", additionalProperties: true },
  },
};

const runSummarySchema: JsonObject = {
  type: "object",
  required: ["run_id", "state", "created_at"],
  properties: {
    run_id: { type: "string" },
    state: { type: "string", enum: [...DSH_STATES] },
    created_at: { type: "string", format: "date-time" },
  },
};

function errorResponse(description: string): JsonObject {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function jsonRef(ref: string): JsonObject {
  return { content: { "application/json": { schema: { $ref: ref } } } };
}

/**
 * Build the OpenAPI 3.1 description of forgepilot-api/v1.
 *
 * Derived from the same route and schema vocabulary the HTTP server serves;
 * the generated document at web/src/api/contracts/openapi.json is the merged
 * baseline the UI milestone consumes. Shapes follow docs/contracts/
 * forgepilot-api-v1.md (M0) exactly.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: {
      title: "ForgePilot orchestrator API",
      version: "0.2.0",
      description:
        "forgepilot-api/v1: the Node-to-UI contract of the ForgePilot pilot. " +
        "The UI calls Node only, at an ephemeral loopback address; it never sees " +
        "dsh sockets, boot tokens, Pi credentials, raw tool output, or provider " +
        "credentials. Generated from the orchestrator implementation; shapes are " +
        "defined by docs/contracts/forgepilot-api-v1.md.",
    },
    servers: [{ url: "http://127.0.0.1", description: "Ephemeral loopback bind" }],
    paths: {
      "/api/v1/tasks": {
        post: {
          operationId: "createTask",
          summary: "Create a remediation task",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["repository_id", "base_ref", "summary"],
                  properties: {
                    repository_id: { type: "string", examples: ["github:Luthiel/AutoFixer"] },
                    base_ref: { type: "string", examples: ["main"] },
                    summary: { type: "string" },
                    source_reference: { type: "string" },
                    acceptance_criteria: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: "Task created", ...jsonRef("#/components/schemas/Task") },
            400: errorResponse("Invalid request"),
            409: errorResponse("Task state conflict"),
            422: errorResponse(
              "Prohibited work was rejected by dsh (details.task_id names the rejected task)",
            ),
            503: errorResponse("PI_UNAVAILABLE or DSH_UNAVAILABLE"),
          },
        },
        get: {
          operationId: "listTasks",
          summary: "List tasks",
          parameters: [
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string", enum: [...UI_STATUSES] } },
          ],
          responses: {
            200: {
              description: "Task page",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["items", "next_cursor"],
                    properties: {
                      items: { type: "array", items: { $ref: "#/components/schemas/Task" } },
                      next_cursor: { type: ["string", "null"] },
                    },
                  },
                },
              },
            },
            400: errorResponse("Invalid cursor or status"),
          },
        },
      },
      "/api/v1/tasks/{task_id}": {
        get: {
          operationId: "getTask",
          summary: "Read one task",
          parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "Task", ...jsonRef("#/components/schemas/Task") },
            404: errorResponse("Task not found"),
          },
        },
      },
      "/api/v1/tasks/{task_id}/runs": {
        get: {
          operationId: "getTaskRuns",
          summary: "List the task's runs, ordered by creation time",
          parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: {
              description: "Run summaries",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["items"],
                    properties: {
                      items: { type: "array", items: { $ref: "#/components/schemas/RunSummary" } },
                    },
                  },
                },
              },
            },
            404: errorResponse("Task not found"),
          },
        },
      },
      "/api/v1/tasks/{task_id}/messages": {
        post: {
          operationId: "sendMessage",
          summary: "Queue a steering or follow-up message for the task's Pi session",
          parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["mode", "content"],
                  properties: {
                    mode: { type: "string", enum: ["steer", "follow_up"] },
                    content: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            202: {
              description: "Message queued",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["task_id", "queued"],
                    properties: { task_id: { type: "string" }, queued: { type: "boolean" } },
                  },
                },
              },
            },
            400: errorResponse("Invalid request"),
            404: errorResponse("Task not found"),
            409: errorResponse("Task state conflict"),
          },
        },
      },
      "/api/v1/tasks/{task_id}/approvals": {
        post: {
          operationId: "approveTask",
          summary: "Record the pre-grant approval decision for an elevated task",
          parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["decision", "scope_digest"],
                  properties: {
                    decision: { type: "string", enum: ["approve", "reject"] },
                    scope_digest: { type: "string", examples: ["sha256:…"] },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Task after the decision",
              ...jsonRef("#/components/schemas/Task"),
            },
            400: errorResponse("Invalid request"),
            404: errorResponse("Task not found"),
            409: errorResponse("Task state conflict"),
            403: errorResponse("FORBIDDEN or a dsh policy denial"),
            503: errorResponse("PI_UNAVAILABLE or DSH_UNAVAILABLE"),
          },
        },
      },
      "/api/v1/tasks/{task_id}/cancel": {
        post: {
          operationId: "cancelTask",
          summary: "Cancel a task",
          parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { reason: { type: "string" } },
                },
              },
            },
          },
          responses: {
            202: { description: "Cancellation requested", ...jsonRef("#/components/schemas/Task") },
            404: errorResponse("Task not found"),
            409: errorResponse("The task cannot be cancelled in its terminal state."),
          },
        },
      },
      "/api/v1/tasks/{task_id}/timeline": {
        get: {
          operationId: "getTaskTimeline",
          summary: "Read the task's redacted event timeline",
          parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: {
              description: "Timeline items",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["items"],
                    properties: {
                      items: { type: "array", items: { $ref: "#/components/schemas/TaskEvent" } },
                    },
                  },
                },
              },
            },
            404: errorResponse("Task not found"),
          },
        },
      },
      "/api/v1/tasks/{task_id}/artifacts/{artifact_id}": {
        get: {
          operationId: "getTaskArtifact",
          summary: "Read one redacted artifact for the task's current run",
          parameters: [
            { name: "task_id", in: "path", required: true, schema: { type: "string" } },
            { name: "artifact_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: {
              description: "Redacted artifact, already redacted by dsh",
              content: {
                "application/json": { schema: { type: "object", additionalProperties: true } },
              },
            },
            403: errorResponse("Artifact access denied"),
            404: errorResponse("Task or artifact not found"),
            409: errorResponse("Artifact not finalized"),
            410: errorResponse("Artifact expired"),
          },
        },
      },
      "/api/v1/tasks/{task_id}/stream": {
        get: {
          operationId: "streamTaskEvents",
          summary: "SSE stream of task events; replays by Last-Event-ID in sequence order",
          parameters: [
            { name: "task_id", in: "path", required: true, schema: { type: "string" } },
            {
              name: "Last-Event-ID",
              in: "header",
              required: false,
              schema: { type: "string" },
              description: "Replay events after this event_id; unknown ids replay from the start.",
            },
          ],
          responses: {
            200: {
              description:
                "text/event-stream. Each event carries id (event_id), the event type, " +
                "and data: the TaskEvent envelope. The stream ends after task.terminal.",
              content: {
                "text/event-stream": {
                  schema: { $ref: "#/components/schemas/TaskEvent" },
                },
              },
            },
            404: errorResponse("Task not found"),
          },
        },
      },
    },
    components: {
      schemas: {
        Task: taskSchema,
        TaskEvent: taskEventSchema,
        RunSummary: runSummarySchema,
        Error: errorSchema,
      },
    },
  };
}
