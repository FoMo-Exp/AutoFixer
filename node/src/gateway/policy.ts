import fs from "node:fs";

import type { Api } from "@mariozechner/pi-ai";

import { validateModelBaseUrl } from "../config.js";
import type {
  ApprovedEndpoint,
  DataClass,
  GatewayFallback,
  GatewayPolicy,
  GatewayScope,
} from "./types.js";
import { DATA_CLASSES } from "./types.js";

/**
 * ADR-0006 seam: resolves the enterprise/workspace policy that governs model
 * egress for one scope. The gateway never accepts a policy from its callers;
 * it asks this resolver and fails closed when nothing resolves.
 *
 * The scope handed to {@link GatewayPolicyResolver.resolve} always comes from
 * the authoritative request-scope pipeline (DAT-241 `resolveRequestScope` via
 * {@link GatewayScopeAuthority}) — never from deployment configuration and
 * never from caller input. A scope with no configured policy resolves nothing
 * and is denied; a multi-tenant deployment serves one policy per
 * enterprise/workspace pair and cross-scope access is structurally impossible
 * (DAT-242).
 */
export interface GatewayPolicyResolver {
  resolve(scope: GatewayScope): GatewayPolicy | undefined | Promise<GatewayPolicy | undefined>;
}

/** One policy bound to the authenticated scope it governs. */
export interface ScopedPolicyBinding {
  scope: GatewayScope;
  policy: GatewayPolicy;
}

/**
 * The scope-backed resolver (DAT-242): serves one validated policy per
 * enterprise/workspace pair. Resolution is keyed by the authenticated scope,
 * so workspace A's identity can only ever resolve workspace A's policy; any
 * scope with no binding resolves nothing and is denied. Duplicate scope
 * entries are a configuration error and fail at construction.
 */
export function createScopeBackedPolicyResolver(
  bindings: readonly ScopedPolicyBinding[],
): GatewayPolicyResolver {
  // Runtime-populated registry: entries come from the deployment's policy
  // configuration, and the composite key serializes the scope pair the same
  // way at insertion (below) and lookup (resolve).
  const byScope = new Map<string, GatewayPolicy>();
  for (const binding of bindings) {
    const key = JSON.stringify([binding.scope.enterpriseId, binding.scope.workspaceId]);
    if (byScope.has(key)) {
      throw new Error(
        `gateway policy scope ${binding.scope.enterpriseId}/${binding.scope.workspaceId} is registered twice`,
      );
    }
    byScope.set(key, validateGatewayPolicy(binding.policy));
  }
  return {
    resolve(requested: GatewayScope): GatewayPolicy | undefined {
      return byScope.get(JSON.stringify([requested.enterpriseId, requested.workspaceId]));
    },
  };
}

