import { TASK_EVENT_TYPES, UI_STATUSES } from "./task-store.js";
import { PI_SUMMARY_STATUSES, PI_SUMMARY_UNAVAILABLE_REASONS } from "./pi-summary.js";
import { DSH_STATES } from "../dsh/types.js";

type JsonObject = Record<string, unknown>;

/** Loosely-typed OpenAPI 3.1 document; schemas stay plain JSON objects. */
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description: string }>;
  /** Global security requirement; every operation also carries it explicitly. */
  security: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
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

const artifactMetadataSchema: JsonObject = {
  type: "object",
  required: ["artifact_id", "available", "digest", "head_sha"],
  properties: {
    artifact_id: { type: "string", examples: ["evidence_bundle", "patch_report"] },
    available: { type: "boolean" },
    digest: { type: ["string", "null"], examples: ["sha256:…"] },
    head_sha: { type: ["string", "null"] },
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
    "association",
    "revision",
    "status",
    "status_reason",
    "risk",
    "progress",
    "pi_summary",
    "governance",
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
    association: {
      type: "object",
      description:
        "Verifiable task/run/repository/revision binding. run_id and " +
        "head_sha are projected from the authoritative dsh run; task_id, " +
        "repository_id, and base_sha are the creation bindings dsh accepted " +
        "and pinned for the run. Node never invents any of these values.",
      required: ["task_id", "run_id", "repository_id", "base_sha", "head_sha"],
      properties: {
        task_id: { type: "string" },
        run_id: { type: ["string", "null"] },
        repository_id: { type: "string" },
        base_sha: { type: "string" },
        head_sha: { type: ["string", "null"] },
      },
    },
    revision: {
      type: "object",
      required: ["base_sha", "head_sha"],
      properties: {
        base_sha: { type: "string" },
        head_sha: { type: ["string", "null"] },
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
    pi_summary: {
      description:
        "Display-safe summary of the latest settled Pi turn for the current " +
        "run (DAT-191). Null until a Pi session exists for the task. The " +
        "raw pi.text_delta stream is never the display source: text is " +
        "exposed only through this fail-closed, Node-judged summary.",
      oneOf: [{ $ref: "#/components/schemas/PiSummary" }, { type: "null" }],
    },
    governance: {
      type: "object",
      description:
        "GitHub merge-boundary projection for the current head. Approvals " +
        "and checks observed against an older head are invalidated: " +
        "observations_valid turns false and merge_queue_eligible turns false " +
        "until dsh observes them against the current head.",
      required: ["current_head_sha", "observations_valid", "merge_queue_eligible"],
      properties: {
        current_head_sha: { type: ["string", "null"] },
        observations_valid: { type: "boolean" },
        merge_queue_eligible: { type: "boolean" },
      },
    },
    artifacts: {
      type: "object",
      required: ["patch", "report", "evidence_bundle_available", "index"],
      properties: {
        patch: { type: "null" },
        report: { type: "null" },
        evidence_bundle_available: { type: "boolean" },
        index: {
          type: "array",
          items: { $ref: "#/components/schemas/ArtifactMetadata" },
        },
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

const piSummarySchema: JsonObject = {
  type: "object",
  description:
    "A display-safe natural-language summary of the latest settled Pi turn " +
    "for one task run. Source: the fully assembled assistant text of that " +
    "turn, judged on the Node side by an ordered fail-closed certification " +
    "table (DAT-192): credentials, shell syntax, absolute workspace paths, " +
    "command invocations, argument material, unredacted logs, and opaque " +
    "high-entropy strings fail closed as unsafe_content; a report that " +
    "something was executed, or a sentence opener the gate cannot recognise " +
    "as narrative prose, fails closed as undecidable. Certification is " +
    "positive — only text recognised as ordinary narrative prose is exposed " +
    "— and never rests on enumerating command tools alone. Fail closed: " +
    "text is exposed only when the entire turn passes every rule; any hit " +
    "or a gate failure yields status=unavailable with text=null, never " +
    "redacted or partial content. Lifecycle: null on the task until a Pi " +
    "session exists; pending from " +
    "session start (and at the start of every run) until a turn settles; " +
    "then exactly one available/unavailable per settled turn, each replacing " +
    "the previous summary — a turn settles (and publishes) exactly once, " +
    "including the duplicated agent_error/agent_settled emission of a " +
    "provider failure. A terminal task whose last turn never settled keeps " +
    "status pending with text null; no summary is fabricated after the " +
    "terminal frame. A pi.summary.updated event carries the same " +
    "object on the SSE stream and in the timeline, replayable by " +
    "Last-Event-ID like every other event.",
  required: ["task_id", "run_id", "turn_id", "status", "text", "unavailable_reason", "updated_at"],
  properties: {
    task_id: { type: "string" },
    run_id: {
      type: ["string", "null"],
      description: "The run whose Pi session produced this summary.",
    },
    turn_id: {
      type: ["string", "null"],
      description: "The Pi turn this summary describes; null while pending.",
    },
    status: { type: "string", enum: [...PI_SUMMARY_STATUSES] },
    text: {
      type: ["string", "null"],
      maxLength: 240,
      description:
        "The bounded excerpt of the validated turn text; non-null iff status is available.",
    },
    unavailable_reason: {
      type: ["string", "null"],
      enum: [...PI_SUMMARY_UNAVAILABLE_REASONS, null],
      description:
        "Why no text is exposed: no_content (the settled turn produced no " +
        "displayable text), unsafe_content (identified unsafe material), " +
        "undecidable (the gate could not certify the turn: an execution " +
        "report or an unrecognised sentence opener), gate_error (the gate " +
        "itself failed). Null unless status is unavailable. The enum is " +
        "additive: clients render an unknown reason as a plain unavailable " +
        "state.",
    },
    updated_at: { type: "string", format: "date-time" },
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
 * The single Bearer security requirement applied to every operation. The
 * per-process token (see the M0 Authentication section) is what authorizes a
 * caller — approvals included — so a client generated from this contract
 * knows to send `Authorization: Bearer <token>` on every call.
 */
const BEARER_SECURITY: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

/** The 401 response every operation can return when the token is missing/wrong. */
function unauthorizedResponse(): JsonObject {
  return errorResponse("Missing or invalid Authorization: Bearer <token> header");
}

/**
 * Stamp the security requirement and 401 response onto every operation in a
 * paths object, so auth coverage cannot silently miss an endpoint.
 */
function stampAuth(paths: Record<string, Record<string, unknown>>): void {
  for (const methods of Object.values(paths)) {
    for (const operation of Object.values(methods)) {
      if (operation === null || typeof operation !== "object") {
        continue;
      }
      const op = operation as { security?: unknown; responses?: Record<string, unknown> };
      op.security = BEARER_SECURITY;
      op.responses = { ...op.responses, 401: unauthorizedResponse() };
    }
  }
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
  const paths: Record<string, Record<string, unknown>> = {
    "/api/v1/tasks": {
      post: {
        operationId: "createTask",
        summary: "Create a remediation task",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string", maxLength: 256 },
            description:
              "Replay-safe create. Repeating the request with the same key " +
              "and payload returns the original task instead of minting a " +
              "second run; the same key with a different payload is 409 " +
              "IDEMPOTENCY_CONFLICT.",
          },
        ],
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
          409: errorResponse("Task state conflict or IDEMPOTENCY_CONFLICT"),
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
        summary:
          "SSE stream of task events; replays by Last-Event-ID in sequence order " +
          "from the durable projection, so a reconnect after an orchestrator " +
          "restart resumes exactly where the client stopped without duplicating " +
          "business events. A terminal task's stream always closes after its " +
          "replay, including when Last-Event-ID is already anchored at " +
          "task.terminal and the replay has nothing left to write.",
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
  };

  // Stamp the security requirement and 401 response onto every operation so
  // auth coverage cannot silently miss an endpoint.
  stampAuth(paths);

  return {
    openapi: "3.1.0",
    info: {
      title: "ForgePilot orchestrator API",
      version: "0.4.0",
      description:
        "forgepilot-api/v1: the Node-to-UI contract of the ForgePilot pilot. " +
        "The UI calls Node only, at an ephemeral loopback address; it never sees " +
        "dsh sockets, boot tokens, Pi credentials, raw tool output, or provider " +
        "credentials. Pi text is displayed only through the fail-closed " +
        "pi_summary contract (DAT-191), hardened by the certification " +
        "boundary of DAT-192. Generated from the orchestrator " +
        "implementation; shapes are defined by " +
        "docs/contracts/forgepilot-api-v1.md.",
    },
    servers: [{ url: "http://127.0.0.1", description: "Ephemeral loopback bind" }],
    security: BEARER_SECURITY,
    paths,
    components: {
      schemas: {
        Task: taskSchema,
        TaskEvent: taskEventSchema,
        PiSummary: piSummarySchema,
        RunSummary: runSummarySchema,
        ArtifactMetadata: artifactMetadataSchema,
        Error: errorSchema,
      },
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Per-process API bearer token, minted at orchestrator start and written " +
            "0600 to the API token file. The UI reads that file and sends it as " +
            "Authorization: Bearer <token> on every request; possession of the token " +
            "authorizes acting as the local operator, approvals included.",
        },
      },
    },
  };
}
