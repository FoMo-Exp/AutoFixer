/**
 * OpenAPI contract for the security case, rule-correction, recovery, and
 * audit surfaces (DAT-213, ADR-0005 §6).
 *
 * This is a *contract* milestone: it defines the shapes a later HTTP serving
 * layer and the web client consume, and it exports fixtures validated against
 * these schemas. It deliberately exposes no bypass: no operation accepts a
 * per-call exemption, a `send_anyway` flag, a client-supplied scope, or a rule
 * targeting one invocation/case/request/secret. Rule activation still needs an
 * independent review and the complete request is still rechecked on recovery.
 *
 * The sensitive endpoints are explicit:
 * - quarantine viewing requires a separately issued, scoped grant and is
 *   audited on every attempt;
 * - audit reads/exports require a stated purpose and are themselves recorded;
 * - a recovery dispatch is the only operation that can cause model bytes to
 *   leave, and it is bound to an independently approved, expiring, single-use
 *   authorization.
 */

import type { JsonObject } from "./openapi-types.js";
import { SECURITY_AUDIT_EVENT_TYPES, SECURITY_AUDIT_RESULTS } from "../security/audit.js";
import { RECOVERY_INVALID_REASONS } from "../security/recovery-authorization.js";
import { CASE_STATES, CASE_TRANSITIONS } from "../security/types.js";
import type { CaseState } from "../security/types.js";

const errorRef = { $ref: "#/components/schemas/Error" } as const;

function errorResponse(description: string): JsonObject {
  return { description, content: { "application/json": { schema: errorRef } } };
}

function jsonRef(ref: string): JsonObject {
  return { content: { "application/json": { schema: { $ref: ref } } } };
}

const WORKSPACE_ID_PARAMETER: JsonObject = {
  name: "workspace_id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Workspace scope. Resolved against the caller's authenticated membership.",
};

const CASE_ID_PARAMETER: JsonObject = {
  name: "case_id",
  in: "path",
  required: true,
  schema: { type: "string" },
};

const CURSOR_PARAMETER: JsonObject = {
  name: "cursor",
  in: "query",
  required: false,
  schema: { type: "string" },
  description: "Opaque pagination cursor copied from a previous page's next_cursor.",
};

const IDEMPOTENCY_KEY_PARAMETER: JsonObject = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 256 },
  description:
    "Replay-safe command identity. Repeating the same command with the same key " +
    "returns the recorded result instead of applying it twice; the same key with " +
    "a different payload is 409 IDEMPOTENCY_CONFLICT.",
};

const SCOPE_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["enterprise_id", "workspace_id", "issue_id", "run_id"],
  properties: {
    enterprise_id: { type: "string" },
    workspace_id: { type: "string" },
    issue_id: { type: "string" },
    run_id: { type: "string" },
  },
};

const RULE_SCOPE_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["enterprise_id", "workspace_id"],
  properties: {
    enterprise_id: { type: "string" },
    workspace_id: { type: "string" },
  },
  description: "A rule correction is bound to exactly one enterprise and workspace.",
};

const DESTINATION_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["endpoint_id", "provider", "model_id", "internal"],
  properties: {
    endpoint_id: { type: "string" },
    provider: { type: "string" },
    model_id: { type: "string" },
    internal: {
      type: "boolean",
      description: "An internal endpoint is still scanned; internal never means exempt.",
    },
  },
};

const BLOCK_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["invocation_id", "trace_id", "reason", "safe_detail", "at"],
  properties: {
    invocation_id: { type: "string" },
    trace_id: { type: "string" },
    reason: {
      type: "string",
      enum: [
        "SENSITIVE_DATA_UNCERTAIN",
        "MODEL_EGRESS_DENIED",
        "SECURITY_REVIEW_REQUIRED",
        "CLASSIFICATION_UNKNOWN",
        "SCANNER_UNAVAILABLE",
        "DATA_CLASS_NOT_AUTHORIZED",
        "AUDIT_UNAVAILABLE",
      ],
      description: "Stable redacted reason. Never carries matched content.",
    },
    safe_detail: {
      type: "string",
      description: "Content-free handler summary; scrubbed at intake.",
    },
    at: { type: "string", format: "date-time" },
  },
};

const CASE_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "case_id",
    "scope",
    "state",
    "created_at",
    "updated_at",
    "blocks",
    "quarantine_ids",
    "allowed_transitions",
  ],
  properties: {
    case_id: { type: "string" },
    scope: { $ref: "#/components/schemas/SecurityScope" },
    state: { type: "string", enum: [...CASE_STATES] },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    blocks: { type: "array", items: { $ref: "#/components/schemas/SecurityBlock" } },
    quarantine_ids: { type: "array", items: { type: "string" } },
    /**
     * The state edges the current state permits. The same matrix the service
     * enforces is exposed so a UI cannot render an impossible action.
     */
    allowed_transitions: { type: "array", items: { type: "string", enum: [...CASE_STATES] } },
  },
  description:
    "Redacted case status. It contains no quarantined content and no " +
    "credential: viewing raw context requires a separately granted, audited " +
    "quarantine access.",
};

