import { ApiError } from "../api/client";
import type {
  MemoryApplicability,
  MemoryEvidence,
  MemoryKind,
  MemorySensitivity,
  MemoryStatus,
  MemoryTrust,
} from "../api/client";

/**
 * Labels map the merged contract enums exactly. Contract values are closed
 * unions in `schema.d.ts`, so a lookup is exhaustive; a value the contract
 * adds later is a type error here rather than an invented UI category.
 */
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  fact: "Fact",
  lesson: "Lesson",
  playbook: "Playbook",
  anti_pattern: "Anti-pattern",
  episode: "Episode",
  policy: "Policy",
};

export const MEMORY_STATUS_LABELS: Record<MemoryStatus, string> = {
  proposed: "Proposed",
  candidate: "Candidate",
  active: "Active",
  deprecated: "Deprecated",
  retired: "Retired",
  quarantined: "Quarantined",
};

export const MEMORY_TRUST_LABELS: Record<MemoryTrust, string> = {
  human: "Human-authored",
  agent: "Agent-authored",
  enterprise_template: "Enterprise template",
  system: "System",
};

export const MEMORY_SENSITIVITY_LABELS: Record<MemorySensitivity, string> = {
  internal: "Internal",
  confidential: "Confidential",
  restricted: "Restricted",
};

export const MEMORY_EVIDENCE_LABELS: Record<MemoryEvidence["evidence_type"], string> = {
  run: "Run",
  issue: "Issue",
  pr: "Pull request",
  commit: "Commit",
  test: "Test",
  reviewer_decision: "Reviewer decision",
  incident: "Incident",
};

export type MemoryTone = "neutral" | "active" | "attention" | "danger" | "muted";

/** Lifecycle tone, expressed with the shared `stage-pip` colour classes. */
export function memoryStatusTone(status: MemoryStatus): MemoryTone {
  switch (status) {
    case "active":
      return "active";
    case "candidate":
      return "attention";
    case "proposed":
      return "neutral";
    case "quarantined":
      return "danger";
    case "deprecated":
    case "retired":
      return "muted";
  }
}

export interface ApplicabilityRow {
  field: keyof MemoryApplicability;
  label: string;
  value: string;
}

/**
 * Only the applicability fields the item actually sets. An unset field means
 * broad applicability; rendering an empty row would imply a constraint that is
 * not there.
 */
export function applicabilityRows(applicability: MemoryApplicability): ApplicabilityRow[] {
  const labels: Array<[keyof MemoryApplicability, string]> = [
    ["team_id", "Team"],
    ["path_prefix", "Path prefix"],
    ["language", "Language"],
    ["task_family", "Task family"],
  ];
  const rows: ApplicabilityRow[] = [];
  for (const [field, label] of labels) {
    const value = applicability[field];
    if (value !== undefined && value.length > 0) rows.push({ field, label, value });
  }
  return rows;
}

/** Date-only rendering for validity windows; timestamps use `formatDate`. */
export function formatMemoryDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

export interface MemoryError {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
}

/**
 * Maps a failed browse to an operator-facing sentence. 403 and 404 stay
 * distinct: "not allowed here" must never be shown as "does not exist".
 */
export function describeMemoryError(caught: unknown): MemoryError {
  if (caught instanceof ApiError) {
    switch (caught.status) {
      case 401:
        return {
          code: caught.code,
          message: "Your session expired. Sign in again to browse workspace memory.",
          status: caught.status,
          retryable: false,
        };
      case 403:
        return {
          code: caught.code,
          message: "Your workspace role cannot browse memory. Ask a workspace owner for access.",
          status: caught.status,
          retryable: false,
        };
      case 404:
        return {
          code: caught.code,
          message:
            "This workspace is not visible to your credential, or it no longer exists. Memory is never readable across workspaces.",
          status: caught.status,
          retryable: false,
        };
      case 429:
        return {
          code: caught.code,
          message: "Too many requests. Retry once the limit clears.",
          status: caught.status,
          retryable: true,
        };
      default:
        return {
          code: caught.code,
          message: caught.message,
          status: caught.status,
          retryable: caught.retryable,
        };
    }
  }
  const message = caught instanceof Error ? caught.message : "Memory browse failed.";
  return { code: "REQUEST_FAILED", message, status: 0, retryable: true };
}
