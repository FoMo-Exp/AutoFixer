import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { BrowserWindow } from "electron";
import { isLoopbackApiUrl } from "./service-discovery.js";

export interface ApiProxyRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ApiStreamMessage {
  type: "chunk" | "end" | "error";
  text?: string;
  message?: string;
}

export interface ApiProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: string;
  stream: boolean;
}

interface ApiProxyOptions {
  apiBaseUrl: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  publish: (requestId: string, message: ApiStreamMessage) => void;
}

const FORWARDED_HEADERS = new Set(["accept", "content-type", "idempotency-key", "last-event-id"]);
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export function createApiProxy(options: ApiProxyOptions): {
  request(input: ApiProxyRequest): Promise<ApiProxyResponse>;
  abort(requestId: string): void;
  dispose(): void;
} {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const active = new Map<string, AbortController>();

  async function request(input: ApiProxyRequest): Promise<ApiProxyResponse> {
    const { target, method, headers, body, isStream } = validateRequest(options, input);
    if (active.has(input.requestId)) throw new Error("Duplicate API request id.");

    const controller = new AbortController();
    active.set(input.requestId, controller);
    let streamStarted = false;
    try {
      const response = await fetchImpl(target, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        redirect: "error",
      });
      const responseHeaders = pickResponseHeaders(response.headers);
      if (isStream && response.ok && response.body) {
        streamStarted = true;
        void pumpStream(response.body, input.requestId, controller, options.publish, () => {
          active.delete(input.requestId);
        });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          stream: true,
        };
      }
      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: await response.text(),
        stream: false,
      };
    } finally {
      if (!streamStarted || controller.signal.aborted) active.delete(input.requestId);
    }
  }

  return {
    request,
    abort(requestId) {
      active.get(requestId)?.abort();
      active.delete(requestId);
    },
    dispose() {
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  };
}

export function installApiProxy(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | undefined,
  proxy: ReturnType<typeof createApiProxy>,
  isTrustedFrameUrl: (url: string) => boolean,
): () => void {
  const isTrustedSender = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
    const window = getWindow();
    return (
      !!window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      isTrustedFrameUrl(event.senderFrame.url)
    );
  };

  const requestHandler = (event: IpcMainInvokeEvent, request: ApiProxyRequest) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted ForgePilot API caller.");
    return proxy.request(request);
  };
  const abortHandler = (event: IpcMainEvent, requestId: string) => {
    if (!isTrustedSender(event)) return;
    if (typeof requestId === "string") proxy.abort(requestId);
  };

  ipcMain.handle("forgepilot:api-request", requestHandler);
  ipcMain.on("forgepilot:api-abort", abortHandler);
  return () => {
    ipcMain.removeHandler("forgepilot:api-request");
    ipcMain.removeListener("forgepilot:api-abort", abortHandler);
    proxy.dispose();
  };
}

function validateRequest(
  options: ApiProxyOptions,
  input: ApiProxyRequest,
): {
  target: URL;
  method: "GET" | "POST";
  headers: Headers;
  body?: string;
  isStream: boolean;
} {
  if (!input || !isRequestId(input.requestId)) throw new Error("Invalid API request id.");
  if (!isLoopbackApiUrl(options.apiBaseUrl)) throw new Error("Local Node service is unavailable.");
  if (!options.apiToken) throw new Error("Local Node service token is unavailable.");

  const base = new URL(options.apiBaseUrl);
  const target = new URL(input.url);
  if (
    !isLoopbackApiUrl(target.href) ||
    target.origin !== base.origin ||
    !/^\/api\/v1\/tasks(?:\/|$)/.test(target.pathname)
  ) {
    throw new Error("API proxy accepts only this local ForgePilot task service.");
  }

  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "POST") throw new Error("Unsupported API method.");
  if (input.body !== undefined && typeof input.body !== "string") {
    throw new Error("API request body must be text.");
  }
  if (input.body && Buffer.byteLength(input.body, "utf8") > MAX_REQUEST_BODY_BYTES) {
    throw new Error("API request body is too large.");
  }
  if (method === "GET" && input.body !== undefined)
    throw new Error("GET requests cannot have a body.");

  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (FORWARDED_HEADERS.has(name.toLowerCase()) && typeof value === "string") {
      headers.set(name, value);
    }
  }
  headers.set("Authorization", `Bearer ${options.apiToken}`);
  return {
    target,
    method,
    headers,
    ...(input.body === undefined ? {} : { body: input.body }),
    isStream: headers.get("accept")?.includes("text/event-stream") ?? false,
  };
}

function isRequestId(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function pickResponseHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ["content-type", "x-request-id"]) {
    const value = headers.get(name);
    if (value) output[name] = value;
  }
  return output;
}

async function pumpStream(
  body: ReadableStream<Uint8Array>,
  requestId: string,
  controller: AbortController,
  publish: ApiProxyOptions["publish"],
  onSettled: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      const text = decoder.decode(chunk.value, { stream: !chunk.done });
      if (text) publish(requestId, { type: "chunk", text });
      if (chunk.done) break;
    }
    publish(requestId, { type: "end" });
  } catch (error) {
    publish(requestId, {
      type: controller.signal.aborted ? "end" : "error",
      ...(controller.signal.aborted
        ? {}
        : { message: error instanceof Error ? error.message : "Local API stream failed." }),
    });
  } finally {
    reader.releaseLock();
    onSettled();
  }
}
