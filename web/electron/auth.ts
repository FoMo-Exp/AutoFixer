import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { BrowserWindow } from "electron";

/**
 * Desktop identity for the Node service (ADR-0006).
 *
 * The main process creates a single-use desktop flow, opens the system
 * browser, and polls the exchange. The desktop-only flow secret and the
 * resulting session bearer token stay in this process: neither is returned
 * over IPC, written to a URL, or logged. When the Node service has no
 * identity subsystem (providers returns 404) the workbench stays on the
 * existing local-operator token path.
 */

export interface LoginProvider {
  provider_instance_id: string;
  provider_type: "github" | "gitlab";
  display_origin: string;
}

export interface AuthMembership {
  enterprise_id: string;
  workspace_id: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export interface AuthEnterpriseRole {
  enterprise_id: string;
  role: "admin";
}

export interface AuthUser {
  id: string;
  display_name: string;
  status: "active" | "suspended";
}

/** Renderer-safe projection: no csrf token, no bearer token. */
export interface AuthSessionView {
  user: AuthUser;
  kind: "web" | "desktop";
  expires_at: string;
  enterprise_roles: AuthEnterpriseRole[];
  memberships: AuthMembership[];
}

export type DesktopAuthStatus =
  "checking" | "legacy" | "signed_out" | "signing_in" | "signed_in" | "expired" | "error";

export interface DesktopAuthState {
  status: DesktopAuthStatus;
  providers: LoginProvider[];
  session?: AuthSessionView;
  message?: string;
  errorCode?: string;
}

export interface DesktopAuthOptions {
  apiBaseUrl: string;
  /** Opens the provider sign-in page in the operating system browser. */
  openExternal: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  now?: () => number;
}

export interface DesktopAuth {
  initialize(): Promise<DesktopAuthState>;
  retry(): Promise<DesktopAuthState>;
  getState(): DesktopAuthState;
  signIn(input?: { provider_instance_id?: string }): Promise<DesktopAuthState>;
  cancelSignIn(): Promise<DesktopAuthState>;
  signOut(): Promise<DesktopAuthState>;
  /** Drops a revoked bearer session; drives the recoverable expired gate. */
  expire(): Promise<DesktopAuthState>;
  /** Bearer credential for the API proxy; undefined when no session exists. */
  getApiToken(): string | undefined;
  subscribe(listener: (state: DesktopAuthState) => void): () => void;
  dispose(): void;
}

interface SessionEnvelope {
  user: AuthUser;
  kind: "web" | "desktop";
  csrf_token: string;
  expires_at: string;
  enterprise_roles: AuthEnterpriseRole[];
  memberships: AuthMembership[];
}

interface DesktopFlowEnvelope {
  flow_id: string;
  secret: string;
  login_url: string;
  expires_at: string;
}

interface GrantEnvelope {
  status: "ok";
  token: string;
  csrf_token: string;
  expires_at: string;
  user: AuthUser;
}

class AuthRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthRequestError";
    this.status = status;
    this.code = code;
  }
}

