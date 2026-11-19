/**
 * DAT-271: run the isolated RSI offline drill.
 *
 * The report is synthetic-only. It writes JSON to stdout and exits non-zero if
 * any governance check fails, so an operator or CI job can archive it as
 * evidence without parsing prose.
 *
 *   npm run drill:rsi                 # two fresh runs, compare the digest
 *   npm run drill:rsi -- --repeat 3   # more repetitions
 */

import { runRsiDrill } from "../src/drill/rsi-drill.js";

function repeatCount(argv: readonly string[]): number {
  const flag = argv.indexOf("--repeat");
  if (flag === -1) {
    return 2;
  }
  const raw = argv[flag + 1];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--repeat requires a positive integer");
  }
  return parsed;
}

const report = runRsiDrill({ repeats: repeatCount(process.argv.slice(2)) });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.summary.ok) {
  process.stderr.write(
    `rsi drill failed: ${report.summary.failed} of ${report.summary.total} checks failed\n`,
  );
  process.exitCode = 1;
}
