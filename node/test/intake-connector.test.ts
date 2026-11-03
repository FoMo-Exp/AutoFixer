import { describe, expect, test } from "vitest";

import {
  ConnectorProtocolError,
  ConnectorUnavailableError,
  createHttpJsonPollConnector,
} from "../src/intake/connector.js";
import type {
  ConnectorTransport,
  ConnectorTransportRequest,
  ConnectorTransportResponse,
} from "../src/intake/connector.js";

function jsonResponse(status: number, body: unknown): ConnectorTransportResponse {
  return { status, body: JSON.stringify(body) };
}

function scriptedTransport(
  respond: (request: ConnectorTransportRequest) => ConnectorTransportResponse | Error,
): { transport: ConnectorTransport; requests: ConnectorTransportRequest[] } {
  const requests: ConnectorTransportRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      const result = respond(request);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

const baseOptions = {
  sourceId: "src_logs",
  endpoint: "https://logs.example.com/v1/events",
  credential: { header: "X-Read-Only-Token", value: "tok_source_scoped" },
};

const sampleEvent = {
  provider_event_id: "evt-1",
  event_time: "2026-11-03T12:00:00Z",
  schema_version: 1,
  provider_severity: "ERR",
  provider_service: "checkout-api",
  provider_environment: "prod-1",
  message: "checkout 1234 timed out",
};

describe("http json poll connector", () => {
  test("polls with the read-only credential header and returns the batch", async () => {
    const { transport, requests } = scriptedTransport(() =>
      jsonResponse(200, {
        events: [sampleEvent],
        next_cursor: "c-2",
        has_more: true,
      }),
    );
    const connector = createHttpJsonPollConnector({ ...baseOptions, transport });

    const batch = await connector.poll({ value: "c-1" }, 100);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.url).toContain("https://logs.example.com/v1/events");
    expect(request?.url).toContain("after=c-1");
    expect(request?.url).toContain("limit=100");
    expect(request?.headers["X-Read-Only-Token"]).toBe("tok_source_scoped");
    expect(request?.url).not.toContain("tok_source_scoped");
    expect(batch.events).toEqual([sampleEvent]);
    expect(batch.cursor).toEqual({ value: "c-2" });
    expect(batch.has_more).toBe(true);
    expect(connector.sourceId).toBe("src_logs");
  });

  test("omits the after parameter on the first poll", async () => {
    const { transport, requests } = scriptedTransport(() =>
      jsonResponse(200, { events: [], next_cursor: null, has_more: false }),
    );
    const connector = createHttpJsonPollConnector({ ...baseOptions, transport });

    const batch = await connector.poll(null, 50);

    expect(requests[0]?.url).not.toContain("after=");
    expect(batch.cursor).toBeNull();
  });

  test("passes a declared retention gap through", async () => {
    const { transport } = scriptedTransport(() =>
      jsonResponse(200, {
        events: [],
        next_cursor: "c-9",
        has_more: false,
        gap: {
          from: "2026-11-03T10:00:00Z",
          to: "2026-11-03T11:00:00Z",
          reason: "provider retention expired",
        },
      }),
    );
    const connector = createHttpJsonPollConnector({ ...baseOptions, transport });

    const batch = await connector.poll(null, 50);

    expect(batch.gap).toEqual({
      from: "2026-11-03T10:00:00Z",
      to: "2026-11-03T11:00:00Z",
      reason: "provider retention expired",
    });
  });

  test("maps server and transport failures to a retryable unavailability", async () => {
    for (const respond of [
      () => jsonResponse(500, {}),
      () => jsonResponse(429, {}),
      () => new Error("connection reset"),
    ]) {
      const { transport } = scriptedTransport(respond);
      const connector = createHttpJsonPollConnector({ ...baseOptions, transport });

      await expect(connector.poll(null, 10)).rejects.toBeInstanceOf(ConnectorUnavailableError);
    }
  });

  test("maps request-shape failures to an explicit protocol error", async () => {
    for (const respond of [
      () => jsonResponse(400, {}),
      () => jsonResponse(401, {}),
      () => ({ status: 200, body: "not json" }),
      () => jsonResponse(200, { events: "nope", next_cursor: null, has_more: false }),
      () => jsonResponse(200, { events: [], next_cursor: 5, has_more: false }),
      () => jsonResponse(200, { events: [], next_cursor: null }),
    ]) {
      const { transport } = scriptedTransport(respond);
      const connector = createHttpJsonPollConnector({ ...baseOptions, transport });

      await expect(connector.poll(null, 10)).rejects.toBeInstanceOf(ConnectorProtocolError);
    }
  });

  test("passes loosely shaped events through for pipeline-side validation", async () => {
    const oddEvent = { provider_event_id: "evt-odd", extra: "unknown field" };
    const { transport } = scriptedTransport(() =>
      jsonResponse(200, { events: [oddEvent], next_cursor: null, has_more: false }),
    );
    const connector = createHttpJsonPollConnector({ ...baseOptions, transport });

    const batch = await connector.poll(null, 10);

    expect(batch.events).toEqual([oddEvent]);
  });
});
