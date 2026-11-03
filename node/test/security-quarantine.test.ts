/**
 * Encrypted quarantine for raw retained context (DAT-210, ADR-0005 §2).
 *
 * The blocked request's raw context lives encrypted at rest, under a retention
 * limit. Viewing requires a separately granted scoped access and always
 * produces an audit event; ordinary logs, notifications, and errors never
 * contain the quarantined values. Expired records refuse reads and are swept.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  EncryptedQuarantine,
  SecurityError,
  type QuarantineAuditEvent,
  type QuarantineKeyProvider,
  type SecurityActor,
} from "../src/security/index.js";

const KEY = Buffer.alloc(32, 3);
const KEY_PROVIDER: QuarantineKeyProvider = {
  keyId: "key_2026_11",
  currentKey: () => KEY,
};
const NO_KEY: QuarantineKeyProvider = {
  keyId: "key_2026_11",
  currentKey: () => undefined,
};

const HANDLER: SecurityActor = { actorId: "human_handler", actorKind: "human" };
const OTHER: SecurityActor = { actorId: "human_other", actorKind: "human" };

// Assembled at runtime: repository secret scanners would flag literals.
const SECRET_VALUE = "sk-" + "live-abcdef1234567890";

const SECRET_CONTEXT = `{"messages":[{"content":"token ${SECRET_VALUE}"}]}`;

function auditRecorder(): {
  events: QuarantineAuditEvent[];
  onEvent: (event: QuarantineAuditEvent) => void;
} {
  const events: QuarantineAuditEvent[] = [];
  return { events, onEvent: (event) => void events.push(event) };
}

function quarantineWith(
  options: Partial<ConstructorParameters<typeof EncryptedQuarantine>[0]> = {},
): EncryptedQuarantine {
  return new EncryptedQuarantine({
    keyProvider: KEY_PROVIDER,
    retentionSeconds: 3600,
    ...options,
  });
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected SecurityError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SecurityError);
    expect((error as SecurityError).code).toBe(code);
  }
}

describe("EncryptedQuarantine sealing", () => {
  test("sealed context is encrypted at rest and reads back only decrypted", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "security-quarantine-"));
    const persistencePath = path.join(directory, "quarantine.json");
    const quarantine = quarantineWith({ persistencePath });
    const sealed = quarantine.seal("case_1", SECRET_CONTEXT);
    expect(sealed).toHaveProperty("quarantineId");
    if (!("quarantineId" in sealed)) return;
    const persisted = readFileSync(persistencePath, "utf8");
    expect(persisted).not.toContain(SECRET_VALUE);
    expect(persisted).not.toContain("messages");
    const grant = quarantine.grantAccess(sealed.quarantineId, "human_handler", HANDLER);
    expect(quarantine.read(sealed.quarantineId, grant, HANDLER)).toBe(SECRET_CONTEXT);
  });

  test("an unavailable key fails closed and never stores plaintext", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "security-quarantine-"));
    const persistencePath = path.join(directory, "quarantine.json");
    const quarantine = new EncryptedQuarantine({
      keyProvider: NO_KEY,
      retentionSeconds: 3600,
      persistencePath,
    });
    const sealed = quarantine.seal("case_1", SECRET_CONTEXT);
    expect(sealed).toEqual({ unavailable: true, detail: expect.any(String) });
    const persisted = existsSync(persistencePath) ? readFileSync(persistencePath, "utf8") : "";
    expect(persisted).not.toContain(SECRET_VALUE);
  });
});

describe("EncryptedQuarantine access control", () => {
  test("viewing needs a separate scoped grant and always audits", () => {
    const { events, onEvent } = auditRecorder();
    const quarantine = quarantineWith({ onEvent });
    const sealed = quarantine.seal("case_1", SECRET_CONTEXT);
    if (!("quarantineId" in sealed)) return;
    expectCode(
      () => quarantine.read(sealed.quarantineId, undefined as never, HANDLER),
      "QUARANTINE_ACCESS_DENIED",
    );
    const grant = quarantine.grantAccess(sealed.quarantineId, "human_handler", HANDLER);
    expect(quarantine.read(sealed.quarantineId, grant, HANDLER)).toBe(SECRET_CONTEXT);
    const types = events.map((event) => event.type);
    expect(types).toContain("quarantine.sealed");
    expect(types).toContain("quarantine.access_granted");
    expect(types).toContain("quarantine.access_denied");
    expect(types).toContain("quarantine.accessed");
    // Audit events carry identifiers only, never the quarantined content.
    expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);
  });

  test("a grant is bound to its subject and never transfers to another viewer", () => {
    const quarantine = quarantineWith();
    const sealed = quarantine.seal("case_1", SECRET_CONTEXT);
    if (!("quarantineId" in sealed)) return;
    const grant = quarantine.grantAccess(sealed.quarantineId, "human_handler", HANDLER);
    expectCode(
      () => quarantine.read(sealed.quarantineId, grant, OTHER),
      "QUARANTINE_ACCESS_DENIED",
    );
  });

  test("an expired grant refuses access while the record is still retained", () => {
    let now = new Date("2026-11-03T00:00:00.000Z");
    const quarantine = quarantineWith({ retentionSeconds: 86_400, now: () => now });
    const sealed = quarantine.seal("case_1", SECRET_CONTEXT);
    if (!("quarantineId" in sealed)) return;
    const grant = quarantine.grantAccess(sealed.quarantineId, "human_handler", HANDLER);
    now = new Date("2026-11-03T02:00:00.000Z");
    expectCode(() => quarantine.read(sealed.quarantineId, grant, HANDLER), "QUARANTINE_EXPIRED");
    expect(quarantine.get(sealed.quarantineId)).toBeDefined();
  });

  test("a run actor never grants or reads quarantined context", () => {
    const quarantine = quarantineWith();
    const sealed = quarantine.seal("case_1", SECRET_CONTEXT);
    if (!("quarantineId" in sealed)) return;
    const runActor: SecurityActor = { actorId: "run_test", actorKind: "run" };
    expectCode(
      () => quarantine.grantAccess(sealed.quarantineId, "run_test", runActor),
      "QUARANTINE_ACCESS_DENIED",
    );
  });
});

describe("EncryptedQuarantine retention", () => {
  test("expired records refuse reads and are swept with an audit event", () => {
    let now = new Date("2026-11-03T00:00:00.000Z");
    const { events, onEvent } = auditRecorder();
    const quarantine = quarantineWith({
      retentionSeconds: 3600,
      now: () => now,
      onEvent,
    });
    const sealed = quarantine.seal("case_1", SECRET_CONTEXT);
    if (!("quarantineId" in sealed)) return;
    const grant = quarantine.grantAccess(sealed.quarantineId, "human_handler", HANDLER);
    now = new Date("2026-11-03T02:00:00.000Z");
    expectCode(() => quarantine.read(sealed.quarantineId, grant, HANDLER), "QUARANTINE_EXPIRED");
    const swept = quarantine.sweep();
    expect(swept).toEqual([sealed.quarantineId]);
    expect(quarantine.get(sealed.quarantineId)).toBeUndefined();
    expect(events.map((event) => event.type)).toContain("quarantine.expired");
  });
});
