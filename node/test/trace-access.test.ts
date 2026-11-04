import { describe, expect, test } from "vitest";

import type { CapturedMaterial } from "../src/trace/content.js";
import {
  ContentAccessAuthorizer,
  ContentAccessDenied,
  ContentGrant,
  ContentVault,
  DENY_ALL_CONTENT,
  DENY_ALL_QUARANTINE,
  QuarantineAccessAuthorizer,
  QuarantineAccessDenied,
  QuarantineConflictError,
  QuarantineGrant,
  QuarantineVault,
} from "../src/trace/access.js";
import { TraceConflictError } from "../src/trace/errors.js";

function captured(overrides: Partial<CapturedMaterial> = {}): CapturedMaterial {
  return {
    record_id: "rec-1",
    kind: "prompt",
    data_classes: ["user_input"],
    captured_at: "2026-11-03T00:00:00.000Z",
    scan: {
      scanner: "pattern-secret-scanner",
      rule_version: "2026-11-03.1",
      classification: "clean",
      detectors: [],
      findings: { suspected: 0, confirmed: 0, unknown: 0 },
    },
    text: "hello world",
    original_chars: 11,
    persisted_chars: 11,
    redactions: 0,
    truncated: false,
    ...overrides,
  };
}

const allowAllContent = { mayReadContent: (_subject: string) => true };
const allowAllQuarantine = { mayReadQuarantine: (_subject: string) => true };

describe("content and quarantine access are separately authorized", () => {
  test("one subject's policies are independent", () => {
    // security-analyst may read quarantine material but not content.
    const contentAuthorizer = new ContentAccessAuthorizer({
      mayReadContent: (subject) => subject === "support",
    });
    const quarantineAuthorizer = new QuarantineAccessAuthorizer({
      mayReadQuarantine: (subject) => subject === "security-analyst",
    });
    const vault = new ContentVault(contentAuthorizer);
    vault.deposit(captured());

    expect(() =>
      vault.read("rec-1", quarantineAuthorizer.authorize("security-analyst") as never),
    ).toThrow(ContentAccessDenied);
    expect(vault.read("rec-1", contentAuthorizer.authorize("support")).record_id).toBe("rec-1");

    const quarantine = new QuarantineVault(quarantineAuthorizer);
    quarantine.deposit({
      case_ref: "case-1",
      kind: "prompt",
      text: "raw material",
      deposited_by: "security-analyst",
      reason: "investigation",
    });
    expect(() =>
      quarantine.read("case-1", contentAuthorizer.authorize("support") as never),
    ).toThrow(QuarantineAccessDenied);
    expect(quarantine.read("case-1", quarantineAuthorizer.authorize("security-analyst")).text).toBe(
      "raw material",
    );
  });

  test("a grant is only valid for the authorizer that minted it", () => {
    const vault = new ContentVault(new ContentAccessAuthorizer(allowAllContent));
    vault.deposit(captured());
    const otherAuthorizer = new ContentAccessAuthorizer(allowAllContent);
    expect(() => vault.read("rec-1", otherAuthorizer.authorize("user"))).toThrow(
      ContentAccessDenied,
    );
  });

  test("caller-constructed grants are refused everywhere", () => {
    const vault = new ContentVault(new ContentAccessAuthorizer(allowAllContent));
    vault.deposit(captured());
    expect(() => vault.read("rec-1", null)).toThrow(ContentAccessDenied);
    expect(() => vault.read("rec-1", undefined)).toThrow(ContentAccessDenied);
    expect(() => vault.read("rec-1", new ContentGrant("user"))).toThrow(ContentAccessDenied);

    const quarantine = new QuarantineVault(new QuarantineAccessAuthorizer(allowAllQuarantine));
    quarantine.deposit({
      case_ref: "case-1",
      kind: "prompt",
      text: "material",
      deposited_by: "security-analyst",
      reason: "investigation",
    });
    expect(() => quarantine.read("case-1", new QuarantineGrant("user"))).toThrow(
      QuarantineAccessDenied,
    );
  });

  test("the default policies deny every read", () => {
    expect(() => new ContentAccessAuthorizer().authorize("user")).toThrow(ContentAccessDenied);
    expect(() => new QuarantineAccessAuthorizer().authorize("user")).toThrow(
      QuarantineAccessDenied,
    );
    expect(DENY_ALL_CONTENT.mayReadContent("user")).toBe(false);
    expect(DENY_ALL_QUARANTINE.mayReadQuarantine("user")).toBe(false);
    expect(() => new ContentAccessAuthorizer().authorize("")).toThrow(ContentAccessDenied);
  });
});

