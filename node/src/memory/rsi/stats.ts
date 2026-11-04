/**
 * Deterministic statistics for RSI gates (DAT-238).
 *
 * Promotion is never decided by a point estimate alone: every verdict carries
 * a Wilson interval per arm and a Newcombe hybrid-score interval for the
 * difference. Both are closed-form, so replaying the same samples always
 * produces the same gate decision.
 */

export interface Interval {
  low: number;
  high: number;
}

export interface DifferenceEstimate extends Interval {
  /** candidate rate minus baseline rate. */
  delta: number;
  candidate_rate: number;
  baseline_rate: number;
}

const Z_95 = 1.959963984540054;

/**
 * Wilson score interval for a binomial proportion. Falls back to [0, 1] when
 * the sample is empty, which a verdict must treat as inconclusive rather than
 * as a pass.
 */
export function wilsonInterval(successes: number, total: number, z = Z_95): Interval {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0) {
    return { low: 0, high: 1 };
  }
  const n = Math.floor(total);
  const k = Math.min(Math.max(0, successes), n);
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
  };
}

/**
 * Newcombe's hybrid score interval (method 10) for the difference of two
 * independent proportions. Conservative and closed-form; a promotion requires
 * the lower bound not to cross the regression ceiling.
 */
export function newcombeDifference(
  candidateSuccesses: number,
  candidateTotal: number,
  baselineSuccesses: number,
  baselineTotal: number,
): DifferenceEstimate {
  if (candidateTotal <= 0 || baselineTotal <= 0) {
    return { delta: 0, low: -1, high: 1, candidate_rate: 0, baseline_rate: 0 };
  }
  const candidate = wilsonInterval(candidateSuccesses, candidateTotal);
  const baseline = wilsonInterval(baselineSuccesses, baselineTotal);
  const candidateRate = Math.min(Math.max(0, candidateSuccesses), candidateTotal) / candidateTotal;
  const baselineRate = Math.min(Math.max(0, baselineSuccesses), baselineTotal) / baselineTotal;
  const delta = candidateRate - baselineRate;
  const low =
    delta - Math.sqrt((candidateRate - candidate.low) ** 2 + (baseline.high - baselineRate) ** 2);
  const high =
    delta + Math.sqrt((candidate.high - candidateRate) ** 2 + (baselineRate - baseline.low) ** 2);
  return {
    delta,
    low: Math.max(-1, low),
    high: Math.min(1, high),
    candidate_rate: candidateRate,
    baseline_rate: baselineRate,
  };
}

/**
 * Monday 00:00:00 UTC of the ISO week containing `date`, as `YYYY-MM-DD`.
 * Buckets the weekly change and reflection-token budgets.
 */
export function isoWeekStart(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - weekday);
  return utc.toISOString().slice(0, 10);
}
