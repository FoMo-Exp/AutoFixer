import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";
import { ApiError, ERROR_ENVELOPE_VERSION, type ApiErrorOverrides } from "../src/api/errors.js";
import { PRODUCT_TRANSITIONS } from "../src/collab/states.js";
import { TASK_EVIDENCE_CONTRACT_VERSION } from "../src/collab/contract.js";

// ajv-formats ships CJS: NodeNext types its default import as the module
// namespace while the runtime binding is the plugin function itself.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

/**
 * Contract-exemplar fixtures for the collaboration v1 surface (DAT-221,
 * ADR-0007): issue, stage, child task, bounded run, immutable candidate,
 * candidate-bound approval, broker-controlled delivery, the issue event
 * envelope, and the shared error envelope's stop/needs_human/unknown
 * semantics.
 *
 * These payloads are authored from the contract — not captured from a live
 * service — and every one of them is validated against the generated OpenAPI
 * document's schemas with closed objects, so a fixture can never invent a
 * field outside `web/src/api/contracts/openapi.json`. The web client may use
 * them as UI fixtures on that basis. Regenerate nothing here: a schema change
 * intentionally breaks these fixtures until they are re-authored against the
 * new contract.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "collab-api-v1");

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
  $id: "urn:forgepilot:collab-contract",
  components: closedCopy({ schemas: document.components.schemas }),
  paths: closedCopy(document.paths),
} as Record<string, unknown>);

function schemaAt(pointer: string[]): { validate: (data: unknown) => boolean; errorsText: string } {
  const escaped = pointer
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
  const validate = ajv.getSchema(`urn:forgepilot:collab-contract#/${escaped}`);
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

const ISSUES = "/api/v1/workspaces/{workspace_id}/issues";
const ISSUE = `${ISSUES}/{issue_id}`;

interface FixtureCase {
  file: string;
  pointer: string[];
}

const FIXTURES: FixtureCase[] = [
  { file: "issue.json", pointer: COMPONENT("Issue") },
  { file: "issue-page.json", pointer: responseSchema(ISSUES, "get") },
  { file: "issue-stage.json", pointer: COMPONENT("IssueStage") },
  { file: "task.json", pointer: COMPONENT("IssueTask") },
  { file: "task-page.json", pointer: responseSchema(`${ISSUE}/tasks`, "get") },
  { file: "run.json", pointer: COMPONENT("IssueRun") },
  { file: "run-page.json", pointer: responseSchema(`${ISSUE}/runs`, "get") },
  { file: "candidate.json", pointer: COMPONENT("Candidate") },
  { file: "candidate-page.json", pointer: responseSchema(`${ISSUE}/candidates`, "get") },
  { file: "approval.json", pointer: COMPONENT("Approval") },
  { file: "approval-page.json", pointer: responseSchema(`${ISSUE}/approvals`, "get") },
  { file: "delivery.json", pointer: COMPONENT("Delivery") },
  { file: "delivery-page.json", pointer: responseSchema(`${ISSUE}/deliveries`, "get") },
  { file: "issue-event.json", pointer: COMPONENT("IssueEvent") },
];

interface ErrorFixtureCase {
  file: string;
  /** Per-instance envelope overrides the service serves for this case. */
  overrides: ApiErrorOverrides;
}

const ERROR_FIXTURES: ErrorFixtureCase[] = [
  { file: "error-issue-not-found.json", overrides: {} },
  { file: "error-disposition-required.json", overrides: {} },
  { file: "error-delivery-outcome-unknown.json", overrides: {} },
  { file: "error-idempotency-conflict.json", overrides: {} },
];

describe("collaboration contract fixtures", () => {
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

  test("the stage fixture carries exactly the ADR-0007 outgoing edges", () => {
    const stage = loadFixture("issue-stage.json") as {
      product_state: keyof typeof PRODUCT_TRANSITIONS;
      allowed_transitions: string[];
    };
    expect(stage.allowed_transitions).toEqual([...PRODUCT_TRANSITIONS[stage.product_state]]);
  });

  test("the stopped run fixture preserves a candidate artifact and a revoked grant", () => {
    const run = loadFixture("run.json") as {
      state: string;
      artifact_refs: Array<{ kind: string }>;
      grants: Array<{ state: string; may_create_or_update_pr: boolean }>;
    };
    // ADR-0007: awaiting_change_approval requires a stopped preparation run
    // whose candidate survived the grant revocation, and PR capability is
    // never part of the preparation grant.
    expect(run.state).toBe("stopped");
    expect(
      run.artifact_refs.some(
        (artifact) => artifact.kind === "candidate" || artifact.kind === "patch",
      ),
    ).toBe(true);
    expect(run.grants.every((grant) => grant.state !== "active")).toBe(true);
    expect(run.grants.every((grant) => grant.may_create_or_update_pr === false)).toBe(true);
  });

  test("the candidate and approval fixtures claim the evidence contract version", () => {
    for (const file of ["candidate.json", "approval.json"]) {
      const record = loadFixture(file) as { contract_version: string };
      expect(record.contract_version, file).toBe(TASK_EVIDENCE_CONTRACT_VERSION);
    }
  });

  test("the approval fixture is bound to one candidate's exact digests", () => {
    const candidate = loadFixture("candidate.json") as {
      candidate_id: string;
      head_sha: string;
      diff: { digest: string };
      validation: { results: Array<{ output_digest: { value: string } | null }> };
    };
    const approval = loadFixture("approval.json") as {
      candidate_id: string;
      binding: {
        candidate_id: string;
        head_sha: string;
        diff_digest: { value: string };
        test_evidence_digest: { value: string };
      };
    };
    expect(approval.candidate_id).toBe(candidate.candidate_id);
    expect(approval.binding.candidate_id).toBe(candidate.candidate_id);
    expect(approval.binding.head_sha).toBe(candidate.head_sha);
    expect(approval.binding.diff_digest.value).toBe(candidate.diff.digest);
    expect(approval.binding.test_evidence_digest.value).toBe(
      candidate.validation.results[0]?.output_digest?.value,
    );
  });

  test("the partial delivery fixture is a pushed branch without a PR", () => {
    const delivery = loadFixture("delivery.json") as {
      state: string;
      branch: string | null;
      pr_id: string | null;
      pr_url: string | null;
    };
    // ADR-0007: a pushed branch with failed PR creation remains an explicit
    // partial delivery — never success and never automatically deleted.
    expect(delivery.state).toBe("partial");
    expect(delivery.branch?.startsWith("autofixer/")).toBe(true);
    expect(delivery.pr_id).toBeNull();
    expect(delivery.pr_url).toBeNull();
  });
});