export function createDesktopAuth(options: DesktopAuthOptions): DesktopAuth {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const now = options.now ?? Date.now;
  const base = options.apiBaseUrl.replace(/\/$/, "");
  const listeners = new Set<(state: DesktopAuthState) => void>();

  let state: DesktopAuthState = { status: "checking", providers: [] };
  let token: string | undefined;
  let initialized = false;
  let initializedRequest: Promise<DesktopAuthState> | undefined;
  let signInRequest: Promise<DesktopAuthState> | undefined;
  let flowAbort: AbortController | undefined;

  function cloneState(value: DesktopAuthState): DesktopAuthState {
    return {
      ...value,
      providers: [...value.providers],
      ...(value.session
        ? {
            session: {
              ...value.session,
              user: { ...value.session.user },
              enterprise_roles: value.session.enterprise_roles.map((role) => ({ ...role })),
              memberships: value.session.memberships.map((membership) => ({ ...membership })),
            },
          }
        : {}),
    };
  }

  function publish(next: DesktopAuthState): DesktopAuthState {
    state = next;
    for (const listener of listeners) listener(cloneState(state));
    return cloneState(state);
  }

  async function authRequest<T>(path: string, init: RequestInit = {}, bearer?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
      });
    } catch (error) {
      throw new AuthRequestError(
        0,
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "The Node service is unreachable.",
      );
    }
    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      let message = "The sign-in service rejected the request.";
      try {
        const payload = (await response.json()) as {
          error?: { code?: string; message?: string };
        };
        code = payload.error?.code || code;
        message = payload.error?.message || message;
      } catch {
        // Non-JSON failures keep the status-derived code.
      }
      throw new AuthRequestError(response.status, code, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  function viewOf(session: SessionEnvelope): AuthSessionView {
    return {
      user: session.user,
      kind: session.kind,
      expires_at: session.expires_at,
      enterprise_roles: session.enterprise_roles,
      memberships: session.memberships,
    };
  }

  async function readSession(bearer: string): Promise<AuthSessionView> {
    const session = await authRequest<SessionEnvelope>("/api/v1/auth/session", {}, bearer);
    return viewOf(session);
  }

  async function initialize(): Promise<DesktopAuthState> {
    if (initialized) return cloneState(state);
    if (initializedRequest) return initializedRequest;
    initializedRequest = (async () => {
      if (!base) {
        return publish({ status: "legacy", providers: [] });
      }
      publish({ status: "checking", providers: [] });
      try {
        const providers = await authRequest<{ items: LoginProvider[] }>("/api/v1/auth/providers");
        initialized = true;
        return publish({ status: "signed_out", providers: providers.items });
      } catch (error) {
        if (error instanceof AuthRequestError && error.status === 404) {
          initialized = true;
          return publish({ status: "legacy", providers: [] });
        }
        const message = error instanceof Error ? error.message : "Sign-in is unavailable.";
        return publish({
          status: "error",
          providers: [],
          message,
          ...(error instanceof AuthRequestError ? { errorCode: error.code } : {}),
        });
      } finally {
        initializedRequest = undefined;
      }
    })();
    return initializedRequest;
  }

  function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new AuthRequestError(0, "SIGN_IN_CANCELLED", "Sign-in was cancelled."));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort(): void {
        clearTimeout(timer);
        reject(new AuthRequestError(0, "SIGN_IN_CANCELLED", "Sign-in was cancelled."));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function pollExchange(
    flow: DesktopFlowEnvelope,
    signal: AbortSignal,
  ): Promise<DesktopAuthState> {
    const deadline = Date.parse(flow.expires_at);
    const interval = pollIntervalMs;
    while (true) {
      if (Number.isFinite(deadline) && now() >= deadline) {
        return publish({
          status: "expired",
          providers: state.providers,
          message: "Sign-in expired. Start again.",
          errorCode: "AUTH_FLOW_EXPIRED",
        });
      }
      try {
        const grant = await authRequest<GrantEnvelope>(
          `/api/v1/auth/desktop/flows/${encodeURIComponent(flow.flow_id)}/exchange`,
          { method: "POST", body: JSON.stringify({ secret: flow.secret }) },
        );
        // The grant token is the desktop bearer credential; it never leaves
        // this process.
        token = grant.token;
        let session: AuthSessionView;
        try {
          session = await readSession(grant.token);
        } catch (error) {
          token = undefined;
          const message =
            error instanceof Error ? error.message : "The signed-in session could not be read.";
          return publish({
            status: "error",
            providers: state.providers,
            message,
            ...(error instanceof AuthRequestError ? { errorCode: error.code } : {}),
          });
        }
        return publish({ status: "signed_in", providers: state.providers, session });
      } catch (error) {
        if (signal.aborted) {
          return publish({ status: "signed_out", providers: state.providers });
        }
        if (!(error instanceof AuthRequestError)) throw error;
        if (error.status === 428) {
          await delay(interval, signal);
          continue;
        }
        if (error.status === 429) {
          return publish({
            status: "error",
            providers: state.providers,
            message: "Too many sign-in attempts. Wait a moment, then start again.",
            errorCode: error.code,
          });
        }
        const expired =
          error.status === 410 &&
          (error.code === "AUTH_FLOW_EXPIRED" || error.code === "AUTH_FLOW_CONSUMED");
        return publish({
          status: expired ? "expired" : "error",
          providers: state.providers,
          message: error.message,
          errorCode: error.code,
        });
      }
    }
  }

  async function signIn(input: { provider_instance_id?: string } = {}): Promise<DesktopAuthState> {
    if (signInRequest) return signInRequest;
    signInRequest = (async () => {
      if (!initialized) await initialize();
      if (state.status === "legacy") return cloneState(state);
      if (state.providers.length === 0) {
        return publish({
          status: "error",
          providers: [],
          message: "No administrator-approved login provider is available.",
          errorCode: "NO_PROVIDERS",
        });
      }
      const controller = new AbortController();
      flowAbort = controller;
      try {
        const flow = await authRequest<DesktopFlowEnvelope>("/api/v1/auth/desktop/flows", {
          method: "POST",
          body: JSON.stringify(
            input.provider_instance_id ? { provider_instance_id: input.provider_instance_id } : {},
          ),
        });
        const loginUrl = new URL(flow.login_url);
        if (loginUrl.protocol !== "http:" && loginUrl.protocol !== "https:") {
          return publish({
            status: "error",
            providers: state.providers,
            message: "The sign-in service returned an unusable browser URL.",
            errorCode: "AUTH_FLOW_INVALID",
          });
        }
        publish({ status: "signing_in", providers: state.providers });
        await options.openExternal(loginUrl.toString());
        return await pollExchange(flow, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          return publish({ status: "signed_out", providers: state.providers });
        }
        return publish({
          status: "error",
          providers: state.providers,
          message: error instanceof Error ? error.message : "Sign-in could not be started.",
          ...(error instanceof AuthRequestError ? { errorCode: error.code } : {}),
        });
      } finally {
        if (flowAbort === controller) flowAbort = undefined;
        signInRequest = undefined;
      }
    })();
    return signInRequest;
  }

  async function cancelSignIn(): Promise<DesktopAuthState> {
    flowAbort?.abort();
    if (state.status === "signing_in") {
      return publish({ status: "signed_out", providers: state.providers });
    }
    return cloneState(state);
  }

  async function signOut(): Promise<DesktopAuthState> {
    const bearer = token;
    token = undefined;
    flowAbort?.abort();
    const next = publish({ status: "signed_out", providers: state.providers });
    if (bearer) {
      try {
        await authRequest<unknown>("/api/v1/auth/logout", { method: "POST" }, bearer);
      } catch {
        // The local credential is gone even when the server session already
        // expired; the UI stays signed out either way.
      }
    }
    return next;
  }

  async function expire(): Promise<DesktopAuthState> {
    if (state.status !== "signed_in") return cloneState(state);
    token = undefined;
    return publish({
      status: "expired",
      providers: state.providers,
      message: "Your session expired. Sign in again to continue.",
      errorCode: "UNAUTHENTICATED",
    });
  }

  async function retry(): Promise<DesktopAuthState> {
    // "Check again" after a membership grant must reuse an existing desktop
    // session; only a sessionless retry re-runs provider discovery.
    if (token) {
      try {
        const session = await readSession(token);
        return publish({ status: "signed_in", providers: state.providers, session });
      } catch (error) {
        token = undefined;
        if (error instanceof AuthRequestError && error.status === 401) {
          return publish({
            status: "signed_out",
            providers: state.providers,
            message: "Your session expired. Sign in again.",
          });
        }
        return publish({
          status: "error",
          providers: state.providers,
          message: error instanceof Error ? error.message : "The session could not be refreshed.",
          ...(error instanceof AuthRequestError ? { errorCode: error.code } : {}),
        });
      }
    }
    initialized = false;
    initializedRequest = undefined;
    return initialize();
  }

  return {
    initialize,
    retry,
    getState: () => cloneState(state),
    signIn,
    cancelSignIn,
    signOut,
    expire,
    getApiToken: () => (state.status === "signed_in" ? token : undefined),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      flowAbort?.abort();
      flowAbort = undefined;
      token = undefined;
      listeners.clear();
    },
  };
}