/** Fail-closed default: resolves no policy, so every dispatch is denied. */
export const denyAllPolicyResolver: GatewayPolicyResolver = {
  resolve(): GatewayPolicy | undefined {
    return undefined;
  },
};

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function normalizeEndpointUrl(raw: string, internal: boolean, label: string): string {
  try {
    // Internal instances may be plain HTTP on a private network only when the
    // registration explicitly says so; a private-looking hostname alone is
    // never evidence of trust.
    return validateModelBaseUrl(raw, label, internal);
  } catch (error) {
    throw new Error(
      `${label} is not an acceptable endpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateEndpoint(raw: unknown, index: number): ApprovedEndpoint {
  const label = `gateway policy endpoints[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${label} must be an object`);
  }
  const entry: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const internal = requireBoolean(entry["internal"], `${label}.internal`);
  const baseUrl = normalizeEndpointUrl(
    requireString(entry["baseUrl"], `${label}.baseUrl`),
    internal,
    `${label}.baseUrl`,
  );
  const models = entry["models"];
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(`${label}.models must be a non-empty array of model ids`);
  }
  // Permitted data classes are validated when present (DAT-209). A missing
  // list is not "everything is allowed": the scan gate denies every request
  // to an endpoint without explicit data-class authorization.
  const permittedRaw = entry["permittedDataClasses"];
  let permittedDataClasses: DataClass[] | undefined;
  if (permittedRaw !== undefined) {
    if (!Array.isArray(permittedRaw) || permittedRaw.length === 0) {
      throw new Error(
        `${label}.permittedDataClasses must be a non-empty array of data classes when set`,
      );
    }
    permittedDataClasses = permittedRaw.map((dataClass, classIndex) => {
      if (typeof dataClass !== "string" || !DATA_CLASSES.includes(dataClass as DataClass)) {
        throw new Error(
          `${label}.permittedDataClasses[${classIndex}] must be one of: ${DATA_CLASSES.join(", ")}`,
        );
      }
      return dataClass as DataClass;
    });
  }
  return {
    endpointId: requireString(entry["endpointId"], `${label}.endpointId`),
    provider: requireString(entry["provider"], `${label}.provider`),
    api: requireString(entry["api"], `${label}.api`) as Api,
    baseUrl,
    internal,
    credentialRef: requireString(entry["credentialRef"], `${label}.credentialRef`),
    models: models.map((model, modelIndex) =>
      requireString(model, `${label}.models[${modelIndex}]`),
    ),
    ...(permittedDataClasses ? { permittedDataClasses } : {}),
  };
}

function validateFallback(
  raw: unknown,
  index: number,
  endpoints: readonly ApprovedEndpoint[],
): GatewayFallback {
  const label = `gateway policy fallbacks[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${label} must be an object`);
  }
  const entry: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const endpointId = requireString(entry["endpointId"], `${label}.endpointId`);
  const modelId = requireString(entry["modelId"], `${label}.modelId`);
  const endpoint = endpoints.find((candidate) => candidate.endpointId === endpointId);
  // A fallback may only name an explicitly registered endpoint with an
  // explicitly approved model: fallback is not a way around the allow-list.
  if (!endpoint) {
    throw new Error(`${label}.endpointId ${endpointId} is not a registered endpoint`);
  }
  if (!endpoint.models.includes(modelId)) {
    throw new Error(`${label}.modelId ${modelId} is not approved at endpoint ${endpointId}`);
  }
  return { endpointId, modelId };
}

/**
 * Parse and validate a gateway policy. Throws on anything malformed so a
 * broken deployment configuration fails at startup instead of at dispatch.
 */
export function validateGatewayPolicy(raw: unknown): GatewayPolicy {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("gateway policy must be an object");
  }
  const entry: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const endpointsRaw = entry["endpoints"];
  if (!Array.isArray(endpointsRaw) || endpointsRaw.length === 0) {
    throw new Error("gateway policy endpoints must be a non-empty array");
  }
  const endpoints = endpointsRaw.map(validateEndpoint);
  const seenIds = new Set<string>();
  for (const endpoint of endpoints) {
    if (seenIds.has(endpoint.endpointId)) {
      throw new Error(`gateway policy endpoint ${endpoint.endpointId} is registered twice`);
    }
    seenIds.add(endpoint.endpointId);
  }
  const retryRaw = entry["retry"];
  if (typeof retryRaw !== "object" || retryRaw === null) {
    throw new Error("gateway policy retry must be an object");
  }
  const retry: Record<string, unknown> = Object.fromEntries(Object.entries(retryRaw));
  const maxAttempts = retry["maxAttempts"];
  if (
    typeof maxAttempts !== "number" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10
  ) {
    throw new Error("gateway policy retry.maxAttempts must be an integer between 1 and 10");
  }
  const fallbacksRaw = entry["fallbacks"];
  let fallbacks: GatewayFallback[] | undefined;
  if (fallbacksRaw !== undefined) {
    if (!Array.isArray(fallbacksRaw)) {
      throw new Error("gateway policy fallbacks must be an array");
    }
    fallbacks = fallbacksRaw.map((raw, index) => validateFallback(raw, index, endpoints));
  }
  const policy: GatewayPolicy = {
    revision: requireString(entry["revision"], "gateway policy revision"),
    endpoints,
    retry: { maxAttempts },
  };
  if (fallbacks) policy.fallbacks = fallbacks;
  return policy;
}

/**
 * Parse the scoped policy set of a policy file:
 * `{"policies": [{"scope": {"enterpriseId", "workspaceId"}, ...policy}, ...]}`.
 * Each entry binds one validated policy to the enterprise/workspace pair it
 * governs; there is no unscoped entry, no default scope, and no legacy
 * single-policy shape (DAT-242). Throws on anything malformed so a broken
 * deployment configuration fails at startup instead of at dispatch.
 */
export function parseScopedPolicies(raw: unknown): ScopedPolicyBinding[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("gateway policy file must be an object with a policies array");
  }
  const file: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const policiesRaw = file["policies"];
  if (!Array.isArray(policiesRaw) || policiesRaw.length === 0) {
    throw new Error("gateway policy file policies must be a non-empty array");
  }
  return policiesRaw.map((rawPolicy, index) => {
    const label = `gateway policy file policies[${index}]`;
    if (typeof rawPolicy !== "object" || rawPolicy === null) {
      throw new Error(`${label} must be an object`);
    }
    const policyEntry: Record<string, unknown> = Object.fromEntries(Object.entries(rawPolicy));
    const scopeRaw = policyEntry["scope"];
    if (typeof scopeRaw !== "object" || scopeRaw === null) {
      throw new Error(`${label}.scope must bind enterpriseId and workspaceId`);
    }
    const scope: Record<string, unknown> = Object.fromEntries(Object.entries(scopeRaw));
    return {
      scope: {
        enterpriseId: requireString(scope["enterpriseId"], `${label}.scope.enterpriseId`),
        workspaceId: requireString(scope["workspaceId"], `${label}.scope.workspaceId`),
      },
      policy: validateGatewayPolicy(rawPolicy),
    };
  });
}

/** Load and validate a scoped policy set from a JSON file. */
export function loadGatewayPolicyFile(file: string): GatewayPolicyResolver {
  return createScopeBackedPolicyResolver(
    parseScopedPolicies(JSON.parse(fs.readFileSync(file, "utf8"))),
  );
}

function normalizeUrlForMatch(value: string): string | undefined {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export type EndpointMatch =
  { endpoint: ApprovedEndpoint } | { deny: "MODEL_NOT_APPROVED" | "ENDPOINT_NOT_APPROVED" };

/**
 * Resolve the approved destination for a requested model. Fail closed on
 * anything ambiguous: an unregistered endpoint, an unapproved model, or a
 * requested endpoint that is not the registered one all deny.
 */
export function matchEndpoint(
  policy: GatewayPolicy,
  model: { provider: string; id: string; baseUrl?: string },
): EndpointMatch {
  const candidates = policy.endpoints.filter(
    (endpoint) => endpoint.provider === model.provider && endpoint.models.includes(model.id),
  );
  if (candidates.length === 0) {
    return { deny: "MODEL_NOT_APPROVED" };
  }
  const requestedUrl = model.baseUrl ? normalizeUrlForMatch(model.baseUrl) : undefined;
  if (model.baseUrl && !requestedUrl) {
    return { deny: "ENDPOINT_NOT_APPROVED" };
  }
  const matching = requestedUrl
    ? candidates.filter((endpoint) => normalizeUrlForMatch(endpoint.baseUrl) === requestedUrl)
    : candidates;
  const endpoint = matching[0];
  // Zero matches: the call would have gone to an unapproved endpoint. More
  // than one: the destination is ambiguous without an explicit endpoint.
  if (matching.length !== 1 || !endpoint) {
    return { deny: "ENDPOINT_NOT_APPROVED" };
  }
  return { endpoint };
}

/**
 * Resolve a policy-declared fallback destination against the registered set.
 * Same fail-closed rules as the primary match: a fallback naming anything but
 * an explicitly registered endpoint with an explicitly approved model denies.
 */
export function matchFallback(policy: GatewayPolicy, fallback: GatewayFallback): EndpointMatch {
  const endpoint = policy.endpoints.find(
    (candidate) => candidate.endpointId === fallback.endpointId,
  );
  if (!endpoint) {
    return { deny: "ENDPOINT_NOT_APPROVED" };
  }
  if (!endpoint.models.includes(fallback.modelId)) {
    return { deny: "MODEL_NOT_APPROVED" };
  }
  return { endpoint };
}
