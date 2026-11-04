import { describe, expect, test } from "vitest";

import type { SecretScanner, SecretScanReport } from "../src/gateway/scan.js";
import {
  ContentCapture,
  ContentScanUnavailableError,
  parseContentCapturePolicy,
  redactContentStrings,
  redactMaterial,
} from "../src/trace/content.js";
import type { ContentCapturePolicy } from "../src/trace/content.js";
import { TraceValidationError } from "../src/trace/errors.js";
import { RetentionConfigError } from "../src/trace/retention.js";

// Assembled from pieces on purpose: runnable secret-shaped literals in this
// file would be rejected by repository push protection (repo corpus convention).
const BEARER = ["Bearer ", "0123456789abcdef", "0123456789abcdef"].join("");
const BEARER_VALUE = ["0123456789abcdef", "0123456789abcdef"].join("");
const ASSIGNED_VALUE = ["verysecret", "value123"].join("");

const RETENTION = {
  evidence_days: 30,
  trace_days: 14,
  content_days: 7,
  usage_days: 90,
  backup_days: 2,
};

function policy(overrides: Partial<ContentCapturePolicy> = {}): ContentCapturePolicy {
  return {
    raw_content_capture: true,
    max_material_chars: 4096,
    retention: RETENTION,
    ...overrides,
  };
}

function fixedNow(): () => Date {
  return () => new Date(Date.UTC(2026, 10, 3, 12, 0, 0));
}

/** A scanner whose report is under the caller's control. */
function scriptedScanner(report: unknown): SecretScanner {
  return {
    id: "scripted-scanner",
    ruleVersion: "test-1",
    scan: () => report as SecretScanReport,
  };
}

