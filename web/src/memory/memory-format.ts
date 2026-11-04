import { ApiError } from "../api/client";
import type {
  MemoryApplicability,
  MemoryEvidence,
  MemoryGovernanceAction,
  MemoryItem,
  MemoryKind,
  MemoryProvenance,
  MemoryReasonCode,
  MemorySensitivity,
  MemoryStatus,
  MemoryTrust,
} from "../api/client";
import type { WorkspaceRole } from "../api/identity";

/** The role-bearing subset of `SessionInfo` that governance gating reads. */
export interface MemorySessionView {
  user: { id: string };
  memberships: Array<{ workspace_id: string; role: WorkspaceRole }>;
}

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

/** Fixed governance vocabulary from `docs/contracts/memory-governance-v1.md` §3. */
export const MEMORY_REASON_LABELS: Record<MemoryReasonCode | "human_approved", string> = {
  duplicate_content: "Duplicate content",
  past_valid_to: "Past valid-to",
  stale_fact: "Stale fact",
  unused_decay: "Unused decay",
  retirement_proposal: "Retirement proposal",
  security_report: "Security report",
  human_decision: "Human decision",
  contradiction: "Contradiction",
  incorrect_content: "Incorrect content",
  policy_violation: "Policy violation",
  secret_leak: "Secret leak",
  poisoning_suspected: "Poisoning suspected",
  restore_after_review: "Restore after review",
  false_positive: "False positive",
  human_approved: "Human approved",
};

/**
 * Timeline `reason_code` is a `string` in the contract while a governance
 * result is the closed vocabulary; a token the UI has no label for is shown
 * verbatim rather than guessed at.
 */
export function memoryReasonLabel(code: string): string {
  return (MEMORY_REASON_LABELS as Record<string, string>)[code] ?? code;
}

export const MEMORY_EVENT_ACTION_LABELS: Record<string, string> = {
  item_created: "Item created",
  version_created: "Version created",
  version_reviewed: "Version reviewed",
  status_changed: "Status changed",
  evidence_added: "Evidence added",
  link_created: "Link created",
  item_deleted: "Item deleted",
  embedding_written: "Embedding written",
  template_published: "Template published",
  template_version_published: "Template version published",
  template_adopted: "Template adopted",
  template_revoked: "Template revoked",
  workspace_erased: "Workspace erased",
  promotion_decision: "Promotion decision",
  merge: "Consolidation merge",
  supersede: "Consolidation supersede",
  expire: "Consolidation expire",
  deprecate: "Consolidation deprecate",
  quarantine: "Consolidation quarantine",
};

export function memoryEventActionLabel(action: string): string {
  return MEMORY_EVENT_ACTION_LABELS[action] ?? action;
}

export const MEMORY_EVENT_SOURCE_LABELS: Record<string, string> = {
  memory_event: "Memory event",
  promotion_decision: "Promotion decision",
  consolidation_op: "Consolidation operation",
};

export const MEMORY_PROVENANCE_LABELS: Record<MemoryProvenance["author_type"], string> = {
  human: "Human author",
  agent: "Agent author",
  system: "System author",
};

/**
 * Content is withheld when the service says so. A quarantined item is treated
 * as redacted even if a response wrongly carries content, because quarantine
 * originals must never reach the DOM.
 */
export function isMemoryRedacted(item: Pick<MemoryItem, "status" | "statement_redacted">): boolean {
  return item.status === "quarantined" || item.statement_redacted === true;
}

/**
 * Ingest a browse/detail/transition item without ever keeping quarantine
 * originals in render state. Only the fields the response is allowed to carry
 * for a quarantined item survive.
 */
export function quarantineSafeItem(item: MemoryItem): MemoryItem {
  if (!isMemoryRedacted(item)) return item;
  return {
    ...item,
    statement: null,
    statement_redacted: true,
    preconditions: [],
    evidence: [],
  };
}

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** The caller's role in one workspace, from session memberships only. */
export function workspaceRoleFromSession(
  session: MemorySessionView | undefined,
  workspaceId: string | undefined,
): WorkspaceRole | undefined {
  if (!session || !workspaceId) return undefined;
  let role: WorkspaceRole | undefined;
  for (const membership of session.memberships) {
    if (membership.workspace_id !== workspaceId) continue;
    if (!role || ROLE_RANK[membership.role] > ROLE_RANK[role]) role = membership.role;
  }
  return role;
}

export interface MemoryStanding {
  role: WorkspaceRole | undefined;
  /** Item-level governance authority, mirroring the server matrix. */
  canGovern: boolean;
  /** Why the item is or is not governable, shown beside the actions. */
  scope: "workspace" | "team" | "none";
  note: string;
}

/**
 * Client-side mirror of the governance permission matrix. It only decides
 * which affordances to show; the service stays the authority and every 403 is
 * reported as a denial, never retried.
 */
export function memoryStanding(
  role: WorkspaceRole | undefined,
  ledTeamIds: ReadonlySet<string>,
  item: Pick<MemoryItem, "applicability" | "sensitivity">,
): MemoryStanding {
  if (role === "owner" || role === "admin") {
    return {
      role,
      canGovern: item.sensitivity !== "restricted",
      scope: "workspace",
      note:
        item.sensitivity === "restricted"
          ? "Restricted items are not governable through this surface."
          : "Workspace-wide governance applies to every item in this workspace.",
    };
  }
  const teamId = item.applicability.team_id;
  if (teamId !== undefined && ledTeamIds.has(teamId)) {
    return {
      role,
      canGovern: item.sensitivity !== "restricted",
      scope: "team",
      note: `Team leadership grants governance for ${teamId} only.`,
    };
  }
  return {
    role,
    canGovern: false,
    scope: "none",
    note:
      role === "member"
        ? "Your role can read this item but not govern it. Only workspace owners, admins, and the leading team can."
        : "Your workspace role is read-only for memory governance.",
  };
}

