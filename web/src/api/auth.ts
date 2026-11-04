import type { components, operations } from "./contracts/schema";
import { ApiError } from "./client";
import type { JsonFetch } from "./client";

/**
 * `forgepilot-api/v1` authentication surface (DAT-202 contract).
 *
 * Browser sessions live in the HttpOnly `fp_session` cookie; the CSRF token is
 * the only credential the page may read and must be echoed as
 * `X-CSRF-Token` on mutating requests. Desktop sessions are exchanged from the
 * single-use flow secret by the Electron main process and never reach renderer
 * JavaScript or a URL.
 */

export type SessionInfo = components["schemas"]["SessionInfo"];
export type LoginProvider = components["schemas"]["LoginProvider"];
export type DesktopFlow = components["schemas"]["DesktopFlow"];
export type SessionUser = components["schemas"]["User"];
export type WorkspaceMembership = SessionInfo["memberships"][number];
export type EnterpriseRole = SessionInfo["enterprise_roles"][number];
export type DesktopExchangeGrant =
  operations["exchangeDesktopFlow"]["responses"][200]["content"]["application/json"];

/** Renderer-safe session projection: no csrf token, no bearer token. */
export type AuthSessionView = Omit<SessionInfo, "csrf_token">;

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function errorFrom(response: Response, fallback: string): Promise<ApiError> {
  let payload: components["schemas"]["Error"] | undefined;
  try {
    payload = (await response.json()) as components["schemas"]["Error"];
  } catch {
    // Keep the status fallback when the server closes without a JSON envelope.
  }
  return new ApiError(response.status, payload, fallback);
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw await errorFrom(response, fallback);
  return (await response.json()) as T;
}

export function authSessionView(session: SessionInfo): AuthSessionView {
  return {
    user: session.user,
    kind: session.kind,
    expires_at: session.expires_at,
    enterprise_roles: session.enterprise_roles,
    memberships: session.memberships,
  };
}

export async function listLoginProviders(
  baseUrl: string,
  options: { fetchImpl?: JsonFetch; signal?: AbortSignal } = {},
): Promise<LoginProvider[]> {
  const response = await (options.fetchImpl ?? fetch)(endpoint(baseUrl, "/api/v1/auth/providers"), {
    headers: { Accept: "application/json" },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await readJson<{ items: LoginProvider[] }>(
    response,
    "Unable to load login providers.",
  );
  return body.items;
}

export async function getAuthSession(
  baseUrl: string,
  options: { fetchImpl?: JsonFetch; signal?: AbortSignal } = {},
): Promise<SessionInfo> {
  const response = await (options.fetchImpl ?? fetch)(endpoint(baseUrl, "/api/v1/auth/session"), {
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return readJson<SessionInfo>(response, "Unable to read the current session.");
}

export async function logoutSession(
  baseUrl: string,
  csrfToken: string | undefined,
  options: { fetchImpl?: JsonFetch; signal?: AbortSignal } = {},
): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(endpoint(baseUrl, "/api/v1/auth/logout"), {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw await errorFrom(response, "Unable to sign out.");
}

/**
 * Build the browser login navigation URL. It carries only the approved
 * provider instance id and a same-deployment return path — never a session
 * token, code, or verifier.
 */
export function buildLoginUrl(baseUrl: string, providerInstanceId: string, returnTo = "/"): string {
  const url = new URL(endpoint(baseUrl, "/api/v1/auth/login"));
  url.searchParams.set("provider_instance_id", providerInstanceId);
  url.searchParams.set(
    "return_to",
    returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/",
  );
  return url.toString();
}

export async function createDesktopFlow(
  baseUrl: string,
  providerInstanceId: string | undefined,
  options: { fetchImpl?: JsonFetch; signal?: AbortSignal } = {},
): Promise<DesktopFlow> {
  const request: JsonFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await request(endpoint(baseUrl, "/api/v1/auth/desktop/flows"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(providerInstanceId ? { provider_instance_id: providerInstanceId } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return readJson<DesktopFlow>(response, "Unable to start desktop sign-in.");
}

/** Exchanges the desktop flow secret. 428 = browser sign-in still pending. */
export async function exchangeDesktopFlow(
  baseUrl: string,
  flowId: string,
  secret: string,
  options: { fetchImpl?: JsonFetch; signal?: AbortSignal } = {},
): Promise<DesktopExchangeGrant> {
  const request: JsonFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await request(
    endpoint(baseUrl, `/api/v1/auth/desktop/flows/${encodeURIComponent(flowId)}/exchange`),
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ secret }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return readJson<DesktopExchangeGrant>(response, "Desktop sign-in could not be completed.");
}
