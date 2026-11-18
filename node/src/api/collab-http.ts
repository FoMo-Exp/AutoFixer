import { createHash, randomUUID } from "node:crypto";
import type http from "node:http";

import type { ApprovalService } from "../collab/approval-service.js";
import type { CandidateReviewService } from "../collab/candidate-service.js";
import type { DeliveryBroker } from "../collab/delivery-broker.js";
import { DeliveryProviderError } from "../collab/delivery-broker.js";
import { CollabError } from "../collab/errors.js";
import type { CollabMachine } from "../collab/machine.js";
import type { DigestRef, IssueRecord, UserRef } from "../collab/types.js";
import { ApiError } from "./errors.js";
import { readJsonBody, requireString, writeJson } from "./http-util.js";

/**
 * Collaboration delivery API serving surface (DAT-259, ADR-0007).
 *
 * This is the HTTP wiring for the merged DAT-219/220 domain and the DAT-221
 * contract: the candidate review card, the candidate-bound human approval, and
 * the broker-controlled delivery operation under one issue. The contract was
 * merged before this module existed; nothing here invents a field, and no
 * record is client-authored or client-mutated.
 *
 * What this module enforces on its own:
 * - **Issue scope.** The issue must belong to the path workspace; another
 *   workspace's issue is an indistinguishable `404 ISSUE_NOT_FOUND`. The
 *   request boundary has already resolved the path workspace against the
 *   caller's live membership (and, when provider authority is in play, the
 *   action class against the effective-access gate), so scope is
 *   server-authoritative here too.
 * - **The approval belongs to the caller.** The approval decision names no
 *   approver in the body: the authenticated session user is the approver, and
 *   the approval service re-observes current repository access and explicit
 *   approval authority before recording anything. A deployment bearer (local
 *   operator) is not a human and can never decide an approval.
 * - **Replay-safe operation identity.** A mutating request maps its
 *   `Idempotency-Key` (scoped to actor, workspace, issue, and route) to the
 *   durable operation id, so a retry returns the recorded record instead of
 *   asking for a second approval/delivery. Reusing a key with a different
 *   payload is `409 IDEMPOTENCY_CONFLICT`.
 * - **No external write by this layer.** Provider writes happen only inside
 *   the delivery broker, which re-checks the current approval, delivery
 *   permission, recorded delivery grant, audit availability, branch
 *   constraint, and exact candidate identity before every write.
 */

export interface CollabHttpDeps {
  machine: CollabMachine;
  candidates: CandidateReviewService;
  approvals: ApprovalService;
  deliveries: DeliveryBroker;
}

/** Who the request acts as; derived from the authenticated request, never a body field. */
export interface CollabActor {
  kind: "local_operator" | "session";
  user_id: string | null;
  display_name: string | null;
}

export interface CollabRequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  requestId: string;
  /** The path workspace, already resolved against live membership. */
  workspaceId: string;
  issueId: string;
  /** Route segments after the issue id: `[resource, id?, action?]`. */
  tail: string[];
  actor: CollabActor;
  /**
   * Trusted delivery-permission decision for this actor, evaluated by the
   * request boundary (never supplied by the client). Recorded on a delivery
   * request and re-evaluated by the broker before every provider write.
   */
  requesterAuthorized: boolean;
}

