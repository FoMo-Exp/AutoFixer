import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Per-process API bearer token.
 *
 * The proof that a caller may act as the local operator — including recording
 * approvals under the configured dsh approver identity — is possession of
 * this process-scoped random token, not the statically configured identity
 * string. The token is minted fresh at every start, written 0600 to a
 * user-private file (the same pattern dsh uses for its boot token), and read
 * by the operator or the UI out of band. A random local process cannot
 * impersonate the operator without reading that file.
 */
export function readOrCreateApiToken(tokenFile: string): string {
  const dir = path.dirname(tokenFile);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const token = randomBytes(32).toString("hex");
  // Replace only regular files so a planted symlink or directory is refused
  // rather than followed or truncated.
  try {
    const stat = fs.lstatSync(tokenFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`refusing to overwrite non-regular API token file ${tokenFile}`);
    }
    fs.unlinkSync(tokenFile);
  } catch (error) {
    const missing =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    if (!missing) {
      throw error;
    }
  }
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
  return token;
}

/** Constant-time check of an `Authorization` header against the token. */
export function isAuthorizedBearer(header: string | string[] | undefined, token: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
    return false;
  }
  // Compare digests so unequal lengths cannot leak through timing either.
  const presented = createHash("sha256").update(value.slice("Bearer ".length)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(presented, expected);
}

/** Loopback-only hosts; the product API must never be reachable off-host. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}
