import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ProviderAccount, ProviderBranch, ProviderRepository } from "./client";
import { discoverRepositories, listAccounts, listBranches, settingsAvailable } from "./client";
import {
  branchSelectValue,
  buildRepositoryOptions,
  CUSTOM_BRANCH,
  CUSTOM_REPOSITORY,
  isBranchInput,
  isRepositoryInput,
  orderedBranchNames,
  pickPrefillOption,
  repositorySelectValue,
  resolveRepositoryOption,
} from "./repository-picker";
import type { PickerView } from "./repository-picker";

interface RepositoryPickerProps {
  repositoryId: string;
  baseRef: string;
  onChange: (patch: { repositoryId?: string; baseRef?: string }) => void;
  /** Opens the settings dialog when the user wants to bind an account. */
  onOpenSettings: () => void;
  /** Bump to re-run discovery after the account set changed. */
  refreshToken?: number;
}

/**
 * Repository and base-ref selectors backed by bound provider accounts.
 * Both fields keep a two-way path between the discovered-options select and
 * free-text input: choosing "Custom…" switches to typing (keeping the
 * current value), and an unrecognized typed value offers "Choose from
 * discovered…" to return to the select.
 */
export function RepositoryPicker({
  repositoryId,
  baseRef,
  onChange,
  onOpenSettings,
  refreshToken = 0,
}: RepositoryPickerProps): ReactElement {
  const available = settingsAvailable();
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [repositoriesByAccount, setRepositoriesByAccount] = useState<
    Map<string, ProviderRepository[]>
  >(new Map());
  const [branches, setBranches] = useState<ProviderBranch[]>([]);
  // The option value the current branches belong to; rendering ignores the
  // list until it matches the selected option, so a switch can never show
  // the previous repository's branches — not even for one frame.
  const [branchesFor, setBranchesFor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  // Tri-state view per field: auto follows discovery, "Choose from
  // discovered…" forces the select open even when the typed value is not an
  // option, and "Custom…" forces free text. Booleans cannot express the
  // forced-select case — the value stays undiscovered, so a boolean flag
  // would bounce straight back to the input.
  const [repositoryView, setRepositoryView] = useState<PickerView>("auto");
  const [branchView, setBranchView] = useState<PickerView>("auto");
  // Account-scoped selection so the same repo path bound to two instances
  // resolves to the account the operator actually picked.
  const [selectedValue, setSelectedValue] = useState<string | undefined>(undefined);

  const refreshRepositories = useCallback(async (): Promise<void> => {
    if (!settingsAvailable()) return;
    setLoading(true);
    setError(undefined);
    try {
      const bound = await listAccounts();
      setAccounts(bound);
      setRepositoriesByAccount(await discoverRepositories(bound));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Repository discovery failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshRepositories();
  }, [refreshRepositories, refreshToken]);

  const options = useMemo(
    () => buildRepositoryOptions(accounts, repositoriesByAccount),
    [accounts, repositoriesByAccount],
  );
  const selectedOption = useMemo(
    () => resolveRepositoryOption(options, repositoryId, selectedValue),
    [options, repositoryId, selectedValue],
  );

  // Auto-prefill: when discovery lands but the current value resolves to no
  // option (e.g. the form default points at another owner than the bound
  // account sees), select a sensible discovered repository once so the
  // pickers — base ref included — are immediately usable. A ref keeps this
  // to a single nudge; it never overrides an explicit choice or re-fires on
  // later discovery refreshes.
  const didPrefill = useRef(false);
  useEffect(() => {
    if (didPrefill.current) return;
    if (options.length === 0) return;
    if (selectedOption !== undefined) {
      didPrefill.current = true;
      return;
    }
    const option = pickPrefillOption(options, repositoryId);
    if (!option) return;
    didPrefill.current = true;
    setRepositoryView("auto");
    setBranchView("auto");
    setSelectedValue(option.value);
    const patch: { repositoryId: string; baseRef?: string } = {
      repositoryId: option.repositoryId,
    };
    if (option.repository.defaultBranch) patch.baseRef = option.repository.defaultBranch;
    onChange(patch);
  }, [options, selectedOption, repositoryId, onChange]);

  // Free text when the view says so, when nothing was discovered, or when
  // the current value is not among the discovered options. "Choose from
  // discovered…" forces the select open (view = "select") even in the last
  // case, where the select lands on the Custom sentinel until an option is
  // picked.
  const repositoryIsCustom = isRepositoryInput(repositoryView, selectedOption !== undefined);
  const repositoryChooseable = options.length > 0;

  // Branch loading is guarded by repository id so a slow response for the
  // previously selected repository can never overwrite the new list.
  const branchRequestRef = useRef(0);
  const loadBranches = useCallback(
    async (
      account: ProviderAccount,
      repo: ProviderRepository,
      optionValue: string,
    ): Promise<void> => {
      const requestId = ++branchRequestRef.current;
      setBranches([]);
      setBranchesFor(optionValue);
      try {
        const loaded = await listBranches(account.id, repo.id);
        if (branchRequestRef.current === requestId) setBranches(loaded);
      } catch {
        if (branchRequestRef.current === requestId) setBranches([]);
      }
    },
    [],
  );

  useEffect(() => {
    if (selectedOption) {
      void loadBranches(selectedOption.account, selectedOption.repository, selectedOption.value);
    } else {
      branchRequestRef.current += 1;
      setBranches([]);
      setBranchesFor(undefined);
    }
  }, [loadBranches, selectedOption]);

  const branchesAreCurrent = selectedOption !== undefined && branchesFor === selectedOption.value;
  const branchNames = useMemo(
    () => (branchesAreCurrent ? orderedBranchNames(selectedOption?.repository, branches) : []),
    [branches, branchesAreCurrent, selectedOption],
  );
  // Branch text input when Custom was chosen, nothing is discovered, or the
  // typed ref is unknown — with a way back to the select in the last case.
  const branchIsCustom = isBranchInput(branchView, branchNames);
  const branchChooseable = branchNames.length > 0;

  return (
    <>
      <div className="form-grid">
        <label>
          Repository
          {repositoryIsCustom ? (
            <div className="picker-input-row">
              <input
                value={repositoryId}
                onChange={(event) => onChange({ repositoryId: event.target.value })}
                placeholder="github:owner/repo"
                required
              />
              {repositoryChooseable && (
                <button
                  className="button button-quiet button-small"
                  type="button"
                  onClick={() => setRepositoryView("select")}
                >
                  Choose from discovered…
                </button>
              )}
            </div>
          ) : (
            <select
              value={repositorySelectValue(selectedOption)}
              onChange={(event) => {
                const value = event.target.value;
                if (value === CUSTOM_REPOSITORY) {
                  // Switch to free-text input without discarding the current
                  // value, so choosing Custom never loses what is typed.
                  setRepositoryView("input");
                  return;
                }
                const option = options.find((entry) => entry.value === value);
                if (!option) return;
                setRepositoryView("auto");
                setBranchView("auto");
                setSelectedValue(option.value);
                const patch: { repositoryId: string; baseRef?: string } = {
                  repositoryId: option.repositoryId,
                };
                if (option.repository.defaultBranch)
                  patch.baseRef = option.repository.defaultBranch;
                onChange(patch);
              }}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              <option value={CUSTOM_REPOSITORY}>Custom repository ID…</option>
            </select>
          )}
        </label>
        <label>
          Base ref
          {branchIsCustom ? (
            <div className="picker-input-row">
              <input
                value={baseRef}
                onChange={(event) => onChange({ baseRef: event.target.value })}
                placeholder="main"
                required
              />
              {branchChooseable && (
                <button
                  className="button button-quiet button-small"
                  type="button"
                  onClick={() => setBranchView("select")}
                >
                  Choose from branches…
                </button>
              )}
            </div>
          ) : (
            <select
              value={branchSelectValue(baseRef, branchNames)}
              onChange={(event) => {
                const value = event.target.value;
                if (value === CUSTOM_BRANCH) {
                  // Keep the current ref when switching to free-text input.
                  setBranchView("input");
                  return;
                }
                setBranchView("auto");
                onChange({ baseRef: value });
              }}
            >
              {branchNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                  {selectedOption?.repository.defaultBranch === name ? " (default)" : ""}
                </option>
              ))}
              <option value={CUSTOM_BRANCH}>Custom ref…</option>
            </select>
          )}
        </label>
      </div>
      {available && (
        <div className="picker-toolbar">
          {accounts.length === 0 ? (
            <span className="field-hint">
              Bind a GitHub or GitLab account in Settings to pick repositories and branches.
            </span>
          ) : (
            <span className="field-hint">
              {options.length} repositories discovered across {accounts.length} bound{" "}
              {accounts.length === 1 ? "account" : "accounts"}.
            </span>
          )}
          <div className="picker-toolbar-actions">
            {error && <span className="picker-error">{error}</span>}
            <button
              className="button button-quiet button-small"
              type="button"
              disabled={loading}
              onClick={() => void refreshRepositories()}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              className="button button-quiet button-small"
              type="button"
              onClick={onOpenSettings}
            >
              Settings
            </button>
          </div>
        </div>
      )}
    </>
  );
}
