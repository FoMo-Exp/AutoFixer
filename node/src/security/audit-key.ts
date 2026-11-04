import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SecurityError } from "./types.js";

const KEY_BYTES = 32;

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/**
 * Refuse a key file that another local principal could read or replace. A
 * symlink is rejected even when its target is a regular 0600 file: the link
 * itself can be retargeted, and the service would then chain-sign with an
 * attacker-supplied key. Group/other permission bits are rejected because the
 * HMAC key is the only thing that makes a rewritten log verify.
 */
export function assertProtectedSecurityAuditKeyFile(keyFile: string): void {
  let stat: fs.Stats;
  try {
    // lstat, not stat: a symlink must never be followed here.
    stat = fs.lstatSync(keyFile);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!stat.isFile()) {
    throw new SecurityError(
      "SECURITY_AUDIT_KEY_UNPROTECTED",
      "the security audit key must be a regular file, not a symlink, directory, or special file",
      { file: keyFile },
    );
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new SecurityError(
      "SECURITY_AUDIT_KEY_UNPROTECTED",
      "the security audit key is readable or writable beyond its owner; fix its mode (0600) first",
      { file: keyFile, mode: (stat.mode & 0o777).toString(8) },
    );
  }
}

/**
 * Read the protected audit-chain key, creating it 0600 on first use. An
 * existing key that is unprotected, unreadable, or malformed fails startup
 * instead of silently starting a new chain (which would orphan the anchored
 * history and make forged records indistinguishable from real ones).
 */
export function readOrCreateSecurityAuditKey(keyFile: string): Buffer {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertProtectedSecurityAuditKeyFile(keyFile);
    try {
      const decoded = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
      if (decoded.length !== KEY_BYTES) {
        throw new SecurityError(
          "SECURITY_AUDIT_KEY_INVALID",
          "the security audit key must be a base64 32-byte value",
          { file: keyFile },
        );
      }
      return decoded;
    } catch (error) {
      if (!isMissing(error)) throw error;
      fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      try {
        const fd = fs.openSync(keyFile, "wx", 0o600);
        try {
          fs.writeSync(fd, randomBytes(KEY_BYTES).toString("base64"));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch (createError) {
        if ((createError as { code?: unknown }).code !== "EEXIST") throw createError;
        // Another process created it first; validate and read it next pass.
      }
    }
  }
  throw new SecurityError(
    "SECURITY_AUDIT_KEY_INVALID",
    `could not read or create the security audit key at ${keyFile}`,
    { file: keyFile },
  );
}
