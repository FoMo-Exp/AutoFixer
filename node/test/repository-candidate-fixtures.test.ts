import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";

// ajv-formats ships CJS: NodeNext types its default import as the module
// namespace while the runtime binding is the plugin function itself.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

/**
 * Real-response fixtures for approved-repository discovery (DAT-289).
 *
 * These files are captured from the running service by
 * `test/repository-candidate-http.test.ts`
 * (`AUTOFIXER_CAPTURE_FIXTURES=1 npx vitest run test/repository-candidate-http.test.ts`);
 * only deployment-specific ids and instants are normalized, never the shape.
 * Each one is validated against the generated OpenAPI schemas with closed
 * objects, so a real response can never carry a field the contract does not
 * define, and the web client may use them as fixtures on that basis.
 *
 * The three files are deliberately different answers, because the surface's
 * honesty lives in that difference: a full page of selectable candidates, an
 * empty page that explains itself with `already_bound`, and a page where every
 * interesting installation is present but restricted.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "repository-candidate-api-v1");
const document = buildOpenApiDocument();
const schemas = document.components.schemas as Record<string, unknown>;

function closedCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(closedCopy);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = closedCopy(item);
  }
  if (
    copy["type"] === "object" &&
    copy["properties"] &&
    copy["additionalProperties"] === undefined
  ) {
    copy["additionalProperties"] = false;
  }
  return copy;
}

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema({
  $id: "urn:forgepilot:repository-candidate-fixtures",
  components: closedCopy({ schemas }),
} as Record<string, unknown>);

function validate(schemaName: string, body: unknown): void {
  const check = ajv.getSchema(
    `urn:forgepilot:repository-candidate-fixtures#/components/schemas/${schemaName}`,
  );
  if (!check) {
    throw new Error(`no contract schema ${schemaName}`);
  }
  expect(check(body), `${schemaName}: ${ajv.errorsText(check.errors)}`).toBe(true);
}

interface CandidatePage {
  coverage: { completeness: string; unsupported_sources: string[]; limits: string[] };
  items: Array<{
    provider_instance_id: string;
    repository_id: string;
    installation_ref: string;
    proposable: boolean;
    restriction_reasons: string[];
    verification: { freshness: string };
  }>;
  next_cursor: string | null;
  totals: { discovered: number; proposable: number; restricted: number; already_bound: number };
}

function load(file: string): CandidatePage {
  const raw = fs.readFileSync(path.join(fixtureDir, file), "utf8");
  return JSON.parse(raw) as CandidatePage;
}

describe("repository-candidate-api-v1 fixtures", () => {
  const files = ["candidates-all.json", "candidates-empty.json", "candidates-restricted.json"];

  test("every committed fixture matches the contract with closed objects", () => {
    for (const file of files) {
      validate("RepositoryCandidatePage", load(file));
    }
  });

  test("no fixture claims a complete listing", () => {
    for (const file of files) {
      const page = load(file);
      expect(page.coverage.completeness, file).toBe("bounded");
      expect(page.coverage.unsupported_sources, file).toEqual(["provider_repository_enumeration"]);
      expect(page.coverage.limits, file).toEqual([
        "provider_repository_enumeration_unsupported",
        "installation_scoped_to_workspace",
      ]);
    }
  });

  test("every candidate carries the identity a proposal needs and a verdict", () => {
    for (const file of files) {
      for (const item of load(file).items) {
        expect(item.provider_instance_id, file).toBeTruthy();
        expect(item.installation_ref, file).toMatch(/^[A-Za-z0-9_]+$/);
        expect(item.repository_id, file).toContain(":");
        expect(item.proposable, file).toBe(item.restriction_reasons.length === 0);
      }
    }
  });

  test("the empty fixture explains itself instead of reading as an error", () => {
    const page = load("candidates-empty.json");
    expect(page.items).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(page.totals.already_bound).toBe(1);
    expect(page.totals.discovered).toBe(0);
  });

  test("the restricted fixture keeps restricted candidates visible with reasons", () => {
    const page = load("candidates-restricted.json");
    expect(page.totals.restricted).toBeGreaterThan(0);
    const restricted = page.items.filter((item) => !item.proposable);
    expect(restricted.length).toBe(page.totals.restricted);
    for (const item of restricted) {
      expect(item.restriction_reasons.length).toBeGreaterThan(0);
    }
    expect(page.items.some((item) => item.verification.freshness === "never_verified")).toBe(true);
  });
});
