import { describe, expect, it } from "vitest";
import { isLoopbackApiUrl, parseNodeServiceLine } from "../../electron/service-discovery";

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

  it("accepts only loopback HTTP endpoints", () => {
    expect(isLoopbackApiUrl("http://127.0.0.1:4321")).toBe(true);
    expect(isLoopbackApiUrl("http://[::1]:4321")).toBe(true);
    expect(isLoopbackApiUrl("https://example.com")).toBe(false);
    expect(isLoopbackApiUrl("http://127.0.0.1.evil:4321")).toBe(false);
  });
});
