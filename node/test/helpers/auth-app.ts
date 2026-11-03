import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createOrchestrator } from "../../src/index.js";
import type { OrchestratorHandle } from "../../src/index.js";
import type { OrchestratorConfig } from "../../src/config.js";
import type { InvitationRateLimits } from "../../src/api/invitation-service.js";
import {
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../../src/control-plane/index.js";
import type { DshServerHandle } from "./dsh-server.js";
import { scriptedStream, TEST_MODEL } from "./scripted-stream.js";
import { scriptedGateway } from "./test-gateway.js";
import { cookieValue, getJson, getRaw } from "./http.js";
import type { RawResponse } from "./http.js";

/**
 * Test harness for the ADR-0006 identity surfaces: an orchestrator with the
 * identity subsystem enabled, a seeded enterprise/workspace, a scripted
 * provider OAuth endpoint, and helpers for the browser login dance.
 */

export const BOOTSTRAP_TOKEN = "test-bootstrap-token-0123456789abcdef0123456789abcdef";
export const GITHUB_ORIGIN = "https://github.com";
const REPOSITORY_ID = "github:Luthiel/AutoFixer";
const APPROVER = "github:local-operator";

export interface FakeProfile {
  id: number;
  login: string;
  name?: string | null;
  email?: string;
}

export interface FakeProvider {
  fetchImpl: typeof fetch;
  /** Profile returned by the user endpoint; swap between logins. */
  profile: FakeProfile;
  /** Every provider request seen, for leak assertions. */
  requests: Array<{ url: string; method: string; body: string }>;
}

export function fakeProvider(profile: FakeProfile): FakeProvider {
  const requests: FakeProvider["requests"] = [];
  const state = { profile };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    requests.push({ url, method: init?.method ?? "GET", body });
    if (url.includes("/login/oauth/access_token") || url.includes("/oauth/token")) {
      const params = new URLSearchParams(body);
      return new Response(
        JSON.stringify({
          access_token: `tok_${params.get("code") ?? "none"}`,
          token_type: "bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: state.profile.id,
        login: state.profile.login,
        name: state.profile.name ?? null,
        email: state.profile.email ?? "shared@example.com",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return {
    fetchImpl,
    get profile() {
      return state.profile;
    },
    set profile(next: FakeProfile) {
      state.profile = next;
    },
    requests,
  };
}

export interface AuthApp {
  orchestrator: OrchestratorHandle;
  base: string;
  enterpriseId: string;
  workspaceId: string;
  /** Seeded, already-approved GitHub provider instance. */
  providerInstanceId: string;
  provider: FakeProvider;
  stop(): Promise<void>;
}

export interface AuthAppOptions {
  dsh: DshServerHandle;
  provider?: FakeProvider;
  configOverrides?: Partial<OrchestratorConfig>;
  lookup?: (hostname: string) => Promise<string[]>;
  /** Rate-limit overrides for the invitation surface (tests). */
  invitationRateLimits?: InvitationRateLimits;
}

let appCounter = 0;

export async function startAuthApp(options: AuthAppOptions): Promise<AuthApp> {
  appCounter += 1;
  const dir = mkdtempSync(path.join(tmpdir(), `forgepilot-auth-${appCounter}-`));
  const provider = options.provider ?? fakeProvider({ id: 1001, login: "octo" });

  // Protected OAuth application credentials file (owner-only).
  const credentialsFile = path.join(dir, "oauth-clients.json");
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      [GITHUB_ORIGIN]: { client_id: "client-id", client_secret: "client-secret" },
      "https://gitlab.example.com": { client_id: "cid", client_secret: "csecret" },
    }),
    { mode: 0o600 },
  );
  chmodSync(credentialsFile, 0o600);

  // Pre-seed the control plane so the task surface has a real workspace and
  // the login picker a real approved provider instance.
  const dbPath = path.join(dir, "control.sqlite");
  const db = openControlPlaneDb({ path: dbPath });
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: `test-ent-${appCounter}`,
    admin_user_id: "usr_seed",
  });
  const instance = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: GITHUB_ORIGIN,
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "AutoFixer",
    repository_id: REPOSITORY_ID,
    provider_instance_id: instance.id,
  });
  db.close();

  const config: OrchestratorConfig = {
    dshSocketPath: options.dsh.socketPath,
    apiHost: "127.0.0.1",
    apiPort: 0,
    apiTokenFile: path.join(dir, "api-token"),
    repositoryId: REPOSITORY_ID,
    repositoryUrl: "https://github.com/Luthiel/AutoFixer.git",
    baseRef: "main",
    baseSha: "52081eaddca099967fd8be13b3060337fde50d3f",
    actorId: "usr_test_operator",
    actorDisplayName: "Test Operator",
    approverIdentity: APPROVER,
    enterpriseId: enterprise.id,
    workspaceId: workspace.id,
    pathHints: ["node"],
    toolCapabilities: ["echo", "sleep"],
    maxWallClockSeconds: 60,
    controlPlaneFile: dbPath,
    oauthClientsFile: credentialsFile,
    bootstrapToken: BOOTSTRAP_TOKEN,
    sessionTtlSeconds: 3600,
    oauthFlowTtlSeconds: 300,
    desktopFlowTtlSeconds: 300,
    ...options.configOverrides,
  };

  const scripted = scriptedStream([]);
  const orchestrator = createOrchestrator({
    config,
    model: TEST_MODEL,
    gateway: scriptedGateway(TEST_MODEL, scripted.streamFn),
    authFetchImpl: provider.fetchImpl,
    authDnsLookup: options.lookup ?? (async () => ["104.16.0.1"]),
    ...(options.invitationRateLimits !== undefined
      ? { invitationRateLimits: options.invitationRateLimits }
      : {}),
  });
  const { port } = await orchestrator.start();
  return {
    orchestrator,
    base: `http://127.0.0.1:${port}`,
    enterpriseId: enterprise.id,
    workspaceId: workspace.id,
    providerInstanceId: instance.id,
    provider,
    stop: () => orchestrator.stop(),
  };
}

