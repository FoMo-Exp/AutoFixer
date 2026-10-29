import { randomBytes } from "node:crypto";

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { BrowserWindow } from "electron";
import type { SafeStorage } from "electron";

import type { BranchSummary, ProviderClient, RepositorySummary } from "./git-providers.js";
import { ProviderApiError } from "./git-providers.js";
import { normalizeInstanceUrl } from "./git-providers.js";
import type { AccountProjection } from "./settings-store.js";
import {
  ACCOUNT_ID_PATTERN,
  loadAccounts,
  newAccountId,
  saveAccounts,
  toAccountProjection,
} from "./settings-store.js";
import {
  getModelSettingsSnapshot,
  removeModelSettings,
  saveModelSettings,
} from "./model-settings-store.js";
import type { ModelSettingsInput } from "./model-settings-store.js";

/**
 * Settings IPC surface for provider account binding.
 *
 * Same trust model as the API proxy: only the app window's top frame may
 * call these channels, and responses are the renderer-safe projections —
 * account tokens never cross the bridge in either direction (a save sends a
 * token in, and no channel ever returns one).
 */

export interface SettingsIpcOptions {
  statePath: string;
  modelSettingsPath: string;
  safeStorage: SafeStorage;
  client: ProviderClient;
  restartApp: () => void;
  clock?: () => Date;
}

interface SaveAccountInput {
  provider: "github" | "gitlab";
  token: string;
  instanceUrl?: string;
}

const MAX_TOKEN_LENGTH = 4096;

