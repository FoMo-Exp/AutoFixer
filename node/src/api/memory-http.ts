/**
 * Workspace memory v1 HTTP surface (DAT-236).
 *
 * Every route is authenticated by a web/desktop session and scoped by the
 * caller's workspace membership — never by a path or body identifier.
 *
 * The surface has two halves:
 *
 * - Retrieval-side (DAT-236/DAT-238): search, feedback, browse, versions,
 *   evaluation recording, and bounded-RSI governance.
 * - Governance (DAT-251): item detail, per-version content, the item audit
 *   timeline, and the four named human transitions promote/deprecate/
 *   quarantine/restore. These require a person with standing (owner/admin, or
 *   the team lead of the item's team). An agent/process credential is refused
 *   with 403 even though it authenticates the operator surface: memory
 *   administration is not reachable from an agent credential.
 */

import type http from "node:http";

import type { SessionContext } from "./auth-service.js";
import type { AuthService } from "./auth-service.js";
import { ApiError } from "./errors.js";
import { readJsonBody, writeJson } from "./http-util.js";
import { requireSessionActor, requestSessionToken } from "./auth-http.js";
import { isAuthorizedBearer } from "./auth.js";
import type { RequestAuthority } from "./request-authority.js";
import type {
  MemoryGovernanceActor,
  MemoryGovernanceReasonCode,
  MemoryGovernanceService,
  MemoryRestoreTargetStatus,
} from "../memory/governance/index.js";
import { MEMORY_GOVERNANCE_ACTIONS } from "../memory/governance/index.js";
import type { WorkspaceRole, WorkspaceScope } from "../control-plane/types.js";
import type {
  MemoryEvalRunInput,
  MemoryFeedbackInput,
  MemoryItemsFilter,
  MemoryRetrievalService,
  MemorySearchRequest,
} from "../memory/retrieval/index.js";
import type {
  CreateRsiProposalInput,
  RsiActor,
  RsiDataset,
  RsiEvaluationRequest,
  RsiProposalFilter,
  RsiProposalStatus,
  RsiRisk,
  RsiService,
  RsiTarget,
} from "../memory/rsi/index.js";
import {
  RSI_DATASETS,
  RSI_PROPOSAL_STATUSES,
  RSI_RISKS,
  RSI_TARGETS,
} from "../memory/rsi/index.js";

export interface MemoryHttpDeps {
  auth: AuthService;
  service: MemoryRetrievalService;
  /** Provider-authority request boundary (DAT-203), when configured. */
  authority?: RequestAuthority;
  /**
   * Bounded RSI governance (DAT-238). Unset keeps the proposal, canary,
   * budget, and kill-switch routes nonexistent.
   */
  rsi?: RsiService;
  /**
   * Memory governance (DAT-251). Unset keeps the detail, versions, events, and
   * promote/deprecate/quarantine/restore routes nonexistent.
   */
  governance?: MemoryGovernanceService;
  /**
   * The deployment's local-operator bearer token. When a caller presents it
   * instead of a session, governance writes answer 403: an agent credential
   * may read retrieval, never administer memory.
   */
  apiToken?: string;
}

export interface MemoryRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  segments: string[];
  requestId: string;
}

interface MemoryScope {
  ctx: SessionContext;
  scope: WorkspaceScope;
  role: WorkspaceRole;
}

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

function requireMemoryScope(deps: MemoryHttpDeps, ctx: MemoryRouteContext): MemoryScope {
  const workspaceId = ctx.segments[3];
  if (workspaceId === undefined || workspaceId.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "workspace_id is required");
  }
  const session = requireSessionActor(deps.auth, ctx.req);
  const membership = deps.auth
    .sessionInfo(session)
    .memberships.find((entry) => entry.workspace_id === workspaceId);
  if (membership === undefined) {
    // A workspace outside the caller's membership is indistinguishable from a
    // missing one; the message never confirms existence.
    throw new ApiError(404, "NOT_FOUND", "no such workspace");
  }
  return {
    ctx: session,
    scope: {
      enterprise_id: membership.enterprise_id,
      workspace_id: membership.workspace_id,
      actor_id: session.user.id,
    },
    role: membership.role as WorkspaceRole,
  };
}

