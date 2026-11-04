/**
 * Fixed-precision monetary quantities for budget reservations (DAT-229).
 *
 * Budget accounting must never use binary floating point: a limit check that
 * rounds down can overspend and one that rounds up can strand budget. Amounts
 * are canonical decimal strings scaled to 12 fractional digits and handled as
 * `bigint` internally. Amounts are non-negative: a budget never carries a
 * negative remainder, and a refund is expressed as a smaller settlement, not
 * as a negative charge.
 */

/** Fractional digits of the internal fixed-precision representation. */
export const AMOUNT_SCALE = 12;

const AMOUNT_SCALE_FACTOR = 10n ** BigInt(AMOUNT_SCALE);

const CANONICAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.(\d{1,12}))?$/;

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** A currency amount as written in policy, requests, and journal entries. */
export interface CurrencyAmount {
  /** ISO 4217 code, upper case; no cross-currency arithmetic is implied. */
  currency: string;
  /** Canonical non-negative fixed-precision decimal string. */
  amount: string;
}

/** A malformed budget amount or currency: refused, never rounded into range. */
export class BudgetAmountError extends Error {
  readonly code = "BUDGET_AMOUNT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "BudgetAmountError";
  }
}

/** Validate one ISO 4217-style currency code. */
export function assertCurrency(currency: unknown, label: string): string {
  if (typeof currency !== "string" || !CURRENCY_CODE.test(currency)) {
    throw new BudgetAmountError(`${label} must be a three-letter upper-case currency code`);
  }
  return currency;
}

/**
 * Parse a canonical non-negative decimal string into scaled units.
 *
 * Accepted: `0`, `12`, `0.5`, `1.000001`; rejected: signs, exponents, leading
 * zeros, more than 12 fractional digits, and trailing-zero spellings (two
 * spellings of one amount would fork the idempotency fingerprint).
 */
export function parseAmount(value: unknown, label = "amount"): bigint {
  if (typeof value !== "string") {
    throw new BudgetAmountError(`${label} must be a fixed-precision decimal string`);
  }
  const match = CANONICAL_AMOUNT.exec(value);
  if (!match) {
    throw new BudgetAmountError(
      `${label} must be a canonical non-negative decimal with at most ${AMOUNT_SCALE} fractional digits`,
    );
  }
  const fraction = match[1] ?? "";
  if (fraction.endsWith("0")) {
    throw new BudgetAmountError(`${label} must not carry trailing fractional zeros`);
  }
  const [whole = "0"] = value.split(".");
  const padded = fraction.padEnd(AMOUNT_SCALE, "0");
  return BigInt(whole) * AMOUNT_SCALE_FACTOR + (padded === "" ? 0n : BigInt(padded));
}

/** Format scaled units back into the canonical decimal spelling. */
export function formatAmount(value: bigint): string {
  if (value < 0n) {
    throw new BudgetAmountError("a budget amount cannot be negative");
  }
  const whole = value / AMOUNT_SCALE_FACTOR;
  const fraction = value % AMOUNT_SCALE_FACTOR;
  if (fraction === 0n) {
    return whole.toString();
  }
  const padded = fraction.toString().padStart(AMOUNT_SCALE, "0");
  return `${whole.toString()}.${padded.replace(/0+$/, "")}`;
}

/** `a + b` in scaled units. */
export function addAmounts(a: bigint, b: bigint): bigint {
  return a + b;
}

/** `a - b` in scaled units; refuses to go negative. */
export function subtractAmounts(a: bigint, b: bigint): bigint {
  if (b > a) {
    throw new BudgetAmountError("a settlement cannot exceed the reserved budget");
  }
  return a - b;
}

/** Compare two scaled amounts. */
export function compareAmounts(a: bigint, b: bigint): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The larger of two scaled amounts. */
export function maxAmount(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Ceiling division for non-negative values; `divisor` must be positive. */
export function ceilDiv(numerator: bigint, divisor: bigint): bigint {
  if (numerator < 0n || divisor <= 0n) {
    throw new BudgetAmountError(
      "ceiling division requires a non-negative numerator and positive divisor",
    );
  }
  return (numerator + divisor - 1n) / divisor;
}

/**
 * Validate and normalize a currency-amount list: no duplicate currency, no
 * implicit conversion, deterministic ordering, canonical amounts.
 */
export function normalizeCurrencyAmounts(
  amounts: readonly CurrencyAmount[],
  label = "amounts",
): CurrencyAmount[] {
  const seen = new Set<string>();
  const normalized: CurrencyAmount[] = amounts.map((entry, index) => {
    const currency = assertCurrency(entry.currency, `${label}[${index}].currency`);
    if (seen.has(currency)) {
      throw new BudgetAmountError(`${label} lists currency ${currency} more than once`);
    }
    seen.add(currency);
    return {
      currency,
      amount: formatAmount(parseAmount(entry.amount, `${label}[${index}].amount`)),
    };
  });
  return normalized.sort((a, b) => (a.currency < b.currency ? -1 : 1));
}

/** Look up one currency in a normalized amount list. */
export function amountFor(
  amounts: readonly CurrencyAmount[],
  currency: string,
): CurrencyAmount | undefined {
  return amounts.find((entry) => entry.currency === currency);
}
