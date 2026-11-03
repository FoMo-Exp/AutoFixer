import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";

import type { GatewayBindingIdentity, ModelGateway } from "../gateway/index.js";
import { scrubSecrets } from "../gateway/redact.js";
import type { ModelSignalBriefing } from "./minimize.js";

/**
 * Signal analysis dispatch (DAT-216).
 *
 * Model analysis of a signal has exactly one egress path: the ADR-0005 model
 * gateway. The context is composed here from the minimized briefing — there
 * is no function in this module (or its callers) that opens a provider
 * connection directly, and a gateway denial fails the call closed. As the
 * last egress-side defense, the composed text is secret-scrubbed again even
 * though `minimizeSignal` already scrubs its fields.
 */

/** Compose the analysis context from briefing fields only. */
export function buildAnalysisContext(briefing: ModelSignalBriefing): Context {
  const lines = [
    "Signal briefing (minimized analysis input):",
    `signal: ${briefing.signal_key}`,
    `severity: ${briefing.severity}`,
    `service: ${briefing.service}`,
    `environment: ${briefing.environment}`,
    `error class: ${briefing.error_class}`,
    `signature: ${briefing.error_signature}`,
    `message: ${briefing.message_excerpt}`,
    `frames: ${briefing.stack_locations.join(", ")}`,
    `occurrences: ${briefing.occurrences}`,
    `rate: ${briefing.rate.count} in ${briefing.rate.window_seconds}s`,
  ];
  return {
    messages: [{ role: "user", content: scrubSecrets(lines.join("\n")), timestamp: Date.now() }],
  };
}

export interface BriefingDispatch {
  gateway: ModelGateway;
  model: Model<Api>;
  identity: GatewayBindingIdentity;
  briefing: ModelSignalBriefing;
  options?: SimpleStreamOptions | undefined;
}

/** Dispatch one minimized briefing through the model gateway. */
export async function dispatchBriefing(
  input: BriefingDispatch,
): Promise<AssistantMessageEventStream> {
  return input.gateway.dispatch(
    input.model,
    buildAnalysisContext(input.briefing),
    input.options,
    input.identity,
  );
}
