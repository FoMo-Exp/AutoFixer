import { describe, expect, it } from "vitest";
import {
  discoverNodeService,
  isLoopbackApiUrl,
  parseNodeServiceLine,
  resolveNodeExecutable,
} from "../../electron/service-discovery";

describe("Electron Node service discovery", () => {
  it("extracts the ephemeral URL and token file from Node startup output", () => {
    expect(
      parseNodeServiceLine(
        "forgepilot-api/v1 listening on http://127.0.0.1:4321\nAPI token file (Authorization: Bearer <token>): /tmp/forgepilot/api-token",
      ),
    ).toEqual({
      apiBaseUrl: "http://127.0.0.1:4321",
      apiTokenFile: "/tmp/forgepilot/api-token",
    });
  });

  it("normalizes an unbracketed IPv6 loopback URL from Node startup output", () => {
    expect(
      parseNodeServiceLine(
        "forgepilot-api/v1 listening on http://::1:4321\nAPI token file (Authorization: Bearer <token>): /tmp/forgepilot/api-token",
      ),
    ).toMatchObject({ apiBaseUrl: "http://[::1]:4321" });
  });

  it("accepts only loopback HTTP endpoints", () => {
    expect(isLoopbackApiUrl("http://127.0.0.1:4321")).toBe(true);
    expect(isLoopbackApiUrl("http://[::1]:4321")).toBe(true);
    expect(isLoopbackApiUrl("https://example.com")).toBe(false);
    expect(isLoopbackApiUrl("http://127.0.0.1.evil:4321")).toBe(false);
  });

  it("uses a Node runtime executable instead of Electron's process executable", () => {
    expect(resolveNodeExecutable({})).toBe("node");
    expect(resolveNodeExecutable({ FORGEPILOT_NODE_EXECUTABLE: "/opt/node/bin/node" })).toBe(
      "/opt/node/bin/node",
    );
  });

  it("explains how to fix the default startup when the base commit is missing", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FORGEPILOT_BASE_SHA: "",
      FORGEPILOT_NODE_EXECUTABLE: "missing-node",
    };
    delete env.FORGEPILOT_API_URL;
    delete env.FORGEPILOT_API_PORT;
    delete env.FORGEPILOT_API_DISCOVERY_FILE;
    delete env.FORGEPILOT_NODE_ENTRY;

    await expect(discoverNodeService(env)).rejects.toThrow(/Set FORGEPILOT_BASE_SHA/);
  });
});