export const MEMORY_GOVERNANCE_ACTIONS: Record<MemoryGovernanceAction, string> = {
  promote: "Promote",
  deprecate: "Deprecate",
  quarantine: "Quarantine",
  restore: "Restore",
};

/** Fixed detail tokens: enums, counts, opaque ids; never free text. */
const SAFE_MEMORY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.,:/-]{0,199}$/;

/**
 * Timeline `detail` is documented as "fixed enums, counts, and opaque ids —
 * never free text and never memory content". This view enforces that instead
 * of trusting it: any value that is not a fixed token is withheld.
 */
export function memoryEventDetailRows(
  detail: Record<string, string | number | boolean> | undefined,
): Array<{ key: string; value: string }> {
  if (!detail) return [];
  const rows: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(detail)) {
    if (!SAFE_MEMORY_TOKEN.test(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      rows.push({ key, value: String(value) });
    } else {
      rows.push({ key, value: SAFE_MEMORY_TOKEN.test(value) ? value : "[withheld]" });
    }
  }
  return rows;
}

export interface MemoryActionOffer {
  action: MemoryGovernanceAction;
  label: string;
  /** Target status the action produces, or the restore choice set. */
  target: MemoryStatus | "choose";
  /** Reason select is mandatory for these actions in the contract. */
  needsReason: boolean;
}

/**
 * The transitions the contract accepts from the item's current status. `retired`
 * is terminal and quarantined items only accept `restore`.
 */
export function memoryActionOffers(
  status: MemoryStatus,
  canGovern: boolean,
  sensitivity: MemorySensitivity,
): MemoryActionOffer[] {
  if (!canGovern || sensitivity === "restricted") return [];
  const offers: MemoryActionOffer[] = [];
  if (status === "candidate") {
    offers.push({
      action: "promote",
      label: "Promote to active",
      target: "active",
      needsReason: false,
    });
  }
  if (status === "active" || status === "candidate") {
    offers.push({
      action: "deprecate",
      label: "Deprecate",
      target: "deprecated",
      needsReason: true,
    });
  }
  if (status !== "quarantined" && status !== "retired") {
    offers.push({
      action: "quarantine",
      label: "Quarantine",
      target: "quarantined",
      needsReason: true,
    });
  }
  if (status === "quarantined") {
    offers.push({ action: "restore", label: "Restore", target: "choose", needsReason: true });
  }
  return offers;
}

/** Default fixed reason per action; promote carries the approval stamp instead. */
export const MEMORY_ACTION_DEFAULT_REASON: Record<
  MemoryGovernanceAction,
  MemoryReasonCode | "human_approved"
> = {
  promote: "human_approved",
  deprecate: "human_decision",
  quarantine: "security_report",
  restore: "restore_after_review",
};

export interface MemoryGovernanceFailure extends MemoryError {
  /** A 409 means this view is stale; the UI offers a refresh, never a retry. */
  stale: boolean;
  /** The failure is an authority or visibility answer, not a transient one. */
  terminal: boolean;
}

export function describeMemoryGovernanceError(
  caught: unknown,
  action: MemoryGovernanceAction,
): MemoryGovernanceFailure {
  if (caught instanceof ApiError) {
    const base = {
      status: caught.status,
      retryable: caught.retryable,
      stale: false,
      terminal: false,
    };
    if (caught.status === 409) {
      if (caught.code === "VERSION_CONFLICT") {
        return {
          ...base,
          code: caught.code,
          stale: true,
          message: `Another change reached this item before your ${action}. Refresh to load the current version, then decide again.`,
        };
      }
      if (caught.code === "INVALID_TRANSITION") {
        return {
          ...base,
          code: caught.code,
          stale: true,
          message: `The service refused ${action} for the item's current status. Refresh before choosing another action.`,
        };
      }
      return {
        ...base,
        code: caught.code,
        stale: true,
        message:
          caught.code === "PRECONDITION_FAILED"
            ? `Promotion was refused: the item has no evidence citation, or a policy is not human-authored.`
            : caught.message,
      };
    }
    if (caught.status === 403) {
      return {
        ...base,
        code: caught.code,
        terminal: true,
        message: `The service refused ${action} for this credential. Only workspace owners, admins, and the leading team may govern memory.`,
      };
    }
    if (caught.status === 404) {
      return {
        ...base,
        code: caught.code,
        terminal: true,
        message: `This item is no longer visible. It may be outside your workspace or above your sensitivity ceiling.`,
      };
    }
    if (caught.status === 401) {
      return {
        ...base,
        code: caught.code,
        terminal: true,
        message: "Your session expired. Sign in again before governing memory.",
      };
    }
    return { ...base, code: caught.code, message: caught.message };
  }
  const message = caught instanceof Error ? caught.message : "The governance request failed.";
  return {
    code: "REQUEST_FAILED",
    message,
    status: 0,
    retryable: true,
    stale: false,
    terminal: false,
  };
}
