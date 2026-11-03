import { streamSimple } from "@mariozechner/pi-ai";
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  Api,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";

import { ModelDispatchError } from "./types.js";

/**
 * The gateway's provider transport. The gateway resolves the approved
 * destination, pins the endpoint, and supplies the credential; the adapter's
 * only job is to speak the provider protocol with those fixed inputs.
 */
export interface ProviderAdapter {
  stream(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
}

/**
 * Options the adapter forwards to the provider protocol layer. Caller-supplied
 * payload hooks, headers, and metadata are dropped: the adapter must not let a
 * caller reshape or annotate a request outside the gateway's checks. Retries
 * are disabled at this layer because every retry must be a separately checked
 * gateway invocation.
 */
export function buildAdapterOptions(
  options: SimpleStreamOptions | undefined,
  credential: string,
): SimpleStreamOptions {
  const forwarded: SimpleStreamOptions = {
    apiKey: credential,
    // Gateway-owned retries only: an SDK-internal retry would send request
    // bytes without gateway checks or audit evidence.
    maxRetries: 0,
  };
  if (!options) return forwarded;
  if (options.temperature !== undefined) forwarded.temperature = options.temperature;
  if (options.maxTokens !== undefined) forwarded.maxTokens = options.maxTokens;
  if (options.signal !== undefined) forwarded.signal = options.signal;
  if (options.reasoning !== undefined) forwarded.reasoning = options.reasoning;
  if (options.thinkingBudgets !== undefined) forwarded.thinkingBudgets = options.thinkingBudgets;
  if (options.transport !== undefined) forwarded.transport = options.transport;
  if (options.cacheRetention !== undefined) forwarded.cacheRetention = options.cacheRetention;
  if (options.sessionId !== undefined) forwarded.sessionId = options.sessionId;
  if (options.timeoutMs !== undefined) forwarded.timeoutMs = options.timeoutMs;
  return forwarded;
}

/**
 * pi-ai backed adapter. The dispatched model always carries the pinned
 * registered `baseUrl`, so the SDK's default endpoint is unreachable; the
 * credential always comes from the gateway, so pi-ai's environment-variable
 * key lookup is unreachable. Both are enforced here as well as in the gateway:
 * this adapter refuses to send anything without an explicit credential.
 */
export const piAiProviderAdapter: ProviderAdapter = {
  stream(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const credential = options?.apiKey;
    if (!credential) {
      throw new ModelDispatchError(
        "gateway adapter refused to dispatch without an explicit credential",
        false,
      );
    }
    return streamSimple(model, context, buildAdapterOptions(options, credential));
  },
};
