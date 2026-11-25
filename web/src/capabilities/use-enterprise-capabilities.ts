import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import type { IdentityClient } from "../api/identity";
import { EnterpriseProjectionError, parseEnterpriseCapabilities } from "./enterprise";
import type { EnterpriseCapabilitySnapshot } from "./enterprise";

export type EnterpriseCapabilityLoadStatus = "idle" | "loading" | "ready" | "error";

export interface EnterpriseCapabilityFailure {
  status: number;
  code: string;
  message: string;
}

export interface EnterpriseCapabilityState {
  status: EnterpriseCapabilityLoadStatus;
  snapshot?: EnterpriseCapabilitySnapshot;
  error?: EnterpriseCapabilityFailure;
  refreshing: boolean;
  refresh: () => void;
}

interface InternalState {
  key: string;
  status: EnterpriseCapabilityLoadStatus;
  snapshot?: EnterpriseCapabilitySnapshot;
  error?: EnterpriseCapabilityFailure;
  refreshing: boolean;
}

const INITIAL: InternalState = { key: "", status: "idle", refreshing: false };
const MAX_TIMEOUT_MS = 2_147_000_000;

function describeFailure(caught: unknown): EnterpriseCapabilityFailure {
  if (caught instanceof ApiError) {
    return { status: caught.status, code: caught.code, message: caught.message };
  }
  if (caught instanceof EnterpriseProjectionError) {
    return {
      status: 0,
      code: caught.code,
      message: "The enterprise capability projection could not be verified.",
    };
  }
  return {
    status: 0,
    code: "CAPABILITY_UNAVAILABLE",
    message: "The enterprise capability projection is unavailable.",
  };
}

/**
 * Reads the enterprise projection and keeps it fail-closed: an enterprise
 * change clears the previous snapshot before the new request renders, an
 * expired or unverified projection grants nothing, and focus/online/expiry
 * re-read it rather than reusing a stale answer.
 */
export function useEnterpriseCapabilities(options: {
  client: IdentityClient;
  enterpriseId: string | null;
  enabled: boolean;
}): EnterpriseCapabilityState {
  const { client, enterpriseId, enabled } = options;
  const [state, setState] = useState<InternalState>(INITIAL);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestRef = useRef(0);

  const load = useCallback(
    async (mode: "initial" | "refresh", targetId: string, signal: AbortSignal): Promise<void> => {
      const requestId = ++requestRef.current;
      if (mode === "initial") {
        setState({ key: targetId, status: "loading", refreshing: false });
      } else {
        setState((current) =>
          current.key === targetId
            ? { ...current, refreshing: true }
            : { key: targetId, status: "loading", refreshing: false },
        );
      }
      try {
        const raw = await client.getEnterpriseCapabilities(targetId, { signal });
        if (signal.aborted || requestRef.current !== requestId) return;
        const snapshot = parseEnterpriseCapabilities(raw, { enterpriseId: targetId });
        if (!snapshot.trusted) {
          setState({
            key: targetId,
            status: "error",
            error: {
              status: 0,
              code: "PROJECTION_UNTRUSTED",
              message:
                "Enterprise administration is not verified by the current projection; no directory data is shown.",
            },
            refreshing: false,
          });
          return;
        }
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
    if (!enabled || enterpriseId === null) {
      setState(INITIAL);
      return;
    }
    const controller = new AbortController();
    void load("initial", enterpriseId, controller.signal);
    return () => controller.abort();
  }, [enabled, enterpriseId, reloadKey, load]);

  useEffect(() => {
    if (!enabled || enterpriseId === null || refreshKey === 0) return;
    const controller = new AbortController();
    void load("refresh", enterpriseId, controller.signal);
    return () => controller.abort();
  }, [enabled, enterpriseId, refreshKey, load]);

  const refresh = useCallback((): void => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || enterpriseId === null) return;
    const onFocus = (): void => refresh();
    const onOnline = (): void => refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled, enterpriseId, refresh]);

  useEffect(() => {
    if (!enabled || enterpriseId === null || state.key !== enterpriseId) return;
    const expiresAt = state.snapshot ? Date.parse(state.snapshot.expiresAt) : undefined;
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return;
    const delay = Math.max(0, expiresAt - Date.now()) + 250;
    const timer = window.setTimeout(
      () => setReloadKey((value) => value + 1),
      Math.min(delay, MAX_TIMEOUT_MS),
    );
    return () => window.clearTimeout(timer);
  }, [enabled, enterpriseId, state.key, state.snapshot]);

  if (enterpriseId === null || !enabled) {
    return { status: "idle", refreshing: false, refresh };
  }
  if (state.key !== enterpriseId) {
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
