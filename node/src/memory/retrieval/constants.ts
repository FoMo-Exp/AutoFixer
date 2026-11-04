/**
 * Closed vocabularies shared by the retrieval modules (DAT-236).
 *
 * Kept separate from `types.ts` so runtime validation and the contract export
 * can iterate the same lists the type system uses.
 */

import type {
  MemoryEvidenceType,
  MemoryKind,
  MemoryLinkType,
  MemorySensitivity,
  MemoryStatus,
  MemoryTrust,
} from "../types.js";

export const MEMORY_EVIDENCE_TYPES: readonly MemoryEvidenceType[] = [
  "run",
  "issue",
  "pr",
  "commit",
  "test",
  "reviewer_decision",
  "incident",
];

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "fact",
  "lesson",
  "playbook",
  "anti_pattern",
  "episode",
  "policy",
];

export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  "proposed",
  "candidate",
  "active",
  "deprecated",
  "retired",
  "quarantined",
];

export const MEMORY_TRUSTS: readonly MemoryTrust[] = [
  "human",
  "agent",
  "enterprise_template",
  "system",
];

export const MEMORY_SENSITIVITIES: readonly MemorySensitivity[] = [
  "internal",
  "confidential",
  "restricted",
];

/** Iteration order for link typing in the retrieval read path. */
export const MEMORY_LINK_TYPES: readonly MemoryLinkType[] = [
  "supersedes",
  "contradicts",
  "related",
  "derived_from",
];
