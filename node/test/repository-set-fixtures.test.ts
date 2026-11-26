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
 * Real-response fixtures for the repository-addition surface (DAT-286).
 *
 * Unlike the authored exemplars of earlier surfaces, these files are captured
 * from the running service by `test/repository-set-change-http.test.ts`
 * (`AUTOFIXER_CAPTURE_FIXTURES=1 npx vitest run test/repository-set-change-http.test.ts`);
 * only deployment-specific ids and instants are normalized, never the shape.
 * Each one is validated against the generated OpenAPI schemas with closed
 * objects, so a real response can never carry a field the contract does not
 * define, and the web client may use them as fixtures on that basis.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "repository-set-api-v1");
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
  $id: "urn:forgepilot:repository-set-fixtures",
  components: closedCopy({ schemas }),
} as Record<string, unknown>);

function validate(schemaName: string, body: unknown): void {
  const check = ajv.getSchema(
    `urn:forgepilot:repository-set-fixtures#/components/schemas/${schemaName}`,
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

interface FixtureMember {
  membership_id: string;
  user_id: string;
  role: string;
  retains_admission: boolean;
  current_capabilities: string[];
  proposed_capabilities: string[];
  reduction: string[];
  evidence_classes: string[];
  evidence_complete: boolean;
  reason: string | null;
}

interface FixturePreview {
  preview: true;
  authorizes_access: false;
  set_version: number;
  proposed_repository_count: number;
  members: FixtureMember[];
  owners: Array<{ user_id: string; effective: boolean; reason: string | null }>;
  last_owner_survives: boolean;
  all_members_retain_admission: boolean;
  reductions_required: Array<{ membership_id: string; user_id: string; capabilities: string[] }>;
  impact: Record<string, number | boolean>;
  committable: boolean;
  commit_blocked_reasons: string[];
}

const FIXTURES: Array<{ file: string; schema: string }> = [
  { file: "addition-preview-reduction.json", schema: "RepositorySetAdditionPreview" },
  { file: "addition-preview-unknown-evidence.json", schema: "RepositorySetAdditionPreview" },
  { file: "addition-preview-last-owner.json", schema: "RepositorySetAdditionPreview" },
  { file: "addition-confirmation.json", schema: "RepositorySetAdditionConfirmation" },
  { file: "addition-commit-result.json", schema: "RepositorySetAdditionCommitResult" },
];

describe("repository-set addition fixtures", () => {
  test("every captured response matches the committed contract", () => {
    for (const fixture of FIXTURES) {
      validate(fixture.schema, load(fixture.file));
    }
  });

  test("the reduction preview shows before and after without authorizing access", () => {
    const preview = load("addition-preview-reduction.json") as unknown as FixturePreview;
    expect(preview.preview).toBe(true);
    expect(preview.authorizes_access).toBe(false);
    expect(preview.committable).toBe(true);
    expect(preview.commit_blocked_reasons).toEqual([]);

    const reduced = preview.members.find((member) => member.reduction.length > 0);
    expect(reduced).toBeDefined();
    expect(reduced?.retains_admission).toBe(true);
    expect(reduced?.proposed_capabilities).toEqual(["code_read"]);
    expect(reduced?.current_capabilities).toContain("repository_write");
    expect(reduced?.reduction).toEqual(["issue_write", "repository_write"]);

    // The confirmation list is exactly the reduction each member must accept.
    expect(preview.reductions_required).toEqual(
      preview.members
        .filter((member) => member.reduction.length > 0)
        .map((member) => ({
          membership_id: member.membership_id,
          user_id: member.user_id,
          capabilities: member.reduction,
        })),
    );
    // The assigned role is reported separately from the capability ceiling.
    expect(new Set(preview.members.map((member) => member.role))).toEqual(
      new Set(["owner", "member"]),
    );
  });

  test("unknown evidence blocks the whole addition and is not a confirmed removal", () => {
    const preview = load("addition-preview-unknown-evidence.json") as unknown as FixturePreview;
    const blocked = preview.members.find((member) => !member.retains_admission);
    expect(blocked).toBeDefined();
    expect(blocked?.evidence_classes).toEqual(["unknown"]);
    expect(blocked?.evidence_complete).toBe(false);
    // Nothing is subtracted: unknown is not a downgrade.
    expect(blocked?.reduction).toEqual([]);
    expect(blocked?.proposed_capabilities).toEqual([]);
    expect(preview.committable).toBe(false);
    expect(preview.commit_blocked_reasons).toEqual(["MEMBER_ADMISSION_NOT_RETAINED"]);
    expect(preview.reductions_required).toEqual([]);
  });

  test("a last effective owner who keeps read but loses management blocks the addition", () => {
    const preview = load("addition-preview-last-owner.json") as unknown as FixturePreview;
    const owner = preview.members.find((member) => member.role === "owner");
    expect(owner?.retains_admission).toBe(true);
    expect(owner?.proposed_capabilities).toEqual(["code_read", "issue_write", "repository_write"]);
    expect(owner?.reduction).toEqual(["repository_manage"]);
    expect(preview.owners).toEqual([
      { user_id: owner?.user_id, effective: false, reason: "management_missing" },
    ]);
    expect(preview.last_owner_survives).toBe(false);
    expect(preview.committable).toBe(false);
    expect(preview.commit_blocked_reasons).toEqual(["LAST_EFFECTIVE_OWNER_MISSING"]);
  });

  test("the confirmation is evidence of a decision, not a grant", () => {
    const confirmation = load("addition-confirmation.json") as unknown as {
      authorizes_access: false;
      consumed_at: string | null;
      expires_at: string;
      checked_at: string;
      proposed_repositories: Array<Record<string, unknown>>;
      members: FixtureMember[];
    };
    expect(confirmation.authorizes_access).toBe(false);
    expect(confirmation.consumed_at).toBeNull();
    expect(Date.parse(confirmation.expires_at)).toBeGreaterThan(
      Date.parse(confirmation.checked_at),
    );
    // Only immutable identities: a decision record never stores a URL or name.
    for (const repository of confirmation.proposed_repositories) {
      expect(Object.keys(repository).sort()).toEqual(["provider_instance_id", "repository_id"]);
    }
  });
});
