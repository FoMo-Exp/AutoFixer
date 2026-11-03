import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  ContentAccessAuthorizer,
  ContentVault,
  QuarantineAccessAuthorizer,
  QuarantineVault,
} from "../src/trace/access.js";
import type { CapturedMaterial } from "../src/trace/content.js";
import { ContentCapture } from "../src/trace/content.js";
import {
  DurableLocalCapture,
  ExportApprovalRegistry,
  ExportBuffer,
  TraceExporter,
} from "../src/trace/exporter.js";
import type { ExportItem, ExportTransport } from "../src/trace/exporter.js";
import type { NewTraceEvent } from "../src/trace/schema.js";
import { TraceStore } from "../src/trace/store.js";

/**
 * Acceptance: secret-bearing prompt, response, tool and SDK-error material —
 * and every export of it — pass leakage tests. The corpus is the DAT-209
 * adversarial shape set; a secret value must not appear in any persisted or
 * delivered surface, whatever the detector calls it. Credential shapes are
 * assembled from fragments so the fixture source is not itself a secret
 * (the repo's existing corpus convention).
 */
const SECRETS = {
  bearer: "0123456789abcdef0123456789abcdef",
  openaiKey: ["sk-proj-", "DEADBEEFCAFE", "0123456789"].join(""),
  awsKey: ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""),
  githubToken: ["ghp", "_1234567890", "abcdefghijklmnop"].join(""),
  slackToken: ["xox", "b-0123456789", "-abcdefghijklmnopqrstuv"].join(""),
  jwt: [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join("."),
  assignedValue: ["verysecret", "value123"].join(""),
  privateKeyBody: ["MII", "testkeybody"].join(""),
  literal: "ent-literal-secret-42",
};

function secretBearingText(): string {
  return [
    `Authorization: Bearer ${SECRETS.bearer}`,
    `key ${SECRETS.openaiKey}`,
    `aws ${SECRETS.awsKey}`,
    `github ${SECRETS.githubToken}`,
    `slack ${SECRETS.slackToken}`,
    `jwt ${SECRETS.jwt}`,
    `api_key=${SECRETS.assignedValue}`,
    `-----BEGIN PRIVATE KEY-----\n${SECRETS.privateKeyBody}\n-----END PRIVATE KEY-----`,
  ].join("\n");
}

function expectNoSecrets(surfaces: Record<string, string>): void {
  for (const [name, serialized] of Object.entries(surfaces)) {
    for (const [secretName, value] of Object.entries(SECRETS)) {
      expect(serialized, `${name} leaked ${secretName}`).not.toContain(value);
    }
  }
}

const RETENTION = {
  evidence_days: 30,
  trace_days: 14,
  content_days: 7,
  usage_days: 90,
  backup_days: 2,
};

function rawCapture(): ContentCapture {
  return new ContentCapture({
    policy: {
      raw_content_capture: true,
      max_material_chars: 8192,
      retention: RETENTION,
    },
    now: () => new Date(Date.UTC(2026, 10, 3, 0, 0, 0)),
  });
}

