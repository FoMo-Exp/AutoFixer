/// <reference types="vite/client" />

interface ProviderAccountSummary {
  id: string;
  provider: "github" | "gitlab";
  instanceUrl: string;
  login: string;
  createdAt: string;
}

interface ProviderRepositorySummary {
  id: string;
  provider: "github" | "gitlab";
  owner: string;
  name: string;
  defaultBranch: string | null;
  private: boolean;
}

interface ProviderBranchSummary {
  name: string;
  isDefault: boolean;
}

interface Window {
  forgePilotConfig?: {
    apiBaseUrl: string;
    startupError?: string;
  };
  forgePilotApi?: {
    request: (request: {
      requestId: string;
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => Promise<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body?: string;
      stream: boolean;
    }>;
    abort: (requestId: string) => void;
    onStream: (
      requestId: string,
      callback: (message: {
        type: "chunk" | "end" | "error";
        text?: string;
        message?: string;
      }) => void,
    ) => () => void;
  };
  forgePilotSettings?: {
    getModelSettings: () => Promise<{
      providers: Array<{ id: string; label: string }>;
      current?: {
        provider: string;
        modelId: string;
        baseUrl?: string;
        apiKeyConfigured: boolean;
      };
      secureStorageAvailable: boolean;
    }>;
    saveModelSettings: (input: {
      provider: string;
      modelId: string;
      baseUrl?: string;
      apiKey?: string;
    }) => Promise<{
      providers: Array<{ id: string; label: string }>;
      current?: {
        provider: string;
        modelId: string;
        baseUrl?: string;
        apiKeyConfigured: boolean;
      };
      secureStorageAvailable: boolean;
    }>;
    removeModelSettings: () => Promise<void>;
    listAccounts: () => Promise<ProviderAccountSummary[]>;
    saveAccount: (input: {
      provider: "github" | "gitlab";
      token: string;
      instanceUrl?: string;
    }) => Promise<ProviderAccountSummary>;
    removeAccount: (input: { accountId: string }) => Promise<void>;
    listRepositories: (input: { accountId: string }) => Promise<ProviderRepositorySummary[]>;
    listBranches: (input: {
      accountId: string;
      repositoryId: string;
    }) => Promise<ProviderBranchSummary[]>;
  };
}
