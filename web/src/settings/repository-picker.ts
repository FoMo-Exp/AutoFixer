import type { ProviderAccount, ProviderRepository } from "./client";

/**
 * Sentinel option values that switch a picker field to free-text input.
 * The branch sentinel deliberately contains `..`, which is illegal in a
 * valid git ref, so a real branch can never collide with it.
 */
export const CUSTOM_REPOSITORY = "__forgepilot_custom_repository__";
export const CUSTOM_BRANCH = "__forgepilot_custom_branch__..";

/**
 * Which control renders for a picker field. `auto` follows whether the
 * current value is discovered; `select` forces the dropdown open (after
 * "Choose from discovered…"); `input` forces free text (after choosing
 * "Custom…").
 */
export type PickerView = "auto" | "select" | "input";

/** Free-text input for the repository field? */
export function isRepositoryInput(view: PickerView, hasSelection: boolean): boolean {
  if (view === "input") return true;
  if (view === "select") return false;
  return !hasSelection;
}

/**
 * Free-text input for the base-ref field. No branches means nothing to pick,
 * so that stays free text; otherwise auto mode always offers the dropdown —
 * even when the current base ref is not among the discovered branches (e.g.
 * a ref inherited from a previously selected repository, or a repo with no
 * known default branch). Trapping the user in a text box would hide the
 * branches that are right there; instead the select lands on the "Custom
 * ref…" sentinel so the value stays editable while the branches stay
 * visible.
 */
export function isBranchInput(view: PickerView, branchNames: string[]): boolean {
  if (branchNames.length === 0) return true;
  return view === "input";
}

export interface RepositoryOption {
  /** Select-element value; unique per account so two instances never collide. */
  value: string;
  account: ProviderAccount;
  repository: ProviderRepository;
  /** Task-scoped repository id passed to the create-task form. */
  repositoryId: string;
  label: string;
}

/**
 * Build the repository select options from discovery results. Repositories
 * are labelled (and keyed) with their owning account so the same
 * `owner/name` from two bound accounts or instances stays distinguishable.
 */
export function buildRepositoryOptions(
  accounts: ProviderAccount[],
  repositoriesByAccount: Map<string, ProviderRepository[]>,
): RepositoryOption[] {
  const options: RepositoryOption[] = [];
  for (const account of accounts) {
    for (const repository of repositoriesByAccount.get(account.id) ?? []) {
      options.push({
        value: `${account.id}:${repository.id}`,
        account,
        repository,
        repositoryId: repository.id,
        label: `${repository.owner}/${repository.name} · ${account.login} (${account.provider})`,
      });
    }
  }
  return options;
}

/** Repository name (segment after the last `/`) of a task-scoped id. */
function nameOfRepositoryId(id: string): string | undefined {
  const trimmed = id.trim();
  const separator = trimmed.lastIndexOf("/");
  if (separator === -1 || separator === trimmed.length - 1) return undefined;
  return trimmed.slice(separator + 1);
}

/**
 * Pick the option to auto-select when the current repository id resolves to
 * no discovered option (e.g. the form default points at another owner than
 * the bound account sees). Prefers an option whose repository name matches
 * the current id's name — so a default of `github:Luthiel/AutoFixer` resolves
 * to `github:FoMo-Exp/AutoFixer` — then falls back to the first option so
 * the pickers are immediately usable. Returns undefined when there is
 * nothing to pick.
 */
export function pickPrefillOption(
  options: RepositoryOption[],
  currentRepositoryId: string,
): RepositoryOption | undefined {
  if (options.length === 0) return undefined;
  const currentName = nameOfRepositoryId(currentRepositoryId);
  if (currentName) {
    const wanted = currentName.toLowerCase();
    const match = options.find((option) => option.repository.name.toLowerCase() === wanted);
    if (match) return match;
  }
  return options[0];
}

/**
 * Resolve the option for the current selection. The account-scoped value
 * wins when it still matches the form's repository id, so the same repo
 * path bound to two instances selects the account the operator actually
 * picked; otherwise fall back to the first option with a matching
 * repository id.
 */
export function resolveRepositoryOption(
  options: RepositoryOption[],
  repositoryId: string,
  selectedValue: string | undefined,
): RepositoryOption | undefined {
  if (selectedValue) {
    const scoped = options.find(
      (option) => option.value === selectedValue && option.repositoryId === repositoryId,
    );
    if (scoped) return scoped;
  }
  return options.find((option) => option.repositoryId === repositoryId);
}

/** Select element value for the resolved option. */
export function repositorySelectValue(option: RepositoryOption | undefined): string | undefined {
  return option?.value ?? CUSTOM_REPOSITORY;
}

/** Select element value for the current base ref against known branches. */
export function branchSelectValue(baseRef: string, branches: string[]): string {
  return branches.includes(baseRef) ? baseRef : CUSTOM_BRANCH;
}

/** Branch names for the option's repository, default branch first. */
export function orderedBranchNames(
  repository: ProviderRepository | undefined,
  branches: Array<{ name: string; isDefault: boolean }>,
): string[] {
  const names = branches.map((branch) => branch.name);
  const defaultName = repository?.defaultBranch;
  if (defaultName && names.includes(defaultName)) {
    return [defaultName, ...names.filter((name) => name !== defaultName)];
  }
  return names;
}