export function installSettingsIpc(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | undefined,
  isTrustedFrameUrl: (url: string) => boolean,
  options: SettingsIpcOptions,
): () => void {
  const clock = options.clock ?? (() => new Date());

  const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
    const window = getWindow();
    return (
      !!window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      isTrustedFrameUrl(event.senderFrame.url)
    );
  };

  const guard = <T>(event: IpcMainInvokeEvent, handler: () => Promise<T>): Promise<T> => {
    if (!isTrustedSender(event)) {
      return Promise.reject(new Error("Untrusted ForgePilot settings caller."));
    }
    return handler();
  };

  const listAccountsHandler = (event: IpcMainInvokeEvent): Promise<AccountProjection[]> =>
    guard(event, async () => loadAccounts(options.statePath).map(toAccountProjection));

  const getModelSettingsHandler = (event: IpcMainInvokeEvent) =>
    guard(event, async () =>
      getModelSettingsSnapshot(options.modelSettingsPath, options.safeStorage),
    );

  const saveModelSettingsHandler = (event: IpcMainInvokeEvent, input: unknown) =>
    guard(event, async () => {
      saveModelSettings(
        options.modelSettingsPath,
        options.safeStorage,
        parseModelSettingsInput(input),
      );
      const snapshot = getModelSettingsSnapshot(options.modelSettingsPath, options.safeStorage);
      // Let the IPC response reach the renderer before relaunching. The app's
      // before-quit handler stops the current orchestrator child cleanly.
      setTimeout(options.restartApp, 350);
      return snapshot;
    });

  const removeModelSettingsHandler = (event: IpcMainInvokeEvent) =>
    guard(event, async () => {
      removeModelSettings(options.modelSettingsPath);
      setTimeout(options.restartApp, 350);
    });

  const saveAccountHandler = (
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<AccountProjection> =>
    guard(event, async () => {
      const parsed = parseSaveInput(input);
      const instanceUrl = normalizeInstanceUrl(parsed.provider, parsed.instanceUrl);
      const { login } = await options.client.verifyAccount(
        parsed.provider,
        instanceUrl,
        parsed.token,
      );
      const accounts = loadAccounts(options.statePath);
      const account = {
        id: newAccountId(randomBytes),
        provider: parsed.provider,
        instanceUrl,
        login,
        token: parsed.token,
        createdAt: clock().toISOString(),
      };
      // Rebinding the same provider+origin replaces the previous account so
      // the list stays one identity per provider instead of accumulating
      // stale tokens.
      const next = accounts.filter(
        (existing) =>
          !(existing.provider === account.provider && existing.instanceUrl === account.instanceUrl),
      );
      next.push(account);
      saveAccounts(options.statePath, next);
      return toAccountProjection(account);
    });

  const removeAccountHandler = (event: IpcMainInvokeEvent, input: unknown): Promise<void> =>
    guard(event, async () => {
      const accountId = requireAccountId(input);
      const accounts = loadAccounts(options.statePath);
      saveAccounts(
        options.statePath,
        accounts.filter((account) => account.id !== accountId),
      );
    });

  const listRepositoriesHandler = (
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<RepositorySummary[]> =>
    guard(event, async () => {
      const account = requireAccount(options.statePath, input);
      return options.client.listRepositories(account);
    });

  const listBranchesHandler = (
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<BranchSummary[]> =>
    guard(event, async () => {
      const parsed = requireInputObject(input);
      const account = requireAccount(options.statePath, parsed);
      const repositoryId = parsed["repositoryId"];
      if (typeof repositoryId !== "string" || repositoryId.trim() === "") {
        throw new Error("repositoryId is required.");
      }
      return options.client.listBranches(account, repositoryId.trim());
    });

  ipcMain.handle("forgepilot:settings:list-accounts", listAccountsHandler);
  ipcMain.handle("forgepilot:settings:get-model", getModelSettingsHandler);
  ipcMain.handle("forgepilot:settings:save-model", saveModelSettingsHandler);
  ipcMain.handle("forgepilot:settings:remove-model", removeModelSettingsHandler);
  ipcMain.handle("forgepilot:settings:save-account", saveAccountHandler);
  ipcMain.handle("forgepilot:settings:remove-account", removeAccountHandler);
  ipcMain.handle("forgepilot:settings:list-repositories", listRepositoriesHandler);
  ipcMain.handle("forgepilot:settings:list-branches", listBranchesHandler);
  return () => {
    ipcMain.removeHandler("forgepilot:settings:list-accounts");
    ipcMain.removeHandler("forgepilot:settings:get-model");
    ipcMain.removeHandler("forgepilot:settings:save-model");
    ipcMain.removeHandler("forgepilot:settings:remove-model");
    ipcMain.removeHandler("forgepilot:settings:save-account");
    ipcMain.removeHandler("forgepilot:settings:remove-account");
    ipcMain.removeHandler("forgepilot:settings:list-repositories");
    ipcMain.removeHandler("forgepilot:settings:list-branches");
  };
}

function parseModelSettingsInput(input: unknown): ModelSettingsInput {
  const record = requireInputObject(input);
  const provider = record["provider"];
  const modelId = record["modelId"];
  const baseUrl = record["baseUrl"];
  const apiKey = record["apiKey"];
  if (typeof provider !== "string" || typeof modelId !== "string") {
    throw new Error("A model provider and model ID are required.");
  }
  if (baseUrl !== undefined && typeof baseUrl !== "string") {
    throw new Error("Base URL must be a string.");
  }
  if (apiKey !== undefined && typeof apiKey !== "string") {
    throw new Error("API key must be a string.");
  }
  return {
    provider: provider as ModelSettingsInput["provider"],
    modelId,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

function parseSaveInput(input: unknown): SaveAccountInput {
  const record = requireInputObject(input);
  const provider = record["provider"];
  if (provider !== "github" && provider !== "gitlab") {
    throw new Error("provider must be github or gitlab.");
  }
  const token = record["token"];
  if (typeof token !== "string" || token.trim() === "" || token.length > MAX_TOKEN_LENGTH) {
    throw new Error("token must be a non-empty string within the length limit.");
  }
  const instanceUrl = record["instanceUrl"];
  if (instanceUrl !== undefined && typeof instanceUrl !== "string") {
    throw new Error("instanceUrl must be a string.");
  }
  return { provider, token: token.trim(), ...(instanceUrl !== undefined ? { instanceUrl } : {}) };
}

function requireInputObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid settings request payload.");
  }
  return input as Record<string, unknown>;
}

function requireAccountId(input: unknown): string {
  const record = requireInputObject(input);
  const accountId = record["accountId"];
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("accountId is invalid.");
  }
  return accountId;
}

function requireAccount(statePath: string, input: unknown) {
  const accountId = requireAccountId(input);
  const account = loadAccounts(statePath).find((entry) => entry.id === accountId);
  if (!account) {
    throw new ProviderApiError("not_found", "The requested account is not bound.");
  }
  return account;
}
