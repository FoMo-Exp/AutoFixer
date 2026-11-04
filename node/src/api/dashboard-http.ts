/**
 * Workspace dashboard HTTP surface (DAT-230).
 *
 * Read-only, session-authenticated, and scoped by the caller's live
 * membership. The workspace id in the path is only a locator: authority comes
 * from `resolveRequestScope` (DAT-241), and a path naming another workspace is
 * indistinguishable from a missing one (`404`, never a `403` that confirms
 * existence). Client-supplied enterprise/workspace ids are rejected outright.
 *
 * Separation of access:
 * - Operational metrics: any workspace role.
 * - Financial data (`cost-items`, `export`, and the cost/budget sections of a
 *   summary): owner/admin only. Other roles see `restricted`, never zeros.
 * - Content and quarantine: never served here. Asking for either is denied
 *   with its own code; the trace viewer and ADR-0005 case surface own those.
 * - The read/export audit trail: owner/admin only.
 *
 * Every error after scope resolution is audited as a zero-record read, so a
 * denied financial probe and a denied content probe leave evidence too.
 */

import type http from "node:http";

import type { AuthService, SessionContext } from "./auth-service.js";
import { requireSessionActor } from "./auth-http.js";
import { ApiError } from "./errors.js";
import { writeJson } from "./http-util.js";
import {
  principalFromSession,
  resolveRequestScope,
  type RequestScopeDeps,
} from "../control-plane/request-scope.js";
import { RequestScopeError } from "../control-plane/errors.js";
import type { DashboardService, DashboardScope } from "../dashboard/index.js";

export interface DashboardHttpDeps {
  auth: AuthService;
  service: DashboardService;
  /** Authoritative scope resolution (DAT-241); required for this surface. */
  scope: RequestScopeDeps;
}

export interface DashboardRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  segments: string[];
  requestId: string;
}

type DashboardResource = "summary" | "cost_items" | "issue_drilldown" | "audit" | "export";

const ALLOWED_QUERY = new Set([
  "from",
  "to",
  "timezone",
  "bucket",
  "breakdown",
  "limit",
  "cursor",
  "stale_after_seconds",
  "operation",
  "resource",
]);

const SCOPE_QUERY = new Set(["workspace_id", "enterprise_id"]);

/** Content and quarantine are never served by this surface. */
const DENIED_QUERY: Record<string, { code: string; message: string }> = {
  include_content: {
    code: "CONTENT_ACCESS_DENIED",
    message:
      "the dashboard never serves captured content; use the trace viewer with a content grant",
  },
  content: {
    code: "CONTENT_ACCESS_DENIED",
    message:
      "the dashboard never serves captured content; use the trace viewer with a content grant",
  },
  include_quarantine: {
    code: "QUARANTINE_ACCESS_DENIED",
    message:
      "the dashboard never serves quarantine material; use the ADR-0005 case surface with a quarantine grant",
  },
  quarantine: {
    code: "QUARANTINE_ACCESS_DENIED",
    message:
      "the dashboard never serves quarantine material; use the ADR-0005 case surface with a quarantine grant",
  },
};

function singleParam(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new ApiError(400, "INVALID_REQUEST", `${name} must be given at most once`);
  }
  return values[0];
}

function queryObject(url: URL): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of url.searchParams.entries()) {
    out[key] = value;
  }
  return out;
}

/**
 * Validate the query surface before it reaches the service. Unknown keys are
 * refused rather than silently ignored: a typo must not look like a supported
 * filter, and no client field can slip into an aggregate definition.
 */
function checkQuery(url: URL): void {
  for (const name of url.searchParams.keys()) {
    if (SCOPE_QUERY.has(name)) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `${name} is derived from the authenticated session and must not be sent`,
      );
    }
    const denied = DENIED_QUERY[name];
    if (denied !== undefined) {
      throw new ApiError(403, denied.code, denied.message);
    }
    if (!ALLOWED_QUERY.has(name)) {
      throw new ApiError(400, "INVALID_REQUEST", `unknown query parameter ${name}`);
    }
  }
  for (const name of ALLOWED_QUERY) {
    singleParam(url, name);
  }
}

function resolveScope(deps: DashboardHttpDeps, session: SessionContext): DashboardScope {
  try {
    const resolved = resolveRequestScope(deps.scope, principalFromSession(session));
    return {
      enterprise_id: resolved.enterprise_id,
      workspace_id: resolved.workspace_id,
      subject: resolved.actor_id,
      role: resolved.role,
    };
  } catch (error) {
    if (error instanceof RequestScopeError) {
      throw new ApiError(error.status, error.code, error.message);
    }
    throw error;
  }
}

