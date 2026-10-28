import type { ProviderAccount, ProviderRepository } from "./client";

/**
 * Sentinel option values that switch a picker field to free-text input.
 * The branch sentinel deliberately contains `..`, which is illegal in a
 * valid git ref, so a real branch can never collide with it.
 */
export const CUSTOM_REPOSITORY = "__forgepilot_custom_repository__";
export const CUSTOM_BRANCH = "__forgepilot_custom_branch__..";

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
