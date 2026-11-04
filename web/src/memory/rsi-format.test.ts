import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RsiProposal } from "../api/client";
import {
  evidenceRisk,
  formatInterval,
  formatRate,
  formatSignedPercent,
  RISK_LADDER,
  rsiRiskLabel,
  rsiStatusLabel,
  rsiStatusTone,
  rsiTargetLabel,
  stageLabel,
  verdictLabel,
  verdictTone,
} from "./rsi-format";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/rsi-api-v1",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

describe("RSI rendering vocabulary", () => {
  it("labels every known status, risk, target, and verdict", () => {
    expect(rsiStatusLabel("awaiting_approval")).toBe("Awaiting approval");
    expect(rsiStatusTone("blocked")).toBe("danger");
    expect(rsiStatusTone("rolled_back")).toBe("muted");
    expect(rsiRiskLabel("C")).toBe("Class C · retrieval bounds");
    expect(RISK_LADDER.D.requirement).toBe("Rejected by RSI");
    expect(rsiTargetLabel("retrieval_bounds")).toBe("Retrieval bounds");
    expect(verdictLabel("inconclusive")).toBe("Inconclusive");
    expect(verdictTone("fail")).toBe("danger");
    expect(stageLabel(100)).toBe("100% · full");
  });

  it("renders unknown enum values explicitly instead of guessing", () => {
    expect(rsiStatusLabel("novel_status")).toBe("Unknown proposal status (novel_status)");
    expect(rsiStatusTone("novel_status")).toBe("unknown");
    expect(rsiRiskLabel("E")).toBe("Unknown risk class (E)");
    expect(rsiTargetLabel("novel_target")).toBe("Unknown target (novel_target)");
    expect(verdictLabel("self_grade")).toBe("Unknown verdict (self_grade)");
  });

  it("formats rates, signed deltas, and confidence intervals in percentage points", () => {
    expect(formatRate(17, 20)).toBe("85.0%");
    expect(formatRate(0, 0)).toBe("—");
    expect(formatSignedPercent(0.05)).toBe("+5.00 pp");
    expect(formatSignedPercent(-0.15)).toBe("-15.00 pp");
    expect(formatInterval(-0.0621, 0.1621)).toBe("[-6.21, 16.21] pp");
  });

  it("extracts security events and regressions from server verdicts", () => {
    const failed = fixture<RsiProposal>("proposal-failed.json");
    const risk = evidenceRisk(failed);
    expect(risk.safetyEvents).toBe(2);
    expect(risk.regressions).toHaveLength(2);
    expect(risk.failed).toHaveLength(2);
  });

  it("does not derive pass from a clean-looking diff", () => {
    const failed = fixture<RsiProposal>("proposal-failed.json");
    // The gate is the server's; the diff has no verdict at all.
    expect(failed.gate.offline_evaluation).toBe("fail");
    expect(failed.status).toBe("proposed");
    expect(evidenceRisk(failed).safetyEvents).toBeGreaterThan(0);
  });
});
