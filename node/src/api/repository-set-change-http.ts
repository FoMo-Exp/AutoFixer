/**
 * Workspace repository-addition HTTP routes (DAT-286, ADR-0011).
 *
 * - `POST /api/v1/workspaces/{workspace_id}/repository-set-additions/preview`
 * - `POST /api/v1/workspaces/{workspace_id}/repository-set-additions/confirmations`
 * - `POST /api/v1/workspaces/{workspace_id}/repository-set-additions/confirmations/{confirmation_id}/commit`
 *
 * The route family exists only alongside the identity surface: every request
 * is authenticated by its session, and the path workspace is a locator the
 * service resolves against the caller's live membership. Authorization,
 * admissibility, staleness, expiry, last-owner protection, audit atomicity and
 * the rollout gate are decided by the domain services, never here.
 *
 * Nothing in this module opens a multi-repository scope. A committed set is
 * storage, not authority, until every access path enforces the whole set; the
 * deployment gate stays closed outside the enforcing build.
 */

import type http from "node:http";

import { ApiError } from "./errors.js";
import type { AuthService } from "./auth-service.js";
import { requireEnterpriseSessionActor } from "./auth-http.js";
import { readJsonBody, writeJson } from "./http-util.js";
import type {
  RepositorySetAdditionConfirmRequest,
  RepositorySetAdditionProposalRequest,
  WorkspaceRepositorySetChangeService,
} from "./repository-set-change-service.js";
import type { ConfirmedReduction, RepositorySetAdditionBinding } from "../control-plane/index.js";

export interface RepositorySetChangeHttpDeps {
  auth: AuthService;
  changes: WorkspaceRepositorySetChangeService;
}

export interface RepositorySetChangeRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  segments: string[];
  requestId: string;
}

export function isRepositorySetChangeRoute(segments: string[]): boolean {
  return segments[2] === "workspaces" && segments[4] === "repository-set-additions";
}

function invalid(message: string): never {
  throw new ApiError(400, "INVALID_REQUEST", message);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${field} must be a non-empty string or null`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${field} is required`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalid(`${field} must be an integer`);
  }
  return value;
}

/**
 * A proposed repository carries only its authority-bearing identity plus
 * optional display metadata. Display metadata is never stored: the committed
 * binding takes its name from the verified installation, so a caller cannot
 * smuggle a URL or name into a decision record.
 */
function parseProposal(body: Record<string, unknown>): RepositorySetAdditionProposalRequest {
  const expectedSetVersion = optionalInteger(body["expected_set_version"], "expected_set_version");
  const raw = body["additional_repositories"];
  if (!Array.isArray(raw) || raw.length === 0) {
    invalid("additional_repositories must list at least one repository to add");
  }
  const additionalRepositories = raw.map((entry, index) => {
    const item = requireObject(entry, `additional_repositories[${index}]`);
    const binding: RepositorySetAdditionBinding = {
      provider_instance_id: requiredString(
        item["provider_instance_id"],
        `additional_repositories[${index}].provider_instance_id`,
      ),
      installation_ref:
        optionalNullableString(
          item["installation_ref"],
          `additional_repositories[${index}].installation_ref`,
        ) ?? null,
      repository_id: requiredString(
        item["repository_id"],
        `additional_repositories[${index}].repository_id`,
      ),
    };
    const repositoryUrl = optionalNullableString(
      item["repository_url"],
      `additional_repositories[${index}].repository_url`,
    );
    const repositoryName = optionalNullableString(
      item["repository_name"],
      `additional_repositories[${index}].repository_name`,
    );
    if (repositoryUrl !== undefined) {
      binding.repository_url = repositoryUrl;
    }
    if (repositoryName !== undefined) {
      binding.repository_name = repositoryName;
    }
    return binding;
  });
  return {
    expected_set_version: expectedSetVersion ?? null,
    additional_repositories: additionalRepositories,
  };
}

/**
 * The exact reductions the actor confirmed. Counts and identities only; the
 * domain service re-derives the expected list and refuses any difference, so
 * this parser never decides what a reduction is.
 */
function parseConfirmedReductions(value: unknown): ConfirmedReduction[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    invalid("confirmed_reductions must be an array");
  }
  return value.map((entry, index) => {
    const item = requireObject(entry, `confirmed_reductions[${index}]`);
    const capabilities = item["capabilities"];
    if (!Array.isArray(capabilities) || capabilities.some((cap) => typeof cap !== "string")) {
      invalid(`confirmed_reductions[${index}].capabilities must be an array of strings`);
    }
    return {
      membership_id: requiredString(
        item["membership_id"],
        `confirmed_reductions[${index}].membership_id`,
      ),
      user_id: requiredString(item["user_id"], `confirmed_reductions[${index}].user_id`),
      capabilities: capabilities as ConfirmedReduction["capabilities"],
    };
  });
}

export async function handleRepositorySetChangeRequest(
  deps: RepositorySetChangeHttpDeps,
  ctx: RepositorySetChangeRouteContext,
): Promise<void> {
  const { changes, auth } = deps;
  const { req, res, url, segments } = ctx;
  const method = req.method ?? "GET";
  const workspaceId = segments[3];
  if (workspaceId === undefined || workspaceId.length === 0) {
    invalid("workspace_id is required");
  }
  const actorUserId = requireEnterpriseSessionActor(auth, req).user.id;

  // POST .../repository-set-additions/preview
  if (segments.length === 6 && segments[5] === "preview") {
    if (method !== "POST") {
      throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
    }
    const proposal = parseProposal(await readJsonBody(req));
    writeJson(res, 200, changes.preview(actorUserId, workspaceId, proposal));
    return;
  }

  // POST .../repository-set-additions/confirmations
  if (segments.length === 6 && segments[5] === "confirmations") {
    if (method !== "POST") {
      throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
    }
    const body = await readJsonBody(req);
    const proposal = parseProposal(body);
    const ttl = optionalInteger(body["ttl_ms"], "ttl_ms");
    const request: RepositorySetAdditionConfirmRequest = {
      ...proposal,
      confirmed_reductions: parseConfirmedReductions(body["confirmed_reductions"]),
      ...(ttl !== undefined ? { ttl_ms: ttl } : {}),
    };
    writeJson(res, 201, changes.confirm(actorUserId, workspaceId, request));
    return;
  }

  // POST .../repository-set-additions/confirmations/{confirmation_id}/commit
  if (segments.length === 8 && segments[5] === "confirmations" && segments[7] === "commit") {
    if (method !== "POST") {
      throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
    }
    const confirmationId = segments[6] ?? "";
    writeJson(res, 200, changes.commit(actorUserId, workspaceId, confirmationId));
    return;
  }

  throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
}
