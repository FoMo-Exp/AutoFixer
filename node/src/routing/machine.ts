import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { auditChainProblem, auditDigest, digestOf } from "../collab/audit.js";
import type { RoutingAuditCommand, RoutingAuditRecord } from "./audit.js";
import { RoutingError } from "./errors.js";
import { HANDLERS } from "./handlers.js";
import type {
  ApprovalRequestRecord,
  AssignmentRecord,
  DirectoryMember,
  DirectoryTeam,
  IdentityMatch,
  ProviderIdentityRef,
  Recommendation,
  ResolvedFacts,
  RouteEvidence,
  RoutingAlert,
  RoutingDecision,
  RoutingDirectory,
  RoutingPolicy,
  RoutingScope,
  RoutingState,
  ServiceMapping,
  TransferProposal,
} from "./types.js";
import { emptyRoutingState } from "./types.js";

/**
 * Durable responsibility-routing state machine (DAT-217).
 *
 * Delivery guarantees mirror the collaboration machine:
 *
 * - **At-least-once safe**: every command carries an `operation_id`; a
 *   redelivered operation with the same payload returns the recorded result,
 *   the same id with a different payload is an `OPERATION_CONFLICT`, and a
 *   denied attempt is retriable with the same id.
 * - **Replay-safe**: one append-only audit record per first attempt, with a
 *   digest chain; replaying the log through the same handlers reproduces the
 *   exact decisions, assignments, transfers, approval addressing, alerts,
 *   identifiers, and denials.
 * - **Policy is registered, not caller-supplied**: a command uses the
 *   workspace's registered policy, so no caller (model included) can shop for
 *   a friendlier policy. Every decision records the policy version and
 *   digest and the evidence digest it was made from.
 * - **Eligibility is evidence**: the directory facts resolved at command time
 *   are captured into the audited payload before the pure handler runs, so
 *   current eligibility gates the command and the replay stays exact.
 *
 * This layer grants no authority. Routing produces an assignee, never an
 * approver; transfers never bestow approval rights.
 */

type Payload = Record<string, unknown>;

const SCHEMA_VERSION = 1;

export type CommandBase = {
  operation_id: string;
  actor: string;
  scope: RoutingScope;
};

export type RegisterPolicyInput = CommandBase & {
  policy: RoutingPolicy;
};

export type RouteInput = CommandBase & {
  issue_id: string;
  service_mapping: ServiceMapping;
  evidence: RouteEvidence;
};

export type RecommendAssigneeInput = CommandBase & {
  decision_id: string;
  recommendation: Recommendation;
};

export type ProposeTransferInput = CommandBase & {
  issue_id: string;
  to_user_id: string;
  reason: string;
  evidence?: string | null;
};

export type ConfirmTransferInput = CommandBase & {
  proposal_id: string;
};

export type RejectTransferInput = CommandBase & {
  proposal_id: string;
  reason: string;
};

export type AddressApprovalInput = CommandBase & {
  issue_id: string;
  reviewer_user_id: string;
};

export type RevokeAuthorityInput = CommandBase & {
  subject_user_id: string;
  reason: string;
};

export type ChangeReviewerInput = CommandBase & {
  issue_id: string;
  new_reviewer_user_id: string;
  reason: string;
};

export interface RoutingMachineOptions {
  /** Identity and membership fact source (ADR-0006). */
  directory: RoutingDirectory;
  /** Durable audit log location. Omit for a process-local machine in tests. */
  persistencePath?: string;
  /** Clock seam; captured per command as the audited effective time. */
  now?: () => Date;
}

interface PersistedState {
  schema_version: number;
  audit: RoutingAuditRecord[];
}

export class RoutingMachine {
  private readonly state: RoutingState = emptyRoutingState();
  private readonly audit: RoutingAuditRecord[] = [];
  private readonly directory: RoutingDirectory;
  private readonly persistencePath: string | undefined;
  private readonly clock: () => Date;

  constructor(options: RoutingMachineOptions) {
    this.directory = options.directory;
    this.persistencePath = options.persistencePath;
    this.clock = options.now ?? (() => new Date());
    if (this.persistencePath !== undefined && fs.existsSync(this.persistencePath)) {
      const raw = JSON.parse(fs.readFileSync(this.persistencePath, "utf8")) as unknown;
      this.restore(readPersistedState(raw).audit);
    }
  }

