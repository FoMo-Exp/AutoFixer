/**
 * Service-owned log-source connector seam and one reference adapter (DAT-216,
 * ADR-0007 "Log intake and issue creation").
 *
 * The connector is the only component that talks to a log provider. It is
 * owned and supervised by the intake service, never by a client: its
 * credentials are read-only and source-scoped, it fetches bounded batches
 * behind an opaque cursor, and it reports provider-declared retention gaps
 * instead of hiding them. Transport failures surface as a retryable
 * unavailability (reconnect territory); request/response-shape failures
 * surface as explicit protocol errors. This module claims no coverage of any
 * particular log provider — the adapter below is one reference implementation
 * of the interface.
 */

export interface ConnectorCursor {
  readonly value: string;
}

/** One provider alert/event as delivered by a source. */
export interface ProviderLogEvent {
  provider_event_id: string;
  event_time: string;
  schema_version: number;
  provider_severity: string;
  provider_service: string;
  provider_environment: string;
  message: string;
  error?: { class?: string | undefined; stack_locations?: string[] | undefined } | undefined;
  labels?: Record<string, string> | undefined;
  payload?: Record<string, unknown> | undefined;
}

/** Events in `[from, to)` will never be available from this source. */
export interface RetentionGap {
  from: string;
  to: string;
  reason: string;
}

export interface ConnectorBatch {
  events: ProviderLogEvent[];
  /** Cursor after this batch; null means the source has no forward cursor. */
  cursor: ConnectorCursor | null;
  has_more: boolean;
  gap?: RetentionGap | undefined;
}

/**
 * One configured log source. `poll` fetches the batch AFTER `after`, at most
 * `limit` events; the returned cursor is only ever persisted by the intake
 * pipeline once the batch is durably recorded.
 */
export interface LogSourceConnector {
  readonly sourceId: string;
  poll(after: ConnectorCursor | null, limit: number): Promise<ConnectorBatch>;
}

/** Transport outage: reconnecting and retrying the same cursor can succeed. */
export class ConnectorUnavailableError extends Error {
  readonly retryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConnectorUnavailableError";
  }
}

/** Request or response shape violation: surfaced explicitly, never silently. */
export class ConnectorProtocolError extends Error {
  readonly retryable = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConnectorProtocolError";
  }
}

export interface ConnectorTransportRequest {
  url: string;
  method: "GET";
  headers: Record<string, string>;
}

export interface ConnectorTransportResponse {
  status: number;
  body: string;
}

export type ConnectorTransport = (
  request: ConnectorTransportRequest,
) => Promise<ConnectorTransportResponse>;

export interface HttpJsonPollConnectorOptions {
  sourceId: string;
  /** Provider poll endpoint; the credential never appears in this URL. */
  endpoint: string;
  /** Read-only, source-scoped credential sent in its configured header. */
  credential: { header: string; value: string };
  transport: ConnectorTransport;
}

/**
 * Reference adapter: poll a JSON batch endpoint.
 *
 * Expected response envelope: `{ events: [...], next_cursor: string | null,
 * has_more: boolean, gap?: { from, to, reason } }`. Individual events pass
 * through as-is — the intake pipeline validates and normalizes them, so one
 * malformed event never disconnects the source.
 */
export function createHttpJsonPollConnector(
  options: HttpJsonPollConnectorOptions,
): LogSourceConnector {
  const { sourceId, endpoint, credential, transport } = options;
  return {
    sourceId,
    async poll(after, limit) {
      const url = new URL(endpoint);
      if (after !== null) {
        url.searchParams.set("after", after.value);
      }
      url.searchParams.set("limit", String(limit));
      let response: ConnectorTransportResponse;
      try {
        response = await transport({
          url: url.toString(),
          method: "GET",
          headers: { [credential.header]: credential.value },
        });
      } catch (error) {
        throw new ConnectorUnavailableError(`source ${sourceId} is unreachable`, { cause: error });
      }
      if (response.status === 429 || response.status >= 500) {
        throw new ConnectorUnavailableError(
          `source ${sourceId} returned status ${response.status}`,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ConnectorProtocolError(`source ${sourceId} returned status ${response.status}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch (error) {
        throw new ConnectorProtocolError(`source ${sourceId} returned a non-JSON body`, {
          cause: error,
        });
      }
      return parseBatch(sourceId, parsed);
    },
  };
}

function parseBatch(sourceId: string, parsed: unknown): ConnectorBatch {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConnectorProtocolError(`source ${sourceId} returned a non-object envelope`);
  }
  const envelope = parsed as Record<string, unknown>;
  const events = envelope["events"];
  if (!Array.isArray(events)) {
    throw new ConnectorProtocolError(`source ${sourceId} envelope "events" must be an array`);
  }
  const hasMore = envelope["has_more"];
  if (typeof hasMore !== "boolean") {
    throw new ConnectorProtocolError(`source ${sourceId} envelope "has_more" must be a boolean`);
  }
  const nextCursor = envelope["next_cursor"];
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw new ConnectorProtocolError(
      `source ${sourceId} envelope "next_cursor" must be a string or null`,
    );
  }
  const gap = parseGap(sourceId, envelope["gap"]);
  return {
    events: events.map((event) => {
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        throw new ConnectorProtocolError(
          `source ${sourceId} envelope "events" entries must be objects`,
        );
      }
      return event as unknown as ProviderLogEvent;
    }),
    cursor: typeof nextCursor === "string" ? { value: nextCursor } : null,
    has_more: hasMore,
    ...(gap ? { gap } : {}),
  };
}

function parseGap(sourceId: string, raw: unknown): RetentionGap | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConnectorProtocolError(`source ${sourceId} envelope "gap" must be an object`);
  }
  const gap = raw as Record<string, unknown>;
  const from = gap["from"];
  const to = gap["to"];
  const reason = gap["reason"];
  if (typeof from !== "string" || typeof to !== "string" || typeof reason !== "string") {
    throw new ConnectorProtocolError(
      `source ${sourceId} envelope "gap" needs string from, to and reason`,
    );
  }
  return { from, to, reason };
}
