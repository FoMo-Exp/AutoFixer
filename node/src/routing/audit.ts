import type { AuditRecord } from "../collab/audit.js";

/**
 * The routing audit vocabulary.
 *
 * The record shape and digest chain are the collaboration machine's (see
 * `collab/audit.ts`): one record per first attempt of an operation — applied
 * or denied — chained so the log is tamper-evident and a replay through the
 * same handlers reproduces the exact decisions, assignments, transfers, and
 * denials. Routing commands carry the policy version and digest, the
 * evidence digest, and the directory facts resolved at command time, so
 * every decision is auditable against the policy and evidence it came from.
 */
export type RoutingAuditCommand =
  | "register_policy"
  | "route"
  | "recommend_assignee"
  | "propose_transfer"
  | "confirm_transfer"
  | "reject_transfer"
  | "address_approval"
  | "revoke_authority"
  | "change_reviewer";

export type RoutingAuditRecord = AuditRecord<RoutingAuditCommand>;
