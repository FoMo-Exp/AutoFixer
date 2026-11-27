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
 * Real-response fixtures for explicit task targets (DAT-292).
 *
 * Captured from the running orchestrator by
 * `test/task-target-http.test.ts`
 * (`AUTOFIXER_CAPTURE_FIXTURES=1 npx vitest run test/task-target-http.test.ts`);
 * only deployment-specific ids and instants are normalized, never the shape.
 * Each fixture is validated against the generated OpenAPI schemas with closed
 * objects, so a response can never carry a field the contract does not define.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "task-target-api-v1");
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
  $id: "urn:forgepilot:task-target-fixtures",
  components: closedCopy({ schemas }),
} as Record<string, unknown>);

function validate(schemaName: string, body: unknown): void {
  const check = ajv.getSchema(
    `urn:forgepilot:task-target-fixtures#/components/schemas/${schemaName}`,
  );
  if (!check) {
    throw new Error(`no contract schema ${schemaName}`);
  }
  expect(check(body), `${schemaName}: ${ajv.errorsText(check.errors)}`).toBe(true);
}

function load(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, file), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("task-target fixtures (DAT-292)", () => {
  test("the task fixture validates and binds its target to the task's repository", () => {
    const task = load("task-with-target.json");
    validate("Task", task);

    const repository = task["repository"] as Record<string, unknown>;
    const target = task["target"] as Record<string, unknown>;
    const association = task["association"] as Record<string, unknown>;
    expect(target["repository_id"]).toBe(repository["id"]);
    expect(target["base_sha"]).toBe(repository["base_sha"]);
    expect(target["set_version"]).toBe(task["repository_set_version"]);
    expect(association["repository_id"]).toBe(target["repository_id"]);
    expect(association["base_sha"]).toBe(target["base_sha"]);
  });

  test("the target-list fixture validates and selects the same immutable identity", () => {
    const list = load("task-targets.json");
    validate("TaskTargetList", list);

    const targets = list["targets"] as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(1);
    const candidate = targets[0]!;
    expect(typeof candidate["binding_id"]).toBe("string");
    expect(candidate["position"]).toBe(1);
    expect(candidate["baseline"]).toMatchObject({ state: "trusted" });

    const task = load("task-with-target.json");
    const target = task["target"] as Record<string, unknown>;
    expect(candidate["repository_id"]).toBe(target["repository_id"]);
    expect(candidate["provider_instance_id"]).toBe(target["provider_instance_id"]);
    expect(candidate["installation_ref"]).toBe(target["installation_ref"]);
  });

  test("the read is not a grant: a closed set can still be listed", () => {
    const closed = {
      workspace_id: "wsp_fixture_0001",
      repository_set_version: 2,
      multi_repository: true,
      selection_required: true,
      usable: false,
      blocked_reason: "MULTI_REPOSITORY_SCOPE_DISABLED",
      targets: [
        {
          binding_id: "wrb_fixture_0001",
          repository_id: "github:FoMo-Exp/AutoFixer",
          provider_instance_id: "pi_fixture_0001",
          installation_ref: null,
          repository_name: null,
          position: 1,
          baseline: {
            state: "unavailable",
            base_ref: null,
            base_sha: null,
            reason: "baseline_not_pinned",
          },
        },
      ],
    };
    validate("TaskTargetList", closed);
  });
});
