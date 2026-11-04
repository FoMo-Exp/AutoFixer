// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { ForgePilotClient } from "../api/client";
import { IdentityClient } from "../api/identity";
import type { DesktopAuthState } from "../../electron/auth";

const providers = [
  {
    provider_instance_id: "pi_github",
    provider_type: "github" as const,
    display_origin: "https://github.com",
  },
];

const session = {
  user: { id: "usr_1", display_name: "Ada Lovelace", status: "active" as const },
  kind: "desktop" as const,
  expires_at: "2099-01-01T00:00:00Z",
  enterprise_roles: [],
  memberships: [
    { enterprise_id: "ent_1", workspace_id: "ws_alpha", role: "member" as const },
    { enterprise_id: "ent_1", workspace_id: "ws_beta", role: "admin" as const },
  ],
};

function bridgeWith(initial: DesktopAuthState) {
  let state = initial;
  const listeners = new Set<(value: DesktopAuthState) => void>();
  const emit = (next: DesktopAuthState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  return {
    emit,
    bridge: {
      getState: vi.fn(async () => state),
      signIn: vi.fn(async () => state),
      cancelSignIn: vi.fn(async () => state),
      signOut: vi.fn(async () => state),
      expire: vi.fn(async () => {
        emit({
          status: "expired",
          providers,
          message: "Your session expired. Sign in again.",
          errorCode: "UNAUTHENTICATED",
        });
        return state;
      }),
      retry: vi.fn(async () => state),
      onStateChanged: (callback: (value: DesktopAuthState) => void) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    },
  };
}

function installDesktopAuth(initial: DesktopAuthState) {
  const handle = bridgeWith(initial);
  window.forgePilotConfig = { apiBaseUrl: "http://127.0.0.1:4567" };
  window.forgePilotAuth = handle.bridge;
  return handle;
}

const workspace = {
  id: "ws_alpha",
  enterprise_id: "ent_1",
  name: "Alpha",
  status: "active" as const,
  repository: {
    repository_id: "github:Luthiel/AutoFixer",
    provider_instance_id: "pi_github",
    provider_type: "github" as const,
  },
  role: "member" as const,
  version: 1,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

beforeEach(() => {
  window.localStorage.setItem("fp-workspace:usr_1", "ws_alpha");
  vi.spyOn(IdentityClient.prototype, "listAllWorkspaces").mockResolvedValue([workspace]);
  vi.spyOn(ForgePilotClient.prototype, "listTasks").mockResolvedValue({
    items: [],
    next_cursor: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.removeItem("fp-workspace:usr_1");
  delete window.forgePilotConfig;
  delete window.forgePilotAuth;
  delete window.forgePilotApi;
});

describe("auth gate", () => {
  it("shows providers instead of the workbench when the desktop is signed out", async () => {
    const handle = installDesktopAuth({ status: "signed_out", providers });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Sign in to ForgePilot" })).toBeTruthy();
    expect(ForgePilotClient.prototype.listTasks).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Continue with GitHub/ }));
    expect(handle.bridge.signIn).toHaveBeenCalledWith({ provider_instance_id: "pi_github" });
  });

  it("renders the workbench scoped to the caller's live workspace", async () => {
    installDesktopAuth({ status: "signed_in", providers, session });

    render(<App />);

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    await waitFor(() => expect(ForgePilotClient.prototype.listTasks).toHaveBeenCalled());
    expect(await screen.findByRole("combobox", { name: "Workspace" })).toBeTruthy();
    expect(IdentityClient.prototype.listAllWorkspaces).toHaveBeenCalled();
  });

  it("turns a revoked desktop session into the recoverable expired gate", async () => {
    const handle = installDesktopAuth({ status: "signed_in", providers, session });
    render(<App />);
    await screen.findByText("Ada Lovelace");

    handle.emit({
      status: "expired",
      providers,
      message: "Your session expired. Sign in again.",
      errorCode: "UNAUTHENTICATED",
    });

    expect(await screen.findByRole("heading", { name: "Sign in again to continue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue with GitHub/ })).toBeTruthy();
  });

  it("routes a 401 from the task surface to the expired gate", async () => {
    const handle = installDesktopAuth({ status: "signed_in", providers, session });
    vi.mocked(IdentityClient.prototype.listAllWorkspaces).mockRestore();
    vi.mocked(ForgePilotClient.prototype.listTasks).mockRestore();
    window.forgePilotApi = {
      request: vi.fn(async () => ({
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: {
            code: "UNAUTHENTICATED",
            message: "a valid session is required",
            request_id: "req_1",
            retryable: false,
            details: {},
          },
        }),
        stream: false,
      })),
      abort: vi.fn(),
      onStream: vi.fn(() => () => undefined),
    };

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Sign in again to continue" })).toBeTruthy();
    await waitFor(() => expect(handle.bridge.expire).toHaveBeenCalled());
  });

  it("blocks an account that has no workspace membership", async () => {
    installDesktopAuth({
      status: "signed_in",
      providers,
      session: { ...session, memberships: [] },
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Your account is not in a workspace yet" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
