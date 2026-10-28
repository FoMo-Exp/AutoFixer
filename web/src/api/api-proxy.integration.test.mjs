import { createApiServer } from "../../../node/src/api/server.js";
import { createApiProxy, installApiProxy } from "../../electron/api-proxy.js";
import { describe, expect, it, vi } from "vitest";

describe("Electron main-process API proxy integration", () => {
  it("calls the real Node API without browser CORS preflight", async () => {
    const apiToken = "integration-token";
    const server = createApiServer({
      service: {
        listTasks: () => ({ items: [], next_cursor: null }),
      },
      apiToken,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const fetchImpl = vi.fn((input, init) => globalThis.fetch(input, init));
    const proxy = createApiProxy({
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
      apiToken,
      fetchImpl,
      publish: vi.fn(),
    });

    try {
      const response = await proxy.request({
        requestId: "2a5e79e0-5c42-4d91-a298-1f696f8274c1",
        url: `http://127.0.0.1:${address.port}/api/v1/tasks`,
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer renderer-value-must-not-be-forwarded",
          Origin: "null",
        },
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body ?? "{}")).toEqual({ items: [], next_cursor: null });
      const forwardedHeaders = fetchImpl.mock.calls[0][1].headers;
      expect(forwardedHeaders.get("origin")).toBeNull();
      expect(forwardedHeaders.get("authorization")).toBe(`Bearer ${apiToken}`);
    } finally {
      proxy.dispose();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("pins requests to the configured loopback API origin", async () => {
    const fetchImpl = vi.fn();
    const proxy = createApiProxy({
      apiBaseUrl: "http://127.0.0.1:4321",
      apiToken: "main-token",
      fetchImpl,
      publish: vi.fn(),
    });

    await expect(
      proxy.request({
        requestId: "2a5e79e0-5c42-4d91-a298-1f696f8274c1",
        url: "https://example.invalid/api/v1/tasks",
        method: "GET",
        headers: {},
      }),
    ).rejects.toThrow("API proxy accepts only this local ForgePilot task service");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects IPC requests from an untrusted renderer frame", async () => {
    const handlers = new Map();
    const ipcMain = {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => undefined,
      removeHandler: () => undefined,
      removeListener: () => undefined,
    };
    const mainFrame = { url: "file:///app/dist/index.html" };
    const webContents = { mainFrame };
    const window = { isDestroyed: () => false, webContents };
    const proxy = createApiProxy({
      apiBaseUrl: "http://127.0.0.1:4321",
      apiToken: "main-token",
      fetchImpl: vi.fn(),
      publish: vi.fn(),
    });
    const dispose = installApiProxy(
      ipcMain,
      () => window,
      proxy,
      (url) => url === mainFrame.url,
    );

    try {
      await expect(
        Promise.resolve().then(() =>
          handlers.get("forgepilot:api-request")(
            { sender: webContents, senderFrame: { url: "https://attacker.invalid/" } },
            {
              requestId: "2a5e79e0-5c42-4d91-a298-1f696f8274c1",
              url: "http://127.0.0.1:4321/api/v1/tasks",
              method: "GET",
              headers: {},
            },
          ),
        ),
      ).rejects.toThrow("Untrusted ForgePilot API caller");
    } finally {
      dispose();
    }
  });
});
