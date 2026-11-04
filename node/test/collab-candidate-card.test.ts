import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";
import { CandidateContentStore } from "../src/collab/candidate-store.js";
import { CandidateReviewService } from "../src/collab/candidate-service.js";
import { CollabMachine } from "../src/collab/machine.js";
import type { CollabError } from "../src/collab/errors.js";
import { freezeCandidateInput, planningIssue, stoppedPreparation } from "./helpers/collab.js";

// ajv-formats ships CJS: NodeNext types its default import as the module
// namespace while the runtime binding is the plugin function itself.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

/**
 * Contract test for the candidate review-card API (DAT-219).
 *
 * The card served by `CandidateReviewService` is validated against the merged
 * OpenAPI document (`web/src/api/contracts/openapi.json`'s source) with closed
 * objects, so the serving code and the contract cannot drift and the API can
 * never invent a field a web client would not know about.
 */

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
  $id: "urn:forgepilot:candidate-card-contract",
  components: closedCopy({ schemas: document.components.schemas }),
  paths: closedCopy(document.paths),
} as Record<string, unknown>);

function validate(pointer: string[], payload: unknown): { ok: boolean; error: string } {
  const escaped = pointer
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
  const validator = ajv.getSchema(`urn:forgepilot:candidate-card-contract#/${escaped}`);
  if (!validator) {
    throw new Error(`no contract schema at ${pointer.join("/")}`);
  }
  const ok = validator(payload) as boolean;
  return { ok, error: ajv.errorsText(validator.errors) };
}

const CANDIDATE_SCHEMA = ["components", "schemas", "Candidate"];
const CANDIDATE_PAGE_SCHEMA = [
  "paths",
  "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/candidates",
  "get",
  "responses",
  "200",
  "content",
  "application/json",
  "schema",
];

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as CollabError).code).toBe(code);
    return;
  }
  throw new Error(`expected denial ${code}`);
}

let root: string;
let machine: CollabMachine;
let service: CandidateReviewService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autofixer-candidate-card-"));
  const store = new CandidateContentStore(root);
  machine = new CollabMachine({ candidateStore: store });
  service = new CandidateReviewService(machine, store);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function freezeOne(): { issueId: string; candidateId: string } {
  const issue = planningIssue(machine);
  const context = stoppedPreparation(machine, issue.issue_id);
  const candidate = machine.freezeCandidate(freezeCandidateInput(context));
  return { issueId: issue.issue_id, candidateId: candidate.candidate_id };
}

describe("candidate review-card API contract", () => {
  test("a served card validates against the merged Candidate schema", () => {
    const { issueId, candidateId } = freezeOne();
    const card = service.get(issueId, candidateId);
    const result = validate(CANDIDATE_SCHEMA, card);
    expect(result.error).toBe("No errors");
    expect(result.ok).toBe(true);
    expect(card.contract_version).toBe("1.0.0");
  });

  test("the candidate page validates against the merged list response schema", () => {
    const { issueId } = freezeOne();
    const page = service.page(issueId);
    const result = validate(CANDIDATE_PAGE_SCHEMA, page);
    expect(result.error).toBe("No errors");
    expect(result.ok).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
  });

  test("an invalidated candidate still validates and states its staleness", () => {
    const { issueId, candidateId } = freezeOne();
    machine.invalidateCandidate({
      operation_id: "op_invalidate_card",
      actor: "human:operator",
      candidate_id: candidateId,
      reason: "policy_changed",
    });
    const card = service.get(issueId, candidateId);
    expect(validate(CANDIDATE_SCHEMA, card).ok).toBe(true);
    expect(card.invalidated_reason).toBe("policy_changed");
    expect(service.freshness(issueId, candidateId)).toEqual({
      current: false,
      reason: "policy_changed",
    });
  });

  test("a candidate of another issue is an indistinguishable CANDIDATE_NOT_FOUND", () => {
    const { candidateId } = freezeOne();
    expectCode(() => service.get("iss_somebody_else", candidateId), "CANDIDATE_NOT_FOUND");
    expectCode(() => service.diff("iss_somebody_else", candidateId), "CANDIDATE_NOT_FOUND");
  });
});

describe("review notification contains no sensitive preview", () => {
  const CLIENT = "https://workbench.example.test";

  test("the notification carries bounded metadata and an authenticated link only", () => {
    const { issueId, candidateId } = freezeOne();
    const notification = service.notification(issueId, candidateId, { clientUrl: CLIENT });
    const serialized = JSON.stringify(notification);

    expect(notification).toMatchObject({
      type: "candidate.ready_for_review",
      candidate_id: candidateId,
      changed_paths: 2,
      insertions: 6,
      deletions: 1,
      tests: { total: 1, passed: 1, failed: 0 },
      risk_class: "low",
      requires_human_approval: false,
    });
    // No diff text, changed path, tool output, or digest leaves the service.
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("src/retry.ts");
    expect(serialized).not.toContain("test/retry.test.ts");
    expect(serialized).not.toContain("sha256");
    expect(serialized).not.toContain("npm test");
    expect(notification.link).toBe(
      `${CLIENT}/workspaces/ws_test/issues/${issueId}/candidates/${candidateId}`,
    );
    // The link selects a candidate; it is not a bearer approval.
    const link = new URL(notification.link);
    expect(link.search).toBe("");
    expect(link.username).toBe("");
    expect(link.password).toBe("");
  });

  test("a client URL carrying an approval credential is refused", () => {
    const { issueId, candidateId } = freezeOne();
    for (const clientUrl of [
      "https://workbench.example.test?token=abc",
      "https://workbench.example.test?approval_token=abc",
      "https://user:secret@workbench.example.test",
    ]) {
      expectCode(() => service.notification(issueId, candidateId, { clientUrl }), "INVALID_INPUT");
    }
  });

  test("an overlong summary is truncated in the notification, not in the card", () => {
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    const candidate = machine.freezeCandidate(
      freezeCandidateInput(context, { summary: `${"detail ".repeat(80)}tail` }),
    );
    const notification = service.notification(issue.issue_id, candidate.candidate_id, {
      clientUrl: CLIENT,
    });
    expect(notification.summary.length).toBeLessThanOrEqual(240);
    expect(service.get(issue.issue_id, candidate.candidate_id).summary.length).toBeGreaterThan(240);
  });
});
