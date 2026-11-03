import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";
import {
  ERROR_CATEGORIES,
  ERROR_ENVELOPE_VERSION,
  ERROR_NEXT_ACTIONS,
  ERROR_STAGES,
} from "../src/api/errors.js";
import { UI_STATUSES } from "../src/api/task-store.js";
import {
  TURN_REPORT_ACTIVITIES,
  TURN_REPORT_AREAS,
  TURN_REPORT_OUTCOMES,
} from "../src/pi/turn-report.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const committedPath = path.join(repoRoot, "web", "src", "api", "contracts", "openapi.json");

const CONTRACT_OPERATIONS: Array<[method: string, path: string]> = [
  ["post", "/api/v1/tasks"],
  ["get", "/api/v1/tasks"],
  ["get", "/api/v1/tasks/{task_id}"],
  ["get", "/api/v1/tasks/{task_id}/runs"],
  ["post", "/api/v1/tasks/{task_id}/messages"],
  ["post", "/api/v1/tasks/{task_id}/approvals"],
  ["post", "/api/v1/tasks/{task_id}/cancel"],
  ["post", "/api/v1/tasks/{task_id}/archive"],
  ["post", "/api/v1/tasks/{task_id}/recover"],
  ["get", "/api/v1/tasks/{task_id}/timeline"],
  ["get", "/api/v1/tasks/{task_id}/artifacts/{artifact_id}"],
  ["get", "/api/v1/tasks/{task_id}/stream"],
  ["get", "/api/v1/auth/providers"],
  ["post", "/api/v1/auth/authorize"],
  ["get", "/api/v1/auth/callback/{provider_instance_id}"],
  ["post", "/api/v1/auth/sessions/exchange"],
  ["get", "/api/v1/auth/session"],
  ["delete", "/api/v1/auth/session"],
  ["get", "/api/v1/workspaces"],
  ["post", "/api/v1/workspaces"],
  ["get", "/api/v1/workspaces/{workspace_id}"],
  ["patch", "/api/v1/workspaces/{workspace_id}"],
  ["post", "/api/v1/workspaces/{workspace_id}/archive"],
  ["post", "/api/v1/workspaces/{workspace_id}/restore"],
  ["post", "/api/v1/workspaces/{workspace_id}/transfer"],
  ["get", "/api/v1/workspaces/{workspace_id}/members"],
  ["post", "/api/v1/workspaces/{workspace_id}/members"],
  ["patch", "/api/v1/workspaces/{workspace_id}/members/{membership_id}"],
  ["delete", "/api/v1/workspaces/{workspace_id}/members/{membership_id}"],
  ["get", "/api/v1/workspaces/{workspace_id}/member-candidates"],
  ["get", "/api/v1/workspaces/{workspace_id}/teams"],
  ["post", "/api/v1/workspaces/{workspace_id}/teams"],
  ["get", "/api/v1/workspaces/{workspace_id}/teams/{team_id}"],
  ["patch", "/api/v1/workspaces/{workspace_id}/teams/{team_id}"],
  ["delete", "/api/v1/workspaces/{workspace_id}/teams/{team_id}"],
  ["get", "/api/v1/workspaces/{workspace_id}/invitations"],
  ["post", "/api/v1/workspaces/{workspace_id}/invitations"],
  ["delete", "/api/v1/workspaces/{workspace_id}/invitations/{invitation_id}"],
  ["post", "/api/v1/invitations/preview"],
  ["post", "/api/v1/invitations/redeem"],
];

/** Login bootstrap operations reachable without a credential. */
const PUBLIC_OPERATIONS: Array<[method: string, path: string]> = [
  ["get", "/api/v1/auth/providers"],
  ["post", "/api/v1/auth/authorize"],
  ["get", "/api/v1/auth/callback/{provider_instance_id}"],
  ["post", "/api/v1/auth/sessions/exchange"],
];

/** List operations and their documented `{items, next_cursor}` pagination. */
const LIST_OPERATIONS: Array<[method: string, path: string]> = [
  ["get", "/api/v1/tasks"],
  ["get", "/api/v1/workspaces"],
  ["get", "/api/v1/workspaces/{workspace_id}/members"],
  ["get", "/api/v1/workspaces/{workspace_id}/member-candidates"],
  ["get", "/api/v1/workspaces/{workspace_id}/teams"],
  ["get", "/api/v1/workspaces/{workspace_id}/invitations"],
];

