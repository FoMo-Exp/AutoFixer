/**
 * Fixed-precision money invariants (DAT-228): no float ever touches an
 * amount, rounding is one documented rule, and sub-token-scale prices can
 * never round a real charge into a fake zero.
 */
import { describe, expect, test } from "vitest";

import {
  CostValidationError,
  assertCanonicalAmount,
  computeChargeScaled,
  convertScaled,
  formatAmount,
  invertRateScaled,
  parseAmount,
  parseRateValue,
  roundHalfUpDiv,
} from "../src/cost/index.js";

describe("fixed-precision amounts", () => {
  test("parse and format round-trip at exactly the fixed scale", () => {
    expect(formatAmount(parseAmount("1.5"))).toBe("1.500000000000");
    expect(formatAmount(parseAmount("0"))).toBe("0.000000000000");
    expect(formatAmount(parseAmount("-2.25"))).toBe("-2.250000000000");
    expect(formatAmount(parseAmount("123456789.123456789012"))).toBe("123456789.123456789012");
    // Canonical input round-trips to itself.
    expect(formatAmount(parseAmount("1.500000000000"))).toBe("1.500000000000");
  });

  test("amounts beyond the fixed scale, malformed, or non-plain are refused", () => {
    expect(() => parseAmount("1.0000000000001")).toThrow(CostValidationError);
    expect(() => parseAmount("0x10")).toThrow(CostValidationError);
    expect(() => parseAmount("1e3")).toThrow(CostValidationError);
    expect(() => parseAmount(".5")).toThrow(CostValidationError);
    expect(() => parseAmount("")).toThrow(CostValidationError);
    expect(() => parseAmount("NaN")).toThrow(CostValidationError);
    expect(() => parseAmount("Infinity")).toThrow(CostValidationError);
    expect(() => parseAmount("1,5")).toThrow(CostValidationError);
  });

  test("stored amounts must be canonical: exactly the fixed scale", () => {
    expect(assertCanonicalAmount("1.500000000000", "amount")).toBe(1500000000000n);
    expect(() => assertCanonicalAmount("1.5", "amount")).toThrow(CostValidationError);
    expect(() => assertCanonicalAmount("1.5000000000000", "amount")).toThrow(CostValidationError);
    expect(() => assertCanonicalAmount("-0.000000000000", "amount")).not.toThrow();
  });

  test("division rounds halves away from zero — the one rounding rule", () => {
    expect(roundHalfUpDiv(5n, 2n)).toBe(3n);
    expect(roundHalfUpDiv(7n, 2n)).toBe(4n);
    expect(roundHalfUpDiv(3n, 2n)).toBe(2n);
    expect(roundHalfUpDiv(-5n, 2n)).toBe(-3n);
    expect(roundHalfUpDiv(4n, 2n)).toBe(2n);
    expect(roundHalfUpDiv(0n, 3n)).toBe(0n);
    expect(() => roundHalfUpDiv(1n, 0n)).toThrow(CostValidationError);
    expect(() => roundHalfUpDiv(1n, -2n)).toThrow(CostValidationError);
  });

  test("cost = units × rate / divisor in scaled integers", () => {
    // 1000 tokens at 0.003 per 1000 tokens.
    expect(formatAmount(computeChargeScaled(1000, parseAmount("0.003"), 1000))).toBe(
      "0.003000000000",
    );
    // 500 tokens at 0.006 per 1000 tokens.
    expect(formatAmount(computeChargeScaled(500, parseAmount("0.006"), 1000))).toBe(
      "0.003000000000",
    );
    // 3 tokens at 1.5 per token (divisor 1).
    expect(formatAmount(computeChargeScaled(3, parseAmount("1.5"), 1))).toBe("4.500000000000");
    // Known zero usage is a real zero, computed — never a missing figure.
    expect(formatAmount(computeChargeScaled(0, parseAmount("0.003"), 1000))).toBe("0.000000000000");
  });

  test("a per-token micro-rate can never round a real charge into a fake zero", () => {
    // One token at 0.000000000001 per token: the smallest real charge.
    expect(formatAmount(computeChargeScaled(1, parseAmount("0.000000000001"), 1))).toBe(
      "0.000000000001",
    );
  });

  test("rates must be strictly positive; zero and negative rates are refused", () => {
    expect(formatAmount(parseRateValue("0.003"))).toBe("0.003000000000");
    expect(() => parseRateValue("0")).toThrow(CostValidationError);
    expect(() => parseRateValue("0.0")).toThrow(CostValidationError);
    expect(() => parseRateValue("0.000000000000")).toThrow(CostValidationError);
    expect(() => parseRateValue("-1")).toThrow(CostValidationError);
  });

  test("FX conversion and inversion stay fixed-precision", () => {
    // 10.00 EUR at 1.2345 = 12.345 exactly.
    expect(formatAmount(convertScaled(parseAmount("10"), parseAmount("1.2345")))).toBe(
      "12.345000000000",
    );
    // Half-up at the scale: 1 scaled unit at rate 1.5 rounds up to two units.
    expect(formatAmount(convertScaled(1n, 1500000000000n))).toBe("0.000000000002");
    expect(formatAmount(invertRateScaled(parseAmount("2")))).toBe("0.500000000000");
    expect(() => invertRateScaled(0n)).toThrow(CostValidationError);
  });
});
