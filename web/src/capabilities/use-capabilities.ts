import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import type { IdentityClient } from "../api/identity";
import { CapabilityProjectionError, parseWorkspaceCapabilities } from "./projection";
import type { CapabilitySnapshot } from "./projection";

export type CapabilityLoadStatus = "idle" | "loading" | "ready" | "error";

export interface CapabilityFailure {
  status: number;
  code: string;
  message: string;
}

export interface WorkspaceCapabilityState {
  status: CapabilityLoadStatus;
  snapshot?: CapabilitySnapshot;
  error?: CapabilityFailure;
  /** A background re-read is in flight; the current snapshot is still shown. */
  refreshing: boolean;
  /** Re-read now (focus, reconnect, a server denial, or an explicit retry). */
  refresh: () => void;
}

interface InternalState {
  /** The workspace this state belongs to; a mismatch renders as loading. */
  key: string;
  status: CapabilityLoadStatus;
  snapshot?: CapabilitySnapshot;
  error?: CapabilityFailure;
  refreshing: boolean;
}

const INITIAL: InternalState = { key: "", status: "idle", refreshing: false };

const MAX_TIMEOUT_MS = 2_147_000_000;

function describeFailure(caught: unknown): CapabilityFailure {
  if (caught instanceof ApiError) {
    return { status: caught.status, code: caught.code, message: caught.message };
  }
  if (caught instanceof CapabilityProjectionError) {
    return {
      status: 0,
      code: caught.code,
      message: "The capability projection could not be verified, so no module data is shown.",
    };
  }
  return {
    status: 0,
    code: "CAPABILITY_UNAVAILABLE",
    message: "The capability projection is unavailable, so no module data is shown.",
  };
}

/**
 * Reads the workspace capability projection and keeps it honest:
 *
 * - a workspace change clears the previous snapshot before the new request is
 *   rendered, so another workspace's entries never flash;
 * - `focus`, `online`, and an explicit refresh re-read the projection; a
 *   failed re-read drops the previous snapshot instead of keeping a stale
 *   grant visible;
 * - the snapshot expires on the server's own `expires_at`, which triggers a
 *   re-read rather than using an expired projection.
 */
export function useWorkspaceCapabilities(options: {
  client: IdentityClient;
  workspaceId: string | null;
  enabled: boolean;
}): WorkspaceCapabilityState {
  const { client, workspaceId, enabled } = options;
  const [state, setState] = useState<InternalState>(INITIAL);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestRef = useRef(0);
  // One automatic retry for a response that arrives already expired; a server
  // that keeps serving an expired window must not create a fetch loop.
  const expiryRetryRef = useRef<{ key: string; count: number }>({ key: "", count: 0 });

  const load = useCallback(
    async (mode: "initial" | "refresh", targetId: string, signal: AbortSignal): Promise<void> => {
      const requestId = ++requestRef.current;
      if (mode === "initial") {
        setState({ key: targetId, status: "loading", refreshing: false });
      } else {
        setState((current) =>
          current.key === targetId
            ? { ...current, refreshing: true }
            : { key: targetId, status: "ready", refreshing: true },
        );
      }
      try {
        const raw = await client.getWorkspaceCapabilities(targetId, { signal });
        if (signal.aborted || requestRef.current !== requestId) return;
        const snapshot = parseWorkspaceCapabilities(raw, { workspaceId: targetId });
        if (!snapshot.trusted) {
          // Arrived already expired or past `stale_after`: never use it, and
          // retry at most once so an expired server window cannot loop.
          const retry = expiryRetryRef.current;
          if (retry.key !== targetId) {
            expiryRetryRef.current = { key: targetId, count: 1 };
            setReloadKey((value) => value + 1);
          } else if (retry.count < 1) {
            expiryRetryRef.current = { key: targetId, count: retry.count + 1 };
            setReloadKey((value) => value + 1);
          }
          setState({
            key: targetId,
            status: "error",
            error: {
              status: 0,
              code: "PROJECTION_EXPIRED",
              message: "The capability snapshot expired. Re-read it before continuing.",
            },
            refreshing: false,
          });
          return;
        }
        expiryRetryRef.current = { key: targetId, count: 0 };
        setState({ key: targetId, status: "ready", snapshot, refreshing: false });
      } catch (caught) {
        if (signal.aborted || requestRef.current !== requestId) return;
        setState({
          key: targetId,
          status: "error",
          error: describeFailure(caught),
          refreshing: false,
        });
      }
    },
    [client],
  );

  useEffect(() => {
    if (!enabled || workspaceId === null) {
      setState(INITIAL);
      return;
    }
    const controller = new AbortController();
    void load("initial", workspaceId, controller.signal);
    return () => controller.abort();
  }, [enabled, workspaceId, reloadKey, load]);

  useEffect(() => {
    if (!enabled || workspaceId === null || refreshKey === 0) return;
    const controller = new AbortController();
    void load("refresh", workspaceId, controller.signal);
    return () => controller.abort();
  }, [enabled, workspaceId, refreshKey, load]);

  const refresh = useCallback((): void => setRefreshKey((value) => value + 1), []);

  // A window that regains focus, reconnects, or becomes visible re-reads the
  // projection: a grant or revocation may have landed while it was away.
  useEffect(() => {
    if (!enabled || workspaceId === null) return;
    const onFocus = (): void => refresh();
    const onOnline = (): void => refresh();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, workspaceId, refresh]);

  // Re-read at the server's expiry instead of using an expired snapshot.
  useEffect(() => {
    if (!enabled || workspaceId === null || state.key !== workspaceId) return;
    const expiresAt = state.snapshot ? Date.parse(state.snapshot.expiresAt) : undefined;
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return;
    const delay = Math.max(0, expiresAt - Date.now()) + 250;
    const timer = window.setTimeout(
      () => setReloadKey((value) => value + 1),
      Math.min(delay, MAX_TIMEOUT_MS),
    );
    return () => window.clearTimeout(timer);
  }, [enabled, workspaceId, state.key, state.snapshot]);

  if (workspaceId === null || !enabled) {
    return { status: "idle", refreshing: false, refresh };
  }
  if (state.key !== workspaceId) {
    // The previous workspace's snapshot must never render for the new one.
    return { status: "loading", refreshing: false, refresh };
  }
  return {
    status: state.status,
    ...(state.snapshot ? { snapshot: state.snapshot } : {}),
    ...(state.error ? { error: state.error } : {}),
    refreshing: state.refreshing,
    refresh,
  };
}