const CASE_PAGE_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["items", "next_cursor"],
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/SecurityCase" } },
    next_cursor: { type: ["string", "null"] },
  },
};

const TRANSITION_REQUEST_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["to"],
  properties: {
    to: { type: "string", enum: [...CASE_STATES] },
    note: {
      type: "string",
      maxLength: 2000,
      description: "Non-secret disposition note; scrubbed before it is recorded.",
    },
  },
  description:
    "Every edge requires its separated duty: handling and submission are " +
    "handler work, review decisions are independent-reviewer work, and " +
    "termination is handler or administrator work. Reviewing your own " +
    "handling is rejected.",
};

const OWNER_REQUEST_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    note: { type: "string", maxLength: 2000 },
  },
  description:
    "A task owner's request is recorded, never executed: only handler or " +
    "administrator work dispositions a case.",
};

const QUARANTINE_GRANT_REQUEST_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["quarantine_id", "subject"],
  properties: {
    quarantine_id: { type: "string" },
    subject: { type: "string" },
  },
  description:
    "Issued only by an enterprise security administrator, only to a handler " +
    "or independent reviewer, and only for one record with an expiry. It is " +
    "never a case reference and never a transferable credential.",
};

const QUARANTINE_GRANT_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "grant_id",
    "quarantine_id",
    "subject",
    "scope",
    "granted_by",
    "created_at",
    "expires_at",
  ],
  properties: {
    grant_id: { type: "string" },
    quarantine_id: { type: "string" },
    subject: { type: "string" },
    scope: { type: "string", enum: ["inspect"] },
    granted_by: { type: "string" },
    created_at: { type: "string", format: "date-time" },
    expires_at: { type: "string", format: "date-time" },
  },
};

const QUARANTINE_VIEW_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["quarantine_id", "content", "viewed_at"],
  properties: {
    quarantine_id: { type: "string" },
    content: {
      type: "string",
      description:
        "Decrypted raw context. Returned only under a valid, scoped grant; " +
        "this response is never logged, cached, or copied into an audit event, " +
        "and the view attempt is audited whether it succeeds or is denied.",
    },
    viewed_at: { type: "string", format: "date-time" },
  },
};

const CONSTRAINTS_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    min_shannon_entropy: { type: "number", minimum: 0 },
    min_length: { type: "integer", minimum: 1 },
    required_prefix: { type: "string", maxLength: 24 },
    required_suffix: { type: "string", maxLength: 24 },
  },
  description:
    "Narrowing constraints only. A correction can require more entropy, " +
    "length, or a fixed marker; it can never disable a detector or widen what " +
    "matches.",
};

const REGRESSION_EVIDENCE_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["test_ref", "description", "detector_id", "result", "at"],
  properties: {
    test_ref: { type: "string" },
    description: { type: "string" },
    detector_id: { type: "string" },
    result: { type: "string", enum: ["pass", "fail"] },
    at: { type: "string", format: "date-time" },
  },
  description:
    "Evidence the service computed from its trusted corpus. A proposal cannot " +
    "submit evidence; activation re-verifies it.",
};

const RULE_REVISION_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "lineage",
    "version",
    "kind",
    "status",
    "detector_id",
    "scope",
    "constraints",
    "reason",
    "expires_at",
    "regression_evidence",
    "author_id",
    "proposed_at",
  ],
  properties: {
    lineage: {
      type: "string",
      description: "`detector_id|enterprise_id|workspace_id`; URL-encode it in a path.",
    },
    version: { type: "integer", minimum: 1 },
    kind: { type: "string", enum: ["correction", "rollback"] },
    status: {
      type: "string",
      enum: [
        "proposed",
        "approved",
        "rejected",
        "activated",
        "superseded",
        "rolled_back",
        "expired",
        "applied",
      ],
    },
    detector_id: { type: "string" },
    scope: { $ref: "#/components/schemas/SecurityRuleScope" },
    constraints: { $ref: "#/components/schemas/SecurityRuleConstraints" },
    reason: { type: "string" },
    expires_at: { type: "string", format: "date-time" },
    review_at: { type: ["string", "null"], format: "date-time" },
    regression_evidence: {
      type: "array",
      items: { $ref: "#/components/schemas/SecurityRegressionEvidence" },
    },
    regression_binding: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["rule_digest", "corpus_digest", "at"],
          properties: {
            rule_digest: { type: "string" },
            corpus_digest: { type: "string" },
            at: { type: "string", format: "date-time" },
          },
        },
        { type: "null" },
      ],
    },
    author_id: { type: "string" },
    proposed_at: { type: "string", format: "date-time" },
    review: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["reviewer_id", "approved", "reason", "at"],
          properties: {
            reviewer_id: { type: "string" },
            approved: { type: "boolean" },
            reason: { type: "string" },
            at: { type: "string", format: "date-time" },
          },
        },
        { type: "null" },
      ],
    },
    activated_by: { type: ["string", "null"] },
    activated_at: { type: ["string", "null"], format: "date-time" },
    superseded_at: { type: ["string", "null"], format: "date-time" },
    rolled_back_by: { type: ["string", "null"] },
    rolled_back_at: { type: ["string", "null"], format: "date-time" },
    rolls_back_version: { type: ["integer", "null"] },
    expired_at: { type: ["string", "null"], format: "date-time" },
    rejected_code: { type: ["string", "null"] },
  },
  description:
    "One versioned correction. A rule that selects one invocation, case, " +
    "request digest, or secret value — or disables a whole detector — is " +
    "rejected by name, not silently accepted.",
};