describe("secret-bearing material never reaches persistence or export", () => {
  for (const kind of ["prompt", "response", "tool", "sdk_error"] as const) {
    test(`${kind} material is redacted before persistence`, () => {
      const capture = rawCapture();
      const captured = capture.capture({
        kind,
        text: secretBearingText(),
        data_classes: kind === "prompt" ? ["user_input"] : ["logs"],
        literal_secrets: [SECRETS.literal],
      });
      // Metadata and non-secret scan evidence survive; secret values never do.
      expect(captured.text).not.toBeNull();
      expect(captured.redactions).toBeGreaterThanOrEqual(8);
      expectNoSecrets({
        "captured record": JSON.stringify(captured),
        "content vault read": JSON.stringify(depositAndRead(captured)),
      });
    });
  }

  test("raw capture off keeps not even redacted content text", () => {
    const capture = new ContentCapture({
      policy: { raw_content_capture: false, max_material_chars: 8192, retention: RETENTION },
    });
    const captured = capture.capture({
      kind: "prompt",
      text: secretBearingText(),
      data_classes: ["user_input"],
      literal_secrets: [SECRETS.literal],
    });
    expect(captured.text).toBeNull();
    expectNoSecrets({ "metadata record": JSON.stringify(captured) });
  });

  test("exported records carry no secret values in any field", () => {
    const deliveredBatches: ExportItem[][] = [];
    const transport: ExportTransport = {
      deliver: (items) => deliveredBatches.push([...items]),
    };
    const file = path.join(mkdtempSync(path.join(tmpdir(), "autofixer-leak-")), "capture.jsonl");
    const capture = new DurableLocalCapture({ path: file, maxRecords: 50, maxBytes: 100_000 });
    const exporter = new TraceExporter({
      capture,
      buffer: new ExportBuffer({ maxRecords: 50 }),
      transport,
      destinations: new ExportApprovalRegistry({
        destinations: [
          {
            destination_id: "vendor",
            approval_ref: "adr5-1",
            permitted_data_classes: ["logs", "user_input"],
          },
        ],
      }),
    });

    exporter.captureItem({
      source: "gateway",
      event_id: "inv-1",
      data_classes: ["logs"],
      mandatory: true,
      record: {
        summary: `failed calling the api with Bearer ${SECRETS.bearer}`,
        detail: { note: `api_key=${SECRETS.assignedValue}`, jwt: SECRETS.jwt },
        tool_args: [{ input: SECRETS.openaiKey }],
      },
    });
    const outcome = exporter.flush("vendor");
    expect(outcome.status).toBe("delivered");

    expectNoSecrets({
      "durable capture file": readFileSync(file, "utf8"),
      "delivered export batches": JSON.stringify(deliveredBatches),
    });
    expect(JSON.stringify(deliveredBatches)).toContain("[redacted]");
  });

  test("secret-bearing material cannot persist through the trace store", () => {
    // The store enforces the content gate at its write boundary: a writer
    // stuffing material into an event payload cannot persist secrets
    // through the ordinary persistence path.
    const file = path.join(mkdtempSync(path.join(tmpdir(), "autofixer-leak-")), "trace-state.json");
    const store = new TraceStore({
      persistencePath: file,
      now: () => new Date(Date.UTC(2026, 10, 3, 0, 0, 0)),
    });
    const event: NewTraceEvent = {
      source: "worker-1",
      event_id: "evt-1",
      sequence: 1,
      event_time: "2026-11-03T00:00:01.000Z",
      record_class: "operational_trace",
      kind: "tool.executed",
      enterprise_id: "ent-1",
      workspace_id: "ws-1",
      trace_id: "trace-1",
      span_id: "span-1",
      payload: {
        prompt: secretBearingText(),
        response: secretBearingText(),
        tool: secretBearingText(),
        sdk_error: secretBearingText(),
      },
      labels: { status: `auth ${SECRETS.githubToken}` },
    };
    store.append(event);
    store.flushSync();

    expectNoSecrets({
      "trace store read": JSON.stringify(
        store.query({
          enterprise_id: "ent-1",
          workspace_id: "ws-1",
          subject: "user-1",
        }),
      ),
      "trace store persistence": readFileSync(file, "utf8"),
    });
  });

  test("quarantine holds the raw material — and only quarantine does", () => {
    // The one sanctioned home for required source material: separately
    // authorized, never exported, never in the content or trace surfaces.
    const quarantineAuthorizer = new QuarantineAccessAuthorizer({
      mayReadQuarantine: (subject) => subject === "security-analyst",
    });
    const quarantine = new QuarantineVault(quarantineAuthorizer);
    const sealed = quarantine.deposit({
      case_ref: "case-1",
      kind: "sdk_error",
      text: secretBearingText(),
      deposited_by: "security-analyst",
      reason: "investigation case-1",
    });
    expect(quarantine.read("case-1", quarantineAuthorizer.authorize("security-analyst")).text).toBe(
      sealed.text,
    );

    // The content surface of the same material carries no secret values.
    const captured = rawCapture().capture({
      kind: "sdk_error",
      text: secretBearingText(),
      data_classes: ["logs"],
      literal_secrets: [SECRETS.literal],
    });
    const contentAuthorizer = new ContentAccessAuthorizer({ mayReadContent: () => true });
    const vault = new ContentVault(contentAuthorizer);
    vault.deposit(captured);
    expectNoSecrets({
      "content vault read": JSON.stringify(
        vault.read(captured.record_id, contentAuthorizer.authorize("user")),
      ),
    });
  });
});

function depositAndRead(captured: CapturedMaterial): unknown {
  const authorizer = new ContentAccessAuthorizer({ mayReadContent: () => true });
  const vault = new ContentVault(authorizer);
  vault.deposit(captured);
  return vault.read(captured.record_id, authorizer.authorize("user"));
}
