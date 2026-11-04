/**
 * A real HTTP fake provider for adapter tests (DAT-247).
 *
 * Tests assert the **exact** request line (`method` + `url` including query)
 * and the exact credential header against this server. No substring
 * matching: the DAT-204 regression was precisely that a fake provider
 * accepted any URL containing a substring while the real provider answered
 * 404.
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  /** Exact request target, e.g. `/repos/acme/repo/collaborators?per_page=100&page=1`. */
  url: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
}

export interface FakeProviderResponse {
  status: number;
  headers?: Record<string, string>;
  /** Objects are serialized as JSON; strings are sent verbatim. */
  body?: unknown;
}

export type FakeProviderHandler = (request: RecordedRequest) => FakeProviderResponse;

export interface FakeProvider {
  /** `http://127.0.0.1:<port>` — passed as the adapter's api_base_url. */
  base_url: string;
  requests: RecordedRequest[];
  /** Every request target seen, in order. */
  urls(): string[];
  close(): Promise<void>;
}

function lowerCaseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export async function startFakeProvider(handler: FakeProviderHandler): Promise<FakeProvider> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const recorded: RecordedRequest = {
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: lowerCaseHeaders(request.headers),
    };
    requests.push(recorded);
    // Drain any body so the socket is reusable.
    request.resume();
    request.on("end", () => {
      const fake = handler(recorded);
      const body =
        typeof fake.body === "string"
          ? fake.body
          : fake.body === undefined
            ? ""
            : JSON.stringify(fake.body);
      response.writeHead(fake.status, {
        "content-type": "application/json",
        ...(fake.headers ?? {}),
      });
      response.end(body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    base_url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    urls: () => requests.map((request) => request.url),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // `fetch` keeps connections alive; without this a teardown waits out
        // the server's keep-alive timeout.
        server.closeAllConnections();
      }),
  };
}

/**
 * Route by exact request target. An unmatched request answers 599 so a test
 * fails loudly instead of silently exercising the wrong page.
 */
export function exactRoutes(
  routes: Record<string, FakeProviderResponse | (() => FakeProviderResponse)>,
): FakeProviderHandler {
  return (request) => {
    const route = routes[request.url];
    if (route === undefined) {
      return { status: 599, body: { error: `unexpected request ${request.url}` } };
    }
    return typeof route === "function" ? route() : route;
  };
}
