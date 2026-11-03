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
    // The dispatch budget is consumed at dispatch time; `decide` only
    // adjudicates what happens after the failure.
    expect(governor.reserveAttempt("t-1")).toBe(1);
    const transport = retriesOnly(governor.decide({ caseId: "t-1", code: "TRANSPORT_ERROR" }));
    expect(transport.attempt).toBe(1);
    const stop = governor.decide({ caseId: "t-2", code: "HARNESS_STOP_CONDITION" });
    expect(stop).toMatchObject({ retry: false, reason: "stop_condition" });
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
    governor.reserveAttempt("s-3");
    const allowed = retriesOnly(
      governor.decide({ caseId: "s-3", code: "SANDBOX_UNAVAILABLE", uncertainMutation: false }),
    );
    expect(allowed.attempt).toBe(1);
    // A guarded retry is still bounded like any other retry: with the only
    // dispatch attempt spent, no retry is left to authorize.
    const single = new RetryGovernor({ maxAttempts: 1 });
    expect(single.reserveAttempt("s-4")).toBe(1);
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

describe("attempt budget at the dispatch boundary (DAT-226)", () => {
  test("the budget caps total dispatches, including the first", () => {
    const governor = new RetryGovernor({ maxAttempts: 2 });
    // First dispatch: allowed, and its failure may be retried.
    expect(governor.reserveAttempt("inv-1")).toBe(1);
    expect(retriesOnly(governor.decide({ caseId: "inv-1", code: "TRANSPORT_ERROR" })).retry).toBe(
      true,
    );
    // Second (retry) dispatch: allowed — that is the last one.
    expect(governor.reserveAttempt("inv-1")).toBe(2);
    expect(governor.decide({ caseId: "inv-1", code: "TRANSPORT_ERROR" })).toMatchObject({
      retry: false,
      reason: "exhausted",
    });
    // A third dispatch does not exist in this case's budget.
    expect(governor.reserveAttempt("inv-1")).toBeNull();
  });

  test("dispatch totals match the agreed limit for every limit", () => {
    for (const maxAttempts of [1, 2, 3, 5]) {
      const governor = new RetryGovernor({ maxAttempts });
      let dispatched = 0;
      for (;;) {
        const attempt = governor.reserveAttempt(`inv-${maxAttempts}`);
        if (attempt === null) {
          break;
        }
        dispatched += 1;
        expect(attempt).toBe(dispatched);
        // After the last allowed dispatch the decision must refuse, so an
        // envelope built from it never claims a retry the gate would block.
        const decision = governor.decide({
          caseId: `inv-${maxAttempts}`,
          code: "TRANSPORT_ERROR",
        });
        if (dispatched === maxAttempts) {
          expect(decision).toMatchObject({ retry: false, reason: "exhausted" });
        } else {
          expect(decision).toMatchObject({ retry: true, attempt: dispatched });
        }
      }
      expect(dispatched).toBe(maxAttempts);
    }
  });

  test("retry-after is honored and never compressed by the caller", () => {
    const governor = new RetryGovernor({ clock: () => 1_000 });
    governor.reserveAttempt("inv-r");
    const decision = retriesOnly(
      governor.decide({ caseId: "inv-r", code: "MODEL_RATE_LIMITED", notBeforeMs: 4_000 }),
    );
    expect(decision.authorized_at_ms).toBe(4_000);
  });

  test("a timeout closes the retry window", () => {
    const governor = new RetryGovernor({ clock: () => 5_000 });
    governor.reserveAttempt("inv-t");
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
    governor.reserveAttempt("inv-t2");
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
    expect(governor.reserveAttempt("inv-x")).toBe(1);
    governor.release("inv-x");
    expect(governor.attemptsFor("inv-x")).toBe(0);
    expect(governor.reserveAttempt("inv-x")).toBe(1);
  });
});

describe("concurrent reservations (DAT-226)", () => {
  test("interleaved callers never exceed the dispatch budget", async () => {
    const governor = new RetryGovernor({ maxAttempts: 3 });
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_unused, index) => {
        // Interleave the callers through the microtask queue so a lost
        // reservation would show up as more than three dispatches.
        await Promise.resolve();
        await Promise.resolve();
        return { index, attempt: governor.reserveAttempt("inv-c") };
      }),
    );
    const dispatched = results.filter((entry) => entry.attempt !== null);
    const refused = results.filter((entry) => entry.attempt === null);
    expect(dispatched).toHaveLength(3);
    expect(refused).toHaveLength(9);
    expect(dispatched.map((entry) => entry.attempt).sort()).toEqual([1, 2, 3]);
    expect(governor.attemptsFor("inv-c")).toBe(3);
  });

  test("concurrent cases do not share a dispatch budget", async () => {
    const governor = new RetryGovernor({ maxAttempts: 2 });
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_unused, index) => {
        await Promise.resolve();
        return governor.reserveAttempt(`inv-${index % 5}`);
      }),
    );
    expect(results.every((attempt) => attempt !== null)).toBe(true);
    for (let caseIndex = 0; caseIndex < 5; caseIndex += 1) {
      expect(governor.attemptsFor(`inv-${caseIndex}`)).toBe(2);
    }
  });
});
