import type {
  RepositorySetAdditionPreview,
  RepositorySetAdditionPreviewMember,
  RepositorySetAdditionRepository,
} from "../api/identity";
import { CAPABILITY_LABELS, INELIGIBLE_REASON_LABELS } from "./identity-format";

/**
 * The repository-addition decision surface (DAT-287) over the merged DAT-286
 * contract. Every value below is read from `RepositorySetAdditionPreview`;
 * nothing here derives authority, an admission verdict or a capability the
 * response did not report.
 */

export type PreviewMember = RepositorySetAdditionPreviewMember;
export type PreviewOwner = RepositorySetAdditionPreview["owners"][number];
export type PreviewBlockedReason = RepositorySetAdditionPreview["commit_blocked_reasons"][number];
export type PreviewEvidenceClass = PreviewMember["evidence_classes"][number];
export type PreviewCapability = PreviewMember["proposed_capabilities"][number];

export interface RepositoryDraft {
  /** Stable row identity; never sent to the service. */
  id: string;
  providerInstanceId: string;
  installationRef: string;
  repositoryId: string;
  repositoryName: string;
  repositoryUrl: string;
}

export type RepositoryDraftField = "providerInstanceId" | "installationRef" | "repositoryId";

export interface RepositoryDraftValidation {
  proposals: RepositorySetAdditionRepository[];
  issues: Record<string, Partial<Record<RepositoryDraftField, string>>>;
  valid: boolean;
}

export function newRepositoryDraft(id: string, providerInstanceId = ""): RepositoryDraft {
  return {
    id,
    providerInstanceId,
    installationRef: "",
    repositoryId: "",
    repositoryName: "",
    repositoryUrl: "",
  };
}

/**
 * A proposal row carries the immutable provider identity the contract binds.
 * Display name and URL are optional and never stored in a decision.
 */
export function validateRepositoryDrafts(rows: RepositoryDraft[]): RepositoryDraftValidation {
  const issues: Record<string, Partial<Record<RepositoryDraftField, string>>> = {};
  const seen = new Map<string, string[]>();

  for (const row of rows) {
    const rowIssues: Partial<Record<RepositoryDraftField, string>> = {};
    if (row.providerInstanceId.trim() === "") {
      rowIssues.providerInstanceId = "Enter the approved provider instance id.";
    }
    if (row.installationRef.trim() === "") {
      rowIssues.installationRef = "Enter the approved installation reference.";
    }
    if (row.repositoryId.trim() === "") {
      rowIssues.repositoryId = "Enter the provider-assigned repository id.";
    }
    if (Object.keys(rowIssues).length > 0) {
      issues[row.id] = rowIssues;
    }

    const provider = row.providerInstanceId.trim();
    const repository = row.repositoryId.trim();
    if (provider !== "" && repository !== "") {
      const key = `${provider}\u0000${repository}`;
      seen.set(key, [...(seen.get(key) ?? []), row.id]);
    }
  }

  for (const rowIds of seen.values()) {
    if (rowIds.length < 2) continue;
    for (const rowId of rowIds) {
      issues[rowId] = {
        ...issues[rowId],
        repositoryId: "This repository is already in the proposal.",
      };
    }
  }

  const proposals = rows.map((row) => {
    const repository: RepositorySetAdditionRepository = {
      provider_instance_id: row.providerInstanceId.trim(),
      installation_ref: row.installationRef.trim(),
      repository_id: row.repositoryId.trim(),
    };
    const name = row.repositoryName.trim();
    const url = row.repositoryUrl.trim();
    if (name !== "") repository.repository_name = name;
    if (url !== "") repository.repository_url = url;
    return repository;
  });

  const valid = rows.length > 0 && Object.keys(issues).length === 0;
  return { proposals, issues, valid };
}

export const GATE_LABELS: Record<RepositorySetAdditionPreview["multi_repository_gate"], string> = {
  enabled: "Rollout gate enabled",
  disabled: "Rollout gate closed",
  unreadable: "Rollout gate unreadable",
};

export const EVIDENCE_CLASS_LABELS: Record<PreviewEvidenceClass, string> = {
  verified: "Verified",
  unknown: "Evidence unknown",
  expired: "Verification expired",
  truncated: "Evidence truncated",
  provider_unavailable: "Provider unavailable",
  confirmed_revocation: "Access confirmed removed",
};

export const OWNER_REASON_LABELS: Record<NonNullable<PreviewOwner["reason"]>, string> = {
  user_inactive: "User is inactive",
  enterprise_inactive: "Enterprise membership is inactive",
  admission_unverifiable: "Admission is not verifiable",
  admission_revoked: "Admission was revoked by the provider",
  management_missing: "Repository management would not survive",
};

export const BLOCKED_REASON_LABELS: Record<PreviewBlockedReason, string> = {
  MULTI_REPOSITORY_GATE_DISABLED:
    "The multi-repository rollout gate is closed. This preview is informational; the addition cannot be confirmed or committed.",
  CURRENT_SET_UNUSABLE:
    "The current repository set already authorizes nothing. Repair the current binding before adding repositories.",
  MEMBER_ADMISSION_NOT_RETAINED:
    "At least one current member would not keep verified code read on every proposed repository. The addition is refused.",
  LAST_EFFECTIVE_OWNER_MISSING:
    "No owner would keep verified repository management across the whole proposed set, even if everyone keeps read. Assign or verify another owner first.",
};

export const CURRENT_SET_REASON_LABELS = INELIGIBLE_REASON_LABELS;

/**
 * A verified reduction is shown as before/after. A member whose evidence is
 * incomplete is never rendered as a confirmed loss: the missing verdict is the
 * evidence class, not a revocation.
 */
export interface AdmissionView {
  label: string;
  tone: "active" | "warn" | "danger";
  verifiedLoss: boolean;
}

export function admissionView(member: PreviewMember): AdmissionView {
  if (member.retains_admission) {
    return { label: "Keeps verified access", tone: "active", verifiedLoss: false };
  }
  if (member.evidence_complete) {
    return { label: "Loses access", tone: "danger", verifiedLoss: true };
  }
  return { label: "Access not verified", tone: "warn", verifiedLoss: false };
}

export function capabilityLabel(capability: PreviewCapability): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

export function capabilityList(capabilities: readonly PreviewCapability[]): string {
  if (capabilities.length === 0) return "None";
  return capabilities.map(capabilityLabel).join(", ");
}

export function evidenceList(member: PreviewMember): string {
  if (member.evidence_classes.length === 0) return "Verified";
  return member.evidence_classes.map((item) => EVIDENCE_CLASS_LABELS[item]).join(", ");
}

/**
 * Server codes whose retry must form a new decision. Reusing the confirmation
 * would commit an impact the operator never saw, so the client drops the whole
 * preview instead of letting a repeat click reuse it.
 */
const FRESH_PREVIEW_CODES: Record<string, true> = {
  REPOSITORY_SET_VERSION_CONFLICT: true,
  REPOSITORY_SET_CHANGE_INVALID_PROPOSAL: true,
  REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE: true,
  REPOSITORY_SET_CHANGE_CONFIRMATION_REQUIRED: true,
  REPOSITORY_SET_CHANGE_CONFIRMATION_STALE: true,
  REPOSITORY_SET_CHANGE_CONFIRMATION_EXPIRED: true,
  REPOSITORY_SET_CHANGE_CONFIRMATION_CONSUMED: true,
  REPOSITORY_SET_CHANGE_CONFLICT: true,
};

export function requiresFreshPreview(code: string): boolean {
  return FRESH_PREVIEW_CODES[code] === true;
}