export function installDesktopAuthIpc(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | undefined,
  auth: DesktopAuth,
  isTrustedFrameUrl: (url: string) => boolean,
): () => void {
  const isTrustedSender = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
    const window = getWindow();
    return (
      !!window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      isTrustedFrameUrl(event.senderFrame.url)
    );
  };
  const guard =
    (action: (input?: unknown) => Promise<DesktopAuthState>) =>
    (event: IpcMainInvokeEvent, input?: unknown): Promise<DesktopAuthState> => {
      if (!isTrustedSender(event)) throw new Error("Untrusted ForgePilot auth caller.");
      return action(input);
    };

  const handlers: Record<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown> = {
    "forgepilot:auth-state": guard(() => Promise.resolve(auth.getState())),
    "forgepilot:auth-sign-in": guard((input) => {
      const value = input as { provider_instance_id?: unknown } | undefined;
      const providerInstanceId =
        typeof value?.provider_instance_id === "string" ? value.provider_instance_id : undefined;
      return auth.signIn(providerInstanceId ? { provider_instance_id: providerInstanceId } : {});
    }),
    "forgepilot:auth-cancel": guard(() => auth.cancelSignIn()),
    "forgepilot:auth-sign-out": guard(() => auth.signOut()),
    "forgepilot:auth-expire": guard(() => auth.expire()),
    "forgepilot:auth-retry": guard(() => auth.retry()),
  };

  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
  };
}
