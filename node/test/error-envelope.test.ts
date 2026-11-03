import { describe, expect, test } from "vitest";

import {
  ERROR_CATALOG,
  ERROR_ENVELOPE_VERSION,
  ErrorEnvelopeContractError,
  NEXT_ACTIONS,
  buildErrorEnvelope,
  localizeError,
  migrateErrorEnvelope,
  redactSensitiveText,
  renderAgentError,
  validateErrorEnvelope,
} from "../src/errors/index.js";
import type { ErrorEnvelope } from "../src/errors/index.js";

/** The seven ADR-0008 example codes every envelope test must hold. */
const EXAMPLE_CODES = [
  "MODEL_RATE_LIMITED",
  "MODEL_USAGE_UNKNOWN",
  "TOOL_SCOPE_DENIED",
  "VALIDATION_FAILED",
  "SANDBOX_UNAVAILABLE",
  "SENSITIVE_DATA_UNCERTAIN",
  "DELIVERY_OUTCOME_UNKNOWN",
] as const;

describe("shared error envelope shape (DAT-226)", () => {
  test("every envelope carries the versioned contract fields", () => {
    const envelope = buildErrorEnvelope({
      code: "MODEL_RATE_LIMITED",
      traceId: "trace-1",
      caseRef: "case-1",
      retryAfterMs: 1500,
    });
    expect(envelope.envelope_version).toBe(ERROR_ENVELOPE_VERSION);
    expect(validateErrorEnvelope(envelope)).toEqual(envelope);
    expect(envelope).toMatchObject({
      code: "MODEL_RATE_LIMITED",
      stage: "gateway",
      category: "retry",
      retryable: true,
      retry_after_ms: 1500,
      trace_ref: { trace_id: "trace-1", case_ref: "case-1" },
      next_action: "wait_and_retry",
    });
    for (const field of [
      "message",
      "message_key",
      "agent_guidance",
      "agent_guidance_key",
      "human_guidance",
      "human_guidance_key",
    ] as const) {
      expect(envelope[field].length).toBeGreaterThan(0);
    }
  });

  test("an unknown code is refused loudly instead of inventing vocabulary", () => {
    expect(() => buildErrorEnvelope({ code: "MADE_UP_CODE" })).toThrow(ErrorEnvelopeContractError);
    expect(() =>
      buildErrorEnvelope({ code: "TOOL_SCOPE_DENIED", deniedCapability: "root" as never }),
    ).toThrow(ErrorEnvelopeContractError);
  });

  test("a current-version envelope is validated strictly", () => {
    const envelope = buildErrorEnvelope({ code: "TOOL_SCOPE_DENIED" });
    const missing = { ...envelope } as unknown as Record<string, unknown>;
    delete missing["next_action"];
    expect(() => validateErrorEnvelope(missing)).toThrow(ErrorEnvelopeContractError);
    expect(() =>
      validateErrorEnvelope({ ...envelope, envelope_version: ERROR_ENVELOPE_VERSION + 1 }),
    ).toThrow(/newer than/);
    expect(() => validateErrorEnvelope({ ...envelope, category: "maybe" })).toThrow(
      ErrorEnvelopeContractError,
    );
  });

  test("migration upgrades the unversioned legacy shape and refuses newer schemas", () => {
    const upgraded = migrateErrorEnvelope({ code: "TOOL_SCOPE_DENIED" });
    expect(upgraded.envelope_version).toBe(ERROR_ENVELOPE_VERSION);
    expect(upgraded.trace_ref).toEqual({ trace_id: null, case_ref: null });
    expect(() => migrateErrorEnvelope({ envelope_version: 99, code: "TOOL_SCOPE_DENIED" })).toThrow(
      /newer than/,
    );
    // A current-version record is not defaulted: it must be complete.
    expect(() => migrateErrorEnvelope({ envelope_version: ERROR_ENVELOPE_VERSION })).toThrow(
      ErrorEnvelopeContractError,
    );
  });
});

describe("example errors carry agent action and human guidance (DAT-226)", () => {
  test("each ADR-0008 example code has both, with safe texts", () => {
    for (const code of EXAMPLE_CODES) {
      const envelope = buildErrorEnvelope({ code });
      expect(NEXT_ACTIONS).toContain(envelope.next_action);
      expect(envelope.agent_guidance.length).toBeGreaterThan(10);
      expect(envelope.human_guidance.length).toBeGreaterThan(10);
      // Safe by construction: catalog texts never name secrets, credentials,
      // policy internals, or a trace-id-only guidance.
      const texts = `${envelope.message} ${envelope.agent_guidance} ${envelope.human_guidance}`;
      expect(texts).not.toMatch(/password|credential:|secret:|token:|api[_-]?key/i);
      expect(texts).not.toContain("policy revision");
    }
  });

  test("denials never offer a grant-widening next action", () => {
    for (const code of EXAMPLE_CODES) {
      const envelope = buildErrorEnvelope({ code });
      if (envelope.category === "denial") {
        expect(["request_review", "enter_security_case", "stop_run"]).toContain(
          envelope.next_action,
        );
      }
    }
    for (const action of NEXT_ACTIONS) {
      expect(action).not.toMatch(/widen|escalate|bypass/);
    }
    const denied = buildErrorEnvelope({ code: "TOOL_SCOPE_DENIED" });
    expect(denied.next_action).toBe("request_review");
    expect(denied.retryable).toBe(false);
    expect(denied.retry_after_ms).toBeNull();
  });
});

