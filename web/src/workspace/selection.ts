import type { Workspace } from "../api/client";

/**
 * Workspace selection is a non-sensitive UI locator: the chosen workspace id
 * is stored per signed-in user and restored after a reload. It is never an
 * authorization input — the Node service resolves the caller's live
 * membership for every request and answers a foreign id the same way it
 * answers an unknown one.
 */
const STORAGE_PREFIX = "fp-workspace:";

export interface SelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function workspaceStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

export function readStoredWorkspaceId(
  storage: SelectionStorage,
  userId: string,
): string | undefined {
  try {
    const value = storage.getItem(workspaceStorageKey(userId))?.trim();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}

export function storeWorkspaceId(storage: SelectionStorage, userId: string, workspaceId: string) {
  try {
    storage.setItem(workspaceStorageKey(userId), workspaceId);
  } catch {
    // Storage can be unavailable (private mode, quota); selection then lives
    // for this page's lifetime only.
  }
}

export function clearStoredWorkspaceId(storage: SelectionStorage, userId: string): void {
  try {
    storage.removeItem(workspaceStorageKey(userId));
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/**
 * Resolve the workspace to show. A stored id wins when it is still in the
 * caller's live list; otherwise a single accessible workspace is selected
 * deterministically; two or more with no stored id require an explicit
 * choice rather than an arbitrary default.
 */
export function resolveWorkspace(
  workspaces: Workspace[],
  storedId: string | undefined,
): Workspace | undefined {
  if (workspaces.length === 0) return undefined;
  if (storedId !== undefined) {
    const stored = workspaces.find((workspace) => workspace.id === storedId);
    if (stored !== undefined) return stored;
  }
  return workspaces.length === 1 ? workspaces[0] : undefined;
}
