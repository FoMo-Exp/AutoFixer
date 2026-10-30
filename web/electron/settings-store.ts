import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A bound Git provider account as persisted by the workbench main process. */
export interface StoredAccount {
  id: string;
  provider: "github" | "gitlab";
  /** Normalized provider origin (no trailing slash), e.g. https://github.com. */
  instanceUrl: string;
  /** Verified identity login at bind time. */
  login: string;
  /** Secret. Never leaves the main process; never serialized to the renderer. */
  token: string;
  createdAt: string;
}

/** The renderer-safe projection of a stored account: no token field exists. */
export interface AccountProjection {
  id: string;
  provider: "github" | "gitlab";
  instanceUrl: string;
  login: string;
  createdAt: string;
}

interface StoreDocument {
  version: 1;
  accounts: StoredAccount[];
}

export const ACCOUNT_ID_PATTERN = /^acct_[0-9a-f]{16}$/;

export function newAccountId(randomBytes: (size: number) => Uint8Array): string {
  return `acct_${Buffer.from(randomBytes(8)).toString("hex")}`;
}

export function toAccountProjection(account: StoredAccount): AccountProjection {
  const { id, provider, instanceUrl, login, createdAt } = account;
  return { id, provider, instanceUrl, login, createdAt };
}

/**
 * Read the account store. A missing or unreadable file yields an empty list
 * so a corrupt store can never brick startup; the file is rewritten from
 * memory on the next save.
 */
export function loadAccounts(filePath: string): StoredAccount[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isStoreDocument(document)) return [];
  return document.accounts;
}

/**
 * Persist the account store atomically (write temp file, then rename) with
 * user-only permissions. The parent directory is created 0700 when this
 * function creates it.
 */
export function saveAccounts(filePath: string, accounts: StoredAccount[]): void {
  const document: StoreDocument = { version: 1, accounts };
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

function isStoreDocument(value: unknown): value is StoreDocument {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1 || !Array.isArray(record["accounts"])) return false;
  return record["accounts"].every(isStoredAccount);
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    ACCOUNT_ID_PATTERN.test(record["id"]) &&
    (record["provider"] === "github" || record["provider"] === "gitlab") &&
    typeof record["instanceUrl"] === "string" &&
    typeof record["login"] === "string" &&
    typeof record["token"] === "string" &&
    typeof record["createdAt"] === "string"
  );
}
