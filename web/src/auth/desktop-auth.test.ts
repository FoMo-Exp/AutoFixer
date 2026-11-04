import { describe, expect, it, vi } from "vitest";
import { createDesktopAuth } from "../../electron/auth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function providersResponse(): Response {
  return jsonResponse({
    items: [
      {
        provider_instance_id: "pi_github",
        provider_type: "github",
        display_origin: "https://github.com",
      },
    ],
  });
}

const grant = {
  status: "ok",
  token: "session-token-value",
  csrf_token: "grant-csrf-value",
  expires_at: "2099-01-01T00:00:00Z",
  user: { id: "usr_1", display_name: "Ada", status: "active" },
};

const session = {
  user: { id: "usr_1", display_name: "Ada", status: "active" },
  kind: "desktop",
  csrf_token: "grant-csrf-value",
  expires_at: "2099-01-01T00:00:00Z",
  enterprise_roles: [],
  memberships: [{ enterprise_id: "ent_1", workspace_id: "ws_alpha", role: "member" }],
};

function fetchOf(responses: Response[]) {
  return vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
}

describe("desktop auth flow", () => {
  it("creates the flow, opens the system browser, and keeps the credential in main", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = fetchOf([
      providersResponse(),
      jsonResponse(
        {
          flow_id: "flow_1",
          secret: "flow-secret-value",
          login_url: "https://github.com/login/oauth/authorize?client_id=x",
          expires_at: "2099-01-01T00:00:00Z",
        },
        201,
      ),
      jsonResponse({ error: { code: "AUTH_FLOW_NOT_READY" } }, 428),
      jsonResponse(grant),
      jsonResponse(session),
    ]);
    const auth = createDesktopAuth({
      apiBaseUrl: "http://127.0.0.1:4567",
      openExternal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 0,
    });

    await auth.initialize();
    expect(auth.getState().status).toBe("signed_out");

    const state = await auth.signIn({ provider_instance_id: "pi_github" });

    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize?client_id=x",
    );
    expect(state).toMatchObject({
      status: "signed_in",
      session: { user: { display_name: "Ada" }, kind: "desktop" },
    });
    expect(auth.getApiToken()).toBe("session-token-value");
    const rendererVisible = JSON.stringify(auth.getState());
    expect(rendererVisible).not.toContain("session-token-value");
    expect(rendererVisible).not.toContain("flow-secret-value");
    expect(rendererVisible).not.toContain("grant-csrf-value");
    const exchangeCall = fetchImpl.mock.calls[3];
    expect(exchangeCall?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/auth/desktop/flows/flow_1/exchange",
    );
    expect(JSON.parse(exchangeCall?.[1]?.body as string)).toEqual({ secret: "flow-secret-value" });
  });

  it("surfaces an expired flow without retaining a credential", async () => {
    const fetchImpl = fetchOf([
      providersResponse(),
      jsonResponse(
        {
          flow_id: "flow_1",
          secret: "flow-secret-value",
          login_url: "https://github.com/login",
          expires_at: "2099-01-01T00:00:00Z",
        },
        201,
      ),
      jsonResponse({ error: { code: "AUTH_FLOW_EXPIRED" } }, 410),
    ]);
    const auth = createDesktopAuth({
      apiBaseUrl: "http://127.0.0.1:4567",
      openExternal: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 0,
    });
    await auth.initialize();

    const state = await auth.signIn();

    expect(state).toMatchObject({ status: "expired", errorCode: "AUTH_FLOW_EXPIRED" });
    expect(auth.getApiToken()).toBeUndefined();
  });

  it("stays on the local-operator path when identity endpoints are absent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: {} }, 404));
    const auth = createDesktopAuth({
      apiBaseUrl: "http://127.0.0.1:4567",
      openExternal: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const state = await auth.initialize();

    expect(state.status).toBe("legacy");
    expect(auth.getApiToken()).toBeUndefined();
  });

  it("does not pretend to sign in when no login providers exist", async () => {
    const fetchImpl = fetchOf([jsonResponse({ items: [] })]);
    const auth = createDesktopAuth({
      apiBaseUrl: "http://127.0.0.1:4567",
      openExternal: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await auth.initialize();

    const state = await auth.signIn();

    expect(state).toMatchObject({ status: "error", errorCode: "NO_PROVIDERS" });
  });

  it("re-reads the session on retry without starting a second flow", async () => {
    const fetchImpl = fetchOf([
      providersResponse(),
      jsonResponse(
        {
          flow_id: "flow_1",
          secret: "flow-secret-value",
          login_url: "https://github.com/login",
          expires_at: "2099-01-01T00:00:00Z",
        },
        201,
      ),
      jsonResponse(grant),
      jsonResponse({ ...session, memberships: [] }),
      jsonResponse(session),
    ]);
    const auth = createDesktopAuth({
      apiBaseUrl: "http://127.0.0.1:4567",
      openExternal: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 0,
    });
    await auth.initialize();
    await auth.signIn();

    const state = await auth.retry();

    expect(state.session?.memberships).toEqual([
      { enterprise_id: "ent_1", workspace_id: "ws_alpha", role: "member" },
    ]);
    expect(auth.getApiToken()).toBe("session-token-value");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("clears the desktop credential on sign-out", async () => {
    const fetchImpl = fetchOf([
      providersResponse(),
      jsonResponse(
        {
          flow_id: "flow_1",
          secret: "flow-secret-value",
          login_url: "https://github.com/login",
          expires_at: "2099-01-01T00:00:00Z",
        },
        201,
      ),
      jsonResponse(grant),
      jsonResponse(session),
      new Response(null, { status: 204 }),
    ]);
    const auth = createDesktopAuth({
      apiBaseUrl: "http://127.0.0.1:4567",
      openExternal: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 0,
    });
    await auth.initialize();
    await auth.signIn();

    const state = await auth.signOut();

    expect(state.status).toBe("signed_out");
    expect(auth.getApiToken()).toBeUndefined();
    const logoutCall = fetchImpl.mock.calls[4];
    expect(logoutCall?.[0]).toBe("http://127.0.0.1:4567/api/v1/auth/logout");
    expect(logoutCall?.[1]?.headers).toMatchObject({ Authorization: "Bearer session-token-value" });
  });

  it("drops a revoked bearer session into the recoverable expired gate", async () => {
    const fetchImpl = fetchOf([
      providersResponse(),
      jsonResponse(
        {
          flow_id: "flow_1",
          secret: "flow-secret-value",
          login_url: "https://github.com/login",
          expires_at: "2099-01-01T00:00:00Z",
        },
        201,
      ),
      jsonResponse(grant),
      jsonResponse(session),
    ]);
    const auth = createDesktopAuth({
      apiBaseUrl: "http://127.0.0.1:4567",
      openExternal: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 0,
    });
    await auth.initialize();
    await auth.signIn();

    const state = await auth.expire();

    expect(state).toMatchObject({ status: "expired", errorCode: "UNAUTHENTICATED" });
    expect(auth.getApiToken()).toBeUndefined();
  });
});
