/**
 * Trusted regression evidence for rule corrections (DAT-211, ADR-0005 §4).
 *
 * "Regression evidence that true-secret detection remains effective" must be
 * evidence the *service* produces, not a claim a proposer files: a forged
 * `result: "pass"` list would otherwise let a correction that misses real
 * secrets through the activation gate.
 *
 * This module owns the trusted side of that:
 * - a built-in, code-controlled true-secret corpus (never client input);
 * - digests committing a correction to its exact rule content and to the
 *   exact corpus it was tested against;
 * - {@link runRegressionEvidence}, which scans the samples through the
 *   corrected scanner and computes pass/fail itself.
 */

import { createHash } from "node:crypto";

import type { GatewayScope } from "../gateway/types.js";
import type { SecretScanner } from "../gateway/scan.js";
import { SecurityError } from "./types.js";
import type { DetectorConstraints } from "./rules.js";

/** Machine-checked proof that true-secret detection still works. */
export interface RegressionEvidence {
  /** Reference to the regression sample/corpus entry (never secret material). */
  testRef: string;
  /** What true-secret class this sample proves still detected. */
  description: string;
  /** The detector that must still fire on the sample. */
  detectorId: string;
  result: "pass" | "fail";
  at: string;
}

/** One trusted true-secret sample the regression evidence is computed from. */
export interface TrueSecretSample {
  testRef: string;
  description: string;
  detectorId: string;
  /** Exact true-secret material that must still be detected. Never retained. */
  material: string;
}

/** Commit a correction to its exact rule content. */
export function ruleDigest(input: {
  detectorId: string;
  scope: GatewayScope;
  constraints: DetectorConstraints;
}): string {
  const canonical = JSON.stringify({
    detectorId: input.detectorId,
    enterpriseId: input.scope.enterpriseId,
    workspaceId: input.scope.workspaceId,
    constraints: {
      minShannonEntropy: input.constraints.minShannonEntropy ?? null,
      minLength: input.constraints.minLength ?? null,
      requiredPrefix: input.constraints.requiredPrefix ?? null,
      requiredSuffix: input.constraints.requiredSuffix ?? null,
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Commit a piece of evidence to the exact sample corpus it was computed on. */
export function corpusDigest(samples: readonly TrueSecretSample[]): string {
  const lines = samples
    .map((sample) => `${sample.detectorId}\u0000${sample.testRef}\u0000${sample.material}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * The built-in trusted corpus: one synthetic true-secret sample per detector
 * of the default set. Synthetic material only — assembled at runtime so the
 * source carries no provider-shaped literal, and none of it is a real
 * credential.
 */
export function defaultRegressionSamples(): readonly TrueSecretSample[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return [
    {
      testRef: "regression/private-key-block",
      description: "PEM private-key block still detected",
      detectorId: "private-key-block",
      material: [
        "-----BEGIN ",
        "PRIVATE KEY-----\n",
        "TESTMATERIALONLY",
        "\n-----END ",
        "PRIVATE KEY-----",
      ].join(""),
    },
    {
      testRef: "regression/aws-access-key-id",
      description: "AWS access key id still detected",
      detectorId: "aws-access-key-id",
      material: ["AKIA", "TESTTESTTESTTEST"].join(""),
    },
    {
      testRef: "regression/github-token",
      description: "GitHub token still detected",
      detectorId: "github-token",
      material: ["ghp", "_", "TESTTESTTESTTESTTESTTESTTESTTESTTEST"].join(""),
    },
    {
      testRef: "regression/slack-token",
      description: "Slack token still detected",
      detectorId: "slack-token",
      material: ["xoxb", "-", "1234567890", "-", "TESTTESTTEST"].join(""),
    },
    {
      testRef: "regression/google-api-key",
      description: "Google API key still detected",
      detectorId: "google-api-key",
      material: ["AIza", alphabet.slice(0, 35)].join(""),
    },
    {
      testRef: "regression/openai-api-key",
      description: "OpenAI-style key still detected",
      detectorId: "openai-api-key",
      material: ["sk", "-", "TESTTESTTESTTESTTESTTESTTESTTESTTESTTEST"].join(""),
    },
    {
      testRef: "regression/jwt",
      description: "JWT still detected",
      detectorId: "jwt",
      material: ["eyJTESTTESTTEST", "eyJTESTTESTTEST", "TESTTESTSIGNATURE"].join("."),
    },
    {
      testRef: "regression/bearer-token",
      description: "Bearer credential still detected",
      detectorId: "bearer-token",
      material: ["Bearer", " ", "TESTTESTTESTTESTTEST"].join(""),
    },
    {
      testRef: "regression/credential-assignment",
      description: "credential assignment still detected",
      detectorId: "credential-assignment",
      material: ["API_KEY", "=", "TESTVALUETESTVALUE"].join(""),
    },
    {
      testRef: "regression/high-entropy-token",
      description: "high-entropy token class still detected",
      detectorId: "high-entropy-token",
      material: alphabet,
    },
  ];
}

/**
 * Compute regression evidence for one correction against the trusted corpus.
 * The scanner must answer synchronously (the local pattern scanner does); an
 * asynchronous backend cannot produce evidence and the activation gate then
 * fails closed.
 */
export function runRegressionEvidence(
  scanner: SecretScanner,
  samples: readonly TrueSecretSample[],
  at: string,
  scope: GatewayScope,
): RegressionEvidence[] {
  const evidence: RegressionEvidence[] = [];
  for (const sample of samples) {
    const report = scanner.scan({
      segments: [
        {
          id: `regression-${sample.testRef}`,
          path: ["regression"],
          text: sample.material,
          dataClasses: [],
        },
      ],
      scope,
    });
    if (report instanceof Promise) {
      throw new SecurityError(
        "RULE_EVIDENCE_UNAVAILABLE",
        "the regression scanner must answer synchronously",
      );
    }
    const detected = report.findings.some((finding) => finding.detector === sample.detectorId);
    evidence.push({
      testRef: sample.testRef,
      description: sample.description,
      detectorId: sample.detectorId,
      result: detected ? "pass" : "fail",
      at,
    });
  }
  return evidence;
}
