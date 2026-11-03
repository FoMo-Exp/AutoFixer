/**
 * Rule corrections at the scanner: activated corrections narrow their target
 * detector, only for the scope they were approved for, and nothing else
 * (DAT-211, ADR-0005 §4).
 *
 * A correction changes policy for future scans — never a run grant — and the
 * regression evidence behind it is computed against the corrected scanner, so
 * "true-secret detection remains effective" is machine-checked.
 */
import { describe, expect, test } from "vitest";

import { createPatternSecretScanner } from "../src/gateway/index.js";
import type {
  GatewayScope,
  SecretDetector,
  SecretScanReport,
  SecretScanner,
} from "../src/gateway/index.js";
import {
  SecurityError,
  constrainDetector,
  defaultRegressionSamples,
  runRegressionEvidence,
  type ActiveRuleCorrection,
  type TrueSecretSample,
} from "../src/security/index.js";

// Assembled at runtime: repository secret scanners would flag literals.
const TRUE_SECRET = "sk-" + "live-abcdef1234567890";
const FIXTURE_TOKEN = "fixture-generator-token";

const SCOPE: GatewayScope = { enterpriseId: "ent_test", workspaceId: "ws_test" };

const DETECTOR: SecretDetector = {
  id: "test-token",
  version: "1",
  classification: "secret_confirmed",
  pattern: /\b[A-Za-z0-9-]{6,}\b/g,
};

function scannerWith(corrections: ActiveRuleCorrection[]): SecretScanner {
  return createPatternSecretScanner({
    detectors: [DETECTOR],
    corrections: () => corrections,
  });
}

function correction(
  constraints: ActiveRuleCorrection["constraints"],
  scope: GatewayScope = SCOPE,
): ActiveRuleCorrection {
  return {
    lineage: "test-token|ent_test|ws_test",
    version: 1,
    detectorId: "test-token",
    scope,
    constraints,
  };
}

/** The pattern scanner is synchronous; surface its report directly. */
function scanReport(
  scanner: SecretScanner,
  text: string,
  scope: GatewayScope = SCOPE,
): SecretScanReport {
  const report = scanner.scan({
    segments: [{ id: "s1", path: ["prompt"], text, dataClasses: [] }],
    scope,
  });
  if (report instanceof Promise) throw new Error("pattern scanner must be synchronous");
  return report;
}

describe("corrected detectors narrow, never disable (DAT-211)", () => {
  test("without corrections the detector behaves exactly as stock", () => {
    const report = scanReport(scannerWith([]), FIXTURE_TOKEN);
    expect(report.findings.map((finding) => finding.match)).toEqual([FIXTURE_TOKEN]);
    expect(report.findings[0]?.ruleVersion).toBe("1");
  });

  test("minLength narrows short matches and tags findings with the correction version", () => {
    const report = scanReport(
      scannerWith([correction({ minLength: 24 })]),
      `${FIXTURE_TOKEN} ${TRUE_SECRET}`,
    );
    expect(report.findings.map((finding) => finding.match)).toEqual([TRUE_SECRET]);
    expect(report.findings[0]?.ruleVersion).toBe("1.rc1");
  });

  test("requiredPrefix/requiredSuffix narrow to a bounded marker class", () => {
    const prefixed = scanReport(
      scannerWith([correction({ requiredPrefix: "sk-" })]),
      `${FIXTURE_TOKEN} ${TRUE_SECRET}`,
    );
    expect(prefixed.findings.map((finding) => finding.match)).toEqual([TRUE_SECRET]);
    const suffixed = scanReport(
      scannerWith([correction({ requiredSuffix: "0" })]),
      `${FIXTURE_TOKEN} ${TRUE_SECRET}`,
    );
    expect(suffixed.findings.map((finding) => finding.match)).toEqual([TRUE_SECRET]);
  });

  test("constraints only ever take the stricter side of the detector's own bounds", () => {
    const detector: SecretDetector = { ...DETECTOR, minShannonEntropy: 4, requiredPrefix: "sk-" };
    const narrowed = constrainDetector(detector, {
      minShannonEntropy: 2,
      requiredPrefix: "sk-l",
    });
    expect(narrowed.minShannonEntropy).toBe(4);
    expect(narrowed.requiredPrefix).toBe("sk-l");
  });

  test("disjoint marker constraints would disable the detector and are refused", () => {
    const detector: SecretDetector = { ...DETECTOR, requiredPrefix: "sk-" };
    let thrown: unknown;
    try {
      constrainDetector(detector, { requiredPrefix: "ghp_" });
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof SecurityError)) throw thrown ?? new Error("expected a rejection");
    expect(thrown.code).toBe("RULE_BLANKET_EXEMPTION");
  });

  test("a scanner fails closed when live corrections would disable a detector", () => {
    const detector: SecretDetector = { ...DETECTOR, requiredPrefix: "sk-" };
    const scanner = createPatternSecretScanner({
      detectors: [detector],
      corrections: () => [correction({ requiredPrefix: "ghp_" })],
    });
    expect(() =>
      scanner.scan({
        segments: [{ id: "s1", path: ["prompt"], text: TRUE_SECRET, dataClasses: [] }],
        scope: SCOPE,
      }),
    ).toThrow(SecurityError);
  });

  test("the corrections supplier is consulted per scan: activation takes effect live", () => {
    const live: ActiveRuleCorrection[] = [];
    const scanner = createPatternSecretScanner({
      detectors: [DETECTOR],
      corrections: () => live,
    });
    expect(scanReport(scanner, FIXTURE_TOKEN).findings).toHaveLength(1);
    live.push(correction({ minLength: 24 }));
    expect(scanReport(scanner, FIXTURE_TOKEN).findings).toHaveLength(0);
  });
});

