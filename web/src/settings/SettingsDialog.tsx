import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import {
  getModelSettings,
  listAccounts,
  removeAccount,
  removeModelSettings,
  saveAccount,
  saveModelSettings,
  settingsAvailable,
} from "../settings/client";
import type { ModelSettingsSnapshot, ProviderAccount } from "../settings/client";
import { formatDate } from "../ui/format";
import { applySurface, getSurface } from "../ui/surface";
import type { Surface } from "../ui/surface";
import { Select } from "../ui/Select";

interface SettingsDialogProps {
  onClose: () => void;
  /** Called after the account set changes so pickers can refresh. */
  onChanged?: () => void;
}

type Provider = "github" | "gitlab";
type SettingsTab = "model" | "accounts" | "appearance";

const PROVIDER_LABELS: Record<Provider, string> = { github: "GitHub", gitlab: "GitLab" };

export function SettingsDialog({ onClose, onChanged }: SettingsDialogProps): ReactElement {
  const [activeTab, setActiveTab] = useState<SettingsTab>("model");
  const [surface, setSurfaceState] = useState<Surface>(() => getSurface());
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [modelSettings, setModelSettings] = useState<ModelSettingsSnapshot>();
  const [modelSettingsLoading, setModelSettingsLoading] = useState(true);
  const [modelSettingsLoadError, setModelSettingsLoadError] = useState<string>();
  const [modelProvider, setModelProvider] = useState("anthropic");
  const [modelId, setModelId] = useState("");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string>();
  const [modelNotice, setModelNotice] = useState<string>();
  const [provider, setProvider] = useState<Provider>("github");
  const [token, setToken] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const refresh = useCallback(async (): Promise<void> => {
    if (!settingsAvailable()) {
      setModelSettingsLoading(false);
      return;
    }
    setModelSettingsLoading(true);
    setModelSettingsLoadError(undefined);
    const [accountsResult, modelResult] = await Promise.allSettled([
      Promise.resolve().then(listAccounts),
      Promise.resolve().then(getModelSettings),
    ]);
    if (accountsResult.status === "fulfilled") {
      setAccounts(accountsResult.value);
    } else {
      setError(errorMessage(accountsResult.reason));
    }
    if (modelResult.status === "fulfilled") {
      const nextModelSettings = modelResult.value;
      setModelSettings(nextModelSettings);
      if (nextModelSettings.current) {
        setModelProvider(nextModelSettings.current.provider);
        setModelId(nextModelSettings.current.modelId);
        setModelBaseUrl(nextModelSettings.current.baseUrl ?? "");
      } else if (nextModelSettings.providers[0]) {
        setModelProvider(nextModelSettings.providers[0].id);
      }
    } else {
      setModelSettingsLoadError(modelSettingsLoadErrorMessage(modelResult.reason));
    }
    setModelSettingsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const keepsStoredModelKey =
    modelSettings?.current?.provider === modelProvider &&
    modelSettings.current.apiKeyConfigured;

  async function handleSaveModel(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!modelSettings) return;
    setModelBusy(true);
    setModelError(undefined);
    setModelNotice(undefined);
    try {
      const saved = await saveModelSettings({
        provider: modelProvider,
        modelId: modelId.trim(),
        ...(modelBaseUrl.trim() ? { baseUrl: modelBaseUrl.trim() } : {}),
        ...(modelApiKey.trim() ? { apiKey: modelApiKey.trim() } : {}),
      });
      setModelSettings(saved);
      setModelApiKey("");
      setModelNotice("Saved securely. Restarting ForgePilot to apply the model…");
    } catch (caught) {
      setModelError(errorMessage(caught));
    } finally {
      setModelBusy(false);
    }
  }

  async function handleRemoveModel(): Promise<void> {
    if (!window.confirm("Remove the saved model configuration and restart ForgePilot?")) return;
    setModelBusy(true);
    setModelError(undefined);
    setModelNotice(undefined);
    try {
      await removeModelSettings();
      setModelSettings((current) => (current ? { ...current, current: undefined } : current));
      setModelApiKey("");
      setModelId("");
      setModelBaseUrl("");
      setModelNotice("Model configuration removed. Restarting ForgePilot…");
    } catch (caught) {
      setModelError(errorMessage(caught));
      setModelBusy(false);
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const account = await saveAccount({
        provider,
        token: token.trim(),
        ...(instanceUrl.trim() ? { instanceUrl: instanceUrl.trim() } : {}),
      });
      setToken("");
      setInstanceUrl("");
      setNotice(`${PROVIDER_LABELS[account.provider]} account @${account.login} bound.`);
      await refresh();
      onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(accountId: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await removeAccount(accountId);
      await refresh();
      onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal modal-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Workbench</span>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          <button
            id="settings-tab-model"
            className={`settings-tab${activeTab === "model" ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "model"}
            aria-controls="settings-panel-model"
            onClick={() => setActiveTab("model")}
          >
            Model
            {modelSettings?.current && (
              <span className="settings-tab-status" aria-hidden="true" />
            )}
          </button>
          <button
            id="settings-tab-accounts"
            className={`settings-tab${activeTab === "accounts" ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "accounts"}
            aria-controls="settings-panel-accounts"
            onClick={() => setActiveTab("accounts")}
          >
            Repository accounts
          </button>
          <button
            id="settings-tab-appearance"
            className={`settings-tab${activeTab === "appearance" ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "appearance"}
            aria-controls="settings-panel-appearance"
            onClick={() => setActiveTab("appearance")}
          >
            Appearance
          </button>
        </div>

        <section
          className="settings-panel settings-model"
          id="settings-panel-model"
          role="tabpanel"
          aria-labelledby="settings-tab-model"
          tabIndex={0}
          hidden={activeTab !== "model"}
        >
          <div className="settings-panel-heading">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Orchestrator</span>
                <h3>Model configuration</h3>
              </div>
              <span className="event-count">
                {modelSettingsLoading
                  ? "Loading…"
                  : modelSettingsLoadError
                    ? "Unavailable"
                    : modelSettings?.current
                      ? "Configured"
                      : "Not configured"}
              </span>
            </div>
          </div>
          {!settingsAvailable() && (
            <div className="picker-error" role="status">
              Model configuration requires the Electron desktop app.
            </div>
          )}
          {modelSettings && !modelSettings.secureStorageAvailable && (
            <div className="picker-error" role="status">
              System secure storage is unavailable. API keys cannot be saved on this device.
            </div>
          )}
          {modelSettingsLoading && (
            <div className="picker-error" role="status">
              Loading model settings…
            </div>
          )}
          {modelSettingsLoadError && (
            <div className="picker-error" role="alert">
              {modelSettingsLoadError}
            </div>
          )}
          <form className="model-settings-form" onSubmit={(event) => void handleSaveModel(event)}>
            <div className="form-grid">
              <label>
                Provider
                <Select
                  value={modelProvider}
                  onChange={setModelProvider}
                  disabled={!modelSettings || modelSettingsLoading || modelBusy}
                  options={(modelSettings?.providers ?? []).map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                />
              </label>
              <label>
                Model ID
                <input
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  placeholder={
                    modelProvider === "openai-compatible"
                      ? "e.g. llama3.1"
                      : "e.g. claude-sonnet-4-20250514"
                  }
                  autoComplete="off"
                  required
                  disabled={!modelSettings || modelSettingsLoading || modelBusy}
                />
              </label>
            </div>
            <div className="form-grid model-settings-fields">
              <label>
                API base URL <span className="optional">optional</span>
                <input
                  value={modelBaseUrl}
                  onChange={(event) => setModelBaseUrl(event.target.value)}
                  placeholder={
                    modelProvider === "openai-compatible"
                      ? "https://api.example.com/v1"
                      : "Use the provider default"
                  }
                  autoComplete="url"
                  required={modelProvider === "openai-compatible"}
                  disabled={!modelSettings || modelSettingsLoading || modelBusy}
                />
              </label>
              <label>
                API key{" "}
                <span className="optional">
                  {modelProvider === "openai-compatible"
                    ? "optional for local endpoints"
                    : "required"}
                </span>
                <input
                  type="password"
                  value={modelApiKey}
                  onChange={(event) => setModelApiKey(event.target.value)}
                  placeholder={
                    keepsStoredModelKey
                      ? "Saved securely; leave blank to keep it"
                      : "Enter provider API key"
                  }
                  autoComplete="new-password"
                  required={modelProvider !== "openai-compatible" && !keepsStoredModelKey}
                  disabled={!modelSettings || modelSettingsLoading || modelBusy}
                />
              </label>
            </div>
            {modelError && (
              <div className="picker-error" role="alert">
                {modelError}
              </div>
            )}
            {modelNotice && <div className="success-label">{modelNotice}</div>}
            <div className="modal-footer">
              <div className="modal-actions">
                {modelSettings?.current && (
                  <button
                    className="button button-quiet button-small"
                    type="button"
                    disabled={modelBusy}
                    onClick={() => void handleRemoveModel()}
                  >
                    Remove
                  </button>
                )}
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={
                    !modelSettings ||
                    modelBusy ||
                    (modelSettings.secureStorageAvailable === false &&
                      (!!modelApiKey.trim() || keepsStoredModelKey))
                  }
                >
                  {modelBusy ? "Saving…" : "Save and restart"}
                </button>
              </div>
            </div>
          </form>
        </section>
        <section
          className="settings-panel settings-accounts"
          id="settings-panel-accounts"
          role="tabpanel"
          aria-labelledby="settings-tab-accounts"
          tabIndex={0}
          hidden={activeTab !== "accounts"}
        >
          <div className="settings-panel-heading">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Connected accounts</span>
                <h3>Repository accounts</h3>
              </div>
              <span className="event-count">{accounts.length} bound</span>
            </div>
          </div>
          {!settingsAvailable() && (
            <div className="picker-error" role="status">
              Account binding requires the Electron desktop app.
            </div>
          )}
          <form onSubmit={(event) => void handleSave(event)}>
            <div className="form-grid">
              <label>
                Provider
                <Select
                  value={provider}
                  onChange={(v) => setProvider(v as Provider)}
                  options={[
                    { value: "github", label: "GitHub" },
                    { value: "gitlab", label: "GitLab" },
                  ]}
                />
              </label>
              <label>
                Instance <span className="optional">optional</span>
                <input
                  value={instanceUrl}
                  onChange={(event) => setInstanceUrl(event.target.value)}
                  placeholder={provider === "github" ? "https://github.com" : "https://gitlab.com"}
                />
              </label>
            </div>
            <div className="form-grid settings-account-fields">
              <label>
                Access token
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={provider === "github" ? "ghp_…" : "glpat-…"}
                  autoComplete="off"
                  required
                />
              </label>
              <div className="settings-field-note">
                <span>Required access</span>
                <p>
                  {provider === "github"
                    ? "GitHub: read access to repositories."
                    : "GitLab: read_api scope."}
                </p>
              </div>
            </div>
            {error && (
              <div className="inline-error" role="alert">
                <span>{error}</span>
                <button
                  type="button"
                  aria-label="Dismiss error"
                  onClick={() => setError(undefined)}
                >
                  ×
                </button>
              </div>
            )}
            {notice && <div className="success-label">{notice}</div>}
            <div className="modal-footer">
              <span className="field-hint">
                Tokens are stored locally with owner-only permissions.
              </span>
              <div className="modal-actions">
                <button className="button button-secondary" type="button" onClick={onClose}>
                  Close
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={busy || !settingsAvailable() || !token.trim()}
                >
                  {busy ? "Verifying…" : "Bind account"}
                </button>
              </div>
            </div>
          </form>
          <div className="settings-bound-accounts">
            <div className="settings-bound-accounts-heading">Bound accounts</div>
            {accounts.length === 0 ? (
              <div className="card-empty compact">No provider accounts bound yet.</div>
            ) : (
              <div className="settings-account-list">
                {accounts.map((account) => (
                  <div className="settings-account-row" key={account.id}>
                    <span className="provider-badge">{PROVIDER_LABELS[account.provider]}</span>
                    <div className="settings-account-copy">
                      <strong>@{account.login}</strong>
                      <span>
                        {account.instanceUrl} · bound {formatDate(account.createdAt)}
                      </span>
                    </div>
                    <button
                      className="button button-quiet button-small"
                      disabled={busy}
                      onClick={() => void handleRemove(account.id)}
                    >
                      Disconnect
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
        <section
          className="settings-panel settings-appearance"
          id="settings-panel-appearance"
          role="tabpanel"
          aria-labelledby="settings-tab-appearance"
          tabIndex={0}
          hidden={activeTab !== "appearance"}
        >
          <div className="settings-panel-heading">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Theme</span>
                <h3>Appearance</h3>
              </div>
            </div>
          </div>
          <div className="surface-picker" role="radiogroup" aria-label="Surface">
            {(["dark", "light"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={surface === value}
                className={`surface-option${surface === value ? " selected" : ""}`}
                onClick={() => {
                  setSurfaceState(value);
                  applySurface(value);
                }}
              >
                <span className={`surface-swatch surface-swatch-${value}`} aria-hidden="true">
                  <span className="surface-swatch-accent" />
                </span>
                <span className="surface-option-label">{value === "dark" ? "Dark" : "Light"}</span>
              </button>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "The settings request failed.";
}

function modelSettingsLoadErrorMessage(caught: unknown): string {
  const message = errorMessage(caught);
  if (message.includes("No handler registered for 'forgepilot:settings:get-model'")) {
    return "The Electron main process is out of date. Fully quit and reopen ForgePilot to enable model settings.";
  }
  return `Could not load model settings: ${message}`;
}
