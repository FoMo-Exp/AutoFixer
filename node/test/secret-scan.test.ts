import type { Context, Message, Tool } from "@mariozechner/pi-ai";
import { describe, expect, test } from "vitest";

import {
  DATA_CLASSES,
  authorizeRequestDataClasses,
  collectRequestSegments,
  joinClassification,
  runRequestScanGate,
  tagDerivedSummary,
  validateGatewayPolicy,
} from "../src/index.js";
import type {
  SecretClassification,
  SecretFinding,
  SecretScanReport,
  SecretScanRequest,
  SecretScanner,
} from "../src/index.js";
import { createPatternSecretScanner } from "../src/index.js";

const TOOL: Tool = {
  name: "dsh_request_action",
  description: "request one repository action",
  parameters: { type: "object", properties: { tool_id: { type: "string" } } } as Tool["parameters"],
};

function toolResult(content: string, details?: unknown): Message {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "dsh_request_action",
    content: [{ type: "text", text: content }],
    ...(details !== undefined ? { details } : {}),
    isError: false,
    timestamp: 1,
  };
}

function report(
  classification: SecretScanReport["classification"],
  findings: SecretFinding[] = [],
): SecretScanReport {
  return { scanner: "stub", ruleVersion: "1", classification, findings };
}

function stubScanner(scan: (request: SecretScanRequest) => SecretScanReport): SecretScanner {
  return { id: "stub", ruleVersion: "1", scan };
}

/** Flags one planted string wherever it appears, with the exact material. */
function flaggingScanner(
  needle: string,
  detector = "stub-detector",
  withMatch = true,
): SecretScanner {
  return stubScanner((request) => {
    const findings: SecretFinding[] = [];
    for (const segment of request.segments) {
      if (segment.text.includes(needle)) {
        findings.push({
          classification: "secret_suspected",
          detector,
          ruleVersion: "1",
          segmentId: segment.id,
          ...(withMatch ? { match: needle } : {}),
        });
      }
    }
    return report(findings.length > 0 ? "secret_suspected" : "clean", findings);
  });
}

describe("request collection scans the complete request", () => {
  test("every request text leaf is scanned: system, tools, user, history, tool results", () => {
    const context: Context = {
      systemPrompt: "system-prompt-leaf",
      tools: [TOOL],
      messages: [
        { role: "user", content: "user-leaf", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "openai",
          model: "m",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
          content: [
            { type: "thinking", thinking: "history-thinking-leaf" },
            { type: "text", text: "history-text-leaf" },
            {
              type: "toolCall",
              id: "call_1",
              name: "dsh_request_action",
              arguments: { rationale: "tool-call-args-leaf" },
            },
          ],
        },
        toolResult("tool-result-leaf", { nested: "tool-result-details-leaf" }),
      ],
    };
    const { segments } = collectRequestSegments(context);
    const texts = segments.map((segment) => segment.text);
    for (const leaf of [
      "system-prompt-leaf",
      "user-leaf",
      "history-thinking-leaf",
      "history-text-leaf",
      "tool-call-args-leaf",
      "tool-result-leaf",
      "tool-result-details-leaf",
    ]) {
      expect(texts).toContain(leaf);
    }
    // Tool definitions travel in the request too and are scanned.
    expect(texts).toContain("request one repository action");
  });

  test("structural and content-derived data classes are deterministic", () => {
    const context: Context = {
      systemPrompt: "prose system prompt",
      messages: [
        { role: "user", content: "print a hello", timestamp: 1 },
        toolResult(
          [
            "2026-11-03T10:00:00Z INFO deploy",
            "diff --git a/x b/x",
            "```ts",
            "const x = 1;",
            "```",
          ].join("\n"),
        ),
      ],
    };
    const { segments } = collectRequestSegments(context);
    const classesOf = (text: string): string[] =>
      segments.find((segment) => segment.text.includes(text))?.dataClasses ?? [];
    expect(classesOf("print a hello")).toEqual(["user_input"]);
    const toolClasses = classesOf("INFO deploy");
    expect(toolClasses).toContain("tool_results");
    expect(toolClasses).toContain("logs");
    expect(toolClasses).toContain("diffs");
    expect(toolClasses).toContain("code");
    expect(classesOf("prose system prompt")).toEqual(["system"]);
  });

  test("image binary leaves are scanned but exempt from entropy heuristics", () => {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: "a".repeat(200), mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    };
    const { segments } = collectRequestSegments(context);
    const image = segments.find((segment) => segment.binary);
    expect(image?.text).toBe("a".repeat(200));
  });

  test("derived summaries carry provenance and the derived_summaries class", () => {
    const summary = tagDerivedSummary(
      { role: "user" as const, content: "short summary of earlier work", timestamp: 3 },
      { sourceClassifications: ["secret_suspected"], sourceRefs: ["messages[0]"] },
    );
    const { segments } = collectRequestSegments({ messages: [summary] });
    expect(segments[0]?.derived?.sourceClassifications).toEqual(["secret_suspected"]);
    expect(segments[0]?.dataClasses).toContain("derived_summaries");
  });
});

