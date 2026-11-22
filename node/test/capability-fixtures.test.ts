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
 * Contract-exemplar fixtures for the repository capability ceiling (DAT-276).
 *
 * Authored from the merged contract — not captured — and validated against
 * the generated OpenAPI schemas with closed objects, so a fixture can never
 * invent a field outside `web/src/api/contracts/openapi.json`. A schema change
 * intentionally breaks them until they are re-authored.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "capability-api-v1");
const document = buildOpenApiDocument();

function closedCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(closedCopy);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
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
  $id: "urn:forgepilot:capability-contract",
  components: closedCopy({ schemas: document.components.schemas }),
  paths: closedCopy(document.paths),
} as Record<string, unknown>);

function schemaAt(pointer: string[]): { validate: (data: unknown) => boolean; errorsText: string } {
  const escaped = pointer
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
  const validate = ajv.getSchema(`urn:forgepilot:capability-contract#/${escaped}`);
  if (!validate) {
    throw new Error(`no contract schema at ${pointer.join("/")}`);
  }
  return {
    validate: (data: unknown) => validate(data) as boolean,
    errorsText: ajv.errorsText(validate.errors),
  };
}

function loadFixture(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, file), "utf8")) as unknown;
}

const COMPONENT = (name: string): string[] => ["components", "schemas", name];

const FIXTURES: Array<{ file: string; pointer: string[] }> = [
  { file: "projection-verified.json", pointer: COMPONENT("WorkspaceCapabilityProjection") },
  { file: "projection-downgraded.json", pointer: COMPONENT("WorkspaceCapabilityProjection") },
  { file: "projection-unverified.json", pointer: COMPONENT("WorkspaceCapabilityProjection") },
  { file: "member-capability-ceiling.json", pointer: COMPONENT("MemberCapabilityCeilingView") },
];

describe("capability contract fixtures", () => {
  test("every fixture file is covered by the manifest", () => {
    const onDisk = fs
      .readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .sort();
    expect(onDisk).toEqual(FIXTURES.map((entry) => entry.file).sort());
  });

  test("fixtures conform to the contract schemas with no invented fields", () => {
    for (const { file, pointer } of FIXTURES) {
      const { validate, errorsText } = schemaAt(pointer);
      expect(validate(loadFixture(file)), `${file} vs ${pointer.join("/")}: ${errorsText}`).toBe(
        true,
      );
    }
  });

  test("the projection schema closes the action map over every action kind", () => {
    const projection = document.components.schemas["WorkspaceCapabilityProjection"] as {
      properties: { actions: { required: string[]; additionalProperties: boolean } };
    };
    expect(projection.properties.actions.additionalProperties).toBe(false);
    expect([...projection.properties.actions.required].sort()).toEqual(
      [
        "read",
        "stream",
        "artifact_read",
        "approval",
        "delivery",
        "write",
        "issue_sync",
        "manage",
      ].sort(),
    );
  });

  test("an unknown capability name is rejected by the contract", () => {
    const { validate } = schemaAt(COMPONENT("WorkspaceCapabilityProjection"));
    const fixture = loadFixture("projection-verified.json") as Record<string, unknown>;
    expect(validate({ ...fixture, capabilities: ["code_read", "super_admin"] })).toBe(false);
  });
});