function requireAuthority(
  deps: MemoryHttpDeps,
  memory: MemoryScope,
  action: "read" | "write",
): void {
  deps.authority?.require(memory.ctx.user.id, action, memory.scope.workspace_id);
}

function requireRole(memory: MemoryScope, minimum: WorkspaceRole): void {
  if (ROLE_RANK[memory.role] < ROLE_RANK[minimum]) {
    throw new ApiError(403, "FORBIDDEN", `this session requires the ${minimum} role`);
  }
}

/** Scope identifiers are never accepted from a request body. */
function rejectScopeClaims(body: Record<string, unknown>): void {
  for (const field of ["workspace_id", "enterprise_id"]) {
    if (field in body) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `${field} is derived from the authenticated session and must not be sent`,
      );
    }
  }
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be a string`);
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be a number`);
  }
  return value;
}

function searchRequest(memory: MemoryScope, body: Record<string, unknown>): MemorySearchRequest {
  rejectScopeClaims(body);
  const purpose = optionalString(body, "purpose") ?? "run_plan";
  const includeCandidates = body["include_candidates"];
  if (includeCandidates !== undefined && typeof includeCandidates !== "boolean") {
    throw new ApiError(400, "INVALID_REQUEST", "include_candidates must be a boolean");
  }
  const scope = body["scope"];
  if (
    scope !== undefined &&
    (scope === null || typeof scope !== "object" || Array.isArray(scope))
  ) {
    throw new ApiError(400, "INVALID_REQUEST", "scope must be an object");
  }
  const embedding = body["query_embedding"];
  if (
    embedding !== undefined &&
    (embedding === null || typeof embedding !== "object" || Array.isArray(embedding))
  ) {
    throw new ApiError(400, "INVALID_REQUEST", "query_embedding must be an object");
  }
  return {
    purpose: purpose as MemorySearchRequest["purpose"],
    query: optionalString(body, "query") ?? "",
    role: memory.role,
    ...(scope !== undefined ? { scope } : {}),
    ...(optionalString(body, "run_id") !== undefined
      ? { run_id: optionalString(body, "run_id") }
      : {}),
    ...(optionalString(body, "path_prefix") !== undefined
      ? { path_prefix: optionalString(body, "path_prefix") }
      : {}),
    ...(optionalNumber(body, "context_window_tokens") !== undefined
      ? { context_window_tokens: optionalNumber(body, "context_window_tokens") }
      : {}),
    ...(optionalNumber(body, "max_items") !== undefined
      ? { max_items: optionalNumber(body, "max_items") }
      : {}),
    ...(optionalNumber(body, "max_tokens") !== undefined
      ? { max_tokens: optionalNumber(body, "max_tokens") }
      : {}),
    ...(optionalNumber(body, "policy_version") !== undefined
      ? { policy_version: optionalNumber(body, "policy_version") }
      : {}),
    ...(includeCandidates !== undefined ? { include_candidates: includeCandidates } : {}),
    ...(embedding !== undefined ? { query_embedding: embedding } : {}),
  } as MemorySearchRequest;
}

function feedbackInput(body: Record<string, unknown>): MemoryFeedbackInput {
  rejectScopeClaims(body);
  const bundleId = body["bundle_id"];
  const runId = body["run_id"];
  const outcome = body["outcome"];
  if (typeof bundleId !== "string" || bundleId.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "bundle_id is required");
  }
  if (typeof runId !== "string" || runId.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "run_id is required");
  }
  if (typeof outcome !== "string") {
    throw new ApiError(400, "INVALID_REQUEST", "outcome is required");
  }
  const items = body["items"];
  if (items !== undefined && !Array.isArray(items)) {
    throw new ApiError(400, "INVALID_REQUEST", "items must be an array");
  }
  return {
    bundle_id: bundleId,
    run_id: runId,
    outcome: outcome as MemoryFeedbackInput["outcome"],
    ...(items !== undefined ? { items: items as MemoryFeedbackInput["items"] } : {}),
    ...(optionalString(body, "note") !== undefined ? { note: optionalString(body, "note") } : {}),
  };
}

