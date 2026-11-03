/**
 * Workspace memory v1 HTTP surface (DAT-236).
 *
 * Every route is authenticated by a web/desktop session and scoped by the
 * caller's workspace membership — never by a path or body identifier. The
 * route set is deliberately read-mostly: search, feedback, browse, versions,
 * and evaluation recording. There is no promotion, deprecation, quarantine,
 * or policy-write route here, because memory administration must not be
 * reachable from a retrieval credential.
 */

import type http from "node:http";

import type { SessionContext } from "./auth-service.js";
import type { AuthService } from "./auth-service.js";
import { ApiError } from "./errors.js";
import { readJsonBody, writeJson } from "./http-util.js";
import { requireSessionActor } from "./auth-http.js";
import type { RequestAuthority } from "./request-authority.js";
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
  RsiCanaryObservationInput,
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

/** Parse and bound the browse query string. */
function itemsFilter(url: URL): MemoryItemsFilter {
  const filter: MemoryItemsFilter = {};
  const kind = url.searchParams.get("kind");
  const status = url.searchParams.get("status");
  const tier = url.searchParams.get("tier");
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

function evaluationInput(body: Record<string, unknown>): RsiEvaluationRequest {
  rejectScopeClaims(body);
  const verifierBody = body["verifier"];
  if (verifierBody === null || typeof verifierBody !== "object" || Array.isArray(verifierBody)) {
    throw new ApiError(400, "INVALID_REQUEST", "verifier is required");
  }
  const verifierRecord = verifierBody as Record<string, unknown>;
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
    verifier: {
      kind: String(verifierRecord["kind"] ?? "") as RsiEvaluationRequest["verifier"]["kind"],
      id: String(verifierRecord["id"] ?? ""),
      reference: String(verifierRecord["reference"] ?? ""),
    },
    ...(datasets !== undefined ? { datasets: datasets as RsiDataset[] } : {}),
  };
}

function observationInput(body: Record<string, unknown>): RsiCanaryObservationInput {
  rejectScopeClaims(body);
  const evidence = optionalString(body, "evidence_reference");
  if (evidence === undefined || evidence.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "evidence_reference is required");
  }
  return {
    sample_size: optionalNumber(body, "sample_size") ?? 0,
    baseline_successes: optionalNumber(body, "baseline_successes") ?? 0,
    candidate_successes: optionalNumber(body, "candidate_successes") ?? 0,
    ...(optionalNumber(body, "baseline_rework") !== undefined
      ? { baseline_rework: optionalNumber(body, "baseline_rework") }
      : {}),
    ...(optionalNumber(body, "candidate_rework") !== undefined
      ? { candidate_rework: optionalNumber(body, "candidate_rework") }
      : {}),
    ...(optionalNumber(body, "baseline_cost") !== undefined
      ? { baseline_cost: optionalNumber(body, "baseline_cost") }
      : {}),
    ...(optionalNumber(body, "candidate_cost") !== undefined
      ? { candidate_cost: optionalNumber(body, "candidate_cost") }
      : {}),
    ...(optionalNumber(body, "safety_events") !== undefined
      ? { safety_events: optionalNumber(body, "safety_events") }
      : {}),
    evidence_reference: evidence,
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
  const memory = requireMemoryScope(deps, ctx);
  const resource = segments[5];

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
      rsiService(deps).evaluate(memory.scope, segments[6] as string, evaluationInput(body)),
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
    writeJson(
      res,
      201,
      rsiService(deps).recordCanaryObservation(
        memory.scope,
        segments[6] as string,
        observationInput(body),
        actor(memory),
      ),
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
