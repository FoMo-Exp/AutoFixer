import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import type {
  DshActionRequest,
  DshActionResponse,
  DshApprovalRequest,
  DshApprovalResponse,
  DshCancelRequest,
  DshCancelResponse,
  DshCreateRunRequest,
  DshCreateRunResponse,
  DshErrorBody,
  DshEventsResponse,
  DshHealth,
  DshRunResponse,
} from "./types.js";

/** Error raised for any non-2xx dsh-control/v1 response. */
export class DshError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  readonly requestId: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown>,
    retryable: boolean,
    requestId: string,
  ) {
    super(message);
    this.name = "DshError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.requestId = requestId;
  }
}

export interface DshClientOptions {
  /** Unix socket path or Windows named-pipe name of the dsh control plane. */
  socketPath: string;
  /** Boot-token file. Defaults to `<socketPath>.token` (the unix layout). */
  tokenFile?: string;
}

interface DshRequestSpec {
  method: string;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  protocolHeader: boolean;
}

/**
 * Client for the local dsh-control/v1 plane.
 *
 * Talks HTTP over the UDS (or Windows named pipe) that dsh binds; there is no
 * TCP fallback, matching the contract's local-transport-only rule. Every
 * request except /v1/health carries the protocol version, the boot token from
 * the token file, and a caller-derived request id; writes also carry an
 * idempotency key.
 */
export class DshClient {
  private readonly socketPath: string;
  private readonly tokenFile: string;

  constructor(options: DshClientOptions) {
    this.socketPath = options.socketPath;
    this.tokenFile = options.tokenFile ?? `${options.socketPath}.token`;
  }

  health(): Promise<DshHealth> {
    return this.request<DshHealth>({ method: "GET", path: "/v1/health", protocolHeader: false });
  }

  createRun(
    body: DshCreateRunRequest,
    idempotencyKey: string = randomUUID(),
  ): Promise<DshCreateRunResponse> {
    return this.request<DshCreateRunResponse>({
      method: "POST",
      path: "/v1/runs",
      body,
      idempotencyKey,
      protocolHeader: true,
    });
  }

  getRun(runId: string): Promise<DshRunResponse> {
    return this.request<DshRunResponse>({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(runId)}`,
      protocolHeader: true,
    });
  }

  recordApproval(
    runId: string,
    body: DshApprovalRequest,
    idempotencyKey: string = randomUUID(),
  ): Promise<DshApprovalResponse> {
    return this.request<DshApprovalResponse>({
      method: "POST",
      path: `/v1/runs/${encodeURIComponent(runId)}/approvals`,
      body,
      idempotencyKey,
      protocolHeader: true,
    });
  }

  submitAction(
    runId: string,
    body: DshActionRequest,
    idempotencyKey: string = randomUUID(),
  ): Promise<DshActionResponse> {
    return this.request<DshActionResponse>({
      method: "POST",
      path: `/v1/runs/${encodeURIComponent(runId)}/actions`,
      body,
      idempotencyKey,
      protocolHeader: true,
    });
  }

  cancelRun(
    runId: string,
    body: DshCancelRequest,
    idempotencyKey: string = randomUUID(),
  ): Promise<DshCancelResponse> {
    return this.request<DshCancelResponse>({
      method: "POST",
      path: `/v1/runs/${encodeURIComponent(runId)}/cancel`,
      body,
      idempotencyKey,
      protocolHeader: true,
    });
  }

  getEvents(runId: string, afterSequence = 0, limit = 100): Promise<DshEventsResponse> {
    const query = `after_sequence=${afterSequence}&limit=${limit}`;
    return this.request<DshEventsResponse>({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(runId)}/events?${query}`,
      protocolHeader: true,
    });
  }

  getArtifact(runId: string, artifactId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
      protocolHeader: true,
    });
  }

  private request<T>(spec: DshRequestSpec): Promise<T> {
    const requestId = `req_${randomUUID()}`;
    const headers: Record<string, string> = {
      "X-Request-Id": requestId,
      Accept: "application/json",
    };
    if (spec.protocolHeader) {
      headers["X-DSH-Protocol"] = "1";
      headers["X-DSH-Boot-Token"] = fs.readFileSync(this.tokenFile, "utf8").trim();
    }
    let payload: Buffer | undefined;
    if (spec.body !== undefined) {
      payload = Buffer.from(JSON.stringify(spec.body), "utf8");
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.byteLength);
    }
    if (spec.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = spec.idempotencyKey;
    }

    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const req = http.request(
      {
        socketPath: this.socketPath,
        path: spec.path,
        method: spec.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve((raw.length > 0 ? JSON.parse(raw) : {}) as T);
            return;
          }
          reject(DshClient.parseError(status, raw, requestId));
        });
      },
    );
    req.on("error", (error) => {
      reject(
        new DshError(
          503,
          "DSH_UNAVAILABLE",
          `dsh control plane unreachable at ${path.basename(this.socketPath)}: ${error.message}`,
          {},
          true,
          requestId,
        ),
      );
    });
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
    return promise;
  }

  private static parseError(status: number, raw: string, fallbackRequestId: string): DshError {
    try {
      const parsed = JSON.parse(raw) as DshErrorBody;
      if (parsed.error && typeof parsed.error.code === "string") {
        return new DshError(
          status,
          parsed.error.code,
          parsed.error.message,
          parsed.error.details ?? {},
          parsed.error.retryable ?? false,
          parsed.error.request_id || fallbackRequestId,
        );
      }
    } catch {
      // fall through to the generic envelope below
    }
    return new DshError(
      status,
      "DSH_UNAVAILABLE",
      `dsh returned ${status} without a contract error envelope: ${raw.slice(0, 200)}`,
      {},
      status >= 500,
      fallbackRequestId,
    );
  }
}
