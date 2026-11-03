/**
 * Effective access = enterprise membership ∩ workspace role ∩ current
 * repository access ∩ action policy (DAT-203).
 *
 * The intersection is computed in one pure function so every request path
 * (reads, streams, artifacts, approvals, writes) makes the same decision from
 * the same evidence. Deliberate rules:
 *
 * - Enterprise administration never grants repository data access by itself;
 *   it does not appear in the intersection at all.
 * - A missing input dimension denies. "Probably has access" is not access.
 * - `removed` and `unknown` repository authority deny every action;
 *   `stale` denies sensitive actions and says reconciliation is required.
 * - Sensitive actions additionally require fresh provider verification: an
 *   authority verified longer ago than the freshness window is treated like a
 *   stale one — blocked pending reconciliation, never silently allowed.
 * - A required capability grant must be live (unrevoked and unexpired) at
 *   decision time; grants are re-read, never trusted from a cached verdict.
 */

import {
  DEFAULT_ACTION_POLICY,
  WORKSPACE_ROLE_RANK,
  type AccessDecision,
  type EffectiveAccessInput,
} from "./types.js";

const DEFAULT_FRESH_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Compute one access decision from authoritative inputs. Pure: no I/O, no
 * caching — callers that need request-path enforcement wrap this with state
 * reads (see `access-gate.ts`).
 */
export function computeEffectiveAccess(input: EffectiveAccessInput): AccessDecision {
  const policy = (input.policy ?? DEFAULT_ACTION_POLICY)[input.action];
  const subject = input.repository.subject;
  const freshWindowMs = input.fresh_window_ms ?? DEFAULT_FRESH_WINDOW_MS;
  const staleAfterMs = input.stale_after_ms ?? DEFAULT_STALE_AFTER_MS;

  const base = {
    action: input.action,
    subject,
    authority_verified_at: input.repository.last_verified_at,
    checked_at: input.now.toISOString(),
  };

  // 1. Enterprise membership. Suspended users lose everything immediately.
  if (input.enterprise.user_status !== "active") {
    return { ...base, allowed: false, reason: "user_suspended" };
  }
  if (!input.enterprise.member) {
    return { ...base, allowed: false, reason: "enterprise_membership" };
  }

  // 2. Workspace role. An assigned membership with sufficient rank —
  //    enterprise admin status does not substitute.
  if (input.workspace_role === null) {
    return { ...base, allowed: false, reason: "workspace_role" };
  }
  if (WORKSPACE_ROLE_RANK[input.workspace_role] < WORKSPACE_ROLE_RANK[policy.min_role]) {
    return { ...base, allowed: false, reason: "workspace_role" };
  }

  // 3. Current repository access from the provider. A subject with no
  //    provider identity has no repository access — login alone is not
  //    repository authority.
  if (subject === null || input.repository.state === "absent") {
    return { ...base, allowed: false, reason: "authority_unknown", requires_reconciliation: true };
  }
  if (input.repository.state === "removed") {
    return { ...base, allowed: false, reason: "repository_access" };
  }
  if (input.repository.state === "unknown") {
    return { ...base, allowed: false, reason: "authority_unknown", requires_reconciliation: true };
  }

  // Verification freshness. An aged verification degrades authority to
  // "stale" regardless of what the last sync recorded.
  const verifiedAt = input.repository.last_verified_at
    ? Date.parse(input.repository.last_verified_at)
    : Number.NaN;
  const verificationAgeMs = Number.isNaN(verifiedAt)
    ? Number.POSITIVE_INFINITY
    : input.now.getTime() - verifiedAt;
  const isStaleState = input.repository.state === "stale";
  const isAgedVerification = verificationAgeMs > staleAfterMs;

  if (policy.sensitivity === "sensitive") {
    if (isStaleState || isAgedVerification) {
      return { ...base, allowed: false, reason: "authority_stale", requires_reconciliation: true };
    }
    if (verificationAgeMs > freshWindowMs) {
      return {
        ...base,
        allowed: false,
        reason: "verification_stale",
        requires_reconciliation: true,
      };
    }
  } else if (isStaleState) {
    // Ordinary actions survive a stale authority (the last verified state
    // still showed access), but the decision records nothing more than the
    // state it saw.
    // fall through
  }

  // 4. Action policy: capability grants are re-checked live for actions that
  //    need one. An expired or revoked grant denies — never "probably fine".
  if (policy.requires_capability) {
    if (!input.capability_grants.includes(policy.requires_capability)) {
      return { ...base, allowed: false, reason: "capability_grant" };
    }
  }

  return { ...base, allowed: true };
}