function evalRunInput(body: Record<string, unknown>): MemoryEvalRunInput {
  rejectScopeClaims(body);
  const dataset = body["dataset"];
  if (dataset === null || typeof dataset !== "object" || Array.isArray(dataset)) {
    throw new ApiError(400, "INVALID_REQUEST", "dataset is required");
  }
  const metrics = body["metrics"];
  if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new ApiError(400, "INVALID_REQUEST", "metrics is required");
  }
  return {
    kind: body["kind"] as MemoryEvalRunInput["kind"],
    dataset: dataset as MemoryEvalRunInput["dataset"],
    policy_version: body["policy_version"] as number,
    memory_version: body["memory_version"] as string,
    metrics: metrics as MemoryEvalRunInput["metrics"],
    verdict: body["verdict"] as MemoryEvalRunInput["verdict"],
    ...(optionalString(body, "notes") !== undefined
      ? { notes: optionalString(body, "notes") }
      : {}),
  };
}

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

/** Parse and bound the browse query string. */
function itemsFilter(url: URL): MemoryItemsFilter {
  const filter: MemoryItemsFilter = {};
  const kind = url.searchParams.get("kind");
  const status = url.searchParams.get("status");
  const tier = url.searchParams.get("tier");
  const teamId = optionalQuery(url, "team_id");
  const pathPrefix = optionalQuery(url, "path_prefix");
  const language = optionalQuery(url, "language");
  const taskFamily = optionalQuery(url, "task_family");
  const trust = optionalQuery(url, "trust");
  const sensitivity = optionalQuery(url, "sensitivity");
  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  if (kind !== null && kind.length > 0) {
    filter.kind = kind as MemoryItemsFilter["kind"];
  }
  if (status !== null && status.length > 0) {
    filter.status = status as MemoryItemsFilter["status"];
  }
  if (tier !== null && tier.length > 0) {
    filter.tier = tier as MemoryItemsFilter["tier"];
  }
  if (teamId !== undefined) {
    filter.team_id = teamId;
  }
  if (pathPrefix !== undefined) {
    filter.path_prefix = pathPrefix;
  }
  if (language !== undefined) {
    filter.language = language;
  }
  if (taskFamily !== undefined) {
    filter.task_family = taskFamily;
  }
  if (trust !== undefined) {
    filter.trust = trust as MemoryItemsFilter["trust"];
  }
  if (sensitivity !== undefined) {
    filter.sensitivity = sensitivity as MemoryItemsFilter["sensitivity"];
  }
  if (limit !== null && limit.length > 0) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ApiError(400, "INVALID_REQUEST", "limit must be a positive integer");
    }
    filter.limit = parsed;
  }
  if (cursor !== null && cursor.length > 0) {
    filter.cursor = cursor;
  }
  return filter;
}

// ---------------------------------------------------------------------------
// Memory governance (DAT-251)
// ---------------------------------------------------------------------------

function governanceService(deps: MemoryHttpDeps): MemoryGovernanceService {
  if (deps.governance === undefined) {
    throw new ApiError(404, "NOT_FOUND", "the memory governance surface is not configured");
  }
  return deps.governance;
}

function governanceActor(memory: MemoryScope): MemoryGovernanceActor {
  return { user_id: memory.ctx.user.id, role: memory.role };
}

/**
 * A user session governs memory; the deployment's operator/agent bearer token
 * does not. Authentication and authorization are different questions here:
 * the credential is valid, the authority is absent, so the answer is 403 and
 * never a 401 that would invite a retry with the same token.
 */
function rejectAgentCredential(deps: MemoryHttpDeps, req: http.IncomingMessage): void {
  if (deps.apiToken === undefined || deps.apiToken.length === 0) {
    return;
  }
  const presented = requestSessionToken(req);
  if (presented !== undefined && presented.via === "cookie") {
    // A browser session is a person; the bearer check below is for the
    // operator/agent credential only.
    return;
  }
  if (isAuthorizedBearer(req.headers.authorization, deps.apiToken)) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "agent credentials cannot govern workspace memory; a user session is required",
    );
  }
}

/** Only the documented transition fields are accepted; nothing else is read. */
function requireGovernanceBody(body: Record<string, unknown>, allowed: readonly string[]): void {
  rejectScopeClaims(body);
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `${key} is not part of this transition; only ${allowed.join(", ")} are accepted`,
      );
    }
  }
}

function requiredPositiveInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be a positive integer`);
  }
  return value;
}

function requiredReasonCode(body: Record<string, unknown>): MemoryGovernanceReasonCode {
  const value = body["reason_code"];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "reason_code is required");
  }
  // The service validates membership in the fixed vocabulary; this only
  // rejects a missing or non-string value.
  return value as MemoryGovernanceReasonCode;
}

function requiredTargetStatus(body: Record<string, unknown>): MemoryRestoreTargetStatus {
  const value = body["target_status"];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "target_status is required");
  }
  // The service rejects anything outside the restore vocabulary, including
  // `active`.
  return value as MemoryRestoreTargetStatus;
}

// ---------------------------------------------------------------------------
// Bounded RSI request bodies (DAT-238)
// ---------------------------------------------------------------------------

function rsiService(deps: MemoryHttpDeps): RsiService {
  if (deps.rsi === undefined) {
    throw new ApiError(404, "NOT_FOUND", "the RSI surface is not configured");
  }
  return deps.rsi;
}

function actor(memory: MemoryScope): RsiActor {
  return { id: memory.ctx.user.id, role: memory.role };
}

function memberList(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Proposal creation derives the proposer from the session and the risk from
 * the target: neither is a client claim.
 */
function proposalInput(memory: MemoryScope, body: Record<string, unknown>): CreateRsiProposalInput {
  rejectScopeClaims(body);
  if ("proposer" in body) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "proposer is derived from the authenticated session and must not be sent",
    );
  }
  if ("risk" in body) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "risk is derived from the target and must not be sent",
    );
  }
  const target = body["target"];
  if (typeof target !== "string" || !(RSI_TARGETS as readonly string[]).includes(target)) {
    throw new ApiError(400, "INVALID_REQUEST", `target must be one of ${RSI_TARGETS.join(", ")}`);
  }
  const item = body["memory_item"];
  if (item !== undefined && (item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new ApiError(400, "INVALID_REQUEST", "memory_item must be an object");
  }
  const itemInput = item as Record<string, unknown> | undefined;
  return {
    title: optionalString(body, "title") ?? "",
    summary: optionalString(body, "summary") ?? "",
    diff: optionalString(body, "diff") ?? "",
    target: target as RsiTarget,
    proposer: { id: memory.ctx.user.id, kind: "human" },
    ...(body["candidate_policy"] !== undefined
      ? { candidate_policy: body["candidate_policy"] }
      : {}),
    ...(itemInput !== undefined
      ? {
          memory_item: {
            item_id: String(itemInput["item_id"] ?? ""),
            item_version: Number(itemInput["item_version"] ?? 0),
          },
        }
      : {}),
  };
}

const FORBIDDEN_EVALUATION_FIELDS = [
  "verifier",
  "metrics",
  "sample_size",
  "baseline_sample_size",
  "candidate_sample_size",
  "baseline_successes",
  "candidate_successes",
  "baseline_rework",
  "candidate_rework",
  "baseline_cost",
  "candidate_cost",
  "safety_events",
  "success_delta",
  "delta_ci_low",
  "delta_ci_high",
  "verdict",
  "evidence_reference",
];

/**
 * Evaluation accepts datasets only. The actor is the session principal; the
 * replay and its interval are computed server-side, so any score, verifier
 * claim, or evidence text in the body is a refusal rather than an input.
 */
function evaluationInput(body: Record<string, unknown>): RsiEvaluationRequest {
  rejectScopeClaims(body);
  for (const field of FORBIDDEN_EVALUATION_FIELDS) {
    if (field in body) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `${field} is computed or bound by the server and must not be sent`,
      );
    }
  }
  const datasets = memberList(body, "datasets");
  if (
    datasets !== undefined &&
    datasets.some((entry) => !(RSI_DATASETS as readonly string[]).includes(entry))
  ) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      `datasets entries must be ${RSI_DATASETS.join(", ")}`,
    );
  }
  return {
    ...(datasets !== undefined ? { datasets: datasets as RsiDataset[] } : {}),
  };
}

function proposalFilter(url: URL): RsiProposalFilter {
  const filter: RsiProposalFilter = {};
  const status = url.searchParams.get("status");
  const risk = url.searchParams.get("risk");
  const limit = url.searchParams.get("limit");
  if (status !== null && status.length > 0) {
    if (!(RSI_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      throw new ApiError(400, "INVALID_REQUEST", "unknown proposal status filter");
    }
    filter.status = status as RsiProposalStatus;
  }
  if (risk !== null && risk.length > 0) {
    if (!(RSI_RISKS as readonly string[]).includes(risk)) {
      throw new ApiError(400, "INVALID_REQUEST", "risk must be A, B, C, or D");
    }
    filter.risk = risk as RsiRisk;
  }
  if (limit !== null && limit.length > 0) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ApiError(400, "INVALID_REQUEST", "limit must be a positive integer");
    }
    filter.limit = parsed;
  }
  return filter;
}

/**
 * Handle `/api/v1/workspaces/{workspace_id}/memory/*`. Always handles the
 * request or throws the shared error envelope's mapped error.
 */