describe("content capture policy", () => {
  test("raw content capture is default-off and retention is always required", () => {
    const parsed = parseContentCapturePolicy({
      max_material_chars: 100,
      retention: RETENTION,
    });
    expect(parsed.raw_content_capture).toBe(false);

    // Enabling capture without finite retention values fails closed.
    expect(() =>
      parseContentCapturePolicy({ raw_content_capture: true, max_material_chars: 100 }),
    ).toThrow(RetentionConfigError);
    expect(() =>
      parseContentCapturePolicy({
        raw_content_capture: true,
        max_material_chars: 100,
        retention: { ...RETENTION, content_days: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(RetentionConfigError);
  });

  test("a hand-built policy cannot bypass validation at construction", () => {
    expect(
      () =>
        new ContentCapture({
          policy: { raw_content_capture: true, max_material_chars: 0, retention: RETENTION },
        }),
    ).toThrow(TraceValidationError);
    expect(
      () =>
        new ContentCapture({
          policy: {
            raw_content_capture: true,
            max_material_chars: 100,
            retention: { ...RETENTION, usage_days: 0 },
          },
        }),
    ).toThrow(RetentionConfigError);
  });

  test("metadata-only capture keeps continuity but no content text", () => {
    const capture = new ContentCapture({
      policy: policy({ raw_content_capture: false }),
      now: fixedNow(),
    });
    const captured = capture.capture({
      kind: "prompt",
      text: "please fix the failing test",
      data_classes: ["user_input"],
    });
    expect(captured.text).toBeNull();
    expect(captured.persisted_chars).toBe(0);
    expect(captured.original_chars).toBe("please fix the failing test".length);
    expect(captured.kind).toBe("prompt");
    expect(capture.counters()).toEqual({
      scanned: 1,
      redactions: 0,
      truncated: 0,
      dropped: 1,
    });
  });
});

describe("pre-persistence scanning and redaction", () => {
  test("request material is redacted before it can be persisted", () => {
    const capture = new ContentCapture({ policy: policy(), now: fixedNow() });
    const captured = capture.capture({
      kind: "prompt",
      text: `call the api with ${BEARER} and api_key=${ASSIGNED_VALUE}`,
      data_classes: ["user_input"],
    });
    expect(captured.text).not.toContain(BEARER_VALUE);
    expect(captured.text).not.toContain(ASSIGNED_VALUE);
    expect(captured.text).toContain("[redacted]");
    expect(captured.redactions).toBeGreaterThanOrEqual(2);
  });

  test("response, tool and SDK-error material go through the same gate", () => {
    const capture = new ContentCapture({ policy: policy(), now: fixedNow() });
    for (const kind of ["response", "tool", "sdk_error"] as const) {
      const captured = capture.capture({
        kind,
        text: `debug info ${BEARER}`,
        data_classes: ["logs"],
      });
      expect(captured.text).not.toContain(BEARER_VALUE);
      expect(captured.scan.classification).toBe("secret_confirmed");
    }
    expect(capture.counters().scanned).toBe(3);
  });

  test("material from an internal-only model call is scanned like external material", () => {
    // The gate has no egress input: there is no path that skips the scan for
    // calls that never leave the internal environment.
    const capture = new ContentCapture({ policy: policy(), now: fixedNow() });
    const internalCall = capture.capture({
      kind: "prompt",
      text: `internal endpoint ${BEARER}`,
      data_classes: ["system"],
    });
    const externalCall = capture.capture({
      kind: "prompt",
      text: `external endpoint ${BEARER}`,
      data_classes: ["system"],
    });
    expect(internalCall.text).not.toContain(BEARER_VALUE);
    expect(externalCall.text).not.toContain(BEARER_VALUE);
    expect(internalCall.redactions).toBe(externalCall.redactions);
  });

  test("caller-known literal secrets are removed even when no pattern matches", () => {
    const capture = new ContentCapture({ policy: policy(), now: fixedNow() });
    const captured = capture.capture({
      kind: "tool",
      text: "deployed with ent-literal-secret-42",
      data_classes: ["tool_results"],
      literal_secrets: ["ent-literal-secret-42"],
    });
    expect(captured.text).not.toContain("ent-literal-secret-42");
    expect(captured.text).toContain("[redacted]");
  });

  test("long material is truncated at the bound and counted explicitly", () => {
    const capture = new ContentCapture({
      policy: policy({ max_material_chars: 10 }),
      now: fixedNow(),
    });
    const captured = capture.capture({
      kind: "response",
      text: "a".repeat(25),
      data_classes: ["logs"],
    });
    expect(captured.truncated).toBe(true);
    expect(captured.text).toHaveLength(10);
    expect(captured.persisted_chars).toBe(10);
    expect(capture.counters().truncated).toBe(1);
  });

  test("scan evidence carries detector identity and counts, never matched material", () => {
    const capture = new ContentCapture({ policy: policy(), now: fixedNow() });
    const captured = capture.capture({
      kind: "prompt",
      text: BEARER,
      data_classes: ["user_input"],
    });
    expect(captured.scan.detectors).toContain("bearer-token");
    expect(JSON.stringify(captured.scan)).not.toContain(BEARER_VALUE);
  });
});

describe("scanner failure fails closed", () => {
  const material = {
    kind: "prompt" as const,
    text: "hello",
    data_classes: ["user_input" as const],
  };

  test("a throwing scanner blocks persistence of the material", () => {
    const scanner: SecretScanner = {
      id: "broken",
      ruleVersion: "1",
      scan: () => {
        throw new Error("boom");
      },
    };
    const capture = new ContentCapture({ policy: policy(), scanner });
    expect(() => capture.capture(material)).toThrow(ContentScanUnavailableError);
  });

  test("an asynchronous scanner is refused on the synchronous persistence path", () => {
    const scanner: SecretScanner = {
      id: "async",
      ruleVersion: "1",
      scan: () =>
        Promise.resolve({
          scanner: "async",
          ruleVersion: "1",
          classification: "clean",
          findings: [],
        }),
    };
    const capture = new ContentCapture({ policy: policy(), scanner });
    expect(() => capture.capture(material)).toThrow(ContentScanUnavailableError);
  });

  test("a report with unsafe detector identities is refused", () => {
    const scanner = scriptedScanner({
      scanner: "pattern-secret-scanner",
      ruleVersion: "1",
      classification: "secret_confirmed",
      findings: [
        {
          classification: "secret_confirmed",
          detector: `leak ${["sk-", "DEADBEEFDEADBEEFDEAD"].join("")}`,
          ruleVersion: "1",
          segmentId: "material",
          match: "x",
        },
      ],
    });
    const capture = new ContentCapture({ policy: policy(), scanner });
    // Evidence identities are token-shaped precisely so a hostile scanner
    // cannot smuggle matched material into persisted evidence.
    expect(() => capture.capture(material)).toThrow(ContentScanUnavailableError);
  });

  test("a report with an unknown classification is refused", () => {
    const scanner = scriptedScanner({
      scanner: "pattern-secret-scanner",
      ruleVersion: "1",
      classification: "suspicious",
      findings: [],
    });
    const capture = new ContentCapture({ policy: policy(), scanner });
    expect(() => capture.capture(material)).toThrow(ContentScanUnavailableError);
  });
});

describe("deep redaction for records and exports", () => {
  test("every string leaf is redacted while keys and non-strings survive", () => {
    const redacted = redactContentStrings({
      note: `failed with ${BEARER}`,
      nested: [{ detail: `api_key=${ASSIGNED_VALUE}` }],
      count: 3,
      ok: true,
      absent: null,
    }) as Record<string, unknown>;
    expect(redacted["note"]).not.toContain(BEARER_VALUE);
    expect(redacted["count"]).toBe(3);
    expect(redacted["ok"]).toBe(true);
    expect(redacted["absent"]).toBeNull();
    expect(JSON.stringify(redacted)).not.toContain(ASSIGNED_VALUE);
  });

  test("redactMaterial reports the classification and redaction count", () => {
    // Classification comes from the shared DAT-209 detector corpus; the
    // blunt pass additionally scrubs material no detector matched.
    const detected = redactMaterial(`call with ${BEARER}`);
    expect(detected.classification).toBe("secret_confirmed");
    expect(detected.redactions).toBeGreaterThanOrEqual(1);
    expect(detected.detectors).toContain("bearer-token");
    expect(detected.text).not.toContain(BEARER_VALUE);

    const scrubbedOnly = redactMaterial(`api_key=${ASSIGNED_VALUE} and more`);
    expect(scrubbedOnly.redactions).toBeGreaterThanOrEqual(1);
    expect(scrubbedOnly.text).not.toContain(ASSIGNED_VALUE);
  });
});
