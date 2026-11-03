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

  test("credential-shaped identifiers are scrubbed from audit evidence", async () => {
    // A token-shaped identifier can still be a credential value: the evidence
    // belt scrubs credential-shaped material before the audit/analytics sink.
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
    expect(gate).toMatchObject({ ok: false, reason: "SENSITIVE_DATA_UNCERTAIN" });
    const evidence = JSON.stringify(gate.evidence);
    expect(evidence).not.toContain("a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
    expect(evidence).toContain("[redacted]");
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