const RULE_PAGE_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["items", "next_cursor"],
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/SecurityRuleRevision" } },
    next_cursor: { type: ["string", "null"] },
  },
};

const PROPOSAL_REQUEST_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["detector_id", "constraints", "reason", "expires_at"],
  properties: {
    detector_id: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" },
    constraints: { $ref: "#/components/schemas/SecurityRuleConstraints" },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
    expires_at: { type: "string", format: "date-time" },
    review_at: { type: "string", format: "date-time" },
  },
  description:
    "The scope comes from the authenticated workspace path, never from the " +
    "body. Regression evidence is computed by the service and cannot be " +
    "supplied here.",
};

const REVIEW_REQUEST_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "reason"],
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
  description:
    "Independent-reviewer work. A handler who authored or handled the change " +
    "cannot review it, and role combinations never create an exception.",
};

const RULE_ACTIVATION_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    note: { type: "string", maxLength: 2000 },
  },
  description:
    "Enterprise-security-administrator work after an independent approval. " +
    "Activation re-verifies the computed regression evidence; rollback cannot " +
    "restore a superseded approval.",
};

const RECOVERY_APPROVAL_REQUEST_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["destination"],
  properties: {
    destination: {
      type: "object",
      additionalProperties: false,
      required: ["endpoint_id", "model_id"],
      properties: {
        endpoint_id: { type: "string" },
        model_id: { type: "string" },
      },
    },
    ttl_seconds: { type: "integer", minimum: 1, maximum: 3600 },
  },
  description:
    "Approves rechecking a rebuilt request at one destination — never a " +
    "bypass. The approval binds the reviewed context revision, scope, " +
    "destination, and current policy/rule/scan revisions, and expires.",
};

const RECOVERY_APPROVAL_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "authorization_id",
    "case_id",
    "scope",
    "destination",
    "context_revision",
    "policy_revision",
    "rules_revision",
    "scan_policy_revision",
    "approved_by",
    "approved_at",
    "expires_at",
    "state",
  ],
  properties: {
    authorization_id: { type: "string" },
    case_id: { type: "string" },
    scope: { $ref: "#/components/schemas/SecurityScope" },
    destination: { $ref: "#/components/schemas/SecurityDestination" },
    context_revision: {
      type: "string",
      description: "Keyed identifier of the complete reviewed request.",
    },
    policy_revision: { type: "string" },
    rules_revision: { type: "string" },
    scan_policy_revision: { type: "string" },
    approved_by: { type: "string" },
    approved_at: { type: "string", format: "date-time" },
    expires_at: { type: "string", format: "date-time" },
    state: {
      type: "string",
      enum: ["approved", "consumed", "invalidated", "revoked", "expired"],
    },
    state_reason: { type: ["string", "null"] },
    consumed_at: { type: ["string", "null"], format: "date-time" },
    consumed_by: { type: ["string", "null"] },
  },
  description:
    "An approval is not a dispatch. `state: approved` authorizes one recheck " +
    "attempt; sending is recorded separately as a dispatch outcome.",
};

const RECOVERY_DISPATCH_REQUEST_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["worker_id"],
  properties: {
    worker_id: { type: "string" },
  },
  description:
    "The complete request is rebuilt from approved sources and rechecked " +
    "under current authorization, destination, classification, minimization, " +
    "and secret rules. Any difference from the approved revisions invalidates " +
    "the authorization (RECOVERY_APPROVAL_INVALID).",
};

const RECOVERY_DISPATCH_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "authorization_id",
    "case_id",
    "invocation_id",
    "trace_id",
    "request_digest",
    "outcome",
  ],
  properties: {
    authorization_id: { type: "string" },
    case_id: { type: "string" },
    invocation_id: { type: "string" },
    trace_id: { type: "string" },
    request_digest: {
      type: "string",
      description: "Keyed digest of the exact frozen request handed to the adapter.",
    },
    outcome: { type: "string", enum: ["pending", "dispatched", "failed", "unknown"] },
    detail: { type: ["string", "null"] },
  },
  description:
    "`unknown` means the provider outcome could not be established: the " +
    "authorization is consumed and the request is never automatically " +
    "replayed. An approval and an actual send are distinct audit events.",
};

