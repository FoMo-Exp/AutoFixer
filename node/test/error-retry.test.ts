import { describe, expect, test } from "vitest";

import { RetryGovernor } from "../src/errors/index.js";
import type { RetryDecision, RetryHint } from "../src/errors/index.js";

function retriesOnly(decision: RetryDecision): Extract<RetryDecision, { retry: true }> {
  if (!decision.retry) {
    throw new Error(`expected a retry decision, got ${decision.reason}`);
  }
  return decision;
}

describe("service-side retry authority (DAT-226)", () => {
  test("a model hint cannot make a denial retryable or widen a grant", () => {
    const governor = new RetryGovernor();
    const hint: RetryHint = { retryable: true, delayMs: 0, widenGrant: true };
    const withHint = governor.decide({
      caseId: "inv-1",
      code: "TOOL_SCOPE_DENIED",
      hint,
    });
    const withoutHint = new RetryGovernor().decide({ caseId: "inv-1", code: "TOOL_SCOPE_DENIED" });
    expect(withHint).toEqual(withoutHint);
    expect(withHint).toMatchObject({ retry: false, reason: "denied", hint_ignored: true });
  });

  test("a model hint cannot turn a stop condition into a retry", () => {
    const decision = new RetryGovernor().decide({
      caseId: "run-1",
      code: "HARNESS_STOP_CONDITION",
      hint: { retryable: true, delayMs: 10 },
    });
    expect(decision).toMatchObject({ retry: false, reason: "stop_condition" });
  });

  test("unknown outcomes are never retried, only reconciled", () => {
    for (const code of ["MODEL_USAGE_UNKNOWN", "DELIVERY_OUTCOME_UNKNOWN"] as const) {
      const decision = new RetryGovernor().decide({
        caseId: `case-${code}`,
        code,
        hint: { retryable: true },
      });
      expect(decision).toMatchObject({
        retry: false,
        reason: "unknown_requires_reconciliation",
      });
    }
  });

  test("recoverable transport errors retry while stop conditions do not", () => {
    const governor = new RetryGovernor();
    const transport = retriesOnly(governor.decide({ caseId: "t-1", code: "TRANSPORT_ERROR" }));
    expect(transport.attempt).toBe(1);
    const stop = governor.decide({ caseId: "t-2", code: "HARNESS_STOP_CONDITION" });
    expect(stop).toMatchObject({ retry: false, reason: "stop_condition" });
    // The distinction is outcome-driven, not caller-driven: the transport
    // error consumed an attempt, the stop condition consumed nothing.
    expect(governor.attemptsFor("t-1")).toBe(1);
    expect(governor.attemptsFor("t-2")).toBe(0);
  });

  test("a guarded retry needs the verified no-uncertain-mutation fact", () => {
    const governor = new RetryGovernor();
    expect(
      governor.decide({ caseId: "s-1", code: "SANDBOX_UNAVAILABLE", hint: { retryable: true } }),
    ).toMatchObject({ retry: false, reason: "guard_unsatisfied" });
    expect(
      governor.decide({ caseId: "s-2", code: "SANDBOX_UNAVAILABLE", uncertainMutation: true }),
    ).toMatchObject({ retry: false, reason: "guard_unsatisfied" });
    const allowed = retriesOnly(
      governor.decide({ caseId: "s-3", code: "SANDBOX_UNAVAILABLE", uncertainMutation: false }),
    );
    expect(allowed.attempt).toBe(1);
    // A guarded retry is still bounded like any other retry.
    const single = new RetryGovernor({ maxAttempts: 1 });
    retriesOnly(
      single.decide({ caseId: "s-4", code: "SANDBOX_UNAVAILABLE", uncertainMutation: false }),
    );
    expect(
      single.decide({ caseId: "s-4", code: "SANDBOX_UNAVAILABLE", uncertainMutation: false }),
    ).toMatchObject({ retry: false, reason: "exhausted" });
  });

  test("a service retry veto cannot be overturned", () => {
    expect(
      new RetryGovernor().decide({
        caseId: "v-1",
        code: "MODEL_DISPATCH_FAILED",
        serviceRetryAllowed: false,
        hint: { retryable: true },
      }),
    ).toMatchObject({ retry: false, reason: "not_authorized" });
  });

  test("unknown codes are refused instead of guessed", () => {
    expect(new RetryGovernor().decide({ caseId: "u-1", code: "NOT_A_CODE" })).toMatchObject({
      retry: false,
      reason: "unknown_code",
    });
  });
});