describe("classification joins worst case", () => {
  test("clean < suspected < confirmed < unknown", () => {
    expect(joinClassification("clean", "secret_suspected")).toBe("secret_suspected");
    expect(joinClassification("secret_suspected", "secret_confirmed")).toBe("secret_confirmed");
    expect(joinClassification("secret_confirmed", "unknown")).toBe("unknown");
    expect(joinClassification("unknown", "clean")).toBe("unknown");
    expect(joinClassification("clean", "clean")).toBe("clean");
  });
});

describe("scan gate fail-closed behavior", () => {
  const cleanContext: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

  test("a clean request passes and records non-secret evidence", async () => {
    const gate = await runRequestScanGate(cleanContext, { scanner: createPatternSecretScanner() });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.evidence.classification).toBe("clean");
    expect(gate.evidence.findingCounts).toEqual({
      suspected: 0,
      confirmed: 0,
      unknown: 0,
    });
    expect(gate.evidence.detectors).toEqual([]);
  });

  test("a scanner that throws is unavailable, never clean", async () => {
    const gate = await runRequestScanGate(cleanContext, {
      scanner: stubScanner(() => {
        throw new Error("scanner backend down");
      }),
    });
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
  });

  test("a hung scanner times out into unavailability", async () => {
    const gate = await runRequestScanGate(cleanContext, {
      scanTimeoutMs: 10,
      scanner: {
        id: "hang",
        ruleVersion: "1",
        scan: () => new Promise<SecretScanReport>(() => undefined),
      },
    });
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
  });

  test("a malformed report is unavailable", async () => {
    const gate = await runRequestScanGate(cleanContext, {
      scanner: stubScanner(() => ({ bogus: true }) as unknown as SecretScanReport),
    });
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
  });

  test("a missing scanner is unavailable", async () => {
    const gate = await runRequestScanGate(cleanContext, {
      scanner: undefined as unknown as SecretScanner,
    });
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
  });

  test("an unknown classification blocks", async () => {
    const gate = await runRequestScanGate(cleanContext, {
      scanner: stubScanner(() =>
        report("unknown", [
          {
            classification: "unknown",
            detector: "opaque-detector",
            ruleVersion: "1",
            segmentId: "messages[0].content",
          },
        ]),
      ),
    });
    expect(gate).toMatchObject({ ok: false, reason: "CLASSIFICATION_UNKNOWN" });
  });

  test("scanner error text is never echoed into the denial", async () => {
    const gate = await runRequestScanGate(cleanContext, {
      scanner: stubScanner(() => {
        throw new Error("backend echoed plaintext-secret-123456");
      }),
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.detail).not.toContain("plaintext-secret-123456");
  });

  test("scanner identifiers must be token-shaped or the scanner is unusable", async () => {
    const leak = "spilled secret material in an identifier";
    const gate = await runRequestScanGate(cleanContext, {
      scanner: { id: `scanner ${leak}`, ruleVersion: "1", scan: () => report("clean") },
    });
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
    if (!gate.ok) {
      expect(gate.detail).not.toContain(leak);
      expect(JSON.stringify(gate.evidence)).not.toContain(leak);
    }
  });

  test("a report smuggling text through detector identifiers is invalid and blocks", async () => {
    // QA B2: the detector field is scanner-provided text — anything but a
    // token-shaped identifier invalidates the report, and the text never
    // reaches the denial detail or the audit evidence.
    const leak = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const gate = await runRequestScanGate(cleanContext, {
      scanner: stubScanner((request) =>
        report("secret_suspected", [
          {
            classification: "secret_suspected",
            detector: `detector ${leak}`,
            ruleVersion: "1",
            segmentId: request.segments[0]?.id ?? "",
          },
        ]),
      ),
    });
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
    if (gate.ok) return;
    expect(gate.detail).not.toContain(leak);
    expect(JSON.stringify(gate.evidence)).not.toContain(leak);
  });

  test("credential-shaped identifiers are rejected and never reach audit evidence", async () => {
    // QA B2: a token-shaped identifier can still be a credential value (e.g.
    // an AWS access key ID) — credential shapes are rejected at the seam.
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const gate = await runRequestScanGate(cleanContext, {
      scanner: stubScanner((request) =>
        report("secret_suspected", [
          {
            classification: "secret_suspected",
            detector: token,
            ruleVersion: "1",
            segmentId: request.segments[0]?.id ?? "",
          },
        ]),
      ),
    });
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
    const evidence = JSON.stringify(gate.evidence);
    expect(evidence).not.toContain("a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
  });

  test("an AWS access key ID cannot pass as a scanner or detector identifier", async () => {
    // QA round-2 B2: SAFE_IDENTIFIER alone accepts AKIA + 16 uppercase
    // characters; credential-shaped identifiers must be rejected outright.
    const awsId = "AKIA" + "IOSFODNN7EXAMPLE";
    const asScanner = await runRequestScanGate(cleanContext, {
      scanner: { id: awsId, ruleVersion: "1", scan: () => report("clean") },
    });
    expect(asScanner).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });

    const asDetector = await runRequestScanGate(cleanContext, {
      scanner: stubScanner((request) =>
        report("secret_suspected", [
          {
            classification: "secret_suspected",
            detector: awsId,
            ruleVersion: "1",
            segmentId: request.segments[0]?.id ?? "",
          },
        ]),
      ),
    });
    expect(asDetector).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
    for (const gate of [asScanner, asDetector]) {
      expect(gate.ok).toBe(false);
      if (gate.ok) continue;
      expect(gate.detail).not.toContain(awsId);
      expect(JSON.stringify(gate.evidence)).not.toContain(awsId);
    }
  });

  test("high-entropy material cannot pass as a scanner identifier", async () => {
    const token = "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW";
    const gate = await runRequestScanGate(cleanContext, {
      scanner: { id: token, ruleVersion: "1", scan: () => report("clean") },
    });
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
    if (gate.ok) return;
    expect(JSON.stringify(gate.evidence)).not.toContain(token);
  });

  test("prototype-property classifications are rejected, never clean", async () => {
    // QA round-2 B1: `in` would accept inherited keys like `toString`, and
    // joining them with `clean` used to collapse to `clean`.
    for (const bogus of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      const gate = await runRequestScanGate(cleanContext, {
        scanner: stubScanner(
          () =>
            ({
              scanner: "stub",
              ruleVersion: "1",
              classification: bogus,
              findings: [],
            }) as unknown as SecretScanReport,
        ),
      });
      expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
    }
  });

  test("prototype-property values join to unknown, never to clean", () => {
    expect(joinClassification("toString" as SecretClassification, "clean")).toBe("unknown");
    expect(joinClassification("clean", "constructor" as SecretClassification)).toBe("unknown");
  });

  test("prototype-property source classifications are unknown and block", async () => {
    for (const bogus of ["toString", "constructor"]) {
      const gate = await runRequestScanGate(
        {
          messages: [
            tagDerivedSummary(
              { role: "user" as const, content: "summarized earlier work", timestamp: 2 },
              { sourceClassifications: [bogus as SecretClassification] },
            ),
          ],
        },
        { scanner: stubScanner(() => report("clean")) },
      );
      expect(gate).toMatchObject({ ok: false, reason: "CLASSIFICATION_UNKNOWN" });
    }
  });
});

