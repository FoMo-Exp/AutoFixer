import { useCallback, useEffect, useId, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { MODEL_PROVIDERS, defaultModelBaseUrl } from "../../electron/model-providers";
import {
  getModelSettings,
  listAccounts,
  removeAccount,
  removeModelSettings,
  saveAccount,
  saveModelSettings,
  settingsAvailable,
  testModelConnection,
} from "../settings/client";
import type {
  ModelConnectionResult,
  ModelSettingsSnapshot,
  ProviderAccount,
} from "../settings/client";
import { formatDate } from "../ui/format";
import { applySurface, getSurface } from "../ui/surface";
import type { Surface } from "../ui/surface";
import { Select } from "../ui/Select";
import type { ScrollMode } from "../ui/scroll-mode";

interface SettingsDialogProps {
  onClose: () => void;
  /** Called after the account set changes so pickers can refresh. */
  onChanged?: () => void;
  /** Sidebar task-list scroll mode (Appearance tab). */
  scrollMode?: ScrollMode;
  onScrollModeChange?: (mode: ScrollMode) => void;
}

type Provider = "github" | "gitlab";
type SettingsTab = "model" | "accounts" | "appearance";

const PROVIDER_LABELS: Record<Provider, string> = { github: "GitHub", gitlab: "GitLab" };

export function SettingsDialog({
  onClose,
  onChanged,
  scrollMode = "normal",
  onScrollModeChange,
}: SettingsDialogProps): ReactElement {
  const modelFieldsId = useId();
  const [activeTab, setActiveTab] = useState<SettingsTab>("model");
  const [surface, setSurfaceState] = useState<Surface>(() => getSurface());
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [modelSettings, setModelSettings] = useState<ModelSettingsSnapshot>();
  const [modelSettingsLoading, setModelSettingsLoading] = useState(true);
  const [modelSettingsLoadError, setModelSettingsLoadError] = useState<string>();
  const [modelProvider, setModelProvider] = useState("anthropic");
  const [modelId, setModelId] = useState("");
  const [modelBaseUrl, setModelBaseUrl] = useState(defaultModelBaseUrl("anthropic"));
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [modelTesting, setModelTesting] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<
    ModelConnectionResult & { revision: string }
  >();
  const [modelError, setModelError] = useState<string>();
  const [modelNotice, setModelNotice] = useState<string>();
  const [provider, setProvider] = useState<Provider>("github");
  const [token, setToken] = useState("");
  const [tokenSaved, setTokenSaved] = useState(false);
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
        setModelBaseUrl(
          nextModelSettings.current.baseUrl ??
            defaultModelBaseUrl(nextModelSettings.current.provider),
        );
      } else {
        setModelProvider(MODEL_PROVIDERS[0].id);
        setModelBaseUrl(defaultModelBaseUrl(MODEL_PROVIDERS[0].id));
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
    modelSettings?.current?.provider === modelProvider && modelSettings.current.apiKeyConfigured;
  const modelRevision = JSON.stringify([modelProvider, modelBaseUrl, modelApiKey]);
  const currentTestResult =
    modelTestResult?.revision === modelRevision ? modelTestResult : undefined;
  const availableModels = currentTestResult?.ok ? currentTestResult.models : undefined;

  function changeModelProvider(provider: string): void {
    setModelProvider(provider);
    setModelBaseUrl(defaultModelBaseUrl(provider));
    setModelApiKey("");
    setModelId("");
    setModelTestResult(undefined);
  }

  async function handleTestModel(): Promise<void> {
    if (!modelSettings || modelBusy || modelTesting) return;
    setModelTesting(true);
    setModelTestResult(undefined);
    try {
      const result = await testModelConnection({
        provider: modelProvider,
        ...(modelBaseUrl.trim() ? { baseUrl: modelBaseUrl.trim() } : {}),
        ...(modelApiKey.trim() ? { apiKey: modelApiKey.trim() } : {}),
      });
      setModelTestResult({ ...result, revision: modelRevision });
      if (result.ok && result.models?.length) {
        setModelId((current) => (result.models!.includes(current) ? current : result.models![0]));
      }
    } catch (caught) {
      setModelTestResult({ ok: false, message: errorMessage(caught), revision: modelRevision });
    } finally {
      setModelTesting(false);
    }
  }

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
      setModelBaseUrl(defaultModelBaseUrl(modelProvider));
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
      });
      setToken("");
      setTokenSaved(true);
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
            {modelSettings?.current && <span className="settings-tab-status" aria-hidden="true" />}
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
            Repository Accounts
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
            <div className="form-grid model-settings-fields">
              <div className="picker-field">
                <label htmlFor={`${modelFieldsId}-provider`}>Provider</label>
                <Select
                  id={`${modelFieldsId}-provider`}
                  value={modelProvider}
                  onChange={changeModelProvider}
                  disabled={!modelSettings || modelSettingsLoading || modelBusy || modelTesting}
                  options={MODEL_PROVIDERS.map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                />
              </div>
              <div className="picker-field">
                <label htmlFor={`${modelFieldsId}-url`}>API base URL</label>
                <input
                  id={`${modelFieldsId}-url`}
                  value={modelBaseUrl}
                  onChange={(event) => setModelBaseUrl(event.target.value)}
                  placeholder="https://api.example.com/v1"
                  autoComplete="url"
                  required
                  disabled={!modelSettings || modelSettingsLoading || modelBusy || modelTesting}
                />
              </div>
              <div className="picker-field">
                <label htmlFor={`${modelFieldsId}-key`}>
                  <span className="label-text">
                    API key
                    {modelProvider !== "openai-compatible" && (
                      <span className="required-dot">*</span>
                    )}
                  </span>
                </label>
                <input
                  id={`${modelFieldsId}-key`}
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
                  disabled={!modelSettings || modelSettingsLoading || modelBusy || modelTesting}
                />
              </div>
              <div className="picker-field">
                <label htmlFor={`${modelFieldsId}-model`}>Model ID</label>
                {availableModels?.length ? (
                  <Select
                    id={`${modelFieldsId}-model`}
                    value={modelId}
                    onChange={setModelId}
                    options={availableModels.map((id) => ({ value: id, label: id }))}
                    disabled={modelBusy || modelTesting}
                  />
                ) : (
                  <input
                    id={`${modelFieldsId}-model`}
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                    placeholder="Test connection to discover models"
                    autoComplete="off"
                    required
                    disabled={!modelSettings || modelSettingsLoading || modelBusy || modelTesting}
                  />
                )}
              </div>
            </div>
            {modelError && (
              <div className="picker-error" role="alert">
                {modelError}
              </div>
            )}
            {modelNotice && <div className="success-label">{modelNotice}</div>}
            {currentTestResult && (
              <div
                className={currentTestResult.ok ? "success-label" : "picker-error"}
                role={currentTestResult.ok ? "status" : "alert"}
              >
                {currentTestResult.message}
                {currentTestResult.ok && currentTestResult.latencyMs !== undefined
                  ? ` (${currentTestResult.latencyMs} ms)`
                  : ""}
              </div>
            )}
            <div className="modal-footer">
              <span className="field-hint">Test the endpoint to load available models.</span>
              <div className="modal-actions">
                {modelSettings?.current && (
                  <button
                    className="button button-quiet button-small"
                    type="button"
                    disabled={modelBusy || modelTesting}
                    onClick={() => void handleRemoveModel()}
                  >
                    Remove
                  </button>
                )}
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={
                    !modelSettings ||
                    modelSettingsLoading ||
                    modelBusy ||
                    modelTesting ||
                    !modelBaseUrl.trim()
                  }
                  onClick={() => void handleTestModel()}
                >
                  {modelTesting ? "Testing…" : "Test connection"}
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={
                    !modelSettings ||
                    modelBusy ||
                    modelTesting ||
                    !modelId.trim() ||
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
                <span className="eyebrow">Account Management</span>
                <h3>Remote Configuration</h3>
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
            <div className="form-grid account-form-grid">
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
                Access token
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={
                    tokenSaved ? "••••••••" : provider === "github" ? "ghp_…" : "glpat-…"
                  }
                  autoComplete="off"
                  required
                />
              </label>
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
          <div className="scroll-picker" role="radiogroup" aria-label="Task list scroll">
            <span className="scroll-picker-label">Task list</span>
            <div className="scroll-picker-options">
              {(["normal", "stacked"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={scrollMode === value}
                  className={`scroll-option${scrollMode === value ? " selected" : ""}`}
                  onClick={() => onScrollModeChange?.(value)}
                >
                  <span className={`scroll-preview scroll-preview-${value}`} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="scroll-option-label">
                    {value === "normal" ? "Normal" : "Stacked"}
                  </span>
                </button>
              ))}
            </div>
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