  /** Rebuild a machine from an audit log; used for recovery and reproducibility proofs. */
  static fromAudit(
    records: readonly RoutingAuditRecord[],
    options: RoutingMachineOptions,
  ): RoutingMachine {
    const machine = new RoutingMachine(options);
    machine.restore(records);
    return machine;
  }

  // ---------------------------------------------------------------- commands

  registerPolicy(input: RegisterPolicyInput): {
    scope: RoutingScope;
    policy_version: string;
    policy_digest: string;
  } {
    const payload: Payload = { ...input, at: this.clock().toISOString() };
    return this.execute("register_policy", input, payload) as {
      scope: RoutingScope;
      policy_version: string;
      policy_digest: string;
    };
  }

  route(input: RouteInput): RoutingDecision {
    const payload: Payload = {
      ...input,
      resolved: this.facts(
        input.scope,
        input.evidence.blame.flatMap((fact) => (fact.author ? [fact.author] : [])),
        true,
      ),
      at: this.clock().toISOString(),
      decision_id: `rdc_${randomUUID().replaceAll("-", "")}`,
    };
    return this.execute("route", input, payload) as RoutingDecision;
  }

  recommendAssignee(input: RecommendAssigneeInput): AssignmentRecord {
    const payload: Payload = {
      ...input,
      recommendation: {
        recommended_user_id: input.recommendation.recommended_user_id,
        rationale: input.recommendation.rationale ?? null,
        asserted_confidence: input.recommendation.asserted_confidence ?? null,
      },
      resolved: this.facts(input.scope),
      at: this.clock().toISOString(),
    };
    return this.execute("recommend_assignee", input, payload) as AssignmentRecord;
  }

  proposeTransfer(input: ProposeTransferInput): TransferProposal {
    const payload: Payload = {
      ...input,
      evidence: input.evidence ?? null,
      resolved: this.facts(input.scope),
      at: this.clock().toISOString(),
      transfer_id: `rtf_${randomUUID().replaceAll("-", "")}`,
    };
    return this.execute("propose_transfer", input, payload) as TransferProposal;
  }

  confirmTransfer(input: ConfirmTransferInput): {
    proposal: TransferProposal;
    assignment: AssignmentRecord;
  } {
    const payload: Payload = {
      ...input,
      resolved: this.facts(input.scope),
      at: this.clock().toISOString(),
    };
    return this.execute("confirm_transfer", input, payload) as {
      proposal: TransferProposal;
      assignment: AssignmentRecord;
    };
  }

  rejectTransfer(input: RejectTransferInput): TransferProposal {
    const payload: Payload = {
      ...input,
      resolved: this.facts(input.scope),
      at: this.clock().toISOString(),
    };
    return this.execute("reject_transfer", input, payload) as TransferProposal;
  }

  addressApproval(input: AddressApprovalInput): ApprovalRequestRecord {
    const payload: Payload = {
      ...input,
      resolved: this.facts(input.scope),
      at: this.clock().toISOString(),
      request_id: `rap_${randomUUID().replaceAll("-", "")}`,
    };
    return this.execute("address_approval", input, payload) as ApprovalRequestRecord;
  }

  /**
   * Record that a user's approval authority was revoked (role revocation,
   * membership removal, suspension). Every pending approval request addressed
   * to them is invalidated and a newly addressed request is created for the
   * next eligible approver; when none qualifies the request stays invalidated
   * and an operator alert is recorded.
   */
  revokeAuthority(input: RevokeAuthorityInput): {
    invalidated: ApprovalRequestRecord[];
    created: ApprovalRequestRecord[];
  } {
    const payload: Payload = {
      ...input,
      resolved: this.facts(input.scope),
      readdress_seed: randomUUID(),
      at: this.clock().toISOString(),
    };
    return this.execute("revoke_authority", input, payload) as {
      invalidated: ApprovalRequestRecord[];
      created: ApprovalRequestRecord[];
    };
  }

  /**
   * Record that the reviewer of an issue changed: the pending approval request
   * is invalidated and a newly addressed request is created for the new
   * reviewer. Denies when no approval request is pending.
   */
  changeReviewer(input: ChangeReviewerInput): {
    invalidated: ApprovalRequestRecord;
    created: ApprovalRequestRecord;
  } {
    const payload: Payload = {
      ...input,
      resolved: this.facts(input.scope),
      at: this.clock().toISOString(),
      request_id: `rap_${randomUUID().replaceAll("-", "")}`,
    };
    return this.execute("change_reviewer", input, payload) as {
      invalidated: ApprovalRequestRecord;
      created: ApprovalRequestRecord;
    };
  }

