import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadAccounts,
  newAccountId,
  saveAccounts,
  toAccountProjection,
} from "../../electron/settings-store.js";
import type { StoredAccount } from "../../electron/settings-store.js";

function account(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: "acct_0123456789abcdef",
    provider: "github",
    instanceUrl: "https://github.com",
    login: "octocat",
    token: "ghp_secret",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("provider account store", () => {
  let directory: string;
  let statePath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "forgepilot-settings-"));
    statePath = path.join(directory, "provider-accounts.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("round-trips accounts through a user-private file", () => {
    saveAccounts(statePath, [account()]);
    const loaded = loadAccounts(statePath);
    expect(loaded).toEqual([account()]);
    if (process.platform !== "win32") {
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
    }
  });

  it("returns an empty list for a missing file", () => {
    expect(loadAccounts(path.join(directory, "absent.json"))).toEqual([]);
  });

  it("tolerates a corrupt store instead of bricking startup", () => {
    writeFileSync(statePath, "{not json");
    expect(loadAccounts(statePath)).toEqual([]);
  });

  it("drops documents whose accounts fail schema validation", () => {
    writeFileSync(
      statePath,
      JSON.stringify({ version: 1, accounts: [{ id: "acct_1", provider: "github" }] }),
    );
    expect(loadAccounts(statePath)).toEqual([]);
  });

  it("never projects the token to the renderer", () => {
    const projection = toAccountProjection(account());
    expect(projection).not.toHaveProperty("token");
    expect(Object.keys(projection).sort()).toEqual(
      ["createdAt", "id", "instanceUrl", "login", "provider"].sort(),
    );
  });

  it("mints ids matching the account id pattern", () => {
    const id = newAccountId((size) => new Uint8Array(size).fill(7));
    expect(id).toMatch(/^acct_[0-9a-f]{16}$/);
  });

  it("replaces the store without leaving the temp file behind", () => {
    saveAccounts(statePath, [account()]);
    saveAccounts(statePath, [account({ id: "acct_fedcba9876543210", login: "hubot" })]);
    const raw = readFileSync(statePath, "utf8");
    expect(raw).not.toContain("tmp");
    expect(loadAccounts(statePath)).toHaveLength(1);
    expect(loadAccounts(statePath)[0].login).toBe("hubot");
  });
});
