import { describe, expect, test } from "vitest";

import {
  BudgetAmountError,
  ceilDiv,
  formatAmount,
  normalizeCurrencyAmounts,
  parseAmount,
} from "../src/budget/index.js";

describe("budget fixed-precision amounts", () => {
  test("parses and formats canonical non-negative decimals exactly", () => {
    expect(formatAmount(parseAmount("0"))).toBe("0");
    expect(formatAmount(parseAmount("12"))).toBe("12");
    expect(formatAmount(parseAmount("0.5"))).toBe("0.5");
    expect(formatAmount(parseAmount("0.000000000001"))).toBe("0.000000000001");
    expect(parseAmount("1.5")).toBe(1_500_000_000_000n);
    expect(formatAmount(parseAmount("10.01"))).toBe("10.01");
  });

  test("refuses non-canonical spellings instead of rounding them", () => {
    for (const invalid of [
      "01",
      "-1",
      "+1",
      "1e3",
      "1.",
      ".5",
      "1.50",
      "1.0000000000001",
      " 1",
      "",
    ]) {
      expect(() => parseAmount(invalid)).toThrow(BudgetAmountError);
    }
  });

  test("normalizes lists deterministically and refuses duplicate currencies", () => {
    expect(
      normalizeCurrencyAmounts([
        { currency: "USD", amount: "2" },
        { currency: "EUR", amount: "1.5" },
      ]),
    ).toEqual([
      { currency: "EUR", amount: "1.5" },
      { currency: "USD", amount: "2" },
    ]);
    expect(() =>
      normalizeCurrencyAmounts([
        { currency: "USD", amount: "1" },
        { currency: "USD", amount: "2" },
      ]),
    ).toThrow(BudgetAmountError);
  });

  test("ceiling division never rounds a reservation down", () => {
    expect(ceilDiv(0n, 1000n)).toBe(0n);
    expect(ceilDiv(1n, 1000n)).toBe(1n);
    expect(ceilDiv(10_000n, 1000n)).toBe(10n);
    expect(ceilDiv(10_001n, 1000n)).toBe(11n);
    expect(() => ceilDiv(1n, 0n)).toThrow(BudgetAmountError);
  });
});
