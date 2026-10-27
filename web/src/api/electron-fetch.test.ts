import { describe, expect, it, vi } from "vitest";
import { createElectronFetch } from "./electron-fetch";
import type { ElectronApiBridge } from "./electron-fetch";

function bridgeWith(request: ElectronApiBridge["request"]): ElectronApiBridge & {
  emit: (
    requestId: string,
    message: Parameters<Parameters<ElectronApiBridge["onStream"]>[1]>[0],
  ) => void;
} {
  const listeners = new Map<
    string,
    (message: Parameters<Parameters<ElectronApiBridge["onStream"]>[1]>[0]) => void
  >();
  return {
    request,
    abort: vi.fn(),
    onStream(requestId, callback) {
      listeners.set(requestId, callback);
      return () => listeners.delete(requestId);
    },
    emit(requestId, message) {
      listeners.get(requestId)?.(message);
    },
  };
}

describe("Electron API transport", () => {
  it("returns proxied API responses as Fetch responses", async () => {
    const bridge = bridgeWith(async () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [], next_cursor: null }),
      stream: false,
    }));
    const fetch = createElectronFetch(bridge);

    const response = await fetch("http://127.0.0.1:4321/api/v1/tasks");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], next_cursor: null });
  });

  it("bridges stream chunks that arrive before the response headers", async () => {
    let requestId = "";
    const bridge = bridgeWith(async (request) => {
      requestId = request.requestId;
      queueMicrotask(() => {
        bridge.emit(requestId, { type: "chunk", text: "data: event\n\n" });
        bridge.emit(requestId, { type: "end" });
      });
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/event-stream" },
        stream: true,
      };
    });
    const fetch = createElectronFetch(bridge);

    const response = await fetch("http://127.0.0.1:4321/api/v1/tasks/tsk_1/stream", {
      headers: { Accept: "text/event-stream" },
    });

    expect(await response.text()).toBe("data: event\n\n");
  });

  it("forwards cancellation to the main process", async () => {
    let requestId = "";
    const bridge = bridgeWith((request) => {
      requestId = request.requestId;
      return new Promise(() => undefined);
    });
    const fetch = createElectronFetch(bridge);
    const controller = new AbortController();
    const pending = fetch("http://127.0.0.1:4321/api/v1/tasks/tsk_1/stream", {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    expect(bridge.abort).toHaveBeenCalledWith(requestId);
    void pending.catch(() => undefined);
  });
});
