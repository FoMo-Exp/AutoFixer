import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { ProviderClient, RepositorySummary } from "../../electron/git-providers.js";
import { installSettingsIpc } from "../../electron/settings-ipc.js";

const TRUSTED_URL = "file:///app/dist/index.html";

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: {
    isDestroyed: () => boolean;
    mainFrame: { url: string };
  };
}

function fakeEvent(sender: FakeWindow["webContents"]): IpcMainInvokeEvent {
  return { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent;
}

function fakeIpcMain(
  handlers: Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>,
) {
  return {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  } as unknown as IpcMain;
}

const repositories: RepositorySummary[] = [
  {
    id: "github:octocat/hello",
    provider: "github",
    owner: "octocat",
    name: "hello",
    defaultBranch: "main",
    private: false,
  },
];

const client: ProviderClient = {
  verifyAccount: vi.fn(async () => ({ login: "octocat" })),
  listRepositories: vi.fn(async () => repositories),
  listBranches: vi.fn(async () => [{ name: "main", isDefault: true }]),
};

describe("settings IPC surface", () => {
  let directory: string;
  let statePath: string;
  let handlers: Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>;
  let window: FakeWindow;
  let trustedWindow: FakeWindow;
  let dispose: () => void;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "forgepilot-settings-ipc-"));
    statePath = path.join(directory, "provider-accounts.json");
    handlers = new Map();
    window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: { url: TRUSTED_URL } },
    };
    trustedWindow = window;
    vi.mocked(client.verifyAccount).mockClear();
    dispose = installSettingsIpc(
      fakeIpcMain(handlers),
      () => window as never,
      (url) => url === TRUSTED_URL,
      {
        statePath,
        client,
        clock: () => new Date("2026-02-03T04:05:06.000Z"),
      },
    );
  });

  afterEach(() => {
    dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  function invoke(channel: string, input?: unknown) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(fakeEvent((trustedWindow as FakeWindow).webContents), input);
  }

  it("rejects callers outside the app's top frame", async () => {
    const rogue = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        mainFrame: { url: "https://evil.example.com/" },
      },
    };
    const handler = handlers.get("forgepilot:settings:list-accounts");
    expect(handler).toBeDefined();
    await expect(handler!(fakeEvent(rogue.webContents), undefined)).rejects.toThrow(/Untrusted/);
  });

  it("binds an account after verification and returns a token-free projection", async () => {
    const saved = (await invoke("forgepilot:settings:save-account", {
      provider: "github",
      token: "ghp_secret-token",
    })) as Record<string, unknown>;
    expect(saved["login"]).toBe("octocat");
    expect(saved).not.toHaveProperty("token");
    expect(client.verifyAccount).toHaveBeenCalledWith(
      "github",
      "https://github.com",
      "ghp_secret-token",
    );

    const listed = (await invoke("forgepilot:settings:list-accounts")) as Array<
      Record<string, unknown>
    >;
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("token");
  });

  it("validates the save payload before touching the provider", async () => {
    for (const bad of [
      { provider: "bitbucket", token: "x" },
      { provider: "github", token: "" },
      { provider: "github" },
      "not-an-object",
    ]) {
      await expect(invoke("forgepilot:settings:save-account", bad)).rejects.toThrow();
    }
    expect(client.verifyAccount).not.toHaveBeenCalled();
  });

  it("accepts a custom https origin as the bound instance", async () => {
    const saved = (await invoke("forgepilot:settings:save-account", {
      provider: "gitlab",
      token: "glpat-x",
      instanceUrl: "https://gitlab.example.com/",
    })) as Record<string, unknown>;
    // Any https origin is a legitimate self-hosted instance; the provider
    // client's same-origin guard keeps the token on exactly this origin.
    expect(saved["instanceUrl"]).toBe("https://gitlab.example.com");
  });

  it("lists repositories for a bound account and rejects unknown ids", async () => {
    const saved = (await invoke("forgepilot:settings:save-account", {
      provider: "github",
      token: "ghp_token",
    })) as { id: string };
    const repositories = (await invoke("forgepilot:settings:list-repositories", {
      accountId: saved.id,
    })) as Array<{ id: string }>;
    expect(repositories.map((entry) => entry.id)).toEqual(["github:octocat/hello"]);
    await expect(
      invoke("forgepilot:settings:list-repositories", { accountId: "acct_ffffffffffffffff" }),
    ).rejects.toThrow(/not bound/);
  });

  it("requires both account and repository for branch listing", async () => {
    const saved = (await invoke("forgepilot:settings:save-account", {
      provider: "github",
      token: "ghp_token",
    })) as { id: string };
    await expect(
      invoke("forgepilot:settings:list-branches", { accountId: saved.id }),
    ).rejects.toThrow(/repositoryId/);
    const branches = (await invoke("forgepilot:settings:list-branches", {
      accountId: saved.id,
      repositoryId: "github:octocat/hello",
    })) as Array<{ name: string }>;
    expect(branches.map((entry) => entry.name)).toEqual(["main"]);
  });

  it("removes an account by id", async () => {
    const saved = (await invoke("forgepilot:settings:save-account", {
      provider: "github",
      token: "ghp_token",
    })) as { id: string };
    await invoke("forgepilot:settings:remove-account", { accountId: saved.id });
    expect(await invoke("forgepilot:settings:list-accounts")).toEqual([]);
  });
});