describe("derived summaries inherit source classification", () => {
  const derived = (
    sourceClassifications: Array<"clean" | "secret_suspected" | "secret_confirmed" | "unknown">,
    classificationPolicy?: { id: string; version: string },
  ): Context => ({
    messages: [
      tagDerivedSummary(
        { role: "user" as const, content: "summarized earlier work", timestamp: 2 },
        { sourceClassifications, ...(classificationPolicy ? { classificationPolicy } : {}) },
      ),
    ],
  });

  const cleanScanner = stubScanner(() => report("clean"));

  test("a summary of secret-bearing sources blocks even though its text is clean", async () => {
    const gate = await runRequestScanGate(derived(["secret_confirmed"]), {
      scanner: cleanScanner,
    });
    expect(gate).toMatchObject({ ok: false, reason: "SENSITIVE_DATA_UNCERTAIN" });
  });

  test("a separately authorized deterministic policy may change the classification", async () => {
    const gate = await runRequestScanGate(
      derived(["secret_confirmed"], { id: "summ-v2", version: "2" }),
      {
        scanner: cleanScanner,
        scanPolicy: {
          derivedClassification: { id: "summ-v2", version: "2", authorized: true },
        },
      },
    );
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    // Both request leaves of the summary message (role and content) carry the
    // provenance and were reclassified by the authorized policy.
    expect(gate.evidence.classificationChanges).toEqual([
      { policyId: "summ-v2", policyVersion: "2", segments: 2 },
    ]);
  });

  test("an unauthorized claimed policy never changes anything", async () => {
    const gate = await runRequestScanGate(
      derived(["secret_suspected"], { id: "summ-v2", version: "2" }),
      {
        scanner: cleanScanner,
        scanPolicy: {
          derivedClassification: { id: "summ-v2", version: "2", authorized: false },
        },
      },
    );
    expect(gate).toMatchObject({ ok: false, reason: "AUTHORIZATION_MISSING" });
  });

  test("unestablished source classification is unknown and blocks", async () => {
    const gate = await runRequestScanGate(derived([]), { scanner: cleanScanner });
    expect(gate).toMatchObject({ ok: false, reason: "CLASSIFICATION_UNKNOWN" });
  });
});

