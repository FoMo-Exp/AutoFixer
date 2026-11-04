/**
 * Fixed-precision monetary arithmetic (DAT-228).
 *
 * Every monetary amount in the cost domain is a scaled integer (BigInt) with
 * exactly `MONEY_SCALE` fractional digits, serialized as a canonical decimal
 * string. No floating point ever touches an amount: cost = chargeable units ×
 * bound rate / divisor and FX conversions are integer arithmetic with a
 * documented half-up rounding at the scale.
 *
 * The scale is deliberately fine (12 fractional digits) so per-token rates
 * cannot round a small invocation into a fake zero cost.
 */
import { CostValidationError } from "./errors.js";

export const MONEY_SCALE = 12;

const SCALE_FACTOR = 10n ** BigInt(MONEY_SCALE);

/** Accepted input amount: optional sign, digits, optional fraction. */
const AMOUNT_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;

/** Canonical stored amount: exactly MONEY_SCALE fractional digits. */
const CANONICAL_AMOUNT_PATTERN = /^-?(0|[1-9]\d*)\.\d{12}$/;

/**
 * Parse a decimal string into its scaled-integer form. Accepts up to
 * MONEY_SCALE fractional digits; callers store `formatAmount` output so the
 * serialized form is always canonical.
 */
export function parseAmount(value: string): bigint {
  const match = AMOUNT_PATTERN.exec(value);
  if (!match) {
    throw new CostValidationError(
      `monetary amount ${JSON.stringify(value)} is not a plain decimal string`,
    );
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  if (fraction.length > MONEY_SCALE) {
    throw new CostValidationError(
      `monetary amount ${JSON.stringify(value)} exceeds the fixed scale of ${MONEY_SCALE} fractional digits`,
    );
  }
  const digits = `${whole}${fraction.padEnd(MONEY_SCALE, "0")}`;
  return sign * BigInt(digits);
}

/** Canonical serialization: exactly MONEY_SCALE fractional digits. */
export function formatAmount(scaled: bigint): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / SCALE_FACTOR;
  const fraction = (absolute % SCALE_FACTOR).toString().padStart(MONEY_SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Validate a stored amount string. Records carry canonical amounts only, so a
 * round trip through `parseAmount`/`formatAmount` must be identity.
 */
export function assertCanonicalAmount(value: string, what: string): bigint {
  if (!CANONICAL_AMOUNT_PATTERN.test(value)) {
    throw new CostValidationError(
      `${what} must be a fixed-precision decimal with exactly ${MONEY_SCALE} fractional digits, got ${JSON.stringify(value)}`,
    );
  }
  return parseAmount(value);
}

/**
 * Parse a rate value. Rates are strictly positive: a model without a rate
 * keeps an unknown cost component. A zero rate is never a default — it would
 * invent a free bill for a model nobody priced.
 */
export function parseRateValue(value: string): bigint {
  const scaled = parseAmount(value);
  if (scaled <= 0n) {
    throw new CostValidationError(
      `rate ${JSON.stringify(value)} must be strictly positive; an unpriced model stays unknown instead of a zero rate`,
    );
  }
  return scaled;
}

/**
 * Integer division rounding halves away from zero — the one rounding rule of
 * the cost domain. Deterministic across platforms; no float ever rounds.
 */
export function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new CostValidationError("division denominator must be a positive integer");
  }
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * cost = chargeable units × rate / divisor, computed in scaled integers and
 * rounded half-up at MONEY_SCALE.
 */
export function computeChargeScaled(
  chargeableUnits: number,
  rateScaled: bigint,
  divisor: number,
): bigint {
  return roundHalfUpDiv(BigInt(chargeableUnits) * rateScaled, BigInt(divisor));
}

/** Convert an amount at an FX rate: amount × rate, rounded half-up at scale. */
export function convertScaled(amountScaled: bigint, rateScaled: bigint): bigint {
  return roundHalfUpDiv(amountScaled * rateScaled, SCALE_FACTOR);
}

/** Invert an FX rate (quote → base) with half-up rounding at scale. */
export function invertRateScaled(rateScaled: bigint): bigint {
  if (rateScaled <= 0n) {
    throw new CostValidationError("FX rate must be strictly positive");
  }
  return roundHalfUpDiv(SCALE_FACTOR * SCALE_FACTOR, rateScaled);
}

export const ZERO_AMOUNT = formatAmount(0n);
