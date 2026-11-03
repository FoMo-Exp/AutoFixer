import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api/auth";
import { createBrowserAuthController } from "./controller";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    user: { id: "usr_1", display_name: "Ada Lovelace", status: "active" },
    kind: "web",
    csrf_token: "csrf-1",
    expires_at: "2099-01-01T00:00:00Z",
    enterprise_roles: [],
    memberships: [
      { enterprise_id: "ent_1", workspace_id: "ws_alpha", role: "member" },
      { enterprise_id: "ent_1", workspace_id: "ws_beta", role: "admin" },
    ],
    ...overrides,
  };
}

function providersResponse(): Response {
  return jsonResponse({
    items: [
      {
        provider_instance_id: "pi_github",
        provider_type: "github",
        display_origin: "https://github.com",
      },
      {
        provider_instance_id: "pi_gitlab",
        provider_type: "gitlab",
        display_origin: "https://gitlab.example.test",
      },
    ],
  });
}

describe("browser auth controller", () => {
  it("loads providers and an existing cookie session into a workspace scope", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(providersResponse())
      .mockResolvedValueOnce(jsonResponse(sessionInfo()));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
    });

    await controller.initialize();

    expect(controller.getSnapshot()).toMatchObject({
      status: "signed_in",
      providers: [
        { provider_instance_id: "pi_github", provider_type: "github" },
        { provider_instance_id: "pi_gitlab", provider_type: "gitlab" },
      ],
      workspace: { workspace_id: "ws_alpha", role: "member" },
      session: { user: { display_name: "Ada Lovelace" } },
    });
    expect(controller.getSnapshot().session).not.toHaveProperty("csrf_token");
    expect(controller.csrfToken()).toBe("csrf-1");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4567/api/v1/auth/providers");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:4567/api/v1/auth/session");
    expect(fetchImpl.mock.calls[1]?.[1]?.credentials).toBe("include");
  });

  it("stays signed out when no cookie session exists", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(providersResponse())
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 401));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
    });

    await controller.initialize();

    expect(controller.getSnapshot()).toMatchObject({ status: "signed_out" });
    expect(controller.getSnapshot().providers).toHaveLength(2);
  });

  it("falls back to the local-operator mode when identity is not configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ error: {} }, 404));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
    });

    await controller.initialize();

    expect(controller.getSnapshot().status).toBe("legacy");
  });

  it("navigates to the contract login path without any credential", async () => {
    const navigate = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(providersResponse())
      .mockResolvedValueOnce(jsonResponse(sessionInfo()));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
      navigate,
    });
    await controller.initialize();

    await controller.signIn("pi_github");

    expect(navigate).toHaveBeenCalledTimes(1);
    const url = new URL(navigate.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/api/v1/auth/login");
    expect(url.searchParams.get("provider_instance_id")).toBe("pi_github");
    expect(url.searchParams.get("return_to")).toBe("/");
    expect(url.href).not.toMatch(/token|secret|csrf|code=/i);
  });

  it("revokes the cookie session with its CSRF token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(providersResponse())
      .mockResolvedValueOnce(jsonResponse(sessionInfo()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
    });
    await controller.initialize();

    await controller.signOut();

    const logoutCall = fetchImpl.mock.calls[2];
    expect(logoutCall?.[0]).toBe("http://127.0.0.1:4567/api/v1/auth/logout");
    expect(logoutCall?.[1]?.method).toBe("POST");
    expect(logoutCall?.[1]?.headers).toMatchObject({ "X-CSRF-Token": "csrf-1" });
    expect(controller.getSnapshot().status).toBe("signed_out");
    expect(controller.csrfToken()).toBeUndefined();
  });

  it("turns a revoked session into a recoverable expired gate", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(providersResponse())
      .mockResolvedValueOnce(jsonResponse(sessionInfo()));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
    });
    await controller.initialize();

    controller.handleUnauthorized();

    expect(controller.getSnapshot()).toMatchObject({
      status: "expired",
      message: "Your session expired. Sign in again.",
    });
    expect(controller.getSnapshot().session).toBeUndefined();
  });

  it("keeps the expired gate when concurrent requests fail together", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(providersResponse())
      .mockResolvedValueOnce(jsonResponse(sessionInfo()));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
    });
    await controller.initialize();

    controller.handleUnauthorized();
    controller.handleUnauthorized();

    expect(controller.getSnapshot()).toMatchObject({
      status: "expired",
      message: "Your session expired. Sign in again.",
    });
  });

  it("reports a 403 as dismissible permission feedback without dropping the session", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(providersResponse())
      .mockResolvedValueOnce(jsonResponse(sessionInfo()));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
    });
    await controller.initialize();

    controller.handleForbidden("this session has read-only access");
    expect(controller.getSnapshot()).toMatchObject({
      status: "signed_in",
      notice: "this session has read-only access",
    });

    controller.dismissNotice();
    expect(controller.getSnapshot().notice).toBeUndefined();
  });

  it("switches the display workspace only within the session's memberships", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(providersResponse())
      .mockResolvedValueOnce(jsonResponse(sessionInfo()));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
    });
    await controller.initialize();

    controller.setWorkspace("ws_beta");
    expect(controller.getSnapshot().workspace).toMatchObject({
      workspace_id: "ws_beta",
      role: "admin",
    });

    controller.setWorkspace("ws_forged");
    expect(controller.getSnapshot().workspace?.workspace_id).toBe("ws_beta");
  });

  it("requires a membership instead of presenting a workspace-less app", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(providersResponse())
      .mockResolvedValueOnce(jsonResponse(sessionInfo({ memberships: [] })));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
    });
    await controller.initialize();

    expect(controller.getSnapshot()).toMatchObject({ status: "no_workspace" });
    expect(controller.getSnapshot().workspace).toBeUndefined();
  });

  it("expires the gate at the contract expires_at time", async () => {
    vi.useFakeTimers({ now: new Date("2098-12-31T00:00:00Z") });
    let expiry: (() => void) | undefined;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(providersResponse())
      .mockResolvedValueOnce(jsonResponse(sessionInfo()));
    const controller = createBrowserAuthController({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl,
      schedule: (callback) => {
        expiry = callback;
        return () => {
          expiry = undefined;
        };
      },
    });
    await controller.initialize();

    expect(expiry).toBeTypeOf("function");
    vi.setSystemTime(new Date("2099-01-02T00:00:00Z"));
    expiry?.();

    expect(controller.getSnapshot()).toMatchObject({
      status: "expired",
      message: "Your session expired. Sign in again.",
    });
    vi.useRealTimers();
  });
});
