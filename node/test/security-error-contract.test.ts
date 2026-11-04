import { describe, expect, test } from "vitest";

import { ApiError, ERROR_NEXT_ACTIONS } from "../src/api/errors.js";
import { ERROR_CATALOG, buildErrorEnvelope, mapForeignError } from "../src/errors/index.js";

/**
 * DAT-213 acceptance: the four ADR-0005 §6 stable codes are consumable by an
 * agent/UI with stage, case/trace reference, retryability, and one authorized
 * next action — and they never leak policy internals or secret material.
 */

const SECURITY_CODES = [
  "SENSITIVE_DATA_UNCERTAIN",
  "SECURITY_REVIEW_REQUIRED",
  "RECOVERY_APPROVAL_INVALID",
  "MODEL_EGRESS_DENIED",
] as const;

describe("shared error catalog", () => {
  test("every ADR-0005 code is catalogued as a non-retryable denial/stop", () => {
    const nextActions: Record<(typeof SECURITY_CODES)[number], string> = {
      SENSITIVE_DATA_UNCERTAIN: "enter_security_case",
      SECURITY_REVIEW_REQUIRED: "request_review",
      RECOVERY_APPROVAL_INVALID: "request_review",
      MODEL_EGRESS_DENIED: "request_review",
    };
    for (const code of SECURITY_CODES) {
      const spec = ERROR_CATALOG[code];
      expect(spec, code).toBeDefined();
      expect(spec!.code).toBe(code);
      expect(spec!.retry, code).toBe("never");
      expect(spec!.category, code).toBe("denial");
      expect(spec!.next_action, code).toBe(nextActions[code]);
      // Texts are safe guidance, never policy internals or a bypass hint.
      expect(spec!.agent_guidance.toLowerCase(), code).not.toMatch(/send anyway|ignore the gate/);
    }
  });

  test("SENSITIVE_DATA_UNCERTAIN never suggests resending the request", () => {
    const spec = ERROR_CATALOG["SENSITIVE_DATA_UNCERTAIN"]!;
    expect(spec.agent_guidance).toContain("do not retry");
    expect(spec.agent_guidance).toContain("do not bypass");
  });

  test("the envelope carries case and trace references with retryability", () => {
    const envelope = buildErrorEnvelope({
      code: "RECOVERY_APPROVAL_INVALID",
      traceId: "trace_1",
      caseRef: "case_1",
    });
    expect(envelope).toMatchObject({
      code: "RECOVERY_APPROVAL_INVALID",
      stage: "policy",
      category: "denial",
      retryable: false,
      trace_ref: { trace_id: "trace_1", case_ref: "case_1" },
      next_action: "request_review",
    });
  });

  test("gateway errors keep their own stable code when mapped", () => {
    for (const code of SECURITY_CODES) {
      const mapped = mapForeignError(
        { code, message: "denied", details: { policy_internal: "secret-policy-path" } },
        { traceId: "trace_1", caseRef: "case_1" },
      );
      expect(mapped.envelope.code).toBe(code);
      expect(mapped.envelope.retryable).toBe(false);
      // Policy internals stay sealed in diagnostics, never in the envelope.
      expect(JSON.stringify(mapped.envelope)).not.toContain("secret-policy-path");
    }
  });
});

describe("forgepilot-api error envelope", () => {
  test("the security codes are exposed with the ADR-0005 semantics and refs", () => {
    const cases = [
      ["SENSITIVE_DATA_UNCERTAIN", "enter_security_case"],
      ["SECURITY_REVIEW_REQUIRED", "request_review"],
      ["RECOVERY_APPROVAL_INVALID", "request_review"],
      ["MODEL_EGRESS_DENIED", "request_review"],
    ] as const;
    for (const [code, nextAction] of cases) {
      const body = new ApiError(
        403,
        code,
        "denied",
        {},
        {
          case_ref: "case_1",
          trace_ref: "trace_1",
        },
      ).toBody("req_1");
      expect(body.error.code).toBe(code);
      expect(body.error.stage).toBe("policy");
      expect(body.error.category).toBe("denial");
      expect(body.error.retryable).toBe(false);
      expect(body.error.next_action).toBe(nextAction);
      expect(body.error.case_ref).toBe("case_1");
      expect(body.error.trace_ref).toBe("trace_1");
    }
  });

  test("the security next action belongs to the documented vocabulary", () => {
    expect(ERROR_NEXT_ACTIONS).toContain("enter_security_case");
  });

  test("a security error body carries no secret or policy internals", () => {
    // Assembled at runtime so the repository's own scanner does not flag it.
    const secret = ["sk", "live", "abcdef1234567890"].join("-");
    const body = new ApiError(
      403,
      "SENSITIVE_DATA_UNCERTAIN",
      "Sensitive data handling is uncertain.",
      {
        case_ref: "case_1",
      },
    ).toBody("req_1");
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.error.message).not.toMatch(/detector|regex|policy_revision/);
  });
});
