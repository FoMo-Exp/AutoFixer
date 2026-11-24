// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { IdentityClient, WorkspaceCapabilityProjection } from "../api/identity";
import { capabilityProjection, expiredCapabilityProjection } from "./test-projection";
import { useWorkspaceCapabilities } from "./use-capabilities";

function fakeClient(
  resolve: (workspaceId: string) => Promise<WorkspaceCapabilityProjection>,
): IdentityClient {
  return {
    getWorkspaceCapabilities: vi.fn(resolve),
  } as unknown as IdentityClient;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useWorkspaceCapabilities", () => {
  it("clears the previous workspace snapshot before the next projection resolves", async () => {
    const pending = Promise.withResolvers<WorkspaceCapabilityProjection>();
    const beta = pending.promise;
    const client = fakeClient((workspaceId) =>
      workspaceId === "ws_alpha"
        ? Promise.resolve(capabilityProjection({ workspaceId: "ws_alpha" }))
        : beta,
    );
    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) =>
        useWorkspaceCapabilities({ client, workspaceId, enabled: true }),
      { initialProps: { workspaceId: "ws_alpha" } },
    );

    await waitFor(() => expect(result.current.snapshot?.workspaceId).toBe("ws_alpha"));
    rerender({ workspaceId: "ws_beta" });
    expect(result.current.status).toBe("loading");
    expect(result.current.snapshot).toBeUndefined();

    await act(async () => {
      pending.resolve(capabilityProjection({ workspaceId: "ws_beta" }));
    });
    await waitFor(() => expect(result.current.snapshot?.workspaceId).toBe("ws_beta"));
  });

  it("drops a stale snapshot when a focus re-read is denied", async () => {
    const client = fakeClient((workspaceId) =>
      Promise.resolve(capabilityProjection({ workspaceId })),
    );
    const { result } = renderHook(() =>
      useWorkspaceCapabilities({ client, workspaceId: "ws_alpha", enabled: true }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    vi.mocked(client.getWorkspaceCapabilities).mockRejectedValue(
      new ApiError(403, undefined, "Denied"),
    );
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.snapshot).toBeUndefined();
    expect(result.current.error?.status).toBe(403);
  });

  it("re-reads an expired projection instead of using it", async () => {
    const client = fakeClient(
      vi
        .fn()
        .mockResolvedValueOnce(expiredCapabilityProjection({ workspaceId: "ws_alpha" }))
        .mockResolvedValueOnce(capabilityProjection({ workspaceId: "ws_alpha" })),
    );
    const { result } = renderHook(() =>
      useWorkspaceCapabilities({ client, workspaceId: "ws_alpha", enabled: true }),
    );

    await waitFor(() => expect(client.getWorkspaceCapabilities).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.snapshot?.trusted).toBe(true);
  });

  it("fails closed on a contract violation and recovers only on an explicit refresh", async () => {
    const client = fakeClient(
      vi
        .fn()
        .mockResolvedValueOnce({ ...capabilityProjection(), schema_version: "future" })
        .mockResolvedValueOnce(capabilityProjection({ workspaceId: "ws_alpha" })),
    );
    const { result } = renderHook(() =>
      useWorkspaceCapabilities({ client, workspaceId: "ws_alpha", enabled: true }),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.snapshot).toBeUndefined();
    expect(result.current.error?.code).toBe("UNKNOWN_SCHEMA_VERSION");

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("stays idle without an identity workspace (legacy local mode)", () => {
    const client = fakeClient(() => Promise.resolve(capabilityProjection()));
    const { result } = renderHook(() =>
      useWorkspaceCapabilities({ client, workspaceId: null, enabled: false }),
    );
    expect(result.current.status).toBe("idle");
    expect(result.current.snapshot).toBeUndefined();
    expect(client.getWorkspaceCapabilities).not.toHaveBeenCalled();
  });
});
