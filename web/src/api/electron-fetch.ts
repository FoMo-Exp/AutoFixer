import type { JsonFetch } from "./client";

interface ApiProxyRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface ApiProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: string;
  stream: boolean;
}

interface ApiStreamMessage {
  type: "chunk" | "end" | "error";
  text?: string;
  message?: string;
}

export interface ElectronApiBridge {
  request(request: ApiProxyRequest): Promise<ApiProxyResponse>;
  abort(requestId: string): void;
  onStream(requestId: string, callback: (message: ApiStreamMessage) => void): () => void;
}

export function createElectronFetch(bridge: ElectronApiBridge): JsonFetch {
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (request?.url ?? String(input));
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(request?.headers);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const signal = init.signal ?? request?.signal;
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");

    const requestId = crypto.randomUUID();
    const wantsStream = headers.get("accept")?.includes("text/event-stream") ?? false;
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let pendingMessages: ApiStreamMessage[] = [];
    let streamEnded = false;
    let cleanedUp = false;
    let unsubscribe = (): void => undefined;

    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => bridge.abort(requestId);
    const receive = (message: ApiStreamMessage): void => {
      if (!streamController) {
        pendingMessages.push(message);
        return;
      }
      deliver(message);
    };
    const deliver = (message: ApiStreamMessage): void => {
      if (!streamController) return;
      if (message.type === "chunk" && message.text) {
        streamController.enqueue(encoder.encode(message.text));
      } else if (message.type === "end") {
        streamEnded = true;
        streamController.close();
        cleanup();
      } else if (message.type === "error") {
        streamController.error(new Error(message.message ?? "Local API stream failed."));
        cleanup();
      }
    };

    if (wantsStream) unsubscribe = bridge.onStream(requestId, receive);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const proxyResponse = await bridge.request({
        requestId,
        url,
        method,
        headers: Object.fromEntries(headers.entries()),
        ...(typeof init.body === "string"
          ? { body: init.body }
          : typeof request?.body === "string"
            ? { body: request.body }
            : {}),
      });
      if (!proxyResponse.stream) {
        cleanup();
        const body = proxyResponse.body ?? "";
        return new Response(body || null, {
          status: proxyResponse.status,
          statusText: proxyResponse.statusText,
          headers: proxyResponse.headers,
        });
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          for (const message of pendingMessages) deliver(message);
          pendingMessages = [];
          if (streamEnded) return;
        },
        cancel() {
          bridge.abort(requestId);
          cleanup();
        },
      });
      return new Response(body, {
        status: proxyResponse.status,
        statusText: proxyResponse.statusText,
        headers: proxyResponse.headers,
      });
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}
