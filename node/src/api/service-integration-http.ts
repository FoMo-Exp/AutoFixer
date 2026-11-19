/**
 * HTTP surface for administrator-controlled service integrations (DAT-267).
 *
 *   GET    /api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/service-integration
 *   PUT    /api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/service-integration
 *   DELETE /api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/service-integration
 *
 * The route lives in the administrator family on purpose. It is the surface
 * that initializes the workspace's authority marker, so it must remain
 * reachable when that integration is deactivated and every ordinary
 * workspace request fails closed. It therefore sits outside the provider
 * authority gate and carries its own administrator check.
 */

import type http from "node:http";

import { adminActorOf } from "./auth-http.js";
import type { AuthService } from "./auth-service.js";
import { ApiError } from "./errors.js";
import { readJsonBody, writeJson } from "./http-util.js";
import {
  assertInitializeFields,
  type InitializeServiceIntegrationInput,
  type ServiceIntegrationService,
} from "./service-integration-service.js";

export interface ServiceIntegrationHttpDeps {
  auth: AuthService;
  service: ServiceIntegrationService;
}

export interface ServiceIntegrationRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  segments: string[];
}

const SERVICE_INTEGRATION_SEGMENTS = 8;

export function isServiceIntegrationRoute(segments: string[]): boolean {
  return (
    segments.length === SERVICE_INTEGRATION_SEGMENTS &&
    segments[2] === "admin" &&
    segments[3] === "enterprises" &&
    segments[5] === "workspaces" &&
    segments[7] === "service-integration"
  );
}

function parseInitializeBody(body: Record<string, unknown>): InitializeServiceIntegrationInput {
  assertInitializeFields(body);
  const source = body["source_credential_ref"];
  if (typeof source !== "string" || source.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "source_credential_ref is required");
  }
  const optional = (field: string): string | undefined => {
    const value = body[field];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new ApiError(400, "INVALID_REQUEST", `${field} must be a non-empty string`);
    }
    return value;
  };
  const checkout = optional("checkout_credential_ref");
  const delivery = optional("delivery_credential_ref");
  return {
    source_credential_ref: source,
    ...(checkout !== undefined ? { checkout_credential_ref: checkout } : {}),
    ...(delivery !== undefined ? { delivery_credential_ref: delivery } : {}),
  };
}

export async function handleServiceIntegrationRequest(
  deps: ServiceIntegrationHttpDeps,
  ctx: ServiceIntegrationRouteContext,
): Promise<void> {
  const { req, res, url, segments } = ctx;
  const method = req.method ?? "GET";
  if (!isServiceIntegrationRoute(segments)) {
    throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
  }
  const isRead = method === "GET";
  const isInitialize = method === "PUT";
  const isDeactivate = method === "DELETE";
  if (!isRead && !isInitialize && !isDeactivate) {
    throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
  }

  const actor = adminActorOf(deps.auth, req);
  const enterpriseId = segments[4] as string;
  const workspaceId = segments[6] as string;

  if (isRead) {
    writeJson(res, 200, deps.service.get(actor, enterpriseId, workspaceId));
    return;
  }
  if (isDeactivate) {
    deps.service.deactivate(actor, enterpriseId, workspaceId);
    res.writeHead(204);
    res.end();
    return;
  }
  const body = await readJsonBody(req);
  const result = deps.service.initialize(
    actor,
    enterpriseId,
    workspaceId,
    parseInitializeBody(body),
  );
  writeJson(res, result.created ? 201 : 200, result.integration);
}
