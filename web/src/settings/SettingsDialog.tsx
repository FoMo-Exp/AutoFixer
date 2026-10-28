import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { ProviderAccount } from "../settings/client";
import { listAccounts, removeAccount, saveAccount, settingsAvailable } from "../settings/client";
import { formatDate } from "../ui/format";

interface SettingsDialogProps {
  onClose: () => void;
  /** Called after the account set changes so pickers can refresh. */
  onChanged?: () => void;
}

type Provider = "github" | "gitlab";

const PROVIDER_LABELS: Record<Provider, string> = { github: "GitHub", gitlab: "GitLab" };

export function SettingsDialog({ onClose, onChanged }: SettingsDialogProps): ReactElement {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [provider, setProvider] = useState<Provider>("github");
  const [token, setToken] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const refresh = useCallback(async (): Promise<void> => {
    if (!settingsAvailable()) return;
    try {
      setAccounts(await listAccounts());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Workbench</span>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>
        <p className="modal-intro">
          Bind a Git provider account to discover its repositories and branches in the task
          composer. Tokens stay in the local desktop app and are never sent to the Node service.
        </p>

        {!settingsAvailable() && (
          <div className="inline-error" role="alert">
            <span>Account binding requires the desktop app.</span>
          </div>
        )}

        <section className="settings-accounts">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Connected accounts</span>
              <h3>Providers</h3>
            </div>
            <span className="event-count">{accounts.length} bound</span>
          </div>
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
        </section>

        <form onSubmit={(event) => void handleSave(event)}>
          <div className="form-grid">
            <label>
              Provider
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value as Provider)}
              >
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </select>
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
            <span className="field-hint">
              {provider === "github"
                ? "A token with read access to your repositories (classic: repo scope; fine-grained: read access to repositories)."
                : "A personal access token with the read_api scope."}
            </span>
          </label>
          {error && (
            <div className="inline-error" role="alert">
              <span>{error}</span>
              <button type="button" aria-label="Dismiss error" onClick={() => setError(undefined)}>
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
      </section>
    </div>
  );
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "The settings request failed.";
}