const DELIVERY_PAGE_SIZE = 50;
const IDEMPOTENCY_KEY_MAX = 256;
const SHA256_HEX = /^[a-f0-9]{64}$/;

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_INPUT: 400,
  INVALID_CURSOR: 400,
  ISSUE_NOT_FOUND: 404,
  CANDIDATE_NOT_FOUND: 404,
  APPROVAL_NOT_FOUND: 404,
  DELIVERY_NOT_FOUND: 404,
  // A delivery reference that is missing, expired, or revoked is an authority
  // conflict, not a not-found: the caller named something it may not use.
  GRANT_NOT_FOUND: 409,
  GRANT_EXPIRED: 409,
  GRANT_REVOKED: 409,
  CANDIDATE_INVALID: 409,
  CANDIDATE_CONFLICT: 409,
  BASE_ADVANCED: 409,
  APPROVAL_REQUIRED: 409,
  APPROVAL_NOT_APPROVED: 409,
  APPROVAL_CONSUMED: 409,
  APPROVAL_BINDING_STALE: 409,
  APPROVAL_STATE_CONFLICT: 409,
  APPROVAL_ALREADY_PENDING: 409,
  DELIVERY_STATE_CONFLICT: 409,
  DELIVERY_OUTCOME_UNKNOWN: 409,
  TRANSITION_FORBIDDEN: 409,
  PRODUCT_HARNESS_CONFLICT: 409,
  APPROVER_NOT_AUTHORIZED: 403,
  DELIVERY_FORBIDDEN: 403,
  DELIVERY_AUDIT_UNAVAILABLE: 503,
  PROVIDER_ERROR: 503,
};

/** Map a collaboration domain denial to the shared error envelope. */
export function collabApiError(error: CollabError): ApiError {
  const status = STATUS_BY_CODE[error.code] ?? 409;
  // `OPERATION_CONFLICT` is the machine's "same operation id, different
  // payload" protocol violation; the API names it as the contract does.
  const code = error.code === "OPERATION_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : error.code;
  return new ApiError(status, code, error.message, error.details as Record<string, unknown>);
}

export interface IdempotentOperation {
  /** Durable operation id; a replay with the same key yields the same id. */
  operation_id: string;
  /** The key as received, for conflict diagnostics. */
  key: string | null;
}

/**
 * Derive the durable operation identity of one mutating request.
 *
 * Without a key each request is a new operation (the contract makes the header
 * optional); with a key, the id is deterministic over actor + workspace + issue
 * + route + key, so a safe retry replays the recorded command and a different
 * payload is refused by the machine rather than applied twice.
 */
export function operationFor(
  req: http.IncomingMessage,
  scope: string,
  actorId: string,
): IdempotentOperation {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) {
    return { operation_id: `collab:${scope}:${randomUUID()}`, key: null };
  }
  if (typeof raw !== "string" || raw.length === 0 || raw.length > IDEMPOTENCY_KEY_MAX) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      `Idempotency-Key must be 1–${IDEMPOTENCY_KEY_MAX} characters`,
    );
  }
  const digest = createHash("sha256").update(`${actorId}\0${raw}`).digest("hex");
  return { operation_id: `collab:${scope}:${digest}`, key: raw };
}

/** Audit actor label: the session user, or the deployment bearer's own label. */
function actorLabel(actor: CollabActor): string {
  return actor.kind === "session" && actor.user_id !== null
    ? `user:${actor.user_id}`
    : "local-operator";
}

function requireIssue(machine: CollabMachine, workspaceId: string, issueId: string): IssueRecord {
  const issue = machine.getIssue(issueId);
  if (issue === undefined || issue.workspace.workspace_id !== workspaceId) {
    throw new CollabError("ISSUE_NOT_FOUND", "Issue was not found", { issue_id: issueId });
  }
  return issue;
}

