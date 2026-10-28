import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";
import { UI_STATUSES } from "../src/api/task-store.js";
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
  ["get", "/api/v1/tasks/{task_id}/timeline"],
  ["get", "/api/v1/tasks/{task_id}/artifacts/{artifact_id}"],
  ["get", "/api/v1/tasks/{task_id}/stream"],
];

describe("forgepilot-api/v1 OpenAPI document", () => {
  const document = buildOpenApiDocument();

  test("documents every M0 endpoint", () => {
    for (const [method, path] of M0_ENDPOINTS) {
      expect(document.paths[path], `missing path ${path}`).toBeDefined();
      expect(document.paths[path]?.[method], `missing ${method} ${path}`).toBeDefined();
    }
  });

  test("documents no endpoint outside the M0 contract", () => {
    const documented: Array<[string, string]> = [];
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const method of Object.keys(methods)) {
        documented.push([method, path]);
      }
    }
    expect(documented.sort()).toEqual(
      [...M0_ENDPOINTS].map(([method, path]) => [method, path]).sort(),
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

  test("the error envelope carries the contract's required fields", () => {
    const error = document.components.schemas["Error"] as {
      properties: {
        error: { required: string[]; properties: Record<string, unknown> };
      };
    };
    // Copy before sorting: the toEqual below compares the very same document.
    expect([...error.properties.error.required].sort()).toEqual(
      ["code", "details", "message", "request_id", "retryable"].sort(),
    );
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