describe("content vault", () => {
  test("deposits are re-scanned as defense in depth", () => {
    const authorizer = new ContentAccessAuthorizer(allowAllContent);
    const vault = new ContentVault(authorizer);
    // A misrouted raw string still cannot rest here unredacted.
    vault.deposit(
      captured({
        text: "api_key=verysecretvalue123",
      }),
    );
    const read = vault.read("rec-1", authorizer.authorize("user"));
    expect(read.text).not.toContain("verysecretvalue123");
    expect(read.text).toContain("[redacted]");
  });

  test("records are never rewritten through the deposit path", () => {
    const authorizer = new ContentAccessAuthorizer(allowAllContent);
    const vault = new ContentVault(authorizer);
    vault.deposit(captured());
    expect(() => vault.deposit(captured({ text: "different" }))).toThrow(TraceConflictError);
    expect(vault.read("rec-1", authorizer.authorize("user")).text).toBe("hello world");
  });

  test("an unauthorized read cannot probe which records exist", () => {
    const authorizer = new ContentAccessAuthorizer(allowAllContent);
    const vault = new ContentVault(authorizer);
    vault.deposit(captured());
    let existing: unknown;
    let missing: unknown;
    try {
      vault.read("rec-1", null);
    } catch (error) {
      existing = (error as Error).message;
    }
    try {
      vault.read("nope", null);
    } catch (error) {
      missing = (error as Error).message;
    }
    // The denial fires before the lookup either way.
    expect(existing).toBe(missing);
  });
});

describe("quarantine vault", () => {
  test("raw source material is only readable under a quarantine grant", () => {
    const authorizer = new QuarantineAccessAuthorizer(allowAllQuarantine);
    const vault = new QuarantineVault(authorizer);
    const sealed = vault.deposit({
      case_ref: "case-1",
      kind: "sdk_error",
      text: "raw secret-bearing failure detail",
      deposited_by: "security-analyst",
      reason: "investigation case-1",
    });
    expect(sealed.text).toBe("raw secret-bearing failure detail");
    expect(vault.read("case-1", authorizer.authorize("security-analyst")).text).toBe(
      "raw secret-bearing failure detail",
    );
  });

  test("duplicate case deposits are refused", () => {
    const vault = new QuarantineVault(new QuarantineAccessAuthorizer(allowAllQuarantine));
    const deposit = {
      case_ref: "case-1",
      kind: "prompt" as const,
      text: "material",
      deposited_by: "security-analyst",
      reason: "investigation",
    };
    vault.deposit(deposit);
    expect(() => vault.deposit(deposit)).toThrow(QuarantineConflictError);
    expect(() => vault.deposit({ ...deposit, case_ref: "" })).toThrow(QuarantineConflictError);
  });

  test("an unauthorized read cannot probe which cases exist", () => {
    const vault = new QuarantineVault(new QuarantineAccessAuthorizer(allowAllQuarantine));
    vault.deposit({
      case_ref: "case-1",
      kind: "prompt",
      text: "material",
      deposited_by: "security-analyst",
      reason: "investigation",
    });
    let existing: unknown;
    let missing: unknown;
    try {
      vault.read("case-1", null);
    } catch (error) {
      existing = (error as Error).message;
    }
    try {
      vault.read("nope", null);
    } catch (error) {
      missing = (error as Error).message;
    }
    expect(existing).toBe(missing);
  });
});