const AUDIT_ACTOR_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["actor_id", "actor_kind", "role", "independent_of"],
  properties: {
    actor_id: { type: "string" },
    actor_kind: { type: "string", enum: ["human", "service", "run"] },
    role: { type: ["string", "null"] },
    independent_of: { type: ["string", "null"] },
  },
};

const AUDIT_SCAN_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "scanner",
    "rule_version",
    "classification",
    "segments",
    "data_classes",
    "finding_counts",
    "detectors",
    "derived_segments",
  ],
  properties: {
    scanner: { type: "string" },
    rule_version: { type: "string" },
    classification: { type: "string" },
    segments: { type: "integer", minimum: 0 },
    data_classes: { type: "array", items: { type: "string" } },
    finding_counts: {
      type: "object",
      additionalProperties: false,
      required: ["suspected", "confirmed", "unknown"],
      properties: {
        suspected: { type: "integer", minimum: 0 },
        confirmed: { type: "integer", minimum: 0 },
        unknown: { type: "integer", minimum: 0 },
      },
    },
    detectors: { type: "array", items: { type: "string" } },
    derived_segments: { type: "integer", minimum: 0 },
  },
};

const AUDIT_EVENT_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "event_id",
    "at",
    "event",
    "scope",
    "case_id",
    "invocation_id",
    "trace_id",
    "actor",
    "action",
    "reason",
    "result",
    "review",
    "destination",
    "data_classes",
    "protected_refs",
    "policy_revision",
    "rules_revision",
    "detector_version",
    "redaction_version",
    "scan",
    "authorization",
    "link",
    "detail",
  ],
  properties: {
    event_id: { type: "string" },
    at: { type: "string", format: "date-time" },
    event: { type: "string", enum: [...SECURITY_AUDIT_EVENT_TYPES] },
    scope: { $ref: "#/components/schemas/SecurityScope" },
    case_id: { type: ["string", "null"] },
    invocation_id: { type: ["string", "null"] },
    trace_id: { type: ["string", "null"] },
    actor: { oneOf: [{ $ref: "#/components/schemas/SecurityAuditActor" }, { type: "null" }] },
    action: { type: "string" },
    reason: { type: ["string", "null"] },
    result: { type: "string", enum: [...SECURITY_AUDIT_RESULTS] },
    review: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["reviewer_id", "independent"],
          properties: {
            reviewer_id: { type: "string" },
            independent: { type: "boolean" },
          },
        },
        { type: "null" },
      ],
    },
    destination: {
      oneOf: [{ $ref: "#/components/schemas/SecurityDestination" }, { type: "null" }],
    },
    data_classes: { type: "array", items: { type: "string" } },
    protected_refs: {
      type: "array",
      items: { type: "string" },
      description:
        "Keyed identifiers for content correlation. Never raw content and " +
        "never a plain hash of a low-entropy secret value.",
    },
    policy_revision: { type: ["string", "null"] },
    rules_revision: { type: ["string", "null"] },
    detector_version: { type: ["string", "null"] },
    redaction_version: { type: ["string", "null"] },
    scan: { oneOf: [{ $ref: "#/components/schemas/SecurityAuditScanEvidence" }, { type: "null" }] },
    authorization: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["authorization_id", "state", "expires_at", "consumed_at"],
          properties: {
            authorization_id: { type: "string" },
            state: { type: "string" },
            expires_at: { type: ["string", "null"], format: "date-time" },
            consumed_at: { type: ["string", "null"], format: "date-time" },
          },
        },
        { type: "null" },
      ],
    },
    link: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["block_event_id", "dispatch_event_id"],
          properties: {
            block_event_id: { type: ["string", "null"] },
            dispatch_event_id: { type: ["string", "null"] },
          },
        },
        { type: "null" },
      ],
    },
    detail: { type: "object", additionalProperties: true },
  },
  description:
    "One hash-chained, non-secret security audit event. Reading or exporting " +
    "the trail records its own `audit.trail_read` / `audit.trail_exported` " +
    "event with the requester and stated purpose.",
};

const AUDIT_ENTRY_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["seq", "hash", "event"],
  properties: {
    seq: { type: "integer", minimum: 1 },
    hash: { type: "string" },
    event: { $ref: "#/components/schemas/SecurityAuditEvent" },
  },
};

const AUDIT_PAGE_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["items", "next_cursor"],
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/SecurityAuditEntry" } },
    next_cursor: { type: ["string", "null"] },
  },
};

const AUDIT_QUERY_PROPERTIES: Record<string, JsonObject> = {
  case_id: { type: "string" },
  run_id: { type: "string" },
  trace_id: { type: "string" },
  invocation_id: { type: "string" },
  event_type: { type: "string", enum: [...SECURITY_AUDIT_EVENT_TYPES] },
  from: { type: "string", format: "date-time" },
  to: { type: "string", format: "date-time" },
};