describe("corrections are scoped to their own enterprise/workspace (DAT-211)", () => {
  test("a correction applies only to scans resolved for the same scope", () => {
    const scanner = scannerWith([correction({ minLength: 24 })]);
    // Same enterprise+workspace: the correction narrows.
    expect(scanReport(scanner, FIXTURE_TOKEN, SCOPE).findings).toHaveLength(0);
    // A different workspace in the same enterprise: stock behavior.
    expect(
      scanReport(scanner, FIXTURE_TOKEN, { enterpriseId: "ent_test", workspaceId: "ws_other" })
        .findings,
    ).toHaveLength(1);
    // A different enterprise: stock behavior.
    expect(
      scanReport(scanner, FIXTURE_TOKEN, { enterpriseId: "ent_other", workspaceId: "ws_test" })
        .findings,
    ).toHaveLength(1);
  });

  test("a correction from another workspace never suppresses this workspace's secrets", () => {
    const scanner = scannerWith([
      correction({ minLength: 24 }, { enterpriseId: "ent_test", workspaceId: "ws_other" }),
    ]);
    expect(scanReport(scanner, FIXTURE_TOKEN, SCOPE).findings.map((f) => f.match)).toEqual([
      FIXTURE_TOKEN,
    ]);
  });

  test("an unscoped scan applies no correction at all", () => {
    const scanner = scannerWith([correction({ minLength: 24 })]);
    const report = scanner.scan({
      segments: [{ id: "s1", path: ["prompt"], text: FIXTURE_TOKEN, dataClasses: [] }],
    });
    if (report instanceof Promise) throw new Error("pattern scanner must be synchronous");
    expect(report.findings.map((finding) => finding.match)).toEqual([FIXTURE_TOKEN]);
  });
});

describe("regression evidence is computed against the corrected scanner (DAT-211)", () => {
  const secretSample: TrueSecretSample = {
    testRef: "corpus/openai-key",
    description: "provider-shaped key still detected",
    detectorId: "test-token",
    material: TRUE_SECRET,
  };
  const fixtureSample: TrueSecretSample = {
    testRef: "corpus/fixture-token",
    description: "fixture-class material",
    detectorId: "test-token",
    material: FIXTURE_TOKEN,
  };

  test("evidence passes when true-secret samples are still detected", () => {
    // The correction keeps the provider-shaped sample detectable…
    const evidence = runRegressionEvidence(
      scannerWith([correction({ requiredPrefix: "sk-" })]),
      [secretSample],
      "2026-11-03T00:00:00.000Z",
      SCOPE,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.result).toBe("pass");
  });

  test("evidence fails when the correction would suppress a true-secret sample", () => {
    // …and a correction that suppresses the sample produces failing evidence,
    // which both proposal and activation refuse (see security-rules.test.ts).
    const evidence = runRegressionEvidence(
      scannerWith([correction({ minLength: 24 })]),
      [fixtureSample],
      "2026-11-03T00:00:00.000Z",
      SCOPE,
    );
    expect(evidence[0]?.result).toBe("fail");
  });

  test("evidence is computed for the rule's own scope, not a foreign one", () => {
    // A correction approved for another workspace does not narrow this
    // workspace's scan, so the sample is detected — and the evidence is
    // computed against exactly the scope it was handed.
    const foreign = runRegressionEvidence(
      scannerWith([correction({ minLength: 24 })]),
      [fixtureSample],
      "2026-11-03T00:00:00.000Z",
      { enterpriseId: "ent_test", workspaceId: "ws_other" },
    );
    expect(foreign[0]?.result).toBe("pass");
  });
});

describe("built-in trusted corpus (DAT-211)", () => {
  test("every built-in detector's trusted sample is detected by the stock scanner", () => {
    const scanner = createPatternSecretScanner();
    for (const sample of defaultRegressionSamples()) {
      const report = scanReport(scanner, sample.material, SCOPE);
      expect(
        report.findings.some((finding) => finding.detector === sample.detectorId),
        sample.testRef,
      ).toBe(true);
    }
  });

  test("a correction that excludes the trusted sample class fails evidence", () => {
    const scanner = createPatternSecretScanner({
      corrections: () => [
        {
          lineage: "high-entropy-token|ent_test|ws_test",
          version: 1,
          detectorId: "high-entropy-token",
          scope: SCOPE,
          constraints: { minLength: 200 },
        },
      ],
    });
    const sample = defaultRegressionSamples().find(
      (entry) => entry.detectorId === "high-entropy-token",
    );
    if (!sample) throw new Error("missing high-entropy-token sample");
    const evidence = runRegressionEvidence(scanner, [sample], "2026-11-03T00:00:00.000Z", SCOPE);
    expect(evidence[0]?.result).toBe("fail");
  });
});