  // ------------------------------------------------------------------ reads

  getDecision(decisionId: string): RoutingDecision | undefined {
    const decision = this.state.decisions.get(decisionId);
    return decision ? structuredClone(decision) : undefined;
  }

  getAssignment(issueId: string): AssignmentRecord | undefined {
    const assignment = this.state.assignments.get(issueId);
    return assignment ? structuredClone(assignment) : undefined;
  }

  getTransfer(transferId: string): TransferProposal | undefined {
    const proposal = this.state.transfers.get(transferId);
    return proposal ? structuredClone(proposal) : undefined;
  }

  listDecisions(issueId: string): RoutingDecision[] {
    return [...this.state.decisions.values()]
      .filter((decision) => decision.issue_id === issueId)
      .sort((a, b) => a.at.localeCompare(b.at) || a.decision_id.localeCompare(b.decision_id))
      .map((decision) => structuredClone(decision));
  }

  listTransfers(issueId: string): TransferProposal[] {
    return [...this.state.transfers.values()]
      .filter((proposal) => proposal.issue_id === issueId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((proposal) => structuredClone(proposal));
  }

  listApprovalRequests(issueId: string): ApprovalRequestRecord[] {
    return [...this.state.approvals.values()]
      .filter((request) => request.issue_id === issueId)
      .sort((a, b) => a.addressed_at.localeCompare(b.addressed_at))
      .map((request) => structuredClone(request));
  }

  listAlerts(): RoutingAlert[] {
    return structuredClone(this.state.alerts);
  }

  auditLog(): RoutingAuditRecord[] {
    return structuredClone(this.audit);
  }

  /**
   * Digest over the whole machine state. Equal digests on two machines mean
   * the audit log reproduced the same policies, decisions, assignments,
   * transfers, approval addressing, alerts, and operation bookkeeping.
   */
  snapshotDigest(): string {
    return digestOf({
      policies: [...this.state.policies.entries()].sort(),
      decisions: [...this.state.decisions.values()].sort((a, b) =>
        a.decision_id.localeCompare(b.decision_id),
      ),
      assignments: [...this.state.assignments.entries()].sort(),
      transfers: [...this.state.transfers.values()].sort((a, b) =>
        a.transfer_id.localeCompare(b.transfer_id),
      ),
      approvals: [...this.state.approvals.values()].sort((a, b) =>
        a.request_id.localeCompare(b.request_id),
      ),
      alerts: this.state.alerts,
      attempts: [...this.state.attempts.entries()].sort(),
      results: [...this.state.results.entries()].sort(),
      audit_head:
        this.audit.length > 0 ? (this.audit[this.audit.length - 1]?.digest ?? null) : null,
    });
  }

  // ------------------------------------------------------------ durability

  /** Atomically persist the audit log if a path is configured. */
  flushSync(): void {
    if (this.persistencePath === undefined) {
      return;
    }
    const state: PersistedState = { schema_version: SCHEMA_VERSION, audit: [...this.audit] };
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.persistencePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.persistencePath);
  }

  // --------------------------------------------------------------- internals

