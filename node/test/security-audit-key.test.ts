import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  SecurityError,
  assertProtectedSecurityAuditKeyFile,
  readOrCreateSecurityAuditKey,
} from "../src/security/index.js";

/**
 * DAT-213 blocker: the HMAC key is the only thing that makes a rewritten audit
 * log verify. A key file that is a symlink, a non-regular file, or readable by
 * anyone but its owner lets another local principal forge a chain, so startup
 * must refuse it rather than chain-sign with it.
 */

const OWNER_ONLY = 0o600;
const GROUP_READABLE = 0o640;

function keyDir(): string {
  return mkdtempSync(path.join(tmpdir(), "security-audit-key-"));
}

function onWindows(): boolean {
  return process.platform === "win32";
}

describe("security audit key protection", () => {
  test("creates a missing key as an owner-only regular file", () => {
    const dir = keyDir();
    const keyFile = path.join(dir, "security-audit.key");
    const key = readOrCreateSecurityAuditKey(keyFile);

    expect(key).toHaveLength(32);
    const stat = statSync(keyFile);
    expect(stat.isFile()).toBe(true);
    if (!onWindows()) {
      expect(stat.mode & 0o777).toBe(OWNER_ONLY);
    }
    // The persisted base64 decodes to the same key on the next startup.
    expect(readOrCreateSecurityAuditKey(keyFile).equals(key)).toBe(true);
  });

  test("accepts an existing owner-only key file", () => {
    const dir = keyDir();
    const keyFile = path.join(dir, "security-audit.key");
    const expected = Buffer.alloc(32, 7);
    writeFileSync(keyFile, expected.toString("base64"), { mode: OWNER_ONLY });

    expect(readOrCreateSecurityAuditKey(keyFile).equals(expected)).toBe(true);
    expect(() => assertProtectedSecurityAuditKeyFile(keyFile)).not.toThrow();
  });

  test("rejects a symlink even when it points at a valid key", () => {
    const dir = keyDir();
    const real = path.join(dir, "real.key");
    writeFileSync(real, Buffer.alloc(32, 3).toString("base64"), { mode: OWNER_ONLY });
    const link = path.join(dir, "security-audit.key");
    symlinkSync(real, link);

    expect(() => assertProtectedSecurityAuditKeyFile(link)).toThrow(SecurityError);
    expect(() => readOrCreateSecurityAuditKey(link)).toThrowError(/regular file/);
  });

  test("rejects a directory in place of the key", () => {
    const dir = keyDir();
    const keyFile = path.join(dir, "security-audit.key");
    mkdirSync(keyFile);

    expect(() => readOrCreateSecurityAuditKey(keyFile)).toThrowError(/regular file/);
  });

  test("rejects a group- or world-readable key file", () => {
    if (onWindows()) return;
    const dir = keyDir();
    const keyFile = path.join(dir, "security-audit.key");
    writeFileSync(keyFile, Buffer.alloc(32, 9).toString("base64"), { mode: OWNER_ONLY });
    chmodSync(keyFile, GROUP_READABLE);

    expect(() => assertProtectedSecurityAuditKeyFile(keyFile)).toThrowError(/beyond its owner/);
    expect(() => readOrCreateSecurityAuditKey(keyFile)).toThrow(SecurityError);
  });

  test("rejects a malformed key instead of starting a new chain", () => {
    const dir = keyDir();
    const keyFile = path.join(dir, "security-audit.key");
    writeFileSync(keyFile, Buffer.alloc(16, 1).toString("base64"), { mode: OWNER_ONLY });

    expect(() => readOrCreateSecurityAuditKey(keyFile)).toThrowError(/32-byte/);
    // The malformed file is left in place for an operator to inspect; it is
    // never silently overwritten.
    expect(readFileSync(keyFile, "utf8")).not.toBe("");
  });
});
