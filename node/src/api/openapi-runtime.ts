/**
 * OpenAPI contract for the runtime diagnostics surface (DAT-257).
 *
 * One operator-only read reports three readiness boundaries — startup, task,
 * model — from redacted component checks. The document reuses the service's
 * closed vocabularies so a client cannot invent a fourth stage or status, and
 * it states explicitly that a blocked report is still a 200: readiness is
 * data, not a transport failure.
 */

import type { JsonObject } from "./openapi-types.js";
import {
  DIAGNOSTIC_STATUSES,
  READINESS_STAGES,
  READINESS_STATUSES,
  RUNTIME_COMPONENT_IDS,
} from "../diagnostics/runtime.js";

const errorRef = { $ref: "#/components/schemas/Error" } as const;

function errorResponse(description: string): JsonObject {
  return { description, content: { "application/json": { schema: errorRef } } };
}

const checkSchema: JsonObject = {
  type: "object",
  required: ["id", "label", "status", "stages", "detail", "next_action"],
  properties: {
    id: { type: "string", enum: [...RUNTIME_COMPONENT_IDS] },
    label: { type: "string", description: "Subsystem name; never a credential or secret." },
    status: {
      type: "string",
      enum: [...DIAGNOSTIC_STATUSES],
      description:
        "`ready` — usable; `degraded` — usable with an operator warning; " +
        "`blocked` — unusable until fixed; `not_configured` — optional subsystem " +
        "absent (or required by a boundary, which makes that boundary blocked).",
    },
    stages: {
      type: "array",
      items: { type: "string", enum: [...READINESS_STAGES] },
      description: "Readiness boundaries this component gates.",
    },
    detail: {
      type: "string",
      description:
        "Redacted evidence for the status. Never contains token, credential, " +
        "session, bootstrap, or key material; absolute state paths are omitted " +
        "from the API (basenames only).",
    },
    next_action: {
      type: ["string", "null"],
      description: "Operator action that changes the status; null when nothing is wrong.",
    },
  },
};

const runtimeDiagnosticsSchema: JsonObject = {
  type: "object",
  required: ["service", "readiness", "checks", "blockers", "notes", "generated_at"],
  properties: {
    service: {
      type: "object",
      required: ["name", "version", "pid", "started_at", "uptime_seconds", "single_instance"],
      properties: {
        name: { type: "string", enum: ["forgepilot-api/v1"] },
        version: { type: "string" },
        pid: { type: "integer" },
        started_at: { type: "string", format: "date-time" },
        uptime_seconds: { type: "integer", minimum: 0 },
        single_instance: {
          type: "boolean",
          enum: [true],
          description:
            "One orchestrator per state directory. The task projection, budget " +
            "journal, control-plane database, and append-only audit streams are " +
            "single-writer; a second instance sharing them is unsupported.",
        },
      },
    },
    readiness: {
      type: "object",
      required: ["startup", "task", "model"],
      properties: {
        startup: {
          type: "string",
          enum: [...READINESS_STATUSES],
          description:
            "Configuration and startup-critical state are valid; a blocked " +
            "startup refuses to serve.",
        },
        task: {
          type: "string",
          enum: [...READINESS_STATUSES],
          description:
            "dsh, the pinned repository/base revision, and durable task state " +
            "are usable; blocked means runs cannot start (DSH_UNAVAILABLE).",
        },
        model: {
          type: "string",
          enum: [...READINESS_STATUSES],
          description:
            "Pi model, gateway policy/credentials, and session-scoped egress are " +
            "usable; blocked means every dispatch is denied (fail closed).",
        },
      },
    },
    checks: { type: "array", items: { $ref: "#/components/schemas/RuntimeDiagnosticCheck" } },
    blockers: {
      type: "array",
      items: { type: "string" },
      description:
        "Component ids (`config`, `dsh`, …) whose status blocks a readiness boundary. " +
        "Empty only when every boundary is ready or degraded.",
    },
    notes: {
      type: "array",
      items: { type: "string" },
      description: "Safe operational notes, including the single-instance limitation.",
    },
    generated_at: { type: "string", format: "date-time" },
  },
};

export const RUNTIME_OPENAPI_SCHEMAS = {
  RuntimeDiagnosticCheck: checkSchema,
  RuntimeDiagnostics: runtimeDiagnosticsSchema,
};

export function runtimeOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/api/v1/runtime/diagnostics": {
      get: {
        operationId: "getRuntimeDiagnostics",
        summary: "Redacted runtime configuration and readiness report",
        description:
          "Operator-only diagnosis of the deployment's own configuration and state: " +
          "dsh reachability, pinned repository/base SHA, Pi model, model gateway, " +
          "enterprise identity, durable state, and budget. Startup, task, and model " +
          "readiness are reported separately; a blocked boundary still returns 200 " +
          "with the evidence and the next action. No secret material is returned. " +
          "Only the local-operator bearer is accepted: deployment paths and " +
          "readiness are not enterprise-user data.",
        responses: {
          200: {
            description:
              "Diagnostics report. Readiness may be degraded or blocked; " +
              "inspect `readiness`, `checks`, and `blockers`.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RuntimeDiagnostics" },
              },
            },
          },
          403: errorResponse("FORBIDDEN — a session credential is not the deployment operator"),
        },
      },
    },
  };
}
