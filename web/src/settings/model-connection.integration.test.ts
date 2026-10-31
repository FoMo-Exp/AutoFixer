import { createServer } from "node:http";
import type { SafeStorage } from "electron";
import { describe, expect, it } from "vitest";
import { testModelConnection } from "../../electron/model-connection.js";

const storage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
  getSelectedStorageBackend: () => "basic_text",
  setUsePlainTextEncryption: () => undefined,
};

describe("model discovery HTTP integration", () => {
  it("fetches real HTTP model lists without an initial Model ID or a generation request", async () => {
    const requests: string[] = [];
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      authorization = request.headers.authorization;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-model-b" }, { id: "local-model-a" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing local server address");
      const result = await testModelConnection(
        "/nonexistent/model-discovery-fixture.json",
        storage,
        {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture-key",
        },
      );
      expect(result).toMatchObject({
        ok: true,
        models: ["local-model-a", "local-model-b"],
        latencyMs: expect.any(Number),
      });
      expect(requests).toEqual(["GET /v1/models"]);
      expect(authorization).toBe("Bearer fixture-key");
      expect(JSON.stringify(result)).not.toContain("fixture-key");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
