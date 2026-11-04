import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";
import {
  ApiError,
  ERROR_CATEGORIES,
  ERROR_ENVELOPE_VERSION,
  ERROR_NEXT_ACTIONS,
  ERROR_STAGES,
} from "../src/api/errors.js";
import { UI_STATUSES } from "../src/api/task-store.js";
import { DSH_STATES } from "../src/dsh/types.js";
import { PRODUCT_STATES, PRODUCT_TRANSITIONS } from "../src/collab/states.js";
import { GRANT_STATES, ROLES, TASK_STATES } from "../src/collab/types.js";
import {
  APPROVAL_INVALIDATION_REASONS,
  APPROVAL_STATES,
  DELIVERY_STATES,
  ISSUE_EVENT_TYPES,
  TASK_EVIDENCE_CONTRACT_VERSION,
} from "../src/collab/contract.js";
import {
  TURN_REPORT_ACTIVITIES,
  TURN_REPORT_AREAS,
  TURN_REPORT_OUTCOMES,
} from "../src/pi/turn-report.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const committedPath = path.join(repoRoot, "web", "src", "api", "contracts", "openapi.json");

const M0_ENDPOINTS: Array<[method: string, path: string]> = [
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
];

/** Identity, session, and administration surface (DAT-202). */
const AUTH_ENDPOINTS: Array<[method: string, path: string]> = [
  ["get", "/api/v1/auth/providers"],
  ["get", "/api/v1/auth/login"],
  ["get", "/api/v1/auth/callback"],
  ["get", "/api/v1/auth/session"],
  ["post", "/api/v1/auth/logout"],
  ["post", "/api/v1/auth/desktop/flows"],
  ["post", "/api/v1/auth/desktop/flows/{flow_id}/exchange"],
  ["post", "/api/v1/admin/enterprises/{enterprise_id}/bootstrap"],
  ["post", "/api/v1/admin/enterprises/{enterprise_id}/provider-instances"],
  ["get", "/api/v1/admin/enterprises/{enterprise_id}/auth-audit"],
  ["put", "/api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/members/{user_id}"],
  [
    "delete",
    "/api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/members/{user_id}",
  ],
  ["post", "/api/v1/admin/users/{user_id}/suspend"],
  ["post", "/api/v1/admin/users/{user_id}/activate"],
];

/** Workspace-scoped task family (DAT-244). */
const WORKSPACE_TASK_ENDPOINTS: Array<[method: string, path: string]> = [
  ["post", "/api/v1/workspaces/{workspace_id}/tasks"],
  ["get", "/api/v1/workspaces/{workspace_id}/tasks"],
  ["get", "/api/v1/workspaces/{workspace_id}/tasks/{task_id}"],
  ["get", "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/runs"],
  ["post", "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/messages"],
  ["post", "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/approvals"],
  ["post", "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/cancel"],
  ["post", "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/archive"],
  ["post", "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/recover"],
  ["get", "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/timeline"],
  ["get", "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/artifacts/{artifact_id}"],
  ["get", "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/stream"],
];

