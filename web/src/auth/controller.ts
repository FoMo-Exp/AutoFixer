import { ApiError } from "../api/client";
import {
  buildLoginUrl,
  getAuthSession,
  listLoginProviders,
  logoutSession,
  type AuthSessionView,
  type LoginProvider,
  type SessionInfo,
} from "../api/auth";
import type { JsonFetch } from "../api/client";
import type { DesktopAuthState, DesktopAuthStatus } from "../../electron/auth";

/**
 * Shared renderer auth state for both surfaces.
 *
 * Task workspace context is resolved by the Node service from the
 * authenticated session; this client never supplies a workspace id as
 * authority. A UI workspace switcher needs a workspace-scoped task contract
 * before it can change the data scope, so none is offered here.
 */

export type AuthStatus = DesktopAuthStatus | "no_workspace";

export interface AuthSnapshot {
  status: AuthStatus;
  providers: LoginProvider[];
  session?: AuthSessionView;
  message?: string;
  errorCode?: string;
  /** Non-blocking permission feedback (a 403 from the task surface). */
  notice?: string;
}

export interface AuthController {
  getSnapshot(): AuthSnapshot;
  subscribe(listener: (snapshot: AuthSnapshot) => void): () => void;
  initialize(): Promise<void>;
  retry(): Promise<void>;
  signIn(providerInstanceId: string): Promise<void>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  csrfToken(): string | undefined;
  refreshCsrfToken(): Promise<string | undefined>;
  handleUnauthorized(): void;
  handleForbidden(message: string): void;
  dismissNotice(): void;
  dispose(): void;
}

export interface DesktopAuthBridge {
  getState(): Promise<DesktopAuthState>;
  signIn(input: { provider_instance_id?: string }): Promise<DesktopAuthState>;
  cancelSignIn(): Promise<DesktopAuthState>;
  signOut(): Promise<DesktopAuthState>;
  expire(): Promise<DesktopAuthState>;
  retry(): Promise<DesktopAuthState>;
  onStateChanged(callback: (state: DesktopAuthState) => void): () => void;
}

