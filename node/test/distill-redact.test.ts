import { describe, expect, test, beforeEach } from "vitest";

import {
  ValidationError,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import { createMemoryRepositories } from "../src/memory/index.js";
import type { MemoryRepositories } from "../src/memory/index.js";
import {
  assertNoSecretOrPii,
  captureOutcome,
  detectSecretOrPii,
  redactText,
  sensitivityFor,
} from "../src/distill/index.js";

let db: ControlPlaneDb;
let memory: MemoryRepositories;
let scope: WorkspaceScope;

const ACTOR = "usr_admin";

function bootstrap(): WorkspaceScope {
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: "test-ent",
    admin_user_id: ACTOR,
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "Repo Workspace",
    repository_id: "repo-1",
    provider_instance_id: provider.id,
  });
  return { enterprise_id: enterprise.id, workspace_id: workspace.id, actor_id: ACTOR };
}

beforeEach(() => {
  db = openControlPlaneDb();
  memory = createMemoryRepositories(db);
  scope = bootstrap();
});

function envelopeWithText(reason: string): Record<string, unknown> {
  return {
    contract_version: "1.0.0",
    task_id: "task-1",
    run_id: "run-1",
    issue_id: "issue-1",
    terminal_state: "rejected",
    reason,
    delivery: {
      patch_status: "not_created",
      head_sha: null,
      pr_id: null,
      change_summary: "No patch was prepared.",
      validation: [],
    },
    evidence: [],
  };
}

// ---------------------------------------------------------------------------
// Scanning and minimization
// ---------------------------------------------------------------------------

describe("secret scanning and PII minimization", () => {
  test("scrubs credential-shaped material", () => {
    const dirty =
      "failed with Bearer sk-live-abcdef123456 and API_KEY=prod-secret-value; ghp_abcdef1234567890 too";
    const report = redactText(dirty);
    expect(report.kinds).toContain("secret");
    expect(report.text).not.toContain("sk-live-abcdef123456");
    expect(report.text).not.toContain("prod-secret-value");
    expect(report.text).not.toContain("ghp_abcdef1234567890");
  });

  test("minimizes personal data to placeholders", () => {
    const dirty =
      "contact ada.lovelace@example.com or +15551234567; card 4111 1111 1111 1111; home /Users/ada/src";
    const report = redactText(dirty);
    expect(report.kinds).toContain("email");
    expect(report.kinds).toContain("phone");
    expect(report.kinds).toContain("payment_card");
    expect(report.kinds).toContain("user_path");
    expect(report.text).not.toContain("ada.lovelace@example.com");
    expect(report.text).not.toContain("4111 1111 1111 1111");
    expect(report.text).not.toContain("/Users/ada");
    expect(report.text).toContain("[email]");
  });

  test("redaction output passes the clean gate and re-detection is stateless", () => {
    const report = redactText("email bob@example.com and token sk-abcdefghijkl");
    expect(report.kinds.length).toBeGreaterThan(0);
    expect(detectSecretOrPii(report.text)).toEqual([]);
    expect(detectSecretOrPii(report.text)).toEqual([]);
  });

  test("clean engineering text is untouched", () => {
    const clean = "Run `cd node && npm test` before claiming done; use vitest for new tests.";
    const report = redactText(clean);
    expect(report.kinds).toEqual([]);
    expect(report.text).toBe(clean);
  });

  test("sensitivity follows the material found", () => {
    expect(sensitivityFor([])).toBe("internal");
    expect(sensitivityFor(["email"])).toBe("confidential");
    expect(sensitivityFor(["secret"])).toBe("restricted");
    expect(sensitivityFor(["secret", "email"])).toBe("restricted");
  });

  test("assertNoSecretOrPii fails closed on raw secret or personal material", () => {
    expect(() => assertNoSecretOrPii("plain text", "statement")).not.toThrow();
    expect(() => assertNoSecretOrPii("sk-live-abcdef123456", "statement")).toThrow(ValidationError);
    expect(() => assertNoSecretOrPii("mail me at bob@example.com", "statement")).toThrow(
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Capture-side redaction
// ---------------------------------------------------------------------------

describe("captured outcomes never carry secrets or personal data", () => {
  test("episode statements are minimized and sensitivity is raised", () => {
    const captured = captureOutcome(
      memory,
      scope,
      envelopeWithText(
        "Reviewer ada.lovelace@example.com rejected: key sk-live-abcdef123456 leaked in logs",
      ),
    );
    const statement = captured.episode.current.statement;
    expect(statement).not.toContain("sk-live-abcdef123456");
    expect(statement).not.toContain("ada.lovelace@example.com");
    expect(statement).toContain("[email]");
    expect(captured.episode.current.sensitivity).toBe("restricted");
    expect(captured.envelope.reason).not.toContain("sk-live-abcdef123456");
  });

  test("a PII-only outcome is classified confidential", () => {
    const captured = captureOutcome(
      memory,
      scope,
      envelopeWithText("Cancelled: reported by ada.lovelace@example.com"),
    );
    expect(captured.episode.current.statement).not.toContain("ada.lovelace@example.com");
    expect(captured.episode.current.sensitivity).toBe("confidential");
  });

  test("clean outcomes stay internal", () => {
    const captured = captureOutcome(
      memory,
      scope,
      envelopeWithText("Cancelled: duplicate of DAT-234"),
    );
    expect(captured.episode.current.sensitivity).toBe("internal");
  });

  test("secrets in the change summary never reach the episode", () => {
    const captured = captureOutcome(memory, scope, {
      contract_version: "1.0.0",
      task_id: "task-9",
      run_id: "run-9",
      issue_id: "issue-9",
      terminal_state: "stopped",
      stop_disposition: "unknown",
      delivery: {
        patch_status: "prepared_no_pr",
        head_sha: "head-9",
        pr_id: null,
        change_summary: "Configured GITHUB_TOKEN=ghp_abcdef1234567890 in the workflow.",
        validation: [],
      },
      evidence: [],
    });
    const statement = captured.episode.current.statement;
    expect(statement).not.toContain("ghp_abcdef1234567890");
    expect(captured.episode.current.sensitivity).toBe("restricted");
  });
});
