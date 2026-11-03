/**
 * Built-in deterministic secret detector for the model gateway's scan gate
 * (DAT-209). A deployment may wire any {@link SecretScanner} backend; this
 * one is the versioned, self-contained default with no network dependency.
 *
 * Detector versions are recorded on every finding and in the audit evidence.
 * Rule corrections (DAT-211) version and bound these detectors; a whole
 * detector disable or blanket allow is not a false-positive correction.
 */

import type { SecretFinding, SecretScanner, SecretScanReport, SecretScanRequest } from "./scan.js";
import { joinClassification, shannonEntropy } from "./scan.js";
import type { SecretClassification } from "./types.js";

export interface SecretDetector {
  id: string;
  version: string;
  classification: "secret_suspected" | "secret_confirmed";
  /** Global pattern; the full match (or `matchGroup`) is the exact material. */
  pattern: RegExp;
  /** Capture group holding the exact secret material for deterministic removal. */
  matchGroup?: number;
  /** Skip on binary leaves (image data), where entropy heuristics misfire. */
  skipBinary?: boolean;
  /** Shannon entropy (bits/char) the matched material must reach to count. */
  minShannonEntropy?: number;
}

/** Rule version of the built-in detector set. */
export const PATTERN_SCANNER_RULE_VERSION = "2026-11-03.1";

/**
 * Default detector set. Strong provider/credential shapes classify as
 * confirmed; ambiguous high-entropy material classifies as suspected, which
 * still blocks unless separately authorized minimization confirms removal.
 */
export function defaultSecretDetectors(): SecretDetector[] {
  return [
    {
      id: "private-key-block",
      version: "1",
      classification: "secret_confirmed",
      pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    },
    {
      id: "aws-access-key-id",
      version: "1",
      classification: "secret_confirmed",
      pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    },
    {
      id: "github-token",
      version: "1",
      classification: "secret_confirmed",
      pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    },
    {
      id: "slack-token",
      version: "1",
      classification: "secret_confirmed",
      pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    },
    {
      id: "google-api-key",
      version: "1",
      classification: "secret_confirmed",
      pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    },
    {
      id: "openai-api-key",
      version: "1",
      classification: "secret_confirmed",
      pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    },
    {
      id: "jwt",
      version: "1",
      classification: "secret_confirmed",
      pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    },
    {
      id: "bearer-token",
      version: "1",
      classification: "secret_confirmed",
      pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    },
    {
      id: "credential-assignment",
      version: "1",
      classification: "secret_confirmed",
      pattern:
        /\b[A-Za-z0-9_]*(?:API_?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*\s*[=:]\s*"?(?!\[redacted\])([^\s"']{6,})"?/g,
      matchGroup: 1,
    },
    {
      id: "high-entropy-token",
      version: "1",
      classification: "secret_suspected",
      pattern: /\b[A-Za-z0-9+/=]{28,}\b/g,
      minShannonEntropy: 4.0,
      skipBinary: true,
    },
  ];
}

function globalCopy(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
}

/**
 * Deterministic pattern scanner. Synchronous and local: it either answers or
 * the gateway treats it as unavailable — never as clean.
 */
export function createPatternSecretScanner(options?: {
  detectors?: SecretDetector[];
}): SecretScanner {
  const detectors = options?.detectors ?? defaultSecretDetectors();
  return {
    id: "pattern-secret-scanner",
    ruleVersion: PATTERN_SCANNER_RULE_VERSION,
    scan(request: SecretScanRequest): SecretScanReport {
      const findings: SecretFinding[] = [];
      for (const segment of request.segments) {
        for (const detector of detectors) {
          if (segment.binary && detector.skipBinary) continue;
          for (const match of segment.text.matchAll(globalCopy(detector.pattern))) {
            const material =
              detector.matchGroup !== undefined ? match[detector.matchGroup] : match[0];
            if (typeof material !== "string" || material.length === 0) continue;
            if (
              detector.minShannonEntropy !== undefined &&
              shannonEntropy(material) < detector.minShannonEntropy
            ) {
              continue;
            }
            findings.push({
              classification: detector.classification,
              detector: detector.id,
              ruleVersion: detector.version,
              segmentId: segment.id,
              match: material,
            });
          }
        }
      }
      let classification: SecretClassification = "clean";
      for (const finding of findings) {
        classification = joinClassification(classification, finding.classification);
      }
      return {
        scanner: "pattern-secret-scanner",
        ruleVersion: PATTERN_SCANNER_RULE_VERSION,
        classification,
        findings,
      };
    },
  };
}