// ---------------------------------------------------------------------------
// Browser login dance
// ---------------------------------------------------------------------------

export interface StartedLogin {
  response: RawResponse;
  authorizeUrl: string;
  state: string;
  codeChallenge: string;
  binding: string;
}

/** GET /api/v1/auth/login as the system browser would, capturing state+binding. */
export async function startLogin(
  app: AuthApp,
  params: {
    providerInstanceId?: string;
    returnTo?: string;
    desktopFlowId?: string;
  } = {},
): Promise<StartedLogin> {
  const query = new URLSearchParams({
    provider_instance_id: params.providerInstanceId ?? app.providerInstanceId,
    ...(params.returnTo !== undefined ? { return_to: params.returnTo } : {}),
    ...(params.desktopFlowId !== undefined ? { desktop_flow: params.desktopFlowId } : {}),
  });
  const response = await getRaw(`${app.base}/api/v1/auth/login?${query.toString()}`);
  const authorizeUrl = response.headers.get("location") ?? "";
  const authorizeParams = authorizeUrl.length > 0 ? new URL(authorizeUrl).searchParams : undefined;
  return {
    response,
    authorizeUrl,
    state: authorizeParams?.get("state") ?? "",
    codeChallenge: authorizeParams?.get("code_challenge") ?? "",
    binding: cookieValue(response.headers, "fp_oauth_binding") ?? "",
  };
}

/** GET /api/v1/auth/callback with explicit binding/state control. */
export async function completeCallback(
  app: AuthApp,
  input: { state: string; code?: string; binding?: string },
): Promise<RawResponse> {
  const query = new URLSearchParams({
    code: input.code ?? "code-1",
    state: input.state,
  });
  return getRaw(`${app.base}/api/v1/auth/callback?${query.toString()}`, {
    headers: input.binding !== undefined ? { Cookie: `fp_oauth_binding=${input.binding}` } : {},
  });
}

export interface LoggedInSession {
  userId: string;
  /** fp_session cookie value. */
  session: string;
  /** Session CSRF token (from GET /api/v1/auth/session). */
  csrf: string;
}

/** Full successful web login; throws on any unexpected status. */
export async function webLogin(app: AuthApp, returnTo?: string): Promise<LoggedInSession> {
  const started = await startLogin(app, returnTo !== undefined ? { returnTo } : {});
  const response = await completeCallback(app, {
    state: started.state,
    binding: started.binding,
  });
  if (response.status !== 302) {
    throw new Error(`login callback returned ${response.status}: ${response.text}`);
  }
  const session = cookieValue(response.headers, "fp_session") ?? "";
  const info = await getJson<{ user: { id: string }; csrf_token: string }>(
    `${app.base}/api/v1/auth/session`,
    { Cookie: `fp_session=${session}` },
  );
  return { userId: info.body.user.id, session, csrf: info.body.csrf_token };
}

export function cookieSessionHeaders(session: LoggedInSession): Record<string, string> {
  return { Cookie: `fp_session=${session.session}`, "X-CSRF-Token": session.csrf };
}
