/**
 * Renderer-side access to the workbench settings bridge.
 *
 * The bridge only exists inside Electron; in a plain browser the pickers
 * degrade to the custom-input mode instead of failing.
 */

export interface ProviderAccount {
  id: string;
  provider: "github" | "gitlab";
  instanceUrl: string;
  login: string;
  createdAt: string;
}

export interface ProviderRepository {
  id: string;
  provider: "github" | "gitlab";
  owner: string;
  name: string;
  defaultBranch: string | null;
  private: boolean;
}

export interface ProviderBranch {
  name: string;
  isDefault: boolean;
}

export interface ModelSettingsSnapshot {
  providers: Array<{ id: string; label: string }>;
  current?: {
    provider: string;
    modelId: string;
    baseUrl?: string;
    apiKeyConfigured: boolean;
  };
  secureStorageAvailable: boolean;
}

export interface SaveModelSettingsInput {
  provider: string;
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
}

export function settingsAvailable(): boolean {
  return typeof window !== "undefined" && window.forgePilotSettings !== undefined;
}

function bridge() {
  const value = window.forgePilotSettings;
  if (!value) throw new Error("Workbench settings require the desktop app.");
  return value;
}

export async function listAccounts(): Promise<ProviderAccount[]> {
  return bridge().listAccounts();
}

export async function getModelSettings(): Promise<ModelSettingsSnapshot> {
  return bridge().getModelSettings();
}

export async function saveModelSettings(
  input: SaveModelSettingsInput,
): Promise<ModelSettingsSnapshot> {
  return bridge().saveModelSettings(input);
}

export async function removeModelSettings(): Promise<void> {
  return bridge().removeModelSettings();
}

export async function saveAccount(input: {
  provider: "github" | "gitlab";
  token: string;
  instanceUrl?: string;
}): Promise<ProviderAccount> {
  return bridge().saveAccount(input);
}

export async function removeAccount(accountId: string): Promise<void> {
  return bridge().removeAccount({ accountId });
}

export async function listRepositories(accountId: string): Promise<ProviderRepository[]> {
  return bridge().listRepositories({ accountId });
}

export async function listBranches(
  accountId: string,
  repositoryId: string,
): Promise<ProviderBranch[]> {
  return bridge().listBranches({ accountId, repositoryId });
}

/** Load repositories across every bound account; per-account failures are skipped. */
export async function discoverRepositories(
  accounts: ProviderAccount[],
): Promise<Map<string, ProviderRepository[]>> {
  const result = new Map<string, ProviderRepository[]>();
  await Promise.all(
    accounts.map(async (account) => {
      try {
        result.set(account.id, await listRepositories(account.id));
      } catch {
        result.set(account.id, []);
      }
    }),
  );
  return result;
}
