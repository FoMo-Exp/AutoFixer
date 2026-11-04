import { describe, expect, it, vi } from "vitest";
import {
  INVITE_TOKEN_STORAGE_KEY,
  captureInviteToken,
  groupInviteCode,
  stashInviteToken,
} from "./invite-token";
import type { TokenStorage } from "./invite-token";

const TOKEN = "inv_2ZxQ7mK9pR4tW8vY1uB6cD3eF5gH0jL";

function memoryStorage(initial?: string): TokenStorage & { values: Record<string, string> } {
  const values: Record<string, string> = {};
  if (initial !== undefined) values[INVITE_TOKEN_STORAGE_KEY] = initial;
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
    removeItem: (key) => {
      delete values[key];
    },
  };
}

describe("invite token capture", () => {
  it("captures the fragment token, clears the fragment, and drops any stash", () => {
    const replaceState = vi.fn();
    const storage = memoryStorage(TOKEN);

    const token = captureInviteToken(`#${TOKEN}`, { replaceState }, storage, "/");

    expect(token).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(storage.values).toEqual({});
  });

  it("never treats an ordinary route hash as an invitation", () => {
    const replaceState = vi.fn();
    const token = captureInviteToken("#/workspaces", { replaceState }, memoryStorage(), "/");

    expect(token).toBeUndefined();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("resumes a stashed invitation after provider sign-in and consumes the stash", () => {
    const storage = memoryStorage(TOKEN);

    expect(captureInviteToken("", { replaceState: vi.fn() }, storage, "/")).toBe(TOKEN);
    expect(storage.values).toEqual({});
  });

  it("rejects stash contents that are not token-shaped", () => {
    const storage = memoryStorage("../admin");
    expect(captureInviteToken("", undefined, storage, "/")).toBeUndefined();
    expect(storage.values).toEqual({});
  });

  it("stashes only the token value for the sign-in round trip", () => {
    const storage = memoryStorage();
    stashInviteToken(TOKEN, storage);
    expect(storage.values[INVITE_TOKEN_STORAGE_KEY]).toBe(TOKEN);
  });

  it("groups the code for display while copying yields the exact token", () => {
    const grouped = groupInviteCode(TOKEN);
    expect(grouped).toBe("inv_2ZxQ 7mK9 pR4t W8vY 1uB6 cD3e F5gH 0jL");
    expect(grouped.replace(/ /g, "")).toBe(TOKEN);
  });
});
