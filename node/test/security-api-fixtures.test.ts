import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";
import { ERROR_NEXT_ACTIONS } from "../src/api/errors.js";
import {
  SECURITY_CASE_STATE_MATRIX,
  SECURITY_OPENAPI_SCHEMAS,
  securityOpenApiPaths,
} from "../src/api/openapi-security.js";
import { SECURITY_AUDIT_EVENT_TYPES, SECURITY_AUDIT_RESULTS } from "../src/security/audit.js";
import { CASE_STATES } from "../src/security/types.js";

// ajv-formats ships CJS: NodeNext types its default import as the module
// namespace while the runtime binding is the plugin function itself.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

/**
 * Contract-exemplar fixtures for the ADR-0005 security surface (DAT-213).
 *
 * Authored from the contract, not captured from a live service (the HTTP
 * layer is a later milestone). Every fixture is validated against the
 * generated OpenAPI document with closed objects, so it cannot invent a field
 * outside `web/src/api/contracts/openapi.json`. These are the fixtures the web
 * client (DAT-214) builds its case/rule/recovery/audit UI from.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "security-api-v1");

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
  $id: "urn:forgepilot:security-contract",
  components: closedCopy({ schemas: document.components.schemas }),
  paths: closedCopy(document.paths),
} as Record<string, unknown>);

function schemaAt(pointer: string[]): { validate: (data: unknown) => boolean; errorsText: string } {
  const escaped = pointer
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
  const validate = ajv.getSchema(`urn:forgepilot:security-contract#/${escaped}`);
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
const RESPONSE = (docPath: string, method: string): string[] => [
  "paths",
  docPath,
  method,
  "responses",
  "200",
  "content",
  "application/json",
  "schema",
];

const BASE = "/api/v1/workspaces/{workspace_id}/security";
const CASES = `${BASE}/cases`;
const CASE = `${CASES}/{case_id}`;
const RULES = `${BASE}/rules`;
const REVISION = `${RULES}/{lineage}/revisions/{version}`;
const APPROVAL = `${BASE}/recovery-approvals/{authorization_id}`;

interface FixtureCase {
  file: string;
  pointer: string[];
}

const FIXTURES: FixtureCase[] = [
  { file: "case.json", pointer: COMPONENT("SecurityCase") },
  { file: "case-page.json", pointer: RESPONSE(CASES, "get") },
  { file: "transition-request.json", pointer: COMPONENT("SecurityCaseTransitionRequest") },
  { file: "rule-revision.json", pointer: COMPONENT("SecurityRuleRevision") },
  { file: "rule-page.json", pointer: RESPONSE(RULES, "get") },
  { file: "rule-proposal-request.json", pointer: COMPONENT("SecurityRuleProposalRequest") },
  { file: "recovery-approval.json", pointer: COMPONENT("SecurityRecoveryApproval") },
  { file: "recovery-approval-request.json", pointer: COMPONENT("SecurityRecoveryApprovalRequest") },
  { file: "recovery-dispatch.json", pointer: COMPONENT("SecurityRecoveryDispatch") },
  { file: "quarantine-grant.json", pointer: COMPONENT("SecurityQuarantineGrant") },
  { file: "audit-entry.json", pointer: COMPONENT("SecurityAuditEntry") },
  { file: "audit-page.json", pointer: RESPONSE(`${BASE}/audit`, "get") },
  { file: "audit-export.json", pointer: RESPONSE(`${BASE}/audit/exports`, "post") },
  { file: "audit-export-request.json", pointer: COMPONENT("SecurityAuditExportRequest") },
  { file: "error-sensitive-data-uncertain.json", pointer: COMPONENT("Error") },
  { file: "error-recovery-approval-invalid.json", pointer: COMPONENT("Error") },
];

describe("security API fixtures validate against the generated contract", () => {
  test.each(FIXTURES)("$file matches its schema", ({ file, pointer }) => {
    const schema = schemaAt(pointer);
    const fixture = loadFixture(file);
    expect(schema.validate(fixture), `${file}: ${schema.errorsText}`).toBe(true);
  });
});

describe("security contract invariants", () => {
  test("every security path is mounted and documented", () => {
    const expected = securityOpenApiPaths();
    for (const [docPath, operations] of Object.entries(expected)) {
      expect(document.paths[docPath], docPath).toBeDefined();
      for (const method of Object.keys(operations)) {
        expect(document.paths[docPath]?.[method], `${method} ${docPath}`).toBeDefined();
      }
    }
  });

  test("the case and audit vocabularies reuse the domain constants", () => {
    const caseSchema = document.components.schemas["SecurityCase"] as {
      properties: { state: { enum: string[] } };
    };
    expect(caseSchema.properties.state.enum).toEqual([...CASE_STATES]);

    const audit = document.components.schemas["SecurityAuditEvent"] as {
      properties: { event: { enum: string[] }; result: { enum: string[] } };
    };
    expect(audit.properties.event.enum).toEqual([...SECURITY_AUDIT_EVENT_TYPES]);
    expect(audit.properties.result.enum).toEqual([...SECURITY_AUDIT_RESULTS]);
  });

  test("the case fixture only offers transitions the service permits", () => {
    const fixture = loadFixture("case.json") as {
      state: string;
      allowed_transitions: string[];
    };
    const permitted = SECURITY_CASE_STATE_MATRIX[fixture.state as never] as readonly string[];
    expect([...fixture.allowed_transitions].sort()).toEqual([...permitted].sort());
  });

  test("no security request body accepts a client-supplied scope or a bypass", () => {
    for (const [docPath, operations] of Object.entries(securityOpenApiPaths())) {
      for (const [method, operation] of Object.entries(operations)) {
        const body = (operation as { requestBody?: unknown }).requestBody;
        const text = JSON.stringify(body ?? {});
        expect(text, `${method} ${docPath}`).not.toMatch(/send_anyway|bypass|exempt/i);
        // References only; the referenced proposal/review schemas never carry
        // workspace_id/enterprise_id, so the server's authenticated scope is
        // the only authority.
        expect(text, `${method} ${docPath}`).not.toMatch(/"workspace_id"|"enterprise_id"/);
      }
    }
  });

  test("the proposal body cannot assert regression evidence", () => {
    const proposal = document.components.schemas["SecurityRuleProposalRequest"] as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(proposal.properties).sort()).toEqual(
      ["constraints", "detector_id", "expires_at", "reason", "review_at"].sort(),
    );
  });

  test("the recovery approval is expiring and single-use in shape", () => {
    const approval = document.components.schemas["SecurityRecoveryApproval"] as {
      required: string[];
      properties: { state: { enum: string[] } };
    };
    expect(approval.required).toContain("expires_at");
    expect(approval.properties.state.enum).toEqual([
      "approved",
      "consumed",
      "invalidated",
      "revoked",
      "expired",
    ]);
  });

  test("the audit fixtures use keyed identifiers, never raw content", () => {
    for (const file of ["audit-entry.json", "audit-page.json", "audit-export.json"]) {
      const text = JSON.stringify(loadFixture(file));
      expect(text, file).not.toMatch(/Authorization:|BEGIN PRIVATE KEY|sk-live|ghp_/);
      expect(text, file).toContain("k1.");
    }
  });

  test("the security error fixtures carry the stable next action vocabulary", () => {
    for (const file of [
      "error-sensitive-data-uncertain.json",
      "error-recovery-approval-invalid.json",
    ]) {
      const body = loadFixture(file) as {
        error: { code: string; next_action: string; retryable: boolean; case_ref: string };
      };
      expect(ERROR_NEXT_ACTIONS).toContain(body.error.next_action);
      expect(body.error.retryable).toBe(false);
      expect(body.error.case_ref).toMatch(/^case_/);
    }
  });

  test("every registered schema is present in the document", () => {
    for (const name of Object.keys(SECURITY_OPENAPI_SCHEMAS)) {
      expect(document.components.schemas[name], name).toBeDefined();
    }
  });

  test("the required security operations are documented", () => {
    for (const [method, docPath] of [
      ["get", CASES],
      ["get", CASE],
      ["post", `${CASE}/transitions`],
      ["post", `${CASE}/termination-requests`],
      ["post", `${CASE}/reassignment-requests`],
      ["post", `${CASE}/quarantine-grants`],
      ["post", `${BASE}/quarantine/{quarantine_id}/views`],
      ["get", RULES],
      ["post", `${RULES}/proposals`],
      ["post", `${REVISION}/reviews`],
      ["post", `${REVISION}/activation`],
      ["post", `${RULES}/{lineage}/rollbacks`],
      ["post", `${CASE}/recovery-approvals`],
      ["get", APPROVAL],
      ["delete", APPROVAL],
      ["post", `${APPROVAL}/dispatch`],
      ["get", `${BASE}/audit`],
      ["post", `${BASE}/audit/exports`],
    ] as Array<[string, string]>) {
      expect(document.paths[docPath]?.[method], `${method} ${docPath}`).toBeDefined();
    }
  });
});