const WORKSPACE_ENDPOINTS: Array<[method: string, path: string]> = [
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

/** Collaboration v1 surface (DAT-221, ADR-0007). */
const COLLAB_BASE = "/api/v1/workspaces/{workspace_id}/issues";
const COLLAB_ENDPOINTS: Array<[method: string, path: string]> = [
  ["get", COLLAB_BASE],
  ["post", COLLAB_BASE],
  ["get", `${COLLAB_BASE}/{issue_id}`],
  ["get", `${COLLAB_BASE}/{issue_id}/stage`],
  ["post", `${COLLAB_BASE}/{issue_id}/stage`],
  ["get", `${COLLAB_BASE}/{issue_id}/tasks`],
  ["post", `${COLLAB_BASE}/{issue_id}/tasks`],
  ["get", `${COLLAB_BASE}/{issue_id}/tasks/{task_id}`],
  ["post", `${COLLAB_BASE}/{issue_id}/tasks/{task_id}/state`],
  ["get", `${COLLAB_BASE}/{issue_id}/runs`],
  ["post", `${COLLAB_BASE}/{issue_id}/runs`],
  ["get", `${COLLAB_BASE}/{issue_id}/runs/{run_id}`],
  ["get", `${COLLAB_BASE}/{issue_id}/candidates`],
  ["get", `${COLLAB_BASE}/{issue_id}/candidates/{candidate_id}`],
  ["get", `${COLLAB_BASE}/{issue_id}/approvals`],
  ["get", `${COLLAB_BASE}/{issue_id}/approvals/{approval_id}`],
  ["post", `${COLLAB_BASE}/{issue_id}/approvals/{approval_id}/decision`],
  ["get", `${COLLAB_BASE}/{issue_id}/deliveries`],
  ["post", `${COLLAB_BASE}/{issue_id}/deliveries`],
  ["get", `${COLLAB_BASE}/{issue_id}/deliveries/{delivery_id}`],
  ["post", `${COLLAB_BASE}/{issue_id}/deliveries/{delivery_id}/reconcile`],
  ["get", `${COLLAB_BASE}/{issue_id}/stream`],
];

const ALL_ENDPOINTS = [
  ...M0_ENDPOINTS,
  ...AUTH_ENDPOINTS,
  ...WORKSPACE_ENDPOINTS,
  ...WORKSPACE_TASK_ENDPOINTS,
  ...COLLAB_ENDPOINTS,
];

describe("forgepilot-api/v1 OpenAPI document", () => {
  const document = buildOpenApiDocument();

  test("documents every M0 endpoint", () => {
    for (const [method, path] of M0_ENDPOINTS) {
      expect(document.paths[path], `missing path ${path}`).toBeDefined();
      expect(document.paths[path]?.[method], `missing ${method} ${path}`).toBeDefined();
    }
  });

  test("documents every identity/session endpoint", () => {
    for (const [method, path] of AUTH_ENDPOINTS) {
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
      [...ALL_ENDPOINTS].map(([method, path]) => [method, path]).sort(),
    );
  });

  test("the login surface is anonymous while sessions and admin declare their schemes", () => {
    for (const path of [
      "/api/v1/auth/providers",
      "/api/v1/auth/login",
      "/api/v1/auth/callback",
      "/api/v1/auth/desktop/flows",
      "/api/v1/auth/desktop/flows/{flow_id}/exchange",
    ]) {
      const methods = document.paths[path] as Record<string, { security: unknown[] }>;
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.security, `${method} ${path}`).toEqual([]);
      }
    }
    const session = document.paths["/api/v1/auth/session"]?.["get"] as { security: unknown[] };
    expect(session.security).toContainEqual({ sessionCookie: [] });
    const bootstrap = document.paths["/api/v1/admin/enterprises/{enterprise_id}/bootstrap"]?.[
      "post"
    ] as { security: unknown[] };
    expect(bootstrap.security).toEqual([{ bootstrapToken: [] }]);
    expect(document.components.securitySchemes["sessionCookie"]).toBeDefined();
    expect(document.components.securitySchemes["bootstrapToken"]).toBeDefined();
  });

  test("Task.status enum matches the contract's UI status vocabulary", () => {
    const task = document.components.schemas["Task"] as {
      properties: { status: { enum: string[] } };
    };
    expect(task.properties.status.enum).toEqual([...UI_STATUSES]);
  });

  test("Task carries the required workspace ownership field", () => {
    const task = document.components.schemas["Task"] as {
      required: string[];
      properties: { workspace_id: { type: string } };
    };
    expect(task.required).toContain("workspace_id");
    expect(task.properties.workspace_id.type).toBe("string");
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

  test("every authenticated state-changing operation documents the CSRF header", () => {
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, rawOperation] of Object.entries(methods)) {
        const operation = rawOperation as {
          security?: Array<Record<string, string[]>>;
          parameters?: Array<{ name?: string }>;
        };
        const key = `${method} ${path}`;
        const mutating = ["post", "patch", "put", "delete"].includes(method);
        const cookieCredential = (operation.security ?? []).some(
          (entry) => entry["sessionCookie"] !== undefined,
        );
        const expectsCsrf = mutating && cookieCredential;
        const hasCsrf = (operation.parameters ?? []).some(
          (parameter) => parameter.name === "X-CSRF-Token",
        );
        expect(hasCsrf, `X-CSRF-Token on ${key}: expected ${expectsCsrf}`).toBe(expectsCsrf);
      }
    }
  });

  test("list operations paginate with opaque cursors", () => {
    for (const [method, path] of [
      ["get", "/api/v1/tasks"],
      ["get", "/api/v1/workspaces"],
      ["get", "/api/v1/workspaces/{workspace_id}/members"],
      ["get", "/api/v1/workspaces/{workspace_id}/member-candidates"],
      ["get", "/api/v1/workspaces/{workspace_id}/teams"],
      ["get", "/api/v1/workspaces/{workspace_id}/invitations"],
    ] as Array<[string, string]>) {
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
        // The workspace/invitation surface never takes a scope identifier in
        // a body. (The admin suspend/activate bodies carry an optional
        // `enterprise_id` narrowing locator that the server authorizes
        // against the admin's own authority — a locator, not authority.)
        const scopeSurface =
          path.startsWith("/api/v1/workspaces") || path.startsWith("/api/v1/invitations");
        if (scopeSurface) {
          expect(
            [...names].filter((name) => name === "workspace_id" || name === "enterprise_id"),
            `${method} ${path} request body must not accept scope identifiers`,
          ).toEqual([]);
        }
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

  test("documents every collaboration endpoint", () => {
    for (const [method, path] of COLLAB_ENDPOINTS) {
      expect(document.paths[path], `missing path ${path}`).toBeDefined();
      expect(document.paths[path]?.[method], `missing ${method} ${path}`).toBeDefined();
    }
  });

  test("collaboration enums reuse the domain vocabularies verbatim", () => {
    const issue = document.components.schemas["Issue"] as {
      properties: { product_state: { enum: string[] } };
    };
    expect(issue.properties.product_state.enum).toEqual([...PRODUCT_STATES]);

    const run = document.components.schemas["IssueRun"] as {
      properties: { state: { enum: string[] }; role: { enum: string[] } };
    };
    expect(run.properties.state.enum).toEqual([...DSH_STATES]);
    expect(run.properties.role.enum).toEqual([...ROLES]);

    const task = document.components.schemas["IssueTask"] as {
      properties: { state: { enum: string[] }; role: { enum: string[] } };
    };
    expect(task.properties.state.enum).toEqual([...TASK_STATES]);
    expect(task.properties.role.enum).toEqual([...ROLES]);

    const grant = document.components.schemas["RunGrant"] as {
      properties: { state: { enum: string[] } };
    };
    expect(grant.properties.state.enum).toEqual([...GRANT_STATES]);

    const approval = document.components.schemas["Approval"] as {
      properties: { state: { enum: string[] }; invalidated_reason: { enum: Array<string | null> } };
    };
    expect(approval.properties.state.enum).toEqual([...APPROVAL_STATES]);
    expect(approval.properties.invalidated_reason.enum).toEqual([
      ...APPROVAL_INVALIDATION_REASONS,
      null,
    ]);

    const delivery = document.components.schemas["Delivery"] as {
      properties: { state: { enum: string[] } };
    };
    expect(delivery.properties.state.enum).toEqual([...DELIVERY_STATES]);

    const event = document.components.schemas["IssueEvent"] as {
      properties: { type: { enum: string[] } };
    };
    expect(event.properties.type.enum).toEqual([...ISSUE_EVENT_TYPES]);
  });

  test("product stages keep their ADR-0007 edges and never borrow harness states", () => {
    // Product stages and harness run states are separate vocabularies: the
    // stage enum must not contain a harness-only value and vice versa.
    const issue = document.components.schemas["Issue"] as {
      properties: { product_state: { enum: string[] } };
    };
    const harnessOnly = DSH_STATES.filter(
      (state) => !(PRODUCT_STATES as readonly string[]).includes(state),
    );
    expect(
      issue.properties.product_state.enum.some((state) => harnessOnly.includes(state as never)),
    ).toBe(false);

    const stage = document.components.schemas["IssueStage"] as {
      properties: { allowed_transitions: { items: { enum: string[] } } };
    };
    expect(stage.properties.allowed_transitions.items.enum).toEqual([...PRODUCT_STATES]);
    // `awaiting_change_approval` is a product stage with no PR; harness
    // `awaiting_review` exists only once a provider PR exists.
    expect(PRODUCT_TRANSITIONS["awaiting_change_approval"]).toContain("delivering");
    expect(PRODUCT_TRANSITIONS["completed"]).toEqual([]);
  });

  test("every collaboration mutation carries the replay-safe Idempotency-Key", () => {
    for (const [path, methods] of Object.entries(document.paths)) {
      if (!path.startsWith(COLLAB_BASE)) continue;
      for (const [method, rawOperation] of Object.entries(methods)) {
        if (!["post", "patch", "put", "delete"].includes(method)) continue;
        const operation = rawOperation as {
          parameters?: Array<{ name?: string; in?: string }>;
        };
        expect(
          (operation.parameters ?? []).some(
            (parameter) => parameter.name === "Idempotency-Key" && parameter.in === "header",
          ),
          `${method} ${path} must document Idempotency-Key`,
        ).toBe(true);
      }
    }
  });

  test("the issue stream documents replay by Last-Event-ID and closes after terminal", () => {
    const stream = document.paths[`${COLLAB_BASE}/{issue_id}/stream`]?.["get"] as {
      parameters: Array<{ name: string; in: string }>;
      responses: Record<
        string,
        { description: string; content?: Record<string, { schema?: Record<string, unknown> }> }
      >;
    };
    expect(
      stream.parameters.some(
        (parameter) => parameter.name === "Last-Event-ID" && parameter.in === "header",
      ),
    ).toBe(true);
    const response = stream.responses["200"];
    expect(response?.content?.["text/event-stream"]?.schema).toEqual({
      $ref: "#/components/schemas/IssueEvent",
    });
    expect(response?.description).toContain("issue.terminal");

    const event = document.components.schemas["IssueEvent"] as {
      required: string[];
      description: string;
      properties: { event_id: { type: string }; sequence: { type: string } };
    };
    expect([...event.required].sort()).toEqual(
      ["event_id", "sequence", "occurred_at", "issue_id", "type", "data"].sort(),
    );
    // The replay-stable id is the consumer's idempotency key; the sequence is
    // the ordering cursor — both are stated in the contract.
    expect(event.description).toContain("idempotent");
    expect(event.description).toContain("Replay semantics");
    expect(event.properties.event_id.type).toBe("string");
    expect(event.properties.sequence.type).toBe("integer");
  });

  test("candidate and approval records claim the evidence contract version", () => {
    for (const schema of ["Candidate", "Approval"]) {
      const record = document.components.schemas[schema] as {
        required: string[];
        properties: { contract_version: { enum: string[] } };
      };
      expect(record.required, schema).toContain("contract_version");
      expect(record.properties.contract_version.enum, schema).toEqual([
        TASK_EVIDENCE_CONTRACT_VERSION,
      ]);
    }
  });

  test("the approval decision body can never assert an approver identity", () => {
    // Agent self-approval is impossible only if the request body cannot name
    // the approver: the identity comes from the authenticated session.
    const operation = document.paths[
      `${COLLAB_BASE}/{issue_id}/approvals/{approval_id}/decision`
    ]?.["post"] as {
      requestBody: {
        content: { "application/json": { schema: { required: string[]; properties: object } } };
      };
    };
    const schema = operation.requestBody.content["application/json"].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["decision", "diff_digest", "note"].sort(),
    );
    expect(schema.required).toEqual(["decision", "diff_digest"]);
  });

  test("collaboration outcomes declare stop, needs_human, and unknown retryability", () => {
    const disposition = new ApiError(428, "DISPOSITION_REQUIRED", "needs human").toBody("req_1");
    expect(disposition.error).toMatchObject({
      stage: "policy",
      category: "stop",
      retryable: false,
      next_action: "request_review",
    });

    const unknown = new ApiError(409, "DELIVERY_OUTCOME_UNKNOWN", "unknown").toBody("req_2");
    expect(unknown.error).toMatchObject({
      stage: "delivery",
      category: "unknown",
      retryable: false,
      next_action: "reconcile",
    });

    const stopped = new ApiError(409, "TRANSITION_FORBIDDEN", "stopped run").toBody("req_3");
    expect(stopped.error).toMatchObject({ category: "stop", retryable: false });

    // A code outside the contract vocabulary must never be served as a
    // retryable or optimistic outcome.
    const unmapped = new ApiError(500, "SOMETHING_NEW", "unexpected").toBody("req_4");
    expect(unmapped.error).toMatchObject({ category: "unknown", retryable: false });
    expect(ERROR_CATEGORIES).toContain(unmapped.error.category);
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
