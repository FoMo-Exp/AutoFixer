import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";
import { ApprovalService } from "../src/collab/approval-service.js";
import type { ApprovalDirectory, ApprovalMemberFact } from "../src/collab/approval-service.js";
import { CandidateContentStore } from "../src/collab/candidate-store.js";
import { deliveryView } from "../src/collab/delivery.js";
import { CollabMachine } from "../src/collab/machine.js";
import type { DeliveryRecord } from "../src/collab/types.js";
import {
  REPOSITORY,
  freezeCandidateInput,
  op,
  planningIssue,
  stoppedPreparation,
} from "./helpers/collab.js";

// ajv-formats ships CJS: NodeNext types its default import as the module
// namespace while the runtime binding is the plugin function itself.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

/**
 * Contract test for the candidate-bound approval and broker delivery surface
 * (DAT-220). Records served by the real domain are validated against the
 * merged OpenAPI document with closed objects, so the implementation and the
 * web client contract cannot drift.
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
  $id: "urn:forgepilot:approval-delivery-contract",
  components: closedCopy({ schemas: document.components.schemas }),
  paths: closedCopy(document.paths),
} as Record<string, unknown>);

function validate(pointer: string[], payload: unknown): void {
  const escaped = pointer
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
  const validator = ajv.getSchema(`urn:forgepilot:approval-delivery-contract#/${escaped}`);
  if (!validator) {
    throw new Error(`no contract schema at ${pointer.join("/")}`);
  }
  const ok = validator(payload) as boolean;
  if (!ok) {
    throw new Error(ajv.errorsText(validator.errors));
  }
}

const APPROVAL_SCHEMA = ["components", "schemas", "Approval"];
const DELIVERY_SCHEMA = ["components", "schemas", "Delivery"];

const member: ApprovalMemberFact = {
  user_id: "usr_erin",
  display_name: "erin",
  role: "maintainer",
  status: "active",
  repository_access: true,
  approval_authority: true,
};

class Directory implements ApprovalDirectory {
  authorityVersion(): string {
    return "2026-11-04.1";
  }

  members(): ApprovalMemberFact[] {
    return [member];
  }

  member(): ApprovalMemberFact | null {
    return member;
  }
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autofixer-approval-contract-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("approval and delivery contract", () => {
  test("the served Approval matches the closed contract schema", () => {
    const machine = new CollabMachine({
      candidateStore: new CandidateContentStore(path.join(root, "candidates")),
    });
    const service = new ApprovalService(machine, new Directory());
    const issue = planningIssue(machine);
    const context = stoppedPreparation(machine, issue.issue_id);
    const candidate = machine.freezeCandidate(freezeCandidateInput(context));
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to: "validating",
      reason: null,
    });
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to: "awaiting_change_approval",
      reason: null,
    });
    const approval = service.request({
      operation_id: op(),
      actor: "orchestrator:approval",
      issue_id: issue.issue_id,
      candidate_id: candidate.candidate_id,
      target_branch: issue.repository.base_ref,
    });
    expect(() => validate(APPROVAL_SCHEMA, approval)).not.toThrow();
    expect(() =>
      validate(
        [
          "paths",
          "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/approvals",
          "post",
          "responses",
          "201",
          "content",
          "application/json",
          "schema",
        ],
        approval,
      ),
    ).not.toThrow();
  });

  test("the served Delivery matches the closed contract schema", () => {
    const record: DeliveryRecord = {
      delivery_id: "dlv_1",
      operation_id: "op_1",
      issue_id: "iss_1",
      candidate_id: "cand_1",
      approval_id: "apr_1",
      repository: REPOSITORY,
      target_branch: REPOSITORY.base_ref,
      head_sha: "c".repeat(40),
      provider: "github",
      state: "delivered",
      branch: "autofixer/iss_1",
      pr_id: "pr_1",
      pr_url: "https://github.com/Luthiel/AutoFixer/pull/1",
      error_code: null,
      created_at: "2026-11-03T00:00:00.000Z",
      updated_at: "2026-11-03T00:01:00.000Z",
      reconciled_at: null,
      grant_id: "grt_internal",
    };
    const view = deliveryView(record);
    expect(view).not.toHaveProperty("grant_id");
    expect(() => validate(DELIVERY_SCHEMA, view)).not.toThrow();
  });

  test("the delivery request contract carries its separate grant identity", () => {
    const post = document.paths["/api/v1/workspaces/{workspace_id}/issues/{issue_id}/deliveries"]
      ?.post as
      { requestBody?: { content: { "application/json": { schema: unknown } } } } | undefined;
    const body = post?.requestBody;
    const schema = body?.content["application/json"].schema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(["approval_id", "grant_id"]));
  });

  test("approval and delivery states stay in their contract vocabularies", () => {
    const approvalStates = (
      document.components.schemas["Approval"] as {
        properties: { state: { enum: string[] } };
      }
    ).properties.state.enum;
    const deliveryStates = (
      document.components.schemas["Delivery"] as {
        properties: { state: { enum: string[] } };
      }
    ).properties.state.enum;
    expect(approvalStates).toEqual([
      "pending",
      "approved",
      "rejected",
      "invalidated",
      "expired",
      "consumed",
      "cancelled",
    ]);
    expect(deliveryStates).toEqual([
      "pending",
      "pushing",
      "opening_pr",
      "delivered",
      "partial",
      "unknown",
      "failed",
      "cancelled",
    ]);
  });
});