describe("attempt and time limits (DAT-226)", () => {
  test("the attempt limit is enforced per case", () => {
    const governor = new RetryGovernor({ maxAttempts: 3 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(
        retriesOnly(governor.decide({ caseId: "inv-9", code: "TRANSPORT_ERROR" })).attempt,
      ).toBe(attempt);
    }
    expect(governor.decide({ caseId: "inv-9", code: "TRANSPORT_ERROR" })).toMatchObject({
      retry: false,
      reason: "exhausted",
    });
  });

  test("retry-after is honored and never compressed by the caller", () => {
    const governor = new RetryGovernor({ clock: () => 1_000 });
    const decision = retriesOnly(
      governor.decide({ caseId: "inv-r", code: "MODEL_RATE_LIMITED", notBeforeMs: 4_000 }),
    );
    expect(decision.authorized_at_ms).toBe(4_000);
  });

  test("a timeout closes the retry window", () => {
    const governor = new RetryGovernor({ clock: () => 5_000 });
    expect(
      governor.decide({
        caseId: "inv-t",
        code: "TRANSPORT_ERROR",
        deadlineMs: 5_000,
      }),
    ).toMatchObject({ retry: false, reason: "deadline" });
  });

  test("a retry-after that falls past the deadline is refused as a timeout", () => {
    const governor = new RetryGovernor({ clock: () => 1_000 });
    expect(
      governor.decide({
        caseId: "inv-t2",
        code: "MODEL_RATE_LIMITED",
        notBeforeMs: 9_000,
        deadlineMs: 8_000,
      }),
    ).toMatchObject({ retry: false, reason: "deadline" });
  });

  test("releasing a case resets its accounting", () => {
    const governor = new RetryGovernor({ maxAttempts: 1 });
    retriesOnly(governor.decide({ caseId: "inv-x", code: "TRANSPORT_ERROR" }));
    governor.release("inv-x");
    expect(governor.attemptsFor("inv-x")).toBe(0);
    expect(governor.decide({ caseId: "inv-x", code: "TRANSPORT_ERROR" }).retry).toBe(true);
  });
});

describe("concurrent decisions (DAT-226)", () => {
  test("interleaved callers never exceed the attempt budget", async () => {
    const governor = new RetryGovernor({ maxAttempts: 3 });
    const decisions = await Promise.all(
      Array.from({ length: 12 }, async (_unused, index) => {
        // Interleave the callers through the microtask queue so a lost
        // increment would show up as more than three authorized retries.
        await Promise.resolve();
        await Promise.resolve();
        return { index, decision: governor.decide({ caseId: "inv-c", code: "TRANSPORT_ERROR" }) };
      }),
    );
    const authorized = decisions.filter((entry) => entry.decision.retry);
    const refused = decisions.filter((entry) => !entry.decision.retry);
    expect(authorized).toHaveLength(3);
    expect(refused).toHaveLength(9);
    expect(authorized.map((entry) => entry.decision.attempt).sort()).toEqual([1, 2, 3]);
    for (const entry of refused) {
      expect(entry.decision).toMatchObject({ reason: "exhausted" });
    }
    expect(governor.attemptsFor("inv-c")).toBe(3);
  });

  test("concurrent cases do not share an attempt budget", async () => {
    const governor = new RetryGovernor({ maxAttempts: 2 });
    const decisions = await Promise.all(
      Array.from({ length: 10 }, async (_unused, index) => {
        await Promise.resolve();
        return governor.decide({ caseId: `inv-${index % 5}`, code: "MODEL_DISPATCH_FAILED" });
      }),
    );
    expect(decisions.filter((decision) => decision.retry)).toHaveLength(10);
    for (let caseIndex = 0; caseIndex < 5; caseIndex += 1) {
      expect(governor.attemptsFor(`inv-${caseIndex}`)).toBe(2);
    }
  });
});
