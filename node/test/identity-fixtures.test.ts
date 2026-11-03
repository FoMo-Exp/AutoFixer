import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";
import { ApiError, ERROR_ENVELOPE_VERSION, type ApiErrorOverrides } from "../src/api/errors.js";

// ajv-formats ships CJS: NodeNext types its default import as the module
// namespace while the runtime binding is the plugin function itself.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

/**
 * Contract-exemplar fixtures for the identity/workspace/team/invitation
 * surface (DAT-205).
 *
 * These payloads are authored from the contract — not captured from a live
 * service — and every one of them is validated against the generated
 * OpenAPI document's schemas with closed objects, so a fixture can never
 * invent a field outside `web/src/api/contracts/openapi.json`. The web
 * client may use them as UI fixtures on that basis. Regenerate nothing here:
 * a schema change intentionally breaks these fixtures until they are
 * re-authored against the new contract.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "identity-api-v1");

const document = buildOpenApiDocument();

/**
 * Deep-copy a schema tree, closing every object schema that declares
 * `properties` with `additionalProperties: false` (an explicit value is kept).
 * Validating against the closed copy proves fixtures use no invented fields.
 */
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
  $id: "urn:forgepilot:contract",
  components: closedCopy({ schemas: document.components.schemas }),
  paths: closedCopy(document.paths),
} as Record<string, unknown>);

function schemaAt(pointer: string[]): { validate: (data: unknown) => boolean; errorsText: string } {
  const escaped = pointer
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
  const validate = ajv.getSchema(`urn:forgepilot:contract#/${escaped}`);
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

function responseSchema(docPath: string, method: string): string[] {
  return ["paths", docPath, method, "responses", "200", "content", "application/json", "schema"];
}

const COMPONENT = (name: string): string[] => ["components", "schemas", name];

interface FixtureCase {
  file: string;
  pointer: string[];
}

const FIXTURES: FixtureCase[] = [
  { file: "session.json", pointer: COMPONENT("Session") },
  { file: "session-credential.json", pointer: COMPONENT("SessionCredential") },
  { file: "login-provider.json", pointer: COMPONENT("LoginProvider") },
  { file: "workspace.json", pointer: COMPONENT("Workspace") },
  { file: "workspace-page.json", pointer: responseSchema("/api/v1/workspaces", "get") },
  { file: "membership.json", pointer: COMPONENT("Membership") },
  {
    file: "membership-page.json",
    pointer: responseSchema("/api/v1/workspaces/{workspace_id}/members", "get"),
  },
  { file: "member-candidate.json", pointer: COMPONENT("MemberCandidate") },
  { file: "team.json", pointer: COMPONENT("Team") },
  { file: "invitation-created.json", pointer: COMPONENT("CreatedInvitation") },
  { file: "invitation-preview.json", pointer: COMPONENT("InvitationPreview") },
  { file: "invitation-redeem.json", pointer: COMPONENT("InvitationRedemption") },
];

interface ErrorFixtureCase {
  file: string;
  /** Per-instance envelope overrides the service serves for this case. */
  overrides: ApiErrorOverrides;
}

const ERROR_FIXTURES: ErrorFixtureCase[] = [
  { file: "error-unauthenticated.json", overrides: {} },
  { file: "error-not-found.json", overrides: {} },
  { file: "error-invitation-not-accepted.json", overrides: {} },
  { file: "error-rate-limited.json", overrides: { stage: "auth", retry_after_seconds: 30 } },
  { file: "error-version-conflict.json", overrides: {} },
];

describe("identity contract fixtures", () => {
  test("every fixture file is covered by the manifest", () => {
    const onDisk = fs
      .readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .sort();
    const manifested = [...FIXTURES, ...ERROR_FIXTURES].map((entry) => entry.file).sort();
    expect(onDisk).toEqual(manifested);
  });

  test("resource fixtures conform to the contract schemas with no invented fields", () => {
    for (const { file, pointer } of FIXTURES) {
      const { validate, errorsText } = schemaAt(pointer);
      expect(validate(loadFixture(file)), `${file} vs ${pointer.join("/")}: ${errorsText}`).toBe(
        true,
      );
    }
  });

  test("error fixtures conform to the shared error envelope", () => {
    for (const { file } of ERROR_FIXTURES) {
      const { validate, errorsText } = schemaAt(COMPONENT("Error"));
      expect(validate(loadFixture(file)), `${file}: ${errorsText}`).toBe(true);
    }
  });

  test("error fixtures carry exactly the envelope semantics the service serves", () => {
    for (const { file, overrides } of ERROR_FIXTURES) {
      const fixture = loadFixture(file) as {
        error: {
          code: string;
          message: string;
          request_id: string;
          details: Record<string, unknown>;
          envelope_version: number;
          stage: string;
          category: string;
          retryable: boolean;
          retry_after_seconds: number | null;
          next_action: string | null;
        };
      };
      const served = new ApiError(
        500,
        fixture.error.code,
        fixture.error.message,
        fixture.error.details,
        overrides,
      ).toBody(fixture.error.request_id);
      expect(fixture.error.envelope_version, file).toBe(ERROR_ENVELOPE_VERSION);
      expect(
        {
          stage: fixture.error.stage,
          category: fixture.error.category,
          retryable: fixture.error.retryable,
          retry_after_seconds: fixture.error.retry_after_seconds,
          next_action: fixture.error.next_action,
        },
        file,
      ).toEqual({
        stage: served.error.stage,
        category: served.error.category,
        retryable: served.error.retryable,
        retry_after_seconds: served.error.retry_after_seconds,
        next_action: served.error.next_action,
      });
    }
  });
});
