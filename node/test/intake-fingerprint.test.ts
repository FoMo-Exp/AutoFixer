import { describe, expect, test } from "vitest";

import {
  SIGNAL_FINGERPRINT_VERSION,
  errorSignature,
  normalizeErrorClass,
  normalizeMessage,
  normalizeStackLocations,
  signalFingerprint,
} from "../src/intake/fingerprint.js";

describe("message normalization", () => {
  test("replaces decimal numbers with a stable placeholder", () => {
    expect(normalizeMessage("invalid user 12345 in /api/users")).toBe("invalid user <n> in <path>");
  });

  test("replaces uuids before bare numbers", () => {
    expect(normalizeMessage("user 550e8400-e29b-41d4-a716-446655440000 not found")).toBe(
      "user <uuid> not found",
    );
  });

  test("replaces long hex ids", () => {
    expect(normalizeMessage("cache key deadbeefcafe1234 invalid")).toBe("cache key <hex> invalid");
  });

  test("replaces iso timestamps before bare numbers", () => {
    expect(normalizeMessage("timeout at 2026-11-03T12:34:56.789Z after 30s")).toBe(
      "timeout at <ts> after <n>s",
    );
  });

  test("lowercases and collapses whitespace", () => {
    expect(normalizeMessage("Request   TIMEOUT for Checkout")).toBe("request timeout for checkout");
  });

  test("truncates long messages at 200 characters", () => {
    const normalized = normalizeMessage("x".repeat(500));
    expect(normalized).toHaveLength(200);
    expect(normalizeMessage("x".repeat(500))).toBe(normalizeMessage("x".repeat(500) + " tail"));
  });

  test("scrubs absolute paths and url-shaped tokens", () => {
    expect(normalizeMessage("failed reading /var/app/secrets/key.pem")).toBe(
      "failed reading <path>",
    );
    expect(normalizeMessage("POST https://example.com/v1/orders failed")).toBe(
      "post <path> failed",
    );
  });
});

describe("error class normalization", () => {
  test("prefers the provider-declared class", () => {
    expect(normalizeErrorClass({ class: "TimeoutError", message: "slow" })).toBe("TimeoutError");
  });

  test("infers the class from a FooError: message prefix", () => {
    expect(normalizeErrorClass({ message: "FooError: boom" })).toBe("FooError");
  });

  test("falls back to unknown when no class is present", () => {
    expect(normalizeErrorClass({ message: "boom" })).toBe("unknown");
  });
});

describe("stack location normalization", () => {
  test("normalizes path:line in fn", () => {
    expect(
      normalizeStackLocations(["/var/app/src/services/checkout.ts:42 in processOrder"]),
    ).toEqual(["checkout.ts:processOrder"]);
  });

  test("normalizes fn (path:line)", () => {
    expect(
      normalizeStackLocations(["processOrder (/var/app/src/services/checkout.ts:42)"]),
    ).toEqual(["checkout.ts:processOrder"]);
  });

  test("keeps the bare filename when no function is present", () => {
    expect(normalizeStackLocations(["/var/app/app.ts:12"])).toEqual(["app.ts"]);
  });

  test("keeps at most the top three locations", () => {
    expect(
      normalizeStackLocations([
        "a.ts:1 in one",
        "b.ts:2 in two",
        "c.ts:3 in three",
        "d.ts:4 in four",
      ]),
    ).toEqual(["a.ts:one", "b.ts:two", "c.ts:three"]);
  });

  test("treats missing locations as empty", () => {
    expect(normalizeStackLocations(undefined)).toEqual([]);
    expect(normalizeStackLocations([])).toEqual([]);
  });
});

describe("error signature", () => {
  const shape = {
    class: "TimeoutError",
    message: "checkout 1234 timed out after 30s",
    stack_locations: ["/srv/checkout.ts:10 in processOrder", "/srv/db.ts:22 in query"],
  };

  test("is a deterministic composite of class, message and frames", () => {
    const signature = errorSignature(shape);
    expect(signature).toBe(errorSignature(structuredClone(shape)));
    expect(signature).toContain("TimeoutError");
    expect(signature).toContain("checkout <n> timed out after <n>s");
    expect(signature).toContain("checkout.ts:processOrder");
  });

  test("changes when a stack frame changes", () => {
    const moved = { ...shape, stack_locations: ["/srv/other.ts:10 in processOrder"] };
    expect(errorSignature(moved)).not.toBe(errorSignature(shape));
  });

  test("never carries the raw message values", () => {
    expect(errorSignature(shape)).not.toContain("1234");
    expect(errorSignature(shape)).not.toContain("/srv/");
  });
});

describe("signal fingerprint", () => {
  const identity = {
    enterprise_id: "ent",
    workspace_id: "ws",
    service: "checkout",
    environment: "prod",
    error_signature: "TimeoutError | checkout <n> timed out after <n>s | checkout.ts:processOrder",
  };

  test("is version-prefixed", () => {
    expect(signalFingerprint(identity).startsWith(`fp${SIGNAL_FINGERPRINT_VERSION}:`)).toBe(true);
    expect(SIGNAL_FINGERPRINT_VERSION).toBe(1);
  });

  test("is stable for equal identities regardless of key order", () => {
    const reordered = {
      error_signature: identity.error_signature,
      environment: identity.environment,
      service: identity.service,
      workspace_id: identity.workspace_id,
      enterprise_id: identity.enterprise_id,
    };
    expect(signalFingerprint(reordered)).toBe(signalFingerprint(identity));
  });

  test("changes with service, environment or signature", () => {
    expect(signalFingerprint({ ...identity, service: "billing" })).not.toBe(
      signalFingerprint(identity),
    );
    expect(signalFingerprint({ ...identity, environment: "staging" })).not.toBe(
      signalFingerprint(identity),
    );
    expect(signalFingerprint({ ...identity, error_signature: "Other" })).not.toBe(
      signalFingerprint(identity),
    );
  });

  test("scopes the fingerprint to the enterprise and workspace", () => {
    const base = {
      enterprise_id: "ent-a",
      workspace_id: "ws-a",
      service: "checkout",
      environment: "prod",
      error_signature: "sig",
    };
    expect(signalFingerprint({ ...base, workspace_id: "ws-b" })).not.toBe(signalFingerprint(base));
    expect(signalFingerprint({ ...base, enterprise_id: "ent-b" })).not.toBe(
      signalFingerprint(base),
    );
  });
});
