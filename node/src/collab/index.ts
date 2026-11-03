/**
 * Durable collaboration state machine (DAT-215, ADR-0007).
 *
 * The module owns the product issue/task/run domain model: product lifecycle
 * states, bounded runs with worktree/scope/limit/grant records, leases with
 * fencing tokens, operation-id idempotency, an append-only digest-chained
 * audit log, and bounded handoffs with immutable artifact references.
 *
 * It grants no authority: dsh remains the execution gate, and product states
 * stay strictly separate from harness (FP-01) run states.
 */
export { CollabMachine } from "./machine.js";
export type {
  AcquireLeaseInput,
  AddTaskInput,
  ArtifactInput,
  CollabMachineOptions,
  CommandBase,
  CreateIssueInput,
  GrantInput,
  LeaseInput,
  OpenRunInput,
  RecordGrantInput,
  RecordHandoffInput,
  RecordRunStateInput,
  RenewLeaseInput,
  RequestRunRestartInput,
  RevokeGrantInput,
  SetTaskStateInput,
  TransitionIssueInput,
} from "./machine.js";
export { CollabError, COLLAB_ERROR_CODES } from "./errors.js";
export type { CollabErrorCode } from "./errors.js";
export {
  PRODUCT_STATES,
  PRODUCT_TRANSITIONS,
  PRODUCT_RUN_RELATION,
  RUN_STATE_TRANSITIONS,
  canTransitionProduct,
  canTransitionRun,
  isTerminalProductState,
  isTerminalRunState,
  productRunConflict,
  runTransitionIssueConflict,
} from "./states.js";
export type { ProductState, ProductRelation, RunView } from "./states.js";
export { grantStateAt } from "./types.js";
export type {
  ArtifactRef,
  CapabilityGrant,
  CollabState,
  Disposition,
  GrantState,
  GrantTool,
  HandoffRecord,
  IssueRecord,
  LeaseRecord,
  RepositoryRef,
  Role,
  RunLimits,
  RunRecord,
  RunScope,
  TaskRecord,
  TaskState,
  WorkspaceScope,
  WorktreeRef,
} from "./types.js";
export { auditChainProblem, canonicalJson, digestOf } from "./audit.js";
export type { AuditCommand, AuditOutcome, AuditRecord } from "./audit.js";