describe("deterministic minimization is separately authorized and verified", () => {
  const SECRET = "hunter2-not-a-real-secret";
  const context: Context = {
    messages: [{ role: "user", content: `log line token ${SECRET} end`, timestamp: 1 }],
  };
  const authorizedPolicy = {
    minimization: {
      id: "min-1",
      version: "1",
      authorized: true,
      appliesTo: { detectors: ["stub-detector"] },
    },
  };

  test("removal that verifies clean proceeds with the minimized request", async () => {
    const gate = await runRequestScanGate(context, {
      scanner: flaggingScanner(SECRET),
      scanPolicy: authorizedPolicy,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(JSON.stringify(gate.context)).not.toContain(SECRET);
    expect(JSON.stringify(gate.context)).toContain("[redacted]");
    expect(gate.evidence.minimization).toMatchObject({
      policyId: "min-1",
      removedFindings: 1,
      verified: true,
    });
    expect(gate.evidence.classification).toBe("clean");
  });

  test("without an authorized policy a suspected secret blocks with zero bytes", async () => {
    const gate = await runRequestScanGate(context, { scanner: flaggingScanner(SECRET) });
    expect(gate).toMatchObject({ ok: false, reason: "SENSITIVE_DATA_UNCERTAIN" });
    expect(gate.evidence.minimization).toBeUndefined();
  });

  test("a finding without exact material cannot confirm removal and blocks", async () => {
    const gate = await runRequestScanGate(context, {
      scanner: flaggingScanner(SECRET, "stub-detector", false),
      scanPolicy: authorizedPolicy,
    });
    expect(gate).toMatchObject({ ok: false, reason: "SENSITIVE_DATA_UNCERTAIN" });
  });

  test("a confirmed secret is never auto-minimized", async () => {
    const gate = await runRequestScanGate(context, {
      scanner: stubScanner((request) =>
        report("secret_confirmed", [
          {
            classification: "secret_confirmed",
            detector: "stub-detector",
            ruleVersion: "1",
            segmentId: request.segments.find((segment) => segment.text.includes(SECRET))?.id ?? "",
            match: SECRET,
          },
        ]),
      ),
      scanPolicy: authorizedPolicy,
    });
    expect(gate).toMatchObject({ ok: false, reason: "SENSITIVE_DATA_UNCERTAIN" });
  });

  test("removal that cannot be verified on the full re-scan still blocks", async () => {
    // The detector also flags the redaction placeholder, so the minimized
    // request does not come back clean: nothing is sent.
    const placeholder = stubScanner((request) => {
      const findings: SecretFinding[] = [];
      for (const segment of request.segments) {
        for (const needle of [SECRET, "[redacted]"]) {
          if (segment.text.includes(needle)) {
            findings.push({
              classification: "secret_suspected",
              detector: "stub-detector",
              ruleVersion: "1",
              segmentId: segment.id,
              match: needle,
            });
          }
        }
      }
      return report(findings.length > 0 ? "secret_suspected" : "clean", findings);
    });
    const gate = await runRequestScanGate(context, {
      scanner: placeholder,
      scanPolicy: authorizedPolicy,
    });
    expect(gate).toMatchObject({ ok: false, reason: "SENSITIVE_DATA_UNCERTAIN" });
  });

  test("a finding whose match is not in its own segment is an invalid report and blocks", async () => {
    // QA B1: material that is not in the request can never be removed, so a
    // report claiming one must never be a basis for dispatching anything.
    const gate = await runRequestScanGate(context, {
      scanner: stubScanner((request) =>
        report("secret_suspected", [
          {
            classification: "secret_suspected",
            detector: "stub-detector",
            ruleVersion: "1",
            segmentId: request.segments.find((segment) => segment.text.includes(SECRET))?.id ?? "",
            match: "material-that-is-not-in-the-request",
          },
        ]),
      ),
      scanPolicy: authorizedPolicy,
    });
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
  });

  test("a minimization that would not change the request is unconfirmed and blocks", async () => {
    // QA B1: the flagged material is already exactly the redaction
    // placeholder — "replacing" it is a no-op, so the dispatch copy would be
    // byte-identical to the unminimized request and must not be sent.
    const placeholderContext: Context = {
      messages: [{ role: "user", content: "log line [redacted] end", timestamp: 1 }],
    };
    const gate = await runRequestScanGate(placeholderContext, {
      scanner: flaggingScanner("[redacted]"),
      scanPolicy: authorizedPolicy,
    });
    expect(gate).toMatchObject({ ok: false, reason: "SENSITIVE_DATA_UNCERTAIN" });
  });

  test("applicability bounds limit what a minimization policy may touch", async () => {
    const gate = await runRequestScanGate(context, {
      scanner: flaggingScanner(SECRET),
      scanPolicy: {
        minimization: {
          id: "min-1",
          version: "1",
          authorized: true,
          // Bounded to other detectors: this finding is out of scope.
          appliesTo: { detectors: ["some-other-detector"] },
        },
      },
    });
    expect(gate).toMatchObject({ ok: false, reason: "SENSITIVE_DATA_UNCERTAIN" });
  });
});

describe("destination data-class authorization", () => {
  test("missing authorization fails closed", () => {
    expect(authorizeRequestDataClasses(["user_input"], {})).toMatchObject({
      ok: false,
      reason: "AUTHORIZATION_MISSING",
    });
  });

  test("a class the destination is not authorized for denies", () => {
    const result = authorizeRequestDataClasses(["user_input", "code"], {
      permittedDataClasses: ["user_input"],
    });
    expect(result).toMatchObject({ ok: false, reason: "DATA_CLASS_NOT_AUTHORIZED" });
    if (result.ok) return;
    expect(result.detail).toContain("code");
  });

  test("covered classes authorize", () => {
    expect(
      authorizeRequestDataClasses(["user_input"], {
        permittedDataClasses: ["user_input", "history"],
      }),
    ).toEqual({ ok: true });
  });

  test("policy validation rejects unknown or empty data-class lists", () => {
    const policy = {
      revision: "r",
      endpoints: [
        {
          endpointId: "ep",
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://ok.test/v1",
          internal: false,
          credentialRef: "cred",
          models: ["m"],
        },
      ],
      retry: { maxAttempts: 1 },
    };
    expect(() =>
      validateGatewayPolicy({
        ...policy,
        endpoints: [{ ...policy.endpoints[0], permittedDataClasses: [] }],
      }),
    ).toThrow(/permittedDataClasses/);
    expect(() =>
      validateGatewayPolicy({
        ...policy,
        endpoints: [{ ...policy.endpoints[0], permittedDataClasses: ["everything"] }],
      }),
    ).toThrow(/permittedDataClasses/);
    expect(() =>
      validateGatewayPolicy({
        ...policy,
        endpoints: [{ ...policy.endpoints[0], permittedDataClasses: [...DATA_CLASSES] }],
      }),
    ).not.toThrow();
  });
});

describe("untrusted scanner reports are snapshotted exactly once (QA round-3)", () => {
  const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

  /** Define a counting getter property. */
  function countingGetter(
    target: Record<string, unknown>,
    key: string,
    values: readonly unknown[],
  ): { reads: () => number } {
    let reads = 0;
    Object.defineProperty(target, key, {
      get() {
        const value = values[Math.min(reads, values.length - 1)];
        reads += 1;
        return value;
      },
      enumerable: true,
      configurable: true,
    });
    return { reads: () => reads };
  }

  test("a detector getter is read exactly once and its second-read text never surfaces", async () => {
    // Regression bullet 1: first read a valid detector token, second read
    // arbitrary (non-credential-shaped) request text. The gate must block,
    // send zero bytes, and never surface the second-read text anywhere.
    const second = "kernel panic in production";
    const finding: Record<string, unknown> = {
      classification: "secret_suspected",
      ruleVersion: "1",
      segmentId: "messages[0].content",
    };
    const detector = countingGetter(finding, "detector", ["stub-detector", second]);
    const gate = await runRequestScanGate(context, {
      scanner: stubScanner(
        () =>
          ({
            scanner: "stub",
            ruleVersion: "1",
            classification: "secret_suspected",
            findings: [finding],
          }) as unknown as SecretScanReport,
      ),
    });
    expect(detector.reads()).toBe(1);
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
    if (gate.ok) return;
    expect(gate.detail).not.toContain(second);
    expect(JSON.stringify(gate.evidence)).not.toContain(second);
    expect(JSON.stringify(gate.evidence)).not.toContain("stub-detector");
  });

  test("every report and finding field is read exactly once", async () => {
    // Regression bullet 2: counting getters over the whole report shape —
    // each field fires exactly once, and nothing is re-read after the
    // snapshot.
    const reads: Record<string, () => number> = {};
    const finding: Record<string, unknown> = {};
    reads["finding.classification"] = countingGetter(finding, "classification", [
      "secret_suspected",
    ]).reads;
    reads["finding.detector"] = countingGetter(finding, "detector", ["stub-detector"]).reads;
    reads["finding.ruleVersion"] = countingGetter(finding, "ruleVersion", ["1"]).reads;
    reads["finding.segmentId"] = countingGetter(finding, "segmentId", [
      "messages[0].content",
    ]).reads;
    reads["finding.match"] = countingGetter(finding, "match", ["hello"]).reads;
    const reportObject: Record<string, unknown> = {};
    reads["classification"] = countingGetter(reportObject, "classification", [
      "secret_suspected",
    ]).reads;
    reads["scanner"] = countingGetter(reportObject, "scanner", ["stub"]).reads;
    reads["ruleVersion"] = countingGetter(reportObject, "ruleVersion", ["1"]).reads;
    reads["findings"] = countingGetter(reportObject, "findings", [[finding]]).reads;
    const gate = await runRequestScanGate(context, {
      scanner: stubScanner(() => reportObject as unknown as SecretScanReport),
    });
    for (const [field, count] of Object.entries(reads)) {
      expect(`${field}=${count()}`).toBe(`${field}=1`);
    }
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("SCANNER_UNAVAILABLE");
  });

  test("a findings getter is read once; its later arrays are never consulted", async () => {
    // Regression bullet 3: two different arrays across reads — only the
    // first read ever happens, and the second array's marker never surfaces.
    const secondMarker = "second-array-marker-9f2";
    const first: unknown[] = [];
    const second: unknown[] = [
      {
        classification: "secret_confirmed",
        detector: secondMarker,
        ruleVersion: "1",
        segmentId: "messages[0].content",
      },
    ];
    const reportObject: Record<string, unknown> = {
      scanner: "stub",
      ruleVersion: "1",
      classification: "clean",
    };
    const findings = countingGetter(reportObject, "findings", [first, second]);
    const gate = await runRequestScanGate(context, {
      scanner: stubScanner(() => reportObject as unknown as SecretScanReport),
    });
    expect(findings.reads()).toBe(1);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.detail).not.toContain(secondMarker);
    expect(JSON.stringify(gate.evidence)).not.toContain(secondMarker);
  });

  test("a classification getter flipping from secret_suspected to clean still blocks", async () => {
    // Regression bullet 4: the old double-read fail-open surface — the first
    // observed value decides, and a later clean value is never consulted.
    const reportObject: Record<string, unknown> = { scanner: "stub", ruleVersion: "1" };
    const classification = countingGetter(reportObject, "classification", [
      "secret_suspected",
      "clean",
    ]);
    reportObject["findings"] = [];
    const gate = await runRequestScanGate(context, {
      scanner: stubScanner(() => reportObject as unknown as SecretScanReport),
    });
    expect(classification.reads()).toBe(1);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("SCANNER_UNAVAILABLE");
  });

  test("the observed value drives the block for plain-data reports", async () => {
    // The snapshot-time value is what decisions and evidence use: a plain
    // report scanning secret_suspected with no findings blocks on that value.
    const gate = await runRequestScanGate(context, {
      scanner: stubScanner(() => report("secret_suspected")),
    });
    expect(gate).toMatchObject({ ok: false, reason: "SENSITIVE_DATA_UNCERTAIN" });
  });

  test("post-scan mutations of the report cannot change decisions or evidence", async () => {
    // Acceptance invariant: whatever the report does after the snapshot, the
    // values entering the decision and evidence equal those observed at
    // snapshot time.
    const raw = report("secret_suspected", [
      {
        classification: "secret_suspected",
        detector: "stub-detector",
        ruleVersion: "1",
        segmentId: "messages[0].content",
      },
    ]);
    const gate = await runRequestScanGate(context, {
      scanner: stubScanner(() => raw),
    });
    expect(gate).toMatchObject({ ok: false, reason: "SENSITIVE_DATA_UNCERTAIN" });
    // Mutate the raw report after the gate ran.
    raw.classification = "clean";
    raw.findings[0]!.detector = "mutated-detector";
    raw.findings.length = 0;
    if (gate.ok) return;
    expect(gate.evidence.classification).toBe("secret_suspected");
    expect(gate.evidence.detectors).toEqual(["stub-detector"]);
    expect(gate.evidence.findingCounts).toEqual({
      suspected: 1,
      confirmed: 0,
      unknown: 0,
    });
  });

  test("a throwing getter fails closed into a static denial", async () => {
    const leak = "scanner echoed plaintext-secret-777";
    const reportObject: Record<string, unknown> = { scanner: "stub", ruleVersion: "1" };
    Object.defineProperty(reportObject, "classification", {
      get() {
        throw new Error(leak);
      },
      enumerable: true,
      configurable: true,
    });
    reportObject["findings"] = [];
    const gate = await runRequestScanGate(context, {
      scanner: stubScanner(() => reportObject as unknown as SecretScanReport),
    });
    expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
    if (gate.ok) return;
    expect(gate.detail).not.toContain(leak);
    expect(JSON.stringify(gate.evidence)).not.toContain(leak);
  });

  test("match and ruleVersion getters are read once and rejected the same way", async () => {
    const second = "second-read-request-text";
    for (const key of ["match", "ruleVersion"] as const) {
      const finding: Record<string, unknown> = {
        classification: "secret_suspected",
        detector: "stub-detector",
        ruleVersion: "1",
        segmentId: "messages[0].content",
      };
      const counter = countingGetter(finding, key, ["hello", second]);
      const gate = await runRequestScanGate(context, {
        scanner: stubScanner(
          () =>
            ({
              scanner: "stub",
              ruleVersion: "1",
              classification: "secret_suspected",
              findings: [finding],
            }) as unknown as SecretScanReport,
        ),
      });
      expect(counter.reads()).toBe(1);
      expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
      if (gate.ok) continue;
      expect(gate.detail).not.toContain(second);
      expect(JSON.stringify(gate.evidence)).not.toContain(second);
    }
  });

  test("non-plain containers, non-array findings, and non-string fields fail closed", async () => {
    class ReportShape {}
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const cases: unknown[] = [
      new ReportShape(),
      { scanner: "stub", ruleVersion: "1", classification: "clean", findings: {} },
      { scanner: "stub", ruleVersion: "1", classification: "clean", findings: { length: 0 } },
      {
        scanner: "stub",
        ruleVersion: "1",
        classification: "clean",
        findings: [
          {
            classification: "secret_suspected",
            detector: "stub-detector",
            ruleVersion: "1",
            segmentId: "messages[0].content",
            match: circular,
          },
        ],
      },
      {
        scanner: "stub",
        ruleVersion: "1",
        classification: "clean",
        findings: [new ReportShape()],
      },
      { scanner: "stub", ruleVersion: "1", classification: 42, findings: [] },
    ];
    for (const raw of cases) {
      const gate = await runRequestScanGate(context, {
        scanner: stubScanner(() => raw as SecretScanReport),
      });
      expect(gate).toMatchObject({ ok: false, reason: "SCANNER_UNAVAILABLE" });
    }
  });
});