function requirePathWorkspace(ctx: DashboardRouteContext, scope: DashboardScope): string {
  const workspaceId = ctx.segments[3];
  if (workspaceId === undefined || workspaceId.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "workspace_id is required");
  }
  if (workspaceId !== scope.workspace_id) {
    // Another workspace is indistinguishable from one that does not exist.
    throw new ApiError(404, "NOT_FOUND", "no such workspace");
  }
  return workspaceId;
}

function queryOf(url: URL): {
  from?: string;
  to?: string;
  timezone?: string;
  bucket?: string;
  breakdown?: string;
  limit?: string;
  cursor?: string;
  stale_after_seconds?: string;
  operation?: string;
  resource?: string;
} {
  const value = (name: string): string | undefined => singleParam(url, name);
  return {
    from: value("from"),
    to: value("to"),
    timezone: value("timezone"),
    bucket: value("bucket"),
    breakdown: value("breakdown"),
    limit: value("limit"),
    cursor: value("cursor"),
    stale_after_seconds: value("stale_after_seconds"),
    operation: value("operation"),
    resource: value("resource"),
  };
}

function classifyRoute(
  segments: string[],
): { resource: DashboardResource; issueId: string | null } | null {
  if (segments.length === 6) {
    const leaf = segments[5];
    if (leaf === "summary") {
      return { resource: "summary", issueId: null };
    }
    if (leaf === "cost-items") {
      return { resource: "cost_items", issueId: null };
    }
    if (leaf === "audit") {
      return { resource: "audit", issueId: null };
    }
    if (leaf === "export") {
      return { resource: "export", issueId: null };
    }
    return null;
  }
  if (segments.length === 7 && segments[5] === "issues") {
    const issueId = segments[6];
    if (issueId === undefined || issueId.length === 0 || issueId.length > 200) {
      throw new ApiError(400, "INVALID_REQUEST", "issue_id must be 1-200 characters");
    }
    return { resource: "issue_drilldown", issueId };
  }
  return null;
}

function auditDenied(
  deps: DashboardHttpDeps,
  scope: DashboardScope,
  ctx: DashboardRouteContext,
  resource: DashboardResource,
  issueId: string | null,
  operation: "read" | "export",
): void {
  try {
    deps.service.auditLog.append({
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
      role: scope.role,
      operation,
      resource,
      issue_id: issueId,
      query: queryObject(ctx.url),
      record_count: 0,
      request_id: ctx.requestId,
    });
  } catch {
    // An audit write failure must not rewrite the authorization outcome into
    // a different error; the request still fails as decided.
  }
}

/** Entry point wired from `server.ts` for `/api/v1/workspaces/{ws}/dashboard/...`. */
export async function handleDashboardRequest(
  deps: DashboardHttpDeps,
  ctx: DashboardRouteContext,
): Promise<void> {
  if (ctx.req.method !== "GET") {
    throw new ApiError(404, "NOT_FOUND", `No route for ${ctx.req.method} ${ctx.url.pathname}`);
  }
  const route = classifyRoute(ctx.segments);
  if (route === null) {
    throw new ApiError(404, "NOT_FOUND", `No route for ${ctx.req.method} ${ctx.url.pathname}`);
  }
  const session = requireSessionActor(deps.auth, ctx.req);
  const scope = resolveScope(deps, session);
  requirePathWorkspace(ctx, scope);

  ctx.res.setHeader("Cache-Control", "no-store");
  try {
    checkQuery(ctx.url);
    const query = queryOf(ctx.url);
    switch (route.resource) {
      case "summary": {
        const summary = deps.service.summary(scope, query, ctx.requestId);
        writeJson(ctx.res, 200, summary);
        return;
      }
      case "cost_items": {
        const page = deps.service.costItems(scope, query, ctx.requestId);
        writeJson(ctx.res, 200, page);
        return;
      }
      case "issue_drilldown": {
        const drilldown = deps.service.issueDrilldown(
          scope,
          route.issueId ?? "",
          query,
          ctx.requestId,
        );
        writeJson(ctx.res, 200, drilldown);
        return;
      }
      case "audit": {
        const page = deps.service.auditTrail(scope, query, ctx.requestId);
        writeJson(ctx.res, 200, page);
        return;
      }
      case "export": {
        const bundle = deps.service.exportBundle(scope, query, ctx.requestId);
        ctx.res.setHeader("Content-Disposition", 'attachment; filename="dashboard-export.json"');
        writeJson(ctx.res, 200, bundle);
        return;
      }
    }
  } catch (error) {
    if (error instanceof ApiError) {
      auditDenied(
        deps,
        scope,
        ctx,
        route.resource,
        route.issueId,
        route.resource === "export" ? "export" : "read",
      );
    }
    throw error;
  }
}