describe("service-decided retryability (DAT-226)", () => {
  test("unknown outcomes are never retryable and point at reconciliation", () => {
    const usage = buildErrorEnvelope({ code: "MODEL_USAGE_UNKNOWN" });
    expect(usage.category).toBe("unknown");
    expect(usage.retryable).toBe(false);
    expect(usage.next_action).toBe("reconcile_usage");
    const delivery = buildErrorEnvelope({ code: "DELIVERY_OUTCOME_UNKNOWN" });
    expect(delivery.retryable).toBe(false);
    expect(delivery.next_action).toBe("reconcile_delivery");
  });

  test("a guarded retry needs the verified no-uncertain-mutation fact", () => {
    expect(buildErrorEnvelope({ code: "SANDBOX_UNAVAILABLE" }).retryable).toBe(false);
    expect(
      buildErrorEnvelope({ code: "SANDBOX_UNAVAILABLE", facts: { uncertainMutation: true } })
        .retryable,
    ).toBe(false);
    expect(
      buildErrorEnvelope({ code: "SANDBOX_UNAVAILABLE", facts: { uncertainMutation: false } })
        .retryable,
    ).toBe(true);
  });

  test("facts can only narrow retry eligibility, never widen it", () => {
    expect(
      buildErrorEnvelope({
        code: "TOOL_SCOPE_DENIED",
        facts: { serviceRetryAllowed: true, uncertainMutation: false },
      }).retryable,
    ).toBe(false);
    expect(
      buildErrorEnvelope({ code: "TRANSPORT_ERROR", facts: { serviceRetryAllowed: false } })
        .retryable,
    ).toBe(false);
  });

  test("an exhausted retryable error falls back to its non-retry action", () => {
    const exhausted = buildErrorEnvelope({
      code: "TRANSPORT_ERROR",
      facts: { serviceRetryAllowed: false },
    });
    expect(exhausted.retryable).toBe(false);
    expect(exhausted.next_action).toBe("report_error");
  });
});

describe("recoverable transport errors stay distinct from harness stop conditions (DAT-226)", () => {
  test("the two outcomes have distinct codes and categories", () => {
    const transport = buildErrorEnvelope({ code: "TRANSPORT_ERROR" });
    const stop = buildErrorEnvelope({ code: "HARNESS_STOP_CONDITION" });
    expect(transport.code).not.toBe(stop.code);
    expect(transport.category).toBe("retry");
    expect(stop.category).toBe("stop");
    expect(transport.retryable).toBe(true);
    expect(stop.retryable).toBe(false);
    expect(stop.next_action).toBe("stop_run");
    expect(stop.agent_guidance).toMatch(/not a failure to retry/);
  });
});

describe("localizable display text (DAT-226)", () => {
  test("translation swaps display text without touching machine fields", () => {
    const envelope = buildErrorEnvelope({ code: "VALIDATION_FAILED" });
    const localized = localizeError(envelope, {
      [envelope.message_key]: "校验失败。",
      [envelope.agent_guidance_key]: "停止当前运行并保留证据。",
      [envelope.human_guidance_key]: "请在时间线中处置。",
    });
    expect(localized.message).toBe("校验失败。");
    expect(localized.agent_guidance).toBe("停止当前运行并保留证据。");
    expect(localized.human_guidance).toBe("请在时间线中处置。");
    expect(localized.code).toBe(envelope.code);
    expect(localized.message_key).toBe(envelope.message_key);
    expect(localized.next_action).toBe(envelope.next_action);
    expect(localized.category).toBe(envelope.category);
    expect(localized.retryable).toBe(envelope.retryable);
  });

  test("a missing translation keeps the default text", () => {
    const envelope = buildErrorEnvelope({ code: "VALIDATION_FAILED" });
    expect(localizeError(envelope, {})).toEqual(envelope);
  });
});

describe("secret redaction (DAT-226)", () => {
  // Assembled from pieces on purpose: a runnable secret-shaped literal in
  // this file would be rejected by repository push protection.
  const openAiStyleKey = ["sk-", "abc123", "def456", "ghi789"].join("");
  const password = ["hun", "ter2"].join("");
  const awsKey = ["AKIA", "0123456789", "ABCDEF"].join("");
  const slackToken = ["xox", "b-1234567890-abcdefghij"].join("");
  const githubToken = ["ghp", "_abcdefghijklmnopqrstuvwx", "yz012345"].join("");

  test("secret-shaped material is scrubbed from any text", () => {
    const raw = [
      `Authorization: Bearer ${openAiStyleKey}`,
      `password=${password}`,
      `api_key: ${awsKey}`,
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      `slack ${slackToken}`,
      `github ${githubToken}`,
    ].join("\n");
    const redacted = redactSensitiveText(raw);
    for (const secret of [openAiStyleKey, password, awsKey, slackToken, githubToken]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("[redacted]");
  });

  test("literal secrets supplied by the caller are scrubbed too", () => {
    expect(redactSensitiveText("failed with key s3cr3t-value", ["s3cr3t-value"])).toBe(
      "failed with key [redacted]",
    );
  });
});

describe("model-facing rendering (DAT-226)", () => {
  test("the rendered text leads with the safe message and the authorized action", () => {
    const envelope: ErrorEnvelope = buildErrorEnvelope({
      code: "TOOL_SCOPE_DENIED",
      deniedCapability: "path_scope",
    });
    const text = renderAgentError(envelope, "DSH_SCOPE_DENIED");
    expect(text).toContain("[TOOL_SCOPE_DENIED]");
    expect(text).toContain("Next action: request_review.");
    expect(text).toContain(envelope.agent_guidance);
    expect(text).toContain("(origin: DSH_SCOPE_DENIED)");
    expect(ERROR_CATALOG["TOOL_SCOPE_DENIED"]?.stage).toBe("tool");
  });
});