const AUDIT_EXPORT_REQUEST_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["purpose"],
  properties: {
    purpose: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Non-secret stated purpose, recorded with the export event.",
    },
    ...AUDIT_QUERY_PROPERTIES,
  },
  description:
    "Restricted to the enterprise security administrator. The export is " +
    "recorded as `audit.trail_exported` before the payload is returned, and " +
    "no secret ever appears in it.",
};

const AUDIT_EXPORT_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["exported_at", "enterprise_id", "workspace_id", "event_count", "entries"],
  properties: {
    exported_at: { type: "string", format: "date-time" },
    enterprise_id: { type: "string" },
    workspace_id: { type: "string" },
    event_count: { type: "integer", minimum: 0 },
    entries: { type: "array", items: { $ref: "#/components/schemas/SecurityAuditEntry" } },
  },
};

const SECURITY_DESCRIPTION =
  "ADR-0005 security surface: scoped disposal cases, separated duties, " +
  "versioned rule corrections, one-time rechecked recovery, and the " +
  "tamper-evident non-secret audit trail. No operation in this surface offers " +
  "a per-call bypass: the only path out of a block is handling plus an " +
  "independent review plus a complete recheck under current rules. Secrets " +
  "never appear in case views, notifications, errors, audit events, or " +
  "exports; quarantined content needs a separate grant and every view is " +
  "audited. Recovery refusals use the stable codes SENSITIVE_DATA_UNCERTAIN, " +
  "SECURITY_REVIEW_REQUIRED, RECOVERY_APPROVAL_INVALID, and MODEL_EGRESS_DENIED " +
  "with stage, case/trace references, retryability, and one authorized next " +
  "action.";

/**
 * Exported schemas. `SecurityScope` is reused by cases, rules, recovery, and
 * audit so a generated client has one correlation shape.
 */
export const SECURITY_OPENAPI_SCHEMAS: Record<string, unknown> = {
  SecurityScope: SCOPE_SCHEMA,
  SecurityRuleScope: RULE_SCOPE_SCHEMA,
  SecurityDestination: DESTINATION_SCHEMA,
  SecurityBlock: BLOCK_SCHEMA,
  SecurityCase: CASE_SCHEMA,
  SecurityCasePage: CASE_PAGE_SCHEMA,
  SecurityCaseTransitionRequest: TRANSITION_REQUEST_SCHEMA,
  SecurityOwnerRequest: OWNER_REQUEST_SCHEMA,
  SecurityQuarantineGrantRequest: QUARANTINE_GRANT_REQUEST_SCHEMA,
  SecurityQuarantineGrant: QUARANTINE_GRANT_SCHEMA,
  SecurityQuarantineView: QUARANTINE_VIEW_SCHEMA,
  SecurityRuleConstraints: CONSTRAINTS_SCHEMA,
  SecurityRegressionEvidence: REGRESSION_EVIDENCE_SCHEMA,
  SecurityRuleRevision: RULE_REVISION_SCHEMA,
  SecurityRulePage: RULE_PAGE_SCHEMA,
  SecurityRuleProposalRequest: PROPOSAL_REQUEST_SCHEMA,
  SecurityRuleReviewRequest: REVIEW_REQUEST_SCHEMA,
  SecurityRuleActivationRequest: RULE_ACTIVATION_SCHEMA,
  SecurityRecoveryApprovalRequest: RECOVERY_APPROVAL_REQUEST_SCHEMA,
  SecurityRecoveryApproval: RECOVERY_APPROVAL_SCHEMA,
  SecurityRecoveryDispatchRequest: RECOVERY_DISPATCH_REQUEST_SCHEMA,
  SecurityRecoveryDispatch: RECOVERY_DISPATCH_SCHEMA,
  SecurityAuditActor: AUDIT_ACTOR_SCHEMA,
  SecurityAuditScanEvidence: AUDIT_SCAN_SCHEMA,
  SecurityAuditEvent: AUDIT_EVENT_SCHEMA,
  SecurityAuditEntry: AUDIT_ENTRY_SCHEMA,
  SecurityAuditPage: AUDIT_PAGE_SCHEMA,
  SecurityAuditExportRequest: AUDIT_EXPORT_REQUEST_SCHEMA,
  SecurityAuditExport: AUDIT_EXPORT_SCHEMA,
};

