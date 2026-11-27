import { ApiError } from "../api/client";
import type { TaskTargetCandidate, TaskTargetList, TaskTargetSelection } from "../api/client";

/** The selection read as the create dialog sees it. */
export interface TaskTargetView {
  status: "loading" | "ready" | "error";
  list?: TaskTargetList;
  error?: string;
}

export const INITIAL_TARGET_VIEW: TaskTargetView = { status: "loading" };

/**
 * Codes that prove the selection was formed against a set the service no
 * longer accepts. Every one of them requires re-reading the list; retrying the
 * same body would be refused again.
 */
const STALE_TARGET_CODES: Record<string, true> = {
  REPOSITORY_NOT_IN_WORKSPACE: true,
  REPOSITORY_SET_VERSION_CONFLICT: true,
  TARGET_IDENTITY_MISMATCH: true,
  TARGET_BASELINE_MISMATCH: true,
  REPOSITORY_BINDING_UNAVAILABLE: true,
};

export function isStaleTargetError(error: unknown): boolean {
  return error instanceof ApiError && STALE_TARGET_CODES[error.code] === true;
}

export function hasTrustedBaseline(
  candidate: TaskTargetCandidate,
): candidate is TaskTargetCandidate & {
  baseline: { state: "trusted"; base_ref: string; base_sha: string };
} {
  return candidate.baseline.state === "trusted";
}

export function targetLabel(candidate: TaskTargetCandidate): string {
  return candidate.repository_name ?? candidate.repository_id;
}

/** The candidate the user picked, or undefined when it is no longer offered. */
export function selectedCandidate(
  list: TaskTargetList | undefined,
  bindingId: string,
): TaskTargetCandidate | undefined {
  if (list === undefined || bindingId === "") return undefined;
  return list.targets.find((candidate) => candidate.binding_id === bindingId);
}

/** The single target a legacy single-repository create is pinned to. */
export function singleCandidate(list: TaskTargetList | undefined): TaskTargetCandidate | undefined {
  if (list === undefined || list.selection_required || list.targets.length !== 1) return undefined;
  return list.targets[0];
}

export function taskTargetCreateReady(view: TaskTargetView, bindingId: string): boolean {
  if (view.status !== "ready" || view.list === undefined) return false;
  const list = view.list;
  if (!list.usable || list.targets.length === 0) return false;
  if (list.selection_required) {
    const candidate = selectedCandidate(list, bindingId);
    return candidate !== undefined && hasTrustedBaseline(candidate);
  }
  const candidate = singleCandidate(list);
  return candidate !== undefined && hasTrustedBaseline(candidate);
}

/**
 * The create body fragment for the current selection. A multi-repository
 * workspace sends the immutable target at the observed set version; a
 * single-repository workspace keeps the legacy selectors, taken from the
 * trusted baseline rather than a typed name or version.
 */
export type TaskTargetInput =
  { target: TaskTargetSelection } | { repository_id: string; base_ref: string };

export function taskTargetInput(
  view: TaskTargetView,
  bindingId: string,
): TaskTargetInput | undefined {
  if (view.list === undefined) return undefined;
  const list = view.list;
  const candidate = list.selection_required
    ? selectedCandidate(list, bindingId)
    : singleCandidate(list);
  if (candidate === undefined || !hasTrustedBaseline(candidate)) return undefined;
  if (!list.selection_required) {
    return { repository_id: candidate.repository_id, base_ref: candidate.baseline.base_ref };
  }
  const target: TaskTargetSelection = {
    repository_id: candidate.repository_id,
    provider_instance_id: candidate.provider_instance_id,
    installation_ref: candidate.installation_ref,
    base_ref: candidate.baseline.base_ref,
    expected_set_version: list.repository_set_version,
  };
  return { target };
}

const BLOCKED_REASONS: Record<string, string> = {
  REPOSITORY_BINDING_MISSING: "No active repository is bound to this workspace.",
  REPOSITORY_BINDING_INCONSISTENT: "The workspace repository binding is inconsistent.",
  REPOSITORY_BINDING_UNAPPROVED: "The workspace repository is not approved.",
  INSTALLATION_NOT_APPROVED: "The repository installation is not approved.",
  WORKSPACE_ARCHIVED: "This workspace is archived.",
  MULTI_REPOSITORY_SCOPE_DISABLED: "Multi-repository execution is disabled for this build.",
  MULTI_REPOSITORY_SCOPE_UNSUPPORTED: "This build cannot execute a multi-repository workspace.",
};

export function targetBlockedMessage(blockedReason: string | null): string {
  return (
    (blockedReason === null ? undefined : BLOCKED_REASONS[blockedReason]) ??
    "Task creation is unavailable for this workspace."
  );
}

/** Status text for a failed target read, keeping the service's own message. */
export function targetReadError(
  error: unknown,
  fallback = "Task targets are unavailable.",
): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