interface BrowserAuthOptions {
  baseUrl: string;
  fetchImpl?: JsonFetch;
  navigate?: (url: string) => void;
  /** Returns a cancel function; injected so tests control session expiry. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Sign-in could not be completed.";
}

function errorCodeOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function browserSessionView(session: SessionInfo): AuthSessionView {
  return {
    user: session.user,
    kind: session.kind,
    expires_at: session.expires_at,
    enterprise_roles: session.enterprise_roles,
    memberships: session.memberships,
  };
}

function logoutReturnPath(): string {
  if (typeof window === "undefined") return "/";
  const path = `${window.location.pathname}${window.location.search}`;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

export function createBrowserAuthController(options: BrowserAuthOptions): AuthController {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl: JsonFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const navigate = options.navigate ?? ((url: string) => window.location.assign(url));
  const schedule = options.schedule ?? defaultSchedule;
  const listeners = new Set<(snapshot: AuthSnapshot) => void>();

  let snapshot: AuthSnapshot = { status: "checking", providers: [] };
  let session: SessionInfo | undefined;
  let cancelExpiry: (() => void) | undefined;
  let initialized = false;
  let initializing: Promise<void> | undefined;

  function publish(next: AuthSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener({ ...snapshot });
  }

  function snapshotWithSession(
    status: "signed_in" | "no_workspace" | "expired",
    nextSession: SessionInfo | undefined,
    message?: string,
  ): AuthSnapshot {
    cancelExpiry?.();
    cancelExpiry = undefined;
    if (!nextSession) {
      return {
        status,
        providers: snapshot.providers,
        ...(message ? { message } : {}),
        ...(snapshot.notice ? { notice: snapshot.notice } : {}),
      };
    }
    const resolvedStatus = nextSession.memberships.length === 0 ? "no_workspace" : status;
    const expiresAt = Date.parse(nextSession.expires_at);
    if (resolvedStatus === "signed_in" && Number.isFinite(expiresAt)) {
      // Timers above 2^31-1 ms fire immediately in browsers; rearm instead of
      // trusting a single long timeout.
      const checkExpiry = (): void => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
          session = undefined;
          publish(
            snapshotWithSession("expired", undefined, "Your session expired. Sign in again."),
          );
          return;
        }
        cancelExpiry = schedule(checkExpiry, Math.min(remaining, 2_147_483_647));
      };
      checkExpiry();
    }
    return {
      status: resolvedStatus,
      providers: snapshot.providers,
      session: browserSessionView(nextSession),
      ...(message ? { message } : {}),
      ...(snapshot.notice ? { notice: snapshot.notice } : {}),
    };
  }

  function applySession(nextSession: SessionInfo, message?: string): void {
    session = nextSession;
    publish(snapshotWithSession("signed_in", nextSession, message));
  }

  function clearSession(status: "signed_out" | "expired", message?: string): void {
    session = undefined;
    cancelExpiry?.();
    cancelExpiry = undefined;
    publish({
      status,
      providers: snapshot.providers,
      ...(message ? { message } : {}),
    });
  }

  async function loadProvidersAndSession(): Promise<void> {
    let providers: LoginProvider[];
    try {
      providers = await listLoginProviders(baseUrl, { fetchImpl });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        initialized = true;
        publish({ status: "legacy", providers: [] });
        return;
      }
      publish({
        status: "error",
        providers: [],
        message: errorMessageOf(error),
        ...(errorCodeOf(error) ? { errorCode: errorCodeOf(error) } : {}),
      });
      return;
    }
    publish({ status: "checking", providers });
    try {
      const current = await getAuthSession(baseUrl, { fetchImpl });
      initialized = true;
      snapshot = { status: "checking", providers };
      applySession(current);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        initialized = true;
        clearSession("signed_out");
        return;
      }
      publish({
        status: "error",
        providers,
        message: errorMessageOf(error),
        ...(errorCodeOf(error) ? { errorCode: errorCodeOf(error) } : {}),
      });
    }
  }

  async function initialize(): Promise<void> {
    if (initialized) return;
    if (initializing) return initializing;
    initializing = loadProvidersAndSession().finally(() => {
      initializing = undefined;
    });
    return initializing;
  }

  return {
    getSnapshot: () => ({ ...snapshot }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    initialize,
    async retry() {
      initialized = false;
      initializing = undefined;
      await initialize();
    },
    async signIn(providerInstanceId) {
      if (!snapshot.providers.some((item) => item.provider_instance_id === providerInstanceId)) {
        publish({
          ...snapshot,
          status: "error",
          message: "That login provider is not available.",
          errorCode: "UNKNOWN_PROVIDER",
        });
        return;
      }
      publish({
        status: "signing_in",
        providers: snapshot.providers,
        ...(snapshot.notice ? { notice: snapshot.notice } : {}),
      });
      navigate(buildLoginUrl(baseUrl, providerInstanceId, logoutReturnPath()));
    },
    async cancelSignIn() {
      clearSession("signed_out");
    },
    async signOut() {
      const csrf = session?.csrf_token;
      if (csrf) {
        try {
          await logoutSession(baseUrl, csrf, { fetchImpl });
        } catch {
          // Local state drops either way; the server session may already be gone.
        }
      }
      clearSession("signed_out");
    },
    csrfToken: () => session?.csrf_token,
    async refreshCsrfToken() {
      try {
        const current = await getAuthSession(baseUrl, { fetchImpl });
        applySession(current);
        return current.csrf_token;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          clearSession("expired", "Your session expired. Sign in again.");
        }
        return undefined;
      }
    },
    handleUnauthorized() {
      // Concurrent requests fail together; keep the first recoverable
      // transition instead of downgrading it to a plain signed-out state.
      if (snapshot.status === "expired") return;
      clearSession(
        snapshot.status === "signed_in" || snapshot.status === "no_workspace"
          ? "expired"
          : "signed_out",
        "Your session expired. Sign in again.",
      );
    },
    handleForbidden(message) {
      publish({
        ...snapshot,
        notice: message,
      });
    },
    dismissNotice() {
      publish({ ...snapshot, notice: undefined });
    },
    dispose() {
      cancelExpiry?.();
      cancelExpiry = undefined;
      listeners.clear();
    },
  };
}

export function createDesktopAuthController(bridge: DesktopAuthBridge): AuthController {
  const listeners = new Set<(snapshot: AuthSnapshot) => void>();
  let snapshot: AuthSnapshot = { status: "checking", providers: [] };
  let unsubscribeBridge: (() => void) | undefined;

  function snapshotOf(state: DesktopAuthState): AuthSnapshot {
    const memberships = state.session?.memberships ?? [];
    return {
      status:
        memberships.length === 0 && state.status === "signed_in" ? "no_workspace" : state.status,
      providers: state.providers,
      ...(state.session ? { session: state.session } : {}),
      ...(state.message ? { message: state.message } : {}),
      ...(state.errorCode ? { errorCode: state.errorCode } : {}),
      ...(snapshot.notice ? { notice: snapshot.notice } : {}),
    };
  }

  function publish(next: AuthSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener({ ...snapshot });
  }

  function apply(state: DesktopAuthState): void {
    publish(snapshotOf(state));
  }

  async function run(action: Promise<DesktopAuthState>): Promise<void> {
    try {
      apply(await action);
    } catch (error) {
      publish({
        status: "error",
        providers: snapshot.providers,
        message: errorMessageOf(error),
      });
    }
  }

  return {
    getSnapshot: () => ({ ...snapshot }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async initialize() {
      if (!unsubscribeBridge) unsubscribeBridge = bridge.onStateChanged(apply);
      try {
        apply(await bridge.getState());
      } catch (error) {
        publish({
          status: "error",
          providers: [],
          message: errorMessageOf(error),
        });
      }
    },
    retry: () => run(bridge.retry()),
    async signIn(providerInstanceId) {
      publish({
        status: "signing_in",
        providers: snapshot.providers,
        ...(snapshot.session ? { session: snapshot.session } : {}),
      });
      await run(bridge.signIn({ provider_instance_id: providerInstanceId }));
    },
    cancelSignIn: () => run(bridge.cancelSignIn()),
    signOut: () => run(bridge.signOut()),
    csrfToken: () => undefined,
    refreshCsrfToken: async () => undefined,
    handleUnauthorized() {
      if (snapshot.status !== "expired") {
        publish({
          ...snapshot,
          status: "expired",
          message: "Your session expired. Sign in again.",
        });
      }
      void run(bridge.expire());
    },
    handleForbidden(message) {
      publish({ ...snapshot, notice: message });
    },
    dismissNotice() {
      publish({ ...snapshot, notice: undefined });
    },
    dispose() {
      unsubscribeBridge?.();
      unsubscribeBridge = undefined;
      listeners.clear();
    },
  };
}

export function createLegacyAuthController(): AuthController {
  const listeners = new Set<(snapshot: AuthSnapshot) => void>();
  const snapshot: AuthSnapshot = { status: "legacy", providers: [] };
  return {
    getSnapshot: () => ({ ...snapshot }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    initialize: async () => undefined,
    retry: async () => undefined,
    signIn: async () => undefined,
    cancelSignIn: async () => undefined,
    signOut: async () => undefined,
    csrfToken: () => undefined,
    refreshCsrfToken: async () => undefined,
    handleUnauthorized: () => undefined,
    handleForbidden: () => undefined,
    dismissNotice: () => undefined,
    dispose() {
      listeners.clear();
    },
  };
}