function requireDigest(body: Record<string, unknown>): DigestRef {
  const value = body["diff_digest"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_REQUEST", "diff_digest is required");
  }
  const digest = value as Record<string, unknown>;
  if (digest["algorithm"] !== "sha256" || typeof digest["value"] !== "string") {
    throw new ApiError(400, "INVALID_REQUEST", "diff_digest must be a sha256 digest");
  }
  if (!SHA256_HEX.test(digest["value"])) {
    throw new ApiError(400, "INVALID_REQUEST", "diff_digest.value must be 64 lowercase hex");
  }
  return { algorithm: "sha256", value: digest["value"] };
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be a non-empty string`);
  }
  return value;
}

function cursorOf(url: URL): string | null {
  const cursor = url.searchParams.get("cursor");
  return cursor === null || cursor === "" ? null : cursor;
}

interface PageBody<T> {
  items: T[];
  next_cursor: string | null;
}

function pageDeliveries(
  items: { delivery_id: string }[],
  cursor: string | null,
): PageBody<unknown> {
  let start = 0;
  if (cursor !== null) {
    const index = items.findIndex((item) => item.delivery_id === cursor);
    if (index === -1) {
      throw new CollabError("INVALID_CURSOR", "unknown delivery cursor", { cursor });
    }
    start = index + 1;
  }
  const page = items.slice(start, start + DELIVERY_PAGE_SIZE);
  const last = page[page.length - 1];
  const more = start + page.length < items.length;
  return {
    items: page,
    next_cursor: last !== undefined && more ? last.delivery_id : null,
  };
}

/**
 * Serve one candidate/approval/delivery request. Returns `false` when the
 * path is not part of this surface, so the caller keeps its own 404.
 */
export async function handleCollabRequest(
  deps: CollabHttpDeps,
  ctx: CollabRequestContext,
): Promise<boolean> {
  const [resource, id, action] = ctx.tail;
  if (resource !== "candidates" && resource !== "approvals" && resource !== "deliveries") {
    return false;
  }
  const method = ctx.req.method ?? "GET";
  const isRead = method === "GET" || method === "HEAD";
  try {
    const issue = requireIssue(deps.machine, ctx.workspaceId, ctx.issueId);
    const actor = actorLabel(ctx.actor);

    if (resource === "candidates") {
      if (!isRead || action !== undefined) {
        return false;
      }
      if (id === undefined) {
        writeJson(ctx.res, 200, deps.candidates.page(issue.issue_id, cursorOf(ctx.url)));
        return true;
      }
      writeJson(ctx.res, 200, deps.candidates.get(issue.issue_id, id));
      return true;
    }

    if (resource === "approvals") {
      if (action === "decision") {
        if (method !== "POST" || id === undefined) {
          return false;
        }
        if (ctx.actor.kind !== "session" || ctx.actor.user_id === null) {
          // The approver is the authenticated caller; the deployment bearer is
          // not a human and a body field can never assert one.
          throw new CollabError(
            "APPROVER_NOT_AUTHORIZED",
            "an approval decision requires an authenticated human approver",
            { approval_id: id },
          );
        }
        const body = await readJsonBody(ctx.req);
        const decision = body["decision"];
        if (decision !== "approve" && decision !== "reject") {
          throw new ApiError(400, "INVALID_REQUEST", "decision must be approve or reject");
        }
        const note = body["note"];
        if (note !== undefined && note !== null && typeof note !== "string") {
          throw new ApiError(400, "INVALID_REQUEST", "note must be a string");
        }
        const operation = operationFor(
          ctx.req,
          `approval-decision:${ctx.workspaceId}:${issue.issue_id}:${id}`,
          actor,
        );
        const approver: UserRef = {
          id: ctx.actor.user_id,
          display_name: ctx.actor.display_name ?? ctx.actor.user_id,
        };
        const approval = deps.approvals.decide({
          operation_id: operation.operation_id,
          actor_user: approver,
          issue_id: issue.issue_id,
          approval_id: id,
          decision,
          diff_digest: requireDigest(body),
          ...(typeof note === "string" ? { note } : {}),
        });
        writeJson(ctx.res, 200, approval);
        return true;
      }
      if (action !== undefined) {
        return false;
      }
      if (id !== undefined && isRead) {
        writeJson(ctx.res, 200, deps.approvals.get(issue.issue_id, id));
        return true;
      }
      if (id === undefined && isRead) {
        writeJson(ctx.res, 200, deps.approvals.page(issue.issue_id, cursorOf(ctx.url)));
        return true;
      }
      if (id === undefined && method === "POST") {
        const body = await readJsonBody(ctx.req);
        const candidateId = requireString(body, "candidate_id");
        const targetBranch = optionalString(body, "target_branch");
        const approverUserId = optionalString(body, "approver_user_id");
        const operation = operationFor(
          ctx.req,
          `approval-request:${ctx.workspaceId}:${issue.issue_id}`,
          actor,
        );
        const approval = deps.approvals.request({
          operation_id: operation.operation_id,
          actor,
          issue_id: issue.issue_id,
          candidate_id: candidateId,
          ...(targetBranch !== undefined ? { target_branch: targetBranch } : {}),
          ...(approverUserId !== undefined ? { approver_user_id: approverUserId } : {}),
        });
        writeJson(ctx.res, 201, approval);
        return true;
      }
      return false;
    }

    // deliveries
    if (action === "reconcile") {
      if (method !== "POST" || id === undefined) {
        return false;
      }
      const operation = operationFor(
        ctx.req,
        `delivery-reconcile:${ctx.workspaceId}:${issue.issue_id}:${id}`,
        actor,
      );
      const delivery = await deps.deliveries.reconcile(id, {
        operation_id: operation.operation_id,
        actor,
      });
      writeJson(ctx.res, 202, delivery);
      return true;
    }
    if (action !== undefined) {
      return false;
    }
    if (id !== undefined && isRead) {
      writeJson(ctx.res, 200, deps.deliveries.get(issue.issue_id, id));
      return true;
    }
    if (id === undefined && isRead) {
      writeJson(
        ctx.res,
        200,
        pageDeliveries(deps.deliveries.list(issue.issue_id), cursorOf(ctx.url)),
      );
      return true;
    }
    if (id === undefined && method === "POST") {
      const body = await readJsonBody(ctx.req);
      const approvalId = requireString(body, "approval_id");
      const grantId = requireString(body, "grant_id");
      const approvalRecord = deps.machine.getApproval(approvalId);
      if (approvalRecord === undefined || approvalRecord.issue_id !== issue.issue_id) {
        throw new CollabError("APPROVAL_NOT_FOUND", "unknown approval request", {
          approval_id: approvalId,
        });
      }
      const operation = operationFor(
        ctx.req,
        `delivery-request:${ctx.workspaceId}:${issue.issue_id}`,
        actor,
      );
      const recorded = deps.deliveries.request({
        operation_id: operation.operation_id,
        actor,
        issue_id: issue.issue_id,
        candidate_id: approvalRecord.candidate_id,
        approval_id: approvalId,
        grant_id: grantId,
        requester_authorized: ctx.requesterAuthorized,
      });
      // The approved change enters the delivery stage: the human approval is
      // consumed and the broker, not the client, owns the provider write. A
      // retry lands here again only while the delivery is still pending.
      const current = deps.machine.getIssue(issue.issue_id);
      if (current?.product_state === "awaiting_change_approval") {
        deps.machine.transitionIssue({
          operation_id: `${operation.operation_id}:delivering`,
          actor,
          issue_id: issue.issue_id,
          to: "delivering",
          reason: "candidate-bound human approval recorded; broker delivery started",
        });
      }
      // One broker attempt inside the same request: the operation identity is
      // already durable, every write is preceded by a re-checked state
      // transition, and an ambiguous/partial outcome is returned as such —
      // never retried here, never reported as success. A replay of this same
      // operation (same Idempotency-Key) returns the delivery's current state
      // instead of starting a second write.
      const live = deps.machine.getDelivery(recorded.delivery_id);
      const delivery =
        live !== undefined && live.state === "pending"
          ? await deps.deliveries.deliver(recorded.delivery_id, { actor })
          : deps.deliveries.get(issue.issue_id, recorded.delivery_id);
      writeJson(ctx.res, 202, delivery);
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof DeliveryProviderError) {
      // The provider could not be read: no write happened and the operation
      // stays unreconciled. Retryable, but never auto-retried by the service.
      throw new ApiError(503, "PROVIDER_ERROR", error.message);
    }
    if (error instanceof CollabError) {
      throw collabApiError(error);
    }
    throw error;
  }
}