describe("forgepilot-api/v1 OpenAPI document", () => {
  const document = buildOpenApiDocument();

  test("documents every contracted endpoint", () => {
    for (const [method, path] of CONTRACT_OPERATIONS) {
      expect(document.paths[path], `missing path ${path}`).toBeDefined();
      expect(document.paths[path]?.[method], `missing ${method} ${path}`).toBeDefined();
    }
  });

  test("documents no endpoint outside the contract", () => {
    const documented: Array<[string, string]> = [];
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const method of Object.keys(methods)) {
        documented.push([method, path]);
      }
    }
    expect(documented.sort()).toEqual(
      [...CONTRACT_OPERATIONS].map(([method, path]) => [method, path]).sort(),
    );
  });

  test("Task.status enum matches the contract's UI status vocabulary", () => {
    const task = document.components.schemas["Task"] as {
      properties: { status: { enum: string[] } };
    };
    expect(task.properties.status.enum).toEqual([...UI_STATUSES]);
  });

  test("Task carries the required pi_summary field with the PiSummary schema", () => {
    const task = document.components.schemas["Task"] as {
      required: string[];
      properties: { pi_summary: { oneOf: Array<Record<string, unknown>> } };
    };
    expect(task.required).toContain("pi_summary");
    expect(task.properties.pi_summary.oneOf).toEqual([
      { $ref: "#/components/schemas/PiSummary" },
      { type: "null" },
    ]);

    const summary = document.components.schemas["PiSummary"] as {
      required: string[];
      properties: {
        status: { enum: string[] };
        unavailable_reason: { enum: Array<string | null> };
        text: { type: string[] };
      };
    };
    // Copy before sorting: the toEqual below compares the very same document.
    expect([...summary.required].sort()).toEqual(
      [
        "task_id",
        "run_id",
        "turn_id",
        "status",
        "text",
        "unavailable_reason",
        "source",
        "updated_at",
      ].sort(),
    );
    expect(summary.properties.status.enum).toEqual(["pending", "available", "unavailable"]);
    expect(summary.properties.unavailable_reason.enum).toEqual([
      "no_content",
      "unsafe_content",
      "undecidable",
      "gate_error",
      "untrusted_source",
      null,
    ]);
    // text can only be a string or null; never a non-string fallback.
    expect(summary.properties.text.type).toEqual(["string", "null"]);
  });

  test("PiSummary carries the verifiable source with its trust chain", () => {
    const summary = document.components.schemas["PiSummary"] as {
      properties: { source: { oneOf: Array<Record<string, unknown>> } };
    };
    expect(summary.properties.source.oneOf).toEqual([
      { $ref: "#/components/schemas/PiSummarySource" },
      { type: "null" },
    ]);

    const source = document.components.schemas["PiSummarySource"] as {
      required: string[];
      properties: {
        kind: { enum: string[] };
        version: { type: string; enum: number[] };
        run_id: { type: string[] };
        report: { $ref: string };
      };
    };
    // The trust chain the contract states: channel, proof version, the
    // task/run/turn attribution, and the report the text was rendered from.
    expect([...source.required].sort()).toEqual(
      ["kind", "version", "task_id", "run_id", "turn_id", "report"].sort(),
    );
    expect(source.properties.kind.enum).toEqual(["turn_report"]);
    expect(source.properties.version.enum).toEqual([1]);
    expect(source.properties.run_id.type).toEqual(["string", "null"]);
    expect(source.properties.report.$ref).toBe("#/components/schemas/TurnReport");

    // The report is a closed vocabulary: no free-text parameter can ride it.
    const report = document.components.schemas["TurnReport"] as {
      required: string[];
      properties: {
        areas: { items: { enum: string[] } };
        activities: { items: { enum: string[] } };
        outcome: { enum: string[] };
      };
    };
    expect([...report.required].sort()).toEqual(["areas", "activities", "outcome"].sort());
    expect(report.properties.areas.items.enum).toEqual([...TURN_REPORT_AREAS]);
    expect(report.properties.activities.items.enum).toEqual([...TURN_REPORT_ACTIVITIES]);
    expect(report.properties.outcome.enum).toEqual([...TURN_REPORT_OUTCOMES]);
    // No extra property beyond the closed parameters.
    expect(Object.keys(report.properties).sort()).toEqual(
      ["areas", "activities", "outcome"].sort(),
    );
  });

  test("TaskEvent documents pi.summary.updated alongside the M0 types", () => {
    const event = document.components.schemas["TaskEvent"] as {
      properties: { type: { enum: string[] } };
    };
    expect(event.properties.type.enum).toContain("pi.summary.updated");
    expect(event.properties.type.enum).toHaveLength(14);
  });

  test("the error envelope carries the shared versioned fields", () => {
    const error = document.components.schemas["Error"] as {
      properties: {
        error: {
          required: string[];
          properties: Record<string, { enum?: unknown[] }>;
        };
      };
    };
    // Copy before sorting: the toEqual below compares the very same document.
    expect([...error.properties.error.required].sort()).toEqual(
      [
        "envelope_version",
        "code",
        "stage",
        "category",
        "message",
        "retryable",
        "retry_after_seconds",
        "request_id",
        "details",
        "next_action",
      ].sort(),
    );
    expect(error.properties.error.properties["envelope_version"]?.enum).toEqual([
      ERROR_ENVELOPE_VERSION,
    ]);
    expect(error.properties.error.properties["stage"]?.enum).toEqual([...ERROR_STAGES]);
    expect(error.properties.error.properties["category"]?.enum).toEqual([...ERROR_CATEGORIES]);
    expect(error.properties.error.properties["next_action"]?.enum).toEqual([
      ...ERROR_NEXT_ACTIONS,
      null,
    ]);
  });

  test("only the login bootstrap is public; every other operation requires a credential", () => {
    const publicKeys = PUBLIC_OPERATIONS.map(([method, path]) => `${method} ${path}`).sort();
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, rawOperation] of Object.entries(methods)) {
        const operation = rawOperation as {
          security?: Array<Record<string, string[]>>;
          responses?: Record<string, unknown>;
        };
        const key = `${method} ${path}`;
        if (publicKeys.includes(key)) {
          expect(operation.security, `public ${key} must accept no credential`).toEqual([]);
          continue;
        }
        expect(operation.security, `missing security on ${key}`).toEqual([
          { bearerAuth: [] },
          { sessionCookie: [] },
        ]);
        expect(operation.responses?.["401"], `missing 401 on ${key}`).toBeDefined();
      }
    }
  });

  test("every authenticated state-changing operation documents the CSRF header", () => {
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, rawOperation] of Object.entries(methods)) {
        const operation = rawOperation as { parameters?: Array<{ name?: string }> };
        const key = `${method} ${path}`;
        const mutating = ["post", "patch", "put", "delete"].includes(method);
        const publicOp = PUBLIC_OPERATIONS.some(
          ([publicMethod, publicPath]) => `${publicMethod} ${publicPath}` === key,
        );
        const expectsCsrf = mutating && !publicOp;
        const hasCsrf = (operation.parameters ?? []).some(
          (parameter) => parameter.name === "X-CSRF-Token",
        );
        expect(hasCsrf, `X-CSRF-Token on ${key}: expected ${expectsCsrf}`).toBe(expectsCsrf);
      }
    }
  });

  test("list operations paginate with opaque cursors", () => {
    for (const [method, path] of LIST_OPERATIONS) {
      const operation = document.paths[path]?.[method] as {
        parameters?: Array<{ name?: string; in?: string }>;
        responses?: Record<
          string,
          { content?: Record<string, { schema?: Record<string, unknown> }> }
        >;
      };
      expect(
        (operation.parameters ?? []).some(
          (parameter) => parameter.name === "cursor" && parameter.in === "query",
        ),
        `missing cursor parameter on ${method} ${path}`,
      ).toBe(true);
      const schema = operation.responses?.["200"]?.content?.["application/json"]?.schema;
      const page = schema as {
        required?: string[];
        properties?: { next_cursor?: { type?: string[] } };
      };
      expect(page.required?.sort(), `page shape on ${method} ${path}`).toEqual(
        ["items", "next_cursor"].sort(),
      );
      expect(page.properties?.next_cursor?.type).toEqual(["string", "null"]);
    }
  });

  test("no request body accepts a client-authoritative scope identifier", () => {
    function propertyNames(value: unknown, found: Set<string>): void {
      if (Array.isArray(value)) {
        for (const item of value) {
          propertyNames(item, found);
        }
        return;
      }
      if (typeof value !== "object" || value === null) {
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === "properties" && typeof item === "object" && item !== null) {
          for (const name of Object.keys(item)) {
            found.add(name);
          }
        }
        propertyNames(item, found);
      }
    }
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, rawOperation] of Object.entries(methods)) {
        const operation = rawOperation as {
          requestBody?: unknown;
          parameters?: Array<{ name?: string; in?: string }>;
        };
        const names = new Set<string>();
        propertyNames(operation.requestBody, names);
        expect(
          [...names].filter((name) => name === "workspace_id" || name === "enterprise_id"),
          `${method} ${path} request body must not accept scope identifiers`,
        ).toEqual([]);
        if (path.includes("{workspace_id}")) {
          expect(
            (operation.parameters ?? []).some(
              (parameter) => parameter.name === "workspace_id" && parameter.in === "path",
            ),
            `${method} ${path} must carry the workspace_id path scope`,
          ).toBe(true);
        }
      }
    }
  });

  test("invitation preview and redemption are non-enumerating", () => {
    for (const path of ["/api/v1/invitations/preview", "/api/v1/invitations/redeem"]) {
      const operation = document.paths[path]?.["post"] as {
        responses?: Record<string, unknown>;
      };
      // Success, malformed body, unauthenticated, the uniform invitation
      // denial, and rate limiting — nothing else, and no 404 to probe with.
      expect(Object.keys(operation.responses ?? {}).sort(), path).toEqual(
        ["200", "400", "401", "403", "429"].sort(),
      );
    }
  });

  test("the SSE endpoint documents Last-Event-ID replay", () => {
    const stream = document.paths["/api/v1/tasks/{task_id}/stream"]?.["get"] as {
      parameters: Array<{ name: string; in: string }>;
    };
    expect(
      stream.parameters.some(
        (parameter) => parameter.name === "Last-Event-ID" && parameter.in === "header",
      ),
    ).toBe(true);
  });

  test("the committed contract file matches a fresh generation (regenerate on drift)", () => {
    expect(
      fs.existsSync(committedPath),
      "web/src/api/contracts/openapi.json is missing; run npm run export:openapi",
    ).toBe(true);
    const committed = JSON.parse(fs.readFileSync(committedPath, "utf8")) as unknown;
    expect(committed).toEqual(document);
  });
});