  private facts(
    scope: RoutingScope,
    refs: ProviderIdentityRef[] = [],
    withTeams = false,
  ): ResolvedFacts {
    const members: DirectoryMember[] = [...this.directory.listMembers(scope)].sort((a, b) =>
      a.user_id.localeCompare(b.user_id),
    );
    const teams: DirectoryTeam[] = withTeams
      ? [...this.directory.listTeams(scope)].sort((a, b) => a.team_id.localeCompare(b.team_id))
      : [];
    const seen = new Set<string>();
    const identityMatches: IdentityMatch[] = [];
    for (const ref of refs) {
      const key = `${ref.provider_instance_id} ${ref.subject}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      identityMatches.push({ ref, user_id: this.directory.resolveProviderIdentity(ref) });
    }
    identityMatches.sort(
      (a, b) =>
        a.ref.provider_instance_id.localeCompare(b.ref.provider_instance_id) ||
        a.ref.subject.localeCompare(b.ref.subject),
    );
    return { members, teams, identity_matches: identityMatches };
  }

  /**
   * Apply one command exactly once per first attempt. A redelivered
   * `operation_id` with the same payload returns the recorded result; the same
   * id with a different payload is a protocol violation that changes nothing,
   * not even the audit log.
   */
  private execute(command: RoutingAuditCommand, input: Payload, payload: Payload): unknown {
    const operationId = requireOperationId(input);
    const inputDigest = digestOf(input);
    const known = this.state.attempts.get(operationId);
    if (known !== undefined && known !== inputDigest) {
      throw new RoutingError(
        "OPERATION_CONFLICT",
        "operation id was used with a different payload",
        {
          operation_id: operationId,
        },
      );
    }
    const memo = this.state.results.get(operationId);
    if (memo !== undefined) {
      return structuredClone(memo);
    }

    let result: unknown;
    let denial: RoutingError | null = null;
    try {
      result = HANDLERS[command](this.state, payload);
    } catch (error) {
      if (!(error instanceof RoutingError)) {
        throw error;
      }
      denial = error;
    }

    const at = payload["at"] as string;
    const previous =
      this.audit.length > 0 ? (this.audit[this.audit.length - 1]?.digest ?? null) : null;
    const content = {
      sequence: this.audit.length + 1,
      event_id: `evt_${randomUUID().replaceAll("-", "")}`,
      operation_id: operationId,
      command,
      actor: String(payload["actor"] ?? ""),
      at,
      outcome: denial === null ? ("applied" as const) : ("denied" as const),
      denial_code: denial?.code ?? null,
      fingerprint: inputDigest,
      payload_digest: digestOf(payload),
      payload: structuredClone(payload),
      result_digest: denial === null ? digestOf(result) : null,
      previous_digest: previous,
    };
    const record: RoutingAuditRecord = {
      ...content,
      command: command as RoutingAuditCommand,
      digest: auditDigest(content),
    };
    this.audit.push(record);
    this.state.attempts.set(operationId, inputDigest);
    if (denial === null) {
      this.state.results.set(operationId, structuredClone(result));
    }
    this.flushSync();
    if (denial !== null) {
      throw denial;
    }
    return structuredClone(result);
  }

  /**
   * Rebuild state by re-executing recorded attempts through the same handlers.
   * Any divergence — broken chain, changed payload, different outcome — fails
   * the rebuild instead of silently accepting corrupted history.
   */
  private restore(records: readonly RoutingAuditRecord[]): void {
    const problem = auditChainProblem(records);
    if (problem !== null) {
      throw new Error(`routing audit log is not intact: ${problem}`);
    }
    for (const record of records) {
      const known = this.state.attempts.get(record.operation_id);
      if (known !== undefined && known !== record.fingerprint) {
        throw new Error(
          `routing audit log reuses operation ${record.operation_id} with a different payload`,
        );
      }
      if (this.state.results.has(record.operation_id)) {
        throw new Error(
          `routing audit log records operation ${record.operation_id} after it was applied`,
        );
      }
      let result: unknown;
      let denial: RoutingError | null = null;
      try {
        result = HANDLERS[record.command](this.state, record.payload);
      } catch (error) {
        if (!(error instanceof RoutingError)) {
          throw error;
        }
        denial = error;
      }
      if (record.outcome === "applied") {
        if (denial !== null) {
          throw new Error(
            `audit replay diverged at sequence ${record.sequence}: expected applied, got ${denial.code}`,
          );
        }
        if (digestOf(result) !== record.result_digest) {
          throw new Error(`audit replay diverged at sequence ${record.sequence}: result mismatch`);
        }
        this.state.results.set(record.operation_id, structuredClone(result));
      } else {
        if (denial === null || denial.code !== record.denial_code) {
          throw new Error(
            `audit replay diverged at sequence ${record.sequence}: expected ${record.denial_code}`,
          );
        }
      }
      this.state.attempts.set(record.operation_id, record.fingerprint);
    }
    this.audit.push(...structuredClone(records));
  }
}

function requireOperationId(input: Payload): string {
  const value = input["operation_id"];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RoutingError("INVALID_INPUT", "operation_id must be a non-empty string", {
      field: "operation_id",
    });
  }
  return value;
}

function readPersistedState(raw: unknown): PersistedState {
  if (raw === null || typeof raw !== "object") {
    throw new Error("routing state is not a JSON object");
  }
  const value = raw as Record<string, unknown>;
  const version = value["schema_version"];
  if (version !== SCHEMA_VERSION) {
    throw new Error(`routing state schema ${String(version)} is not supported (${SCHEMA_VERSION})`);
  }
  const audit = value["audit"];
  if (!Array.isArray(audit)) {
    throw new Error("routing state has no audit log");
  }
  return { schema_version: SCHEMA_VERSION, audit: audit as RoutingAuditRecord[] };
}