export async function handleMemoryRequest(
  deps: MemoryHttpDeps,
  ctx: MemoryRouteContext,
): Promise<void> {
  const { req, res, url, segments } = ctx;
  const method = req.method ?? "GET";
  if (segments.length < 6 || segments[4] !== "memory") {
    throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
  }
  const resource = segments[5];
  // Governance writes are refused for an agent/operator credential *before*
  // session resolution: that credential is valid but has no standing here, so
  // the honest answer is 403, not the 401 a missing session would produce.
  const isGovernanceMutation =
    method === "POST" &&
    resource === "items" &&
    segments.length === 8 &&
    (MEMORY_GOVERNANCE_ACTIONS as readonly string[]).includes(segments[7] as string);
  if (isGovernanceMutation) {
    rejectAgentCredential(deps, req);
  }
  const memory = requireMemoryScope(deps, ctx);

  // POST /memory/search
  if (method === "POST" && resource === "search" && segments.length === 6) {
    requireAuthority(deps, memory, "read");
    const body = await readJsonBody(req);
    writeJson(res, 200, deps.service.search(memory.scope, searchRequest(memory, body)));
    return;
  }

  // POST /memory/feedback
  if (method === "POST" && resource === "feedback" && segments.length === 6) {
    requireRole(memory, "member");
    requireAuthority(deps, memory, "write");
    const body = await readJsonBody(req);
    writeJson(res, 201, deps.service.recordFeedback(memory.scope, feedbackInput(body)));
    return;
  }

  // GET /memory/items
  if (method === "GET" && resource === "items" && segments.length === 6) {
    requireAuthority(deps, memory, "read");
    writeJson(res, 200, deps.service.listItems(memory.scope, memory.role, itemsFilter(url)));
    return;
  }

  // GET /memory/items/{item_id} — detail, same view and ceiling as browse.
  if (method === "GET" && resource === "items" && segments.length === 7) {
    requireAuthority(deps, memory, "read");
    writeJson(
      res,
      200,
      governanceService(deps).getItem(memory.scope, memory.role, segments[6] as string),
    );
    return;
  }

  // GET /memory/items/{item_id}/versions — per-version content for diffing.
  if (
    method === "GET" &&
    resource === "items" &&
    segments.length === 8 &&
    segments[7] === "versions"
  ) {
    requireAuthority(deps, memory, "read");
    writeJson(
      res,
      200,
      governanceService(deps).versions(memory.scope, memory.role, segments[6] as string),
    );
    return;
  }

  // GET /memory/items/{item_id}/events — the merged audit timeline.
  if (
    method === "GET" &&
    resource === "items" &&
    segments.length === 8 &&
    segments[7] === "events"
  ) {
    requireAuthority(deps, memory, "read");
    writeJson(
      res,
      200,
      governanceService(deps).events(memory.scope, memory.role, segments[6] as string),
    );
    return;
  }

  // POST /memory/items/{item_id}/{promote|deprecate|quarantine|restore}
  if (
    method === "POST" &&
    resource === "items" &&
    segments.length === 8 &&
    (MEMORY_GOVERNANCE_ACTIONS as readonly string[]).includes(segments[7] as string)
  ) {
    // Governance is a write; authority is checked before any body is read so
    // an unauthorized caller cannot use error shape as an oracle.
    requireAuthority(deps, memory, "write");
    const action = segments[7] as (typeof MEMORY_GOVERNANCE_ACTIONS)[number];
    const itemId = segments[6] as string;
    const service = governanceService(deps);
    const body = await readJsonBody(req);
    const actor = governanceActor(memory);
    if (action === "promote") {
      requireGovernanceBody(body, ["version", "expected_version"]);
      writeJson(
        res,
        200,
        service.promote(memory.scope, actor, itemId, {
          version: requiredPositiveInteger(body, "version"),
          expected_version: requiredPositiveInteger(body, "expected_version"),
        }),
      );
      return;
    }
    if (action === "deprecate" || action === "quarantine") {
      requireGovernanceBody(body, ["version", "expected_version", "reason_code"]);
      writeJson(
        res,
        200,
        action === "deprecate"
          ? service.deprecate(memory.scope, actor, itemId, {
              version: requiredPositiveInteger(body, "version"),
              expected_version: requiredPositiveInteger(body, "expected_version"),
              reason_code: requiredReasonCode(body),
            })
          : service.quarantine(memory.scope, actor, itemId, {
              version: requiredPositiveInteger(body, "version"),
              expected_version: requiredPositiveInteger(body, "expected_version"),
              reason_code: requiredReasonCode(body),
            }),
      );
      return;
    }
    requireGovernanceBody(body, ["version", "expected_version", "target_status", "reason_code"]);
    writeJson(
      res,
      200,
      service.restore(memory.scope, actor, itemId, {
        version: requiredPositiveInteger(body, "version"),
        expected_version: requiredPositiveInteger(body, "expected_version"),
        target_status: requiredTargetStatus(body),
        reason_code: requiredReasonCode(body),
      }),
    );
    return;
  }

  // GET /memory/versions
  if (method === "GET" && resource === "versions" && segments.length === 6) {
    requireAuthority(deps, memory, "read");
    writeJson(res, 200, deps.service.versions(memory.scope, memory.role));
    return;
  }

  // POST /memory/eval-runs
  if (method === "POST" && resource === "eval-runs" && segments.length === 6) {
    requireRole(memory, "owner");
    requireAuthority(deps, memory, "write");
    const body = await readJsonBody(req);
    writeJson(res, 201, deps.service.recordEvalRun(memory.scope, evalRunInput(body)));
    return;
  }

  // -------------------------------------------------------------------------
  // Bounded RSI (DAT-238)
  // -------------------------------------------------------------------------

  // POST/GET /memory/proposals
  if (resource === "proposals" && segments.length === 6) {
    requireRole(memory, "member");
    const rsi = rsiService(deps);
    if (method === "POST") {
      requireAuthority(deps, memory, "write");
      const body = await readJsonBody(req);
      writeJson(res, 201, rsi.createProposal(memory.scope, proposalInput(memory, body)));
      return;
    }
    if (method === "GET") {
      requireAuthority(deps, memory, "read");
      writeJson(res, 200, {
        proposals: rsi.listProposals(memory.scope, proposalFilter(url)),
      });
      return;
    }
  }

  // GET /memory/proposals/{proposal_id}
  if (method === "GET" && resource === "proposals" && segments.length === 7) {
    requireAuthority(deps, memory, "read");
    writeJson(res, 200, rsiService(deps).getProposal(memory.scope, segments[6] as string));
    return;
  }

  // POST /memory/proposals/{proposal_id}/evaluations
  if (
    method === "POST" &&
    resource === "proposals" &&
    segments.length === 8 &&
    segments[7] === "evaluations"
  ) {
    requireRole(memory, "owner");
    requireAuthority(deps, memory, "write");
    const body = await readJsonBody(req);
    writeJson(
      res,
      201,
      rsiService(deps).evaluate(
        memory.scope,
        segments[6] as string,
        evaluationInput(body),
        actor(memory),
      ),
    );
    return;
  }

  // POST /memory/proposals/{proposal_id}/approvals
  if (
    method === "POST" &&
    resource === "proposals" &&
    segments.length === 8 &&
    segments[7] === "approvals"
  ) {
    requireRole(memory, "admin");
    requireAuthority(deps, memory, "write");
    const body = await readJsonBody(req);
    writeJson(
      res,
      201,
      rsiService(deps).approve(
        memory.scope,
        segments[6] as string,
        actor(memory),
        optionalString(body, "note"),
      ),
    );
    return;
  }

  // POST /memory/proposals/{proposal_id}/canary
  if (
    method === "POST" &&
    resource === "proposals" &&
    segments.length === 8 &&
    segments[7] === "canary"
  ) {
    requireRole(memory, "owner");
    requireAuthority(deps, memory, "write");
    writeJson(
      res,
      201,
      rsiService(deps).startCanary(memory.scope, segments[6] as string, actor(memory)),
    );
    return;
  }

  // POST /memory/proposals/{proposal_id}/canary/observations
  if (
    method === "POST" &&
    resource === "proposals" &&
    segments.length === 9 &&
    segments[7] === "canary" &&
    segments[8] === "observations"
  ) {
    requireRole(memory, "owner");
    requireAuthority(deps, memory, "write");
    const body = await readJsonBody(req);
    if (Object.keys(body).length > 0) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "canary samples are derived from pinned runs and their recorded task outcomes; no request fields are accepted",
      );
    }
    writeJson(
      res,
      201,
      rsiService(deps).recordCanaryObservation(memory.scope, segments[6] as string, actor(memory)),
    );
    return;
  }

  // POST /memory/proposals/{proposal_id}/rollback
  if (
    method === "POST" &&
    resource === "proposals" &&
    segments.length === 8 &&
    segments[7] === "rollback"
  ) {
    requireRole(memory, "owner");
    requireAuthority(deps, memory, "write");
    const body = await readJsonBody(req);
    const reason = optionalString(body, "reason");
    if (reason === undefined || reason.trim().length === 0) {
      throw new ApiError(400, "INVALID_REQUEST", "reason is required");
    }
    writeJson(
      res,
      200,
      rsiService(deps).rollback(memory.scope, segments[6] as string, reason, actor(memory)),
    );
    return;
  }

  // GET /memory/rsi/status
  if (method === "GET" && resource === "rsi" && segments.length === 7 && segments[6] === "status") {
    requireRole(memory, "member");
    requireAuthority(deps, memory, "read");
    writeJson(res, 200, rsiService(deps).status(memory.scope));
    return;
  }

  // POST /memory/rsi/kill-switch
  if (
    method === "POST" &&
    resource === "rsi" &&
    segments.length === 7 &&
    segments[6] === "kill-switch"
  ) {
    requireRole(memory, "owner");
    requireAuthority(deps, memory, "write");
    const body = await readJsonBody(req);
    const enabled = body["enabled"];
    if (typeof enabled !== "boolean") {
      throw new ApiError(400, "INVALID_REQUEST", "enabled must be a boolean");
    }
    writeJson(res, 200, {
      controls: rsiService(deps).setKillSwitch(
        memory.scope,
        enabled,
        optionalString(body, "reason") ?? null,
        actor(memory),
      ),
    });
    return;
  }

  // PATCH /memory/rsi/controls
  if (
    method === "PATCH" &&
    resource === "rsi" &&
    segments.length === 7 &&
    segments[6] === "controls"
  ) {
    requireRole(memory, "owner");
    requireAuthority(deps, memory, "write");
    const body = await readJsonBody(req);
    const auto = body["auto_promote_low_risk"];
    if (auto !== undefined && typeof auto !== "boolean") {
      throw new ApiError(400, "INVALID_REQUEST", "auto_promote_low_risk must be a boolean");
    }
    writeJson(res, 200, {
      controls: rsiService(deps).updateControls(
        memory.scope,
        {
          ...(auto !== undefined ? { auto_promote_low_risk: auto } : {}),
          ...(optionalNumber(body, "weekly_change_budget") !== undefined
            ? { weekly_change_budget: optionalNumber(body, "weekly_change_budget") }
            : {}),
          ...(optionalNumber(body, "weekly_reflection_token_budget") !== undefined
            ? {
                weekly_reflection_token_budget: optionalNumber(
                  body,
                  "weekly_reflection_token_budget",
                ),
              }
            : {}),
        },
        actor(memory),
      ),
    });
    return;
  }

  throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
}