/** Every case/rule/recovery/audit path, mounted under the workspace surface. */
export function securityOpenApiPaths(): Record<string, Record<string, unknown>> {
  const base = "/api/v1/workspaces/{workspace_id}/security";
  const casePath = `${base}/cases/{case_id}`;
  const approvalPath = `${base}/recovery-approvals/{authorization_id}`;
  const revisionPath = `${base}/rules/{lineage}/revisions/{version}`;
  return {
    [`${base}/cases`]: {
      get: {
        operationId: "listSecurityCases",
        summary: "List redacted disposal cases in the workspace",
        description: `${SECURITY_DESCRIPTION} Newest first; redacted status only.`,
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "state",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...CASE_STATES] },
          },
          {
            name: "run_id",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          CURSOR_PARAMETER,
        ],
        responses: {
          200: { description: "Case page", ...jsonRef("#/components/schemas/SecurityCasePage") },
          403: errorResponse("FORBIDDEN — no security duty in this workspace"),
        },
      },
    },
    [casePath]: {
      get: {
        operationId: "getSecurityCase",
        summary: "Read one redacted disposal case and its append-only history summary",
        parameters: [WORKSPACE_ID_PARAMETER, CASE_ID_PARAMETER],
        responses: {
          200: { description: "Case", ...jsonRef("#/components/schemas/SecurityCase") },
          403: errorResponse("FORBIDDEN — no security duty in this workspace"),
          404: errorResponse("CASE_NOT_FOUND"),
        },
      },
    },
    [`${casePath}/transitions`]: {
      post: {
        operationId: "transitionSecurityCase",
        summary: "Apply one duty-gated case disposition edge",
        description: `${SECURITY_DESCRIPTION} Every state is final at resolved/terminated; a failed review returns to handling with an append-only history.`,
        parameters: [WORKSPACE_ID_PARAMETER, CASE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityCaseTransitionRequest" },
            },
          },
        },
        responses: {
          200: { description: "Updated case", ...jsonRef("#/components/schemas/SecurityCase") },
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED or a separation-of-duties refusal"),
          404: errorResponse("CASE_NOT_FOUND"),
          409: errorResponse("CASE_STATE_CONFLICT or CANDIDATE_CONFLICT"),
          422: errorResponse("SOD_SELF_REVIEW_FORBIDDEN or SOD_SAME_PRINCIPAL_FORBIDDEN"),
        },
      },
    },
    [`${casePath}/termination-requests`]: {
      post: {
        operationId: "requestSecurityCaseTermination",
        summary: "Task owner requests termination (recorded, never executed)",
        description: `${SECURITY_DESCRIPTION} Ownership alone never dispositions a case.`,
        parameters: [WORKSPACE_ID_PARAMETER, CASE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityOwnerRequest" },
            },
          },
        },
        responses: {
          202: { description: "Request recorded", ...jsonRef("#/components/schemas/SecurityCase") },
          403: errorResponse("FORBIDDEN — CASE_TERMINATION_REQUEST_FORBIDDEN"),
          404: errorResponse("CASE_NOT_FOUND"),
        },
      },
    },
    [`${casePath}/reassignment-requests`]: {
      post: {
        operationId: "requestSecurityCaseReassignment",
        summary: "Task owner requests reassignment (recorded, never executed)",
        parameters: [WORKSPACE_ID_PARAMETER, CASE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityOwnerRequest" },
            },
          },
        },
        responses: {
          202: { description: "Request recorded", ...jsonRef("#/components/schemas/SecurityCase") },
          403: errorResponse("FORBIDDEN — CASE_REASSIGNMENT_REQUEST_FORBIDDEN"),
          404: errorResponse("CASE_NOT_FOUND"),
        },
      },
    },
    [`${casePath}/quarantine-grants`]: {
      post: {
        operationId: "grantSecurityQuarantineAccess",
        summary: "Grant one subject scoped, time-limited quarantine inspection",
        description: `${SECURITY_DESCRIPTION} Administrator work; the subject must be a handler or independent reviewer. The grant is not case authority.`,
        parameters: [WORKSPACE_ID_PARAMETER, CASE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityQuarantineGrantRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "Grant issued",
            ...jsonRef("#/components/schemas/SecurityQuarantineGrant"),
          },
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED"),
          404: errorResponse("CASE_NOT_FOUND or QUARANTINE_NOT_FOUND"),
        },
      },
    },
    [`${base}/quarantine/{quarantine_id}/views`]: {
      post: {
        operationId: "viewQuarantinedContext",
        summary: "Inspect quarantined raw context under an existing grant",
        description: `${SECURITY_DESCRIPTION} Every attempt — allowed or denied — is audited. The response is never logged or cached by the service.`,
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "quarantine_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "X-Quarantine-Grant",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "Grant id issued for this subject and record.",
          },
        ],
        responses: {
          200: {
            description: "Decrypted content (sensitive)",
            ...jsonRef("#/components/schemas/SecurityQuarantineView"),
          },
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED or QUARANTINE_ACCESS_DENIED"),
          404: errorResponse("QUARANTINE_NOT_FOUND"),
          410: errorResponse("QUARANTINE_EXPIRED or QUARANTINE_ACCESS_GRANT_EXPIRED"),
        },
      },
    },
    [`${base}/rules`]: {
      get: {
        operationId: "listSecurityRuleRevisions",
        summary: "List versioned rule corrections for the workspace",
        description: `${SECURITY_DESCRIPTION} History is per lineage and never rewrites.`,
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "detector_id",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: [
                "proposed",
                "approved",
                "rejected",
                "activated",
                "superseded",
                "rolled_back",
                "expired",
                "applied",
              ],
            },
          },
          CURSOR_PARAMETER,
        ],
        responses: {
          200: {
            description: "Revision page",
            ...jsonRef("#/components/schemas/SecurityRulePage"),
          },
          403: errorResponse("FORBIDDEN — no security duty in this workspace"),
        },
      },
    },
    [`${base}/rules/proposals`]: {
      post: {
        operationId: "proposeSecurityRuleCorrection",
        summary: "Propose one bounded versioned rule correction",
        description: `${SECURITY_DESCRIPTION} The service rejects targeted exemptions (an invocation, case, request digest, or secret value) and blanket allows/disables by name. Regression evidence is computed by the service.`,
        parameters: [WORKSPACE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityRuleProposalRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "Proposal recorded",
            ...jsonRef("#/components/schemas/SecurityRuleRevision"),
          },
          400: errorResponse("RULE_PROPOSAL_INVALID"),
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED"),
          422: errorResponse(
            "RULE_TARGETED_EXEMPTION, RULE_BLANKET_EXEMPTION, RULE_EVIDENCE_MISSING, or RULE_EVIDENCE_FAILED",
          ),
        },
      },
    },
    [`${revisionPath}/reviews`]: {
      post: {
        operationId: "reviewSecurityRuleCorrection",
        summary: "Independent reviewer approves or rejects one revision",
        description: `${SECURITY_DESCRIPTION} The reviewer must differ from the author and every handling principal.`,
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "lineage",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "URL-encoded `detector_id|enterprise_id|workspace_id`.",
          },
          { name: "version", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          IDEMPOTENCY_KEY_PARAMETER,
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityRuleReviewRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Reviewed revision",
            ...jsonRef("#/components/schemas/SecurityRuleRevision"),
          },
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED"),
          404: errorResponse("RULE_REVISION_NOT_FOUND"),
          409: errorResponse("RULE_STATE_CONFLICT"),
          422: errorResponse("SOD_SELF_REVIEW_FORBIDDEN or SOD_SAME_PRINCIPAL_FORBIDDEN"),
        },
      },
    },
    [`${revisionPath}/activation`]: {
      post: {
        operationId: "activateSecurityRuleCorrection",
        summary: "Enterprise security administrator activates an approved revision",
        description: `${SECURITY_DESCRIPTION} Activation re-verifies the regression binding; the complete-request checks still apply afterwards.`,
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "lineage",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "URL-encoded `detector_id|enterprise_id|workspace_id`.",
          },
          { name: "version", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          IDEMPOTENCY_KEY_PARAMETER,
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityRuleActivationRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Activated revision",
            ...jsonRef("#/components/schemas/SecurityRuleRevision"),
          },
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED"),
          404: errorResponse("RULE_REVISION_NOT_FOUND"),
          409: errorResponse("RULE_STATE_CONFLICT or RULE_EVIDENCE_CHANGED"),
          422: errorResponse("RULE_NOT_APPROVED or RULE_EVIDENCE_FAILED"),
        },
      },
    },
    [`${base}/rules/{lineage}/rollbacks`]: {
      post: {
        operationId: "rollbackSecurityRuleCorrection",
        summary: "Roll back the active correction in a lineage (versioned and audited)",
        description: `${SECURITY_DESCRIPTION} Rollback cannot restore a superseded approval.`,
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "lineage",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "URL-encoded `detector_id|enterprise_id|workspace_id`.",
          },
          IDEMPOTENCY_KEY_PARAMETER,
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityRuleActivationRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "Rollback entry",
            ...jsonRef("#/components/schemas/SecurityRuleRevision"),
          },
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED"),
          409: errorResponse("RULE_NOTHING_TO_ROLL_BACK"),
        },
      },
    },
    [`${casePath}/recovery-approvals`]: {
      post: {
        operationId: "approveSecurityRecovery",
        summary: "Independent reviewer approves one recheck of a rebuilt request",
        description: `${SECURITY_DESCRIPTION} Approval authorizes rechecking, never sending: the complete request is rebuilt and scanned again, and the authorization is single-use and expiring.`,
        parameters: [WORKSPACE_ID_PARAMETER, CASE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityRecoveryApprovalRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "Recovery approval issued",
            ...jsonRef("#/components/schemas/SecurityRecoveryApproval"),
          },
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED"),
          404: errorResponse("CASE_NOT_FOUND"),
          409: errorResponse("RECOVERY_CASE_NOT_REVIEWABLE"),
          422: errorResponse("SOD_SELF_REVIEW_FORBIDDEN or MODEL_EGRESS_DENIED"),
        },
      },
    },
    [approvalPath]: {
      get: {
        operationId: "getSecurityRecoveryApproval",
        summary: "Read one recovery authorization's bound facts and state",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "authorization_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "Authorization",
            ...jsonRef("#/components/schemas/SecurityRecoveryApproval"),
          },
          404: errorResponse("RECOVERY_APPROVAL_INVALID — unknown authorization"),
        },
      },
      delete: {
        operationId: "revokeSecurityRecoveryApproval",
        summary: "Withdraw an unconsumed recovery approval",
        description: `${SECURITY_DESCRIPTION} A consumed authorization cannot be revoked or reused.`,
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "authorization_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          IDEMPOTENCY_KEY_PARAMETER,
        ],
        responses: {
          200: {
            description: "Revoked authorization",
            ...jsonRef("#/components/schemas/SecurityRecoveryApproval"),
          },
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED"),
          409: errorResponse("RECOVERY_APPROVAL_NOT_REVOCABLE"),
          422: errorResponse("RECOVERY_APPROVAL_INVALID"),
        },
      },
    },
    [`${approvalPath}/dispatch`]: {
      post: {
        operationId: "dispatchSecurityRecovery",
        summary: "Recheck the complete rebuilt request and dispatch once",
        description: `${SECURITY_DESCRIPTION} Required pre-dispatch audit evidence is persisted before any byte leaves; the authorization is consumed atomically so concurrent workers cannot send twice. An unknown provider outcome is recorded as unknown and never replayed.`,
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "authorization_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          IDEMPOTENCY_KEY_PARAMETER,
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityRecoveryDispatchRequest" },
            },
          },
        },
        responses: {
          202: {
            description: "Dispatch attempt recorded",
            ...jsonRef("#/components/schemas/SecurityRecoveryDispatch"),
          },
          403: errorResponse(
            "FORBIDDEN or MODEL_EGRESS_DENIED — authorization, destination, or policy refusal",
          ),
          422: errorResponse(
            "SENSITIVE_DATA_UNCERTAIN — the recheck still finds uncertain secret material",
          ),
          409: errorResponse(
            "RECOVERY_APPROVAL_INVALID — expired, revoked, consumed, or context changed",
          ),
          503: errorResponse(
            "AUDIT_UNAVAILABLE or SCANNER_UNAVAILABLE — fail closed, no bytes sent",
          ),
        },
      },
    },
    [`${base}/audit`]: {
      get: {
        operationId: "readSecurityAuditTrail",
        summary: "Read the tamper-evident non-secret security audit trail",
        description: `${SECURITY_DESCRIPTION} Restricted to handlers, reviewers, and administrators; the read itself is audited with the stated purpose before data is returned.`,
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "purpose",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 500 },
          },
          {
            name: "case_id",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "run_id",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "trace_id",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "invocation_id",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "event_type",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...SECURITY_AUDIT_EVENT_TYPES] },
          },
          {
            name: "from",
            in: "query",
            required: false,
            schema: { type: "string", format: "date-time" },
          },
          {
            name: "to",
            in: "query",
            required: false,
            schema: { type: "string", format: "date-time" },
          },
          CURSOR_PARAMETER,
        ],
        responses: {
          200: { description: "Audit page", ...jsonRef("#/components/schemas/SecurityAuditPage") },
          400: errorResponse("AUDIT_QUERY_INVALID"),
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED"),
          503: errorResponse("SECURITY_AUDIT_LOG_TAMPERED or SECURITY_AUDIT_LOCK_TIMEOUT"),
        },
      },
    },
    [`${base}/audit/exports`]: {
      post: {
        operationId: "exportSecurityAuditTrail",
        summary: "Export a filtered audit slice (administrator only, audited)",
        description: `${SECURITY_DESCRIPTION} An export leaves the service: it is restricted to the enterprise security administrator and recorded as audit.trail_exported before the payload is returned. No secret ever appears in the export.`,
        parameters: [WORKSPACE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SecurityAuditExportRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Export record and entries",
            ...jsonRef("#/components/schemas/SecurityAuditExport"),
          },
          400: errorResponse("AUDIT_QUERY_INVALID"),
          403: errorResponse("FORBIDDEN — SOD_DUTY_REQUIRED"),
          503: errorResponse("SECURITY_AUDIT_LOG_TAMPERED or SECURITY_AUDIT_LOCK_TIMEOUT"),
        },
      },
    },
  };
}

/** Expose the state matrix for coverage tests without importing internals. */
export const SECURITY_CASE_STATE_MATRIX: Record<CaseState, readonly CaseState[]> = CASE_TRANSITIONS;

/** Recovery invalidation reasons surfaced by stable redacted errors. */
export const SECURITY_RECOVERY_INVALID_REASONS = RECOVERY_INVALID_REASONS;
