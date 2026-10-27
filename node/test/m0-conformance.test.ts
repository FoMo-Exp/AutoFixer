import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contractPath = path.join(repoRoot, "docs", "contracts", "forgepilot-api-v1.md");
const committedPath = path.join(repoRoot, "web", "src", "api", "contracts", "openapi.json");

/**
 * Parse the normative M0 contract (forgepilot-api-v1.md) itself and compare
 * it against the generated OpenAPI document. Unlike the drift test in
 * openapi.test.ts — which checks the committed JSON against a fresh
 * generation of the *implementation* — this test reads the source-of-truth
 * markdown, so it catches the case where the implementation and its own
 * export drift together away from the contract (QA round-1 blocker 4).
 */

/** Pull every backtick-quoted SSE event type from the "Types are …" sentence. */
function parseSseTypes(markdown: string): string[] {
  // Event types contain dots (task.status_changed, pi.summary.updated), so
  // match every dotted segment up to the fixed ". Node replays" terminator
  // rather than stopping at the first period.
  const match = /Types are ([\s\S]*?)\. Node replays/.exec(markdown);
  const sentence = match?.[1];
  if (!sentence) {
    throw new Error("could not locate the SSE event type list in the M0 contract");
  }
  return [...sentence.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/** Pull the endpoint rows (`METHOD /path`) from the endpoints table. */
function parseEndpoints(markdown: string): Array<[method: string, path: string]> {
  const tableSection = /## Endpoints([\s\S]*?)\n## /.exec(markdown);
  const table = tableSection?.[1];
  if (!table) {
    throw new Error("could not locate the endpoints table in the M0 contract");
  }
  const rows = [...table.matchAll(/^\|\s*`(GET|POST) ([^`?`]+)[^`]*`\s*\|/gm)];
  return rows.flatMap((m) =>
    m[1] && m[2] ? [[m[1].toLowerCase(), m[2].trim()] as [string, string]] : [],
  );
}

/** Pull the UI status enum from its sentence. */
function parseUiStatuses(markdown: string): string[] {
  const match = /The UI status enum is ([^.]*?)\.\s*It is a projection/.exec(markdown);
  const sentence = match?.[1];
  if (!sentence) {
    throw new Error("could not locate the UI status enum in the M0 contract");
  }
  return [...sentence.matchAll(/`([a-z_]+)`/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

describe("independent conformance to the normative M0 contract", () => {
  const markdown = fs.readFileSync(contractPath, "utf8");
  const document = buildOpenApiDocument();

  test("SSE event types match the contract exactly (all 14)", () => {
    const contractTypes = parseSseTypes(markdown);
    expect(contractTypes).toHaveLength(14);
    const eventSchema = document.components.schemas["TaskEvent"] as {
      properties: { type: { enum: string[] } };
    };
    expect(eventSchema.properties.type.enum.sort()).toEqual([...contractTypes].sort());
  });

  test("endpoint set matches the contract exactly", () => {
    const contractEndpoints = parseEndpoints(markdown);
    const documented: Array<[string, string]> = [];
    for (const [docPath, methods] of Object.entries(document.paths)) {
      for (const method of Object.keys(methods)) {
        documented.push([method, docPath]);
      }
    }
    // The contract lists `GET /api/v1/tasks?cursor=&status=`; the OpenAPI
    // path is the bare resource with query params, so normalize by stripping
    // any query string from the contract entry before comparing.
    const normalized = contractEndpoints.map(
      ([method, docPath]) => [method, docPath.split("?")[0]] as [string, string],
    );
    expect(documented.sort()).toEqual(normalized.sort());
  });

  test("UI status enum matches the contract exactly", () => {
    const contractStatuses = parseUiStatuses(markdown);
    const task = document.components.schemas["Task"] as {
      properties: { status: { enum: string[] } };
    };
    expect(task.properties.status.enum).toEqual(contractStatuses);
  });

  test("the committed openapi.json also matches the contract (not just the implementation)", () => {
    expect(fs.existsSync(committedPath)).toBe(true);
    const committed = JSON.parse(fs.readFileSync(committedPath, "utf8")) as {
      components: { schemas: { TaskEvent: { properties: { type: { enum: string[] } } } } };
    };
    const contractTypes = parseSseTypes(markdown);
    expect(committed.components.schemas.TaskEvent.properties.type.enum.sort()).toEqual(
      [...contractTypes].sort(),
    );
  });

  test("the generated TypeScript client exists and is committed", () => {
    const typesPath = path.join(repoRoot, "web", "src", "api", "contracts", "schema.d.ts");
    expect(
      fs.existsSync(typesPath),
      "web/src/api/contracts/schema.d.ts is missing; run npm run export:openapi",
    ).toBe(true);
    const types = fs.readFileSync(typesPath, "utf8");
    // The generated client must expose the contract's schemas as types.
    expect(types).toContain("Task");
    expect(types).toContain("TaskEvent");
    expect(types).toContain("paths");
  });

  test("the contract's safe-summary section pins the fail-closed semantics", () => {
    // Independent check: the normative markdown must document the DAT-191
    // display contract — not just the implementation — so a client reading
    // only the contract knows pi_summary is the sole display source and
    // understands every unavailable reason.
    const match = /## Safe Pi text summary([\s\S]*?)\n## /.exec(markdown);
    const section = match?.[1];
    expect(section, "missing '## Safe Pi text summary' section").toBeDefined();
    for (const needle of [
      "pi_summary",
      "pi.summary.updated",
      "unavailable_reason",
      "unsafe_content",
      "undecidable",
      "gate_error",
      "no_content",
      "Fail closed",
      "raw assistant text",
      "Last-Event-ID",
    ]) {
      expect(section, `contract section must document ${needle}`).toContain(needle);
    }
    // Every unavailable reason the OpenAPI enum exposes must be explained by
    // the contract text.
    const summary = document.components.schemas["PiSummary"] as {
      properties: { unavailable_reason: { enum: Array<string | null> } };
    };
    for (const reason of summary.properties.unavailable_reason.enum) {
      if (reason !== null) {
        expect(section).toContain(reason);
      }
    }
  });

  test("the M0 contract itself specifies Bearer auth and the 401 response", () => {
    // Independent check: the normative markdown must document the auth the
    // server enforces, so a client generated from the contract sends the
    // credential (QA round-2 blocker).
    expect(markdown).toMatch(/## Authentication/);
    expect(markdown).toContain("Authorization: Bearer <token>");
    expect(markdown).toContain("401 UNAUTHENTICATED");
    expect(markdown).toContain("bearerAuth");
  });

  test("the OpenAPI document declares the bearerAuth security scheme", () => {
    const scheme = document.components.securitySchemes["bearerAuth"] as {
      type: string;
      scheme: string;
    };
    expect(scheme, "missing components.securitySchemes.bearerAuth").toBeDefined();
    expect(scheme.type).toBe("http");
    expect(scheme.scheme).toBe("bearer");
  });

  test("every operation requires the bearer scheme and documents a 401", () => {
    expect(document.security).toContainEqual({ bearerAuth: [] });
    const operations: string[] = [];
    for (const [docPath, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        operations.push(`${method.toUpperCase()} ${docPath}`);
        const op = operation as {
          security?: Array<Record<string, string[]>>;
          responses?: Record<string, unknown>;
        };
        expect(op.security, `missing security on ${method} ${docPath}`).toContainEqual({
          bearerAuth: [],
        });
        expect(op.responses?.["401"], `missing 401 on ${method} ${docPath}`).toBeDefined();
      }
    }
    // Sanity: the full endpoint set is actually being checked.
    expect(operations).toHaveLength(10);
  });

  test("the committed openapi.json also carries the auth scheme", () => {
    const committed = JSON.parse(fs.readFileSync(committedPath, "utf8")) as {
      components: { securitySchemes: Record<string, unknown> };
      security: Array<Record<string, string[]>>;
    };
    expect(committed.components.securitySchemes["bearerAuth"]).toBeDefined();
    expect(committed.security).toContainEqual({ bearerAuth: [] });
  });
});
