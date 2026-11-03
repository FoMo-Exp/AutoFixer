import http from "node:http";
import { once } from "node:events";

import { afterAll, describe, expect, test } from "vitest";

import { ProviderError, ProviderOAuth, providerAdapters } from "../src/api/oauth.js";
/**
 * Regression for the QA round-1 blocker: provider token/userinfo calls must
 * never follow redirects. A 302/307/308 from a compromised or DNS-re-bound
 * provider would forward the client secret, authorization code, and PKCE
 * verifier (or the bearer access token) to whatever the Location names — and
 * that target can be a cross-origin or internal-network endpoint outside the
 * approved provider origin. These tests drive the real fetch stack against
 * loopback servers: the redirect target is by construction a different
 * origin on an internal address, and it must observe zero requests.
 */

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

interface TestServer {
  base: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

const opened: TestServer[] = [];

interface Rig {
  provider: TestServer;
  evil: TestServer;
}

/**
 * A "provider" whose token and user endpoints answer `status` + Location of
 * the evil server, and an evil server that happily answers the stolen
 * request if anything ever follows the redirect.
 */
async function redirectRig(status: number): Promise<Rig> {
  const evil = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: "stolen-token", id: 666, login: "attacker" }));
  });
  const provider = await startServer((_req, res) => {
    res.writeHead(status, { Location: `${evil.base}/steal` });
    res.end();
  });
  opened.push(provider, evil);
  return { provider, evil };
}

const CREDENTIALS = { client_id: "cid", client_secret: "super-secret" };

function exchange(providerBase: string, oauth: ProviderOAuth): Promise<string> {
  return oauth.exchangeCode({
    adapter: providerAdapters.github,
    origin: providerBase,
    credentials: CREDENTIALS,
    code: "auth-code-1",
    redirectUri: "http://127.0.0.1/cb",
    codeVerifier: "pkce-verifier",
  });
}

afterAll(async () => {
  while (opened.length > 0) {
    await opened.pop()?.close();
  }
});

describe("provider calls never follow redirects", () => {
  test.each([302, 307, 308])(
    "a %i token-endpoint redirect forwards nothing to the target",
    async (status) => {
      const rig = await redirectRig(status);
      const oauth = new ProviderOAuth();
      // The exchange fails instead of completing against the redirect target.
      await expect(exchange(rig.provider.base, oauth)).rejects.toThrow(ProviderError);
      expect(rig.provider.requests).toHaveLength(1);
      expect(rig.provider.requests[0]?.body).toContain("client_secret=super-secret");
      // The cross-origin internal target never sees the secret-bearing body.
      expect(rig.evil.requests).toHaveLength(0);
    },
  );

  test.each([302, 307, 308])(
    "a %i user-endpoint redirect forwards no bearer token to the target",
    async (status) => {
      const rig = await redirectRig(status);
      const oauth = new ProviderOAuth();
      await expect(
        oauth.fetchProfile({
          adapter: providerAdapters.github,
          origin: rig.provider.base,
          accessToken: "access-token-1",
        }),
      ).rejects.toThrow(ProviderError);
      expect(rig.provider.requests).toHaveLength(1);
      expect(rig.evil.requests).toHaveLength(0);
    },
  );

  test("the happy path still works and nothing leaks sideways", async () => {
    const evil = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const provider = await startServer((req, res) => {
      if (req.url?.includes("access_token")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "tok-1" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 42, login: "octo", name: "Octo" }));
    });
    opened.push(provider, evil);
    const oauth = new ProviderOAuth();
    const token = await exchange(provider.base, oauth);
    expect(token).toBe("tok-1");
    const profile = await oauth.fetchProfile({
      adapter: providerAdapters.github,
      origin: provider.base,
      accessToken: token,
    });
    expect(profile.subject).toBe("42");
    expect(evil.requests).toHaveLength(0);
  });
});
