/**
 * Wire types for the dsh-control/v1 local control plane.
 *
 * Shapes mirror docs/contracts/dsh-control-v1.md and the Go implementation in
 * dsh/. Every `state` value uses the task-evidence-contract-v1 §5 vocabulary;
 * this package never invents another dsh state.
 */

export const DSH_STATES = [
  "requested",
  "approved",
  "running",
  "awaiting_review",
  "approved_for_merge",
  "stopped",
  "timed_out",
  "expired",
  "rejected",
  "cancelled",
  "merged",
] as const;

export type DshState = (typeof DSH_STATES)[number];

export function isDshState(value: unknown): value is DshState {
  return typeof value === "string" && (DSH_STATES as readonly string[]).includes(value);
}

export interface DshHealth {
  service: string;
  status: string;
  protocol: { supported: string[]; default: string };
  contract_version: string;
  policy_version: string;
  capabilities: Record<string, boolean>;
}

export interface DshProposedWork {
  localized_reversible_change: boolean;
  broad_refactor: boolean;
  dependency_change: boolean;
  data_shape_change: boolean;
  migration: boolean;
  permission_sensitive: boolean;
  material_uncertainty: boolean;
  requests_secret_access: boolean;
  writes_to_main: boolean;
  edits_ci_workflows: boolean;
  edits_governance: boolean;
  publishes_package: boolean;
  deploys: boolean;
  alters_infrastructure: boolean;
  unapproved_network: boolean;
}

export interface DshRequestedScope {
  path_hints: string[];
  tool_capabilities: string[];
  max_wall_clock_seconds: number;
}

export interface DshCreateRunRequest {
  task_id: string;
  issue: {
    provider: string;
    external_id: string;
    source_reference: string;
  };
  repository: {
    repository_id: string;
    url: string;
    base_ref: string;
    base_sha: string;
  };
  request: {
    summary: string;
    acceptance_criteria?: string[];
    requested_by: {
      actor_id: string;
      display_name: string;
    };
  };
  proposed_work: DshProposedWork;
  requested_scope: DshRequestedScope;
}

export interface DshRiskAssessment {
  contract_version: string;
  task_id: string;
  run_id: string;
  assessed_at: string;
  assessor_identity: string;
  risk_class: "low" | "elevated" | "prohibited";
  decision_code: string;
  rationale_reference: string;
  policy_version: string;
  elevated_approval_reference: unknown | null;
}

export interface DshGrantSummary {
  capability_grant_version: string;
  issued_at: string;
  expires_at: string;
  permitted_paths: string[];
  permitted_tools: Array<{ identity: string; allowed_arguments: string[] }>;
  max_wall_clock_seconds: number;
  scope_digest: string;
}

export interface DshCreateRunResponse {
  run_id: string;
  state: DshState;
  risk_assessment: DshRiskAssessment;
  grant: DshGrantSummary | null;
  required_action: { type: string; scope_digest: string } | null;
}

export interface DshApprovalRequest {
  approval_id: string;
  decision: "approve" | "reject";
  approved_by: { actor_id: string; identity: string };
  approved_at: string;
  scope_digest: string;
}

export interface DshApprovalResponse {
  state: DshState;
  audit_event_reference: string;
  grant: DshGrantSummary | null;
}

export interface DshActionRequest {
  action_id: string;
  agent: { runtime: string; session_id: string; turn_id: string };
  intent: {
    tool_id: string;
    arguments: Record<string, unknown>;
    path_scope: string[];
    network_destinations: string[];
    rationale: string;
  };
}

export interface DshActionResponse {
  action_id: string;
  state: DshState;
  accepted_tool_id: string;
  audit_event_reference: string;
}

export interface DshCancelRequest {
  requested_by: { actor_id: string; identity: string };
  reason: string;
}

export interface DshCancelResponse {
  state: DshState;
  cancellation_requested: boolean;
  audit_event_reference: string;
}

export interface DshRunResponse {
  run_id: string;
  task_id: string;
  issue_id: string;
  state: DshState;
  risk_assessment: DshRiskAssessment;
  grant_status: {
    state: "none" | "active" | "revoked" | "expired";
    scope_digest: string;
    grant: Record<string, unknown> | null;
  };
  execution_counts: {
    actions_total: number;
    actions_allowed: number;
    actions_denied: number;
  };
  patch_report: unknown | null;
  approval_snapshot: unknown | null;
  bundle_available: boolean;
  created_at: string;
}

export interface DshEventsResponse {
  events: Array<Record<string, unknown>>;
  next_after_sequence: number;
  has_more: boolean;
}

export interface DshErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}
