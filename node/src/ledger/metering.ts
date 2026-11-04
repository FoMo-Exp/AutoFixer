/**
 * Provider metering semantics (DAT-227, ADR-0008 "Invocation ledger").
 *
 * One versioned adapter per provider protocol declares — explicitly, never by
 * assumption — how that provider meters an invocation: which wire fields map
 * to which token category, which categories the provider already counts
 * inside other categories or totals (so aggregation never double-counts),
 * the unit token figures are metered in, and the currency provider monetary
 * amounts are expressed in.
 *
 * Two entry points map usage into one adapter-owned frame:
 * - `normalize` takes the provider-native usage payload (the wire shape).
 * - `fromTransport` takes a transport-normalized usage report (the pi-ai
 *   `Usage` frame) and reconstructs this adapter's frame from it.
 *
 * Neither entry point ever invents a figure: a field the provider did not
 * report is `null` with completeness `unknown`, never a stand-in zero. Where
 * a provider's metering semantics define omission as "none" (fields that only
 * appear when non-zero), the adapter documents that and records the
 * semantics-defined zero as `known`.
 */

/** Canonical token categories of a usage ledger entry. */
export const TOKEN_CATEGORIES = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
] as const;

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

/**
 * Completeness of one usage figure — or of a whole record:
 * - `known`: the provider reported the figure (a reported zero is known).
 * - `estimated`: a figure exists but is not a reconciled provider report
 *   (partial figures from an uncompleted attempt, or unmapped semantics).
 * - `unknown`: no figure was reported; `tokens` is null, never zero.
 */
export type UsageCompleteness = "known" | "estimated" | "unknown";

/** Where the usage figures came from. */
export type UsageProvenance = "provider_wire" | "transport_reported" | "absent";

/** Unit every token category of an adapter is metered in. */
export type MeteringUnit = "tokens";

/** How one category relates to the rest of the adapter's frame. */
export interface CategoryMeteringSemantics {
  /**
   * The category whose reported figure already includes this category's
   * tokens, or null when the category is metered on its own line. Totals only
   * sum figures with `includedIn: null`, so an included category is never
   * double-counted.
   */
  includedIn: TokenCategory | null;
}

/** One mapped figure. `tokens: null` means not reported. */
export interface UsageFigure {
  tokens: number | null;
  completeness: UsageCompleteness;
  included_in: TokenCategory | null;
}

/** Adapter output: category figures in the adapter's frame plus their total. */
export interface MappedUsage {
  input: UsageFigure;
  output: UsageFigure;
  cache_read: UsageFigure;
  cache_write: UsageFigure;
  reasoning: UsageFigure;
  /** Sum of figures not included in any other figure; null when any is unknown. */
  total_tokens: number | null;
}

/**
 * Explicit metering semantics of one provider protocol. The adapter's frame
 * is the provider's own billing frame: `input` is the provider's
 * input-metered total, `output` its output-metered total, and `reasoning` /
 * `cache_read` / `cache_write` sit where the provider meters them (inside
 * those totals, or on their own lines) per `categories`.
 */
export interface ProviderMeteringAdapter {
  /** Provider protocol identity (the endpoint's pi-ai `Api`, e.g. "openai-completions"). */
  readonly id: string;
  /** Revision of these metering semantics; every ledger record snapshots it. */
  readonly revision: number;
  /** Unit of all token categories. */
  readonly unit: MeteringUnit;
  /**
   * ISO 4217 currency provider-reported monetary amounts are expressed in,
   * or null when the provider exposes no monetary metering to anchor one.
   */
  readonly currency: string | null;
  /**
   * True when provider-native metering semantics are mapped. False for the
   * transport-normalized fallback: its figures are usable but cannot be
   * reconciled against a provider invoice frame, so records downgrade to
   * `estimated`.
   */
  readonly providerNative: boolean;
  /**
   * Categories this provider finalizes only when the stream completes. On an
   * attempt that never completed, their figures cannot be known — the ledger
   * records them unknown instead of a stale partial count (never a zero-fill).
   */
  readonly completionDependent: readonly TokenCategory[];
  /** Inclusion relations in this adapter's output frame. */
  readonly categories: Readonly<Record<TokenCategory, CategoryMeteringSemantics>>;
  /** Normalize a provider-native usage payload. Defensive; never throws. */
  normalize(raw: unknown): MappedUsage;
  /** Map a transport-normalized usage report into this adapter's frame. */
  fromTransport(report: unknown): MappedUsage;
}

function figure(tokens: number | null, includedIn: TokenCategory | null): UsageFigure {
  return {
    tokens,
    completeness: tokens === null ? "unknown" : "known",
    included_in: includedIn,
  };
}

const UNKNOWN_FIGURE = (includedIn: TokenCategory | null): UsageFigure => figure(null, includedIn);

function asCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return null;
}

/**
 * Count for a detail field whose provider semantics define omission as
 * "none" (the field only appears when non-zero): an absent field is a known
 * zero, a present-but-invalid one is unknown rather than silently zeroed.
 */
function asDetailCount(value: unknown): number | null {
  if (value === undefined) {
    return 0;
  }
  return asCount(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Sum of the figures that carry their own metering line; null when any is unknown. */
export function totalOf(categories: Record<TokenCategory, UsageFigure>): number | null {
  let total = 0;
  for (const category of TOKEN_CATEGORIES) {
    const mapped = categories[category];
    if (mapped.included_in !== null) {
      continue;
    }
    if (mapped.tokens === null) {
      return null;
    }
    total += mapped.tokens;
  }
  return total;
}

/**
 * Every category unknown — the only honest mapping for a payload this
 * adapter cannot read. Used for unreported usage and never for reported zeros.
 */
export function allUnknown(
  categories: Readonly<Record<TokenCategory, CategoryMeteringSemantics>>,
): MappedUsage {
  return assemble({
    input: UNKNOWN_FIGURE(categories.input.includedIn),
    output: UNKNOWN_FIGURE(categories.output.includedIn),
    cache_read: UNKNOWN_FIGURE(categories.cache_read.includedIn),
    cache_write: UNKNOWN_FIGURE(categories.cache_write.includedIn),
    reasoning: UNKNOWN_FIGURE(categories.reasoning.includedIn),
  });
}

function assemble(input: {
  input: UsageFigure;
  output: UsageFigure;
  cache_read: UsageFigure;
  cache_write: UsageFigure;
  reasoning: UsageFigure;
}): MappedUsage {
  const categories: Record<TokenCategory, UsageFigure> = {
    input: input.input,
    output: input.output,
    cache_read: input.cache_read,
    cache_write: input.cache_write,
    reasoning: input.reasoning,
  };
  return { ...categories, total_tokens: totalOf(categories) };
}

/**
 * The pi-ai transport's normalized usage frame: `input` is uncached input,
 * cache reads/writes sit on their own lines, and provider reasoning is folded
 * into `output` without a separate count. A report of all zeros is pi-ai's
 * zero-fill for usage the provider never reported: a metered invocation
 * always reports at least its prompt tokens, so an all-zero report is treated
 * as not reported, never as reported zeros.
 */
interface TransportUsageReport {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function parseTransportReport(report: unknown): TransportUsageReport | null {
  const record = asRecord(report);
  if (!record) {
    return null;
  }
  const input = asCount(record["input"]);
  const output = asCount(record["output"]);
  const cacheRead = asCount(record["cacheRead"]);
  const cacheWrite = asCount(record["cacheWrite"]);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) {
    return null;
  }
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    // Zero-fill, not a provider report of zeros (see above).
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

/**
 * Every provider meters its output line when the response completes: on an
 * uncompleted attempt these categories have no final figure.
 */
const COMPLETION_DEPENDENT: readonly TokenCategory[] = ["output", "reasoning"];

/** OpenAI-style frame: cache reads/writes sit inside input, reasoning inside output. */
const OPENAI_STYLE_CATEGORIES: Record<TokenCategory, CategoryMeteringSemantics> = {
  input: { includedIn: null },
  output: { includedIn: null },
  cache_read: { includedIn: "input" },
  cache_write: { includedIn: "input" },
  reasoning: { includedIn: "output" },
};

/** Frame shared by the Anthropic-style wire shapes: cache metered on its own lines. */
const ANTHROPIC_STYLE_CATEGORIES: Record<TokenCategory, CategoryMeteringSemantics> = {
  input: { includedIn: null },
  output: { includedIn: null },
  cache_read: { includedIn: null },
  cache_write: { includedIn: null },
  reasoning: { includedIn: "output" },
};

/**
 * `anthropic-messages` metering (ADR-0008 adapter reference).
 *
 * Wire usage: `{ input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens }`. All four are always present on a metered
 * response; a missing one is an incomplete report, not a zero. Cache reads and
 * writes are billed on their own lines (not included in `input_tokens`).
 * Thinking tokens are metered inside `output_tokens` and never reported
 * separately, so `reasoning` is unknown-but-included-in-output.
 */
export const anthropicMessagesMetering: ProviderMeteringAdapter = {
  id: "anthropic-messages",
  revision: 1,
  unit: "tokens",
  currency: "USD",
  providerNative: true,
  completionDependent: COMPLETION_DEPENDENT,
  categories: ANTHROPIC_STYLE_CATEGORIES,
  normalize(raw: unknown): MappedUsage {
    const record = asRecord(raw);
    if (!record) {
      return allUnknown(this.categories);
    }
    return assemble({
      input: figure(asCount(record["input_tokens"]), null),
      output: figure(asCount(record["output_tokens"]), null),
      cache_read: figure(asCount(record["cache_read_input_tokens"]), null),
      cache_write: figure(asCount(record["cache_creation_input_tokens"]), null),
      reasoning: UNKNOWN_FIGURE("output"),
    });
  },
  fromTransport(report: unknown): MappedUsage {
    const parsed = parseTransportReport(report);
    if (!parsed) {
      return this.normalize(null);
    }
    return assemble({
      input: figure(parsed.input, null),
      output: figure(parsed.output, null),
      cache_read: figure(parsed.cacheRead, null),
      cache_write: figure(parsed.cacheWrite, null),
      reasoning: UNKNOWN_FIGURE("output"),
    });
  },
};

/**
 * `bedrock-converse-stream` metering: the Converse stream usage object
 * (`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens`)
 * meters cache on its own lines like Anthropic. Thinking tokens ride inside
 * `outputTokens` without a separate count.
 */
export const bedrockConverseMetering: ProviderMeteringAdapter = {
  id: "bedrock-converse-stream",
  revision: 1,
  unit: "tokens",
  currency: "USD",
  providerNative: true,
  completionDependent: COMPLETION_DEPENDENT,
  categories: ANTHROPIC_STYLE_CATEGORIES,
  normalize(raw: unknown): MappedUsage {
    const record = asRecord(raw);
    if (!record) {
      return allUnknown(this.categories);
    }
    return assemble({
      input: figure(asCount(record["inputTokens"]), null),
      output: figure(asCount(record["outputTokens"]), null),
      cache_read: figure(asCount(record["cacheReadInputTokens"]), null),
      cache_write: figure(asCount(record["cacheWriteInputTokens"]), null),
      reasoning: UNKNOWN_FIGURE("output"),
    });
  },
  fromTransport(report: unknown): MappedUsage {
    return anthropicMessagesMetering.fromTransport(report);
  },
};

/**
 * `openai-completions` metering (OpenAI-compatible chat completions).
 *
 * Wire usage: `{ prompt_tokens, completion_tokens, total_tokens,
 * prompt_tokens_details: { cached_tokens, cache_write_tokens? },
 * completion_tokens_details: { reasoning_tokens } }`. `prompt_tokens` already
 * includes cached tokens and `completion_tokens` already includes reasoning
 * tokens, so both are recorded as included-in-total figures and never added
 * on top. The detail fields only appear when non-zero (provider semantics:
 * omission means none), so an absent detail is a known zero; an absent
 * `prompt_tokens`/`completion_tokens` is an incomplete report.
 */
export const openaiCompletionsMetering: ProviderMeteringAdapter = {
  id: "openai-completions",
  revision: 1,
  unit: "tokens",
  currency: "USD",
  providerNative: true,
  completionDependent: COMPLETION_DEPENDENT,
  categories: OPENAI_STYLE_CATEGORIES,
  normalize(raw: unknown): MappedUsage {
    const record = asRecord(raw);
    if (!record) {
      return allUnknown(this.categories);
    }
    const promptDetails = asRecord(record["prompt_tokens_details"]) ?? {};
    const completionDetails = asRecord(record["completion_tokens_details"]) ?? {};
    return assemble({
      input: figure(asCount(record["prompt_tokens"]), null),
      output: figure(asCount(record["completion_tokens"]), null),
      cache_read: figure(asDetailCount(promptDetails["cached_tokens"]), "input"),
      cache_write: figure(asDetailCount(promptDetails["cache_write_tokens"]), "input"),
      reasoning: figure(asDetailCount(completionDetails["reasoning_tokens"]), "output"),
    });
  },
  fromTransport(report: unknown): MappedUsage {
    const parsed = parseTransportReport(report);
    if (!parsed) {
      return this.normalize(null);
    }
    // The transport subtracts cache reads/writes from the prompt figure; the
    // provider's `prompt_tokens` is their sum again.
    return assemble({
      input: figure(parsed.input + parsed.cacheRead + parsed.cacheWrite, null),
      output: figure(parsed.output, null),
      cache_read: figure(parsed.cacheRead, "input"),
      cache_write: figure(parsed.cacheWrite, "input"),
      // The transport folds reasoning into output and drops the count.
      reasoning: UNKNOWN_FIGURE("output"),
    });
  },
};

/**
 * `openai-responses` metering: the Responses API usage object
 * (`input_tokens`/`output_tokens`/`total_tokens` with `input_tokens_details.
 * cached_tokens` and `output_tokens_details.reasoning_tokens`) keeps the same
 * inclusion semantics as chat completions: cache inside input, reasoning
 * inside output.
 */
export const openaiResponsesMetering: ProviderMeteringAdapter = {
  id: "openai-responses",
  revision: 1,
  unit: "tokens",
  currency: "USD",
  providerNative: true,
  completionDependent: COMPLETION_DEPENDENT,
  categories: OPENAI_STYLE_CATEGORIES,
  normalize(raw: unknown): MappedUsage {
    const record = asRecord(raw);
    if (!record) {
      return allUnknown(this.categories);
    }
    const inputDetails = asRecord(record["input_tokens_details"]) ?? {};
    const outputDetails = asRecord(record["output_tokens_details"]) ?? {};
    return assemble({
      input: figure(asCount(record["input_tokens"]), null),
      output: figure(asCount(record["output_tokens"]), null),
      cache_read: figure(asDetailCount(inputDetails["cached_tokens"]), "input"),
      // The Responses API meters no cache-write line; cache writes are not
      // reported and never billed on one.
      cache_write: figure(0, "input"),
      reasoning: figure(asDetailCount(outputDetails["reasoning_tokens"]), "output"),
    });
  },
  fromTransport(report: unknown): MappedUsage {
    return openaiCompletionsMetering.fromTransport(report);
  },
};

/**
 * `google-generative-ai` / `google-vertex` metering: `usageMetadata`
 * (`promptTokenCount` includes `cachedContentTokenCount`; `candidatesTokenCount`
 * plus `thoughtsTokenCount` is the output-metered total). Thinking tokens are
 * exposed as their own count and sit inside the output total.
 */
function googleMetering(id: string): ProviderMeteringAdapter {
  return {
    id,
    revision: 1,
    unit: "tokens",
    currency: "USD",
    providerNative: true,
    completionDependent: COMPLETION_DEPENDENT,
    categories: OPENAI_STYLE_CATEGORIES,
    normalize(raw: unknown): MappedUsage {
      const record = asRecord(raw);
      if (!record) {
        return allUnknown(this.categories);
      }
      const prompt = asCount(record["promptTokenCount"]);
      const candidates = asCount(record["candidatesTokenCount"]);
      const thoughts = asDetailCount(record["thoughtsTokenCount"]);
      return assemble({
        input: figure(prompt, null),
        output:
          prompt === null || candidates === null || thoughts === null
            ? UNKNOWN_FIGURE(null)
            : figure(candidates + thoughts, null),
        cache_read: figure(asDetailCount(record["cachedContentTokenCount"]), "input"),
        cache_write: figure(0, "input"),
        reasoning: figure(thoughts, "output"),
      });
    },
    fromTransport(report: unknown): MappedUsage {
      return openaiCompletionsMetering.fromTransport(report);
    },
  };
}

export const googleGenerativeAiMetering = googleMetering("google-generative-ai");
export const googleVertexMetering = googleMetering("google-vertex");

/**
 * Fallback for a protocol no adapter maps yet: figures are recorded in the
 * transport's normalized frame with no provider-native semantics to reconcile
 * against. `normalize` refuses to guess a wire shape, so provider-native
 * payloads stay `unknown` (the raw payload is preserved on the record for
 * later reconciliation instead). No currency is established.
 */
export const transportNormalizedMetering: ProviderMeteringAdapter = {
  id: "transport-normalized",
  revision: 1,
  unit: "tokens",
  currency: null,
  providerNative: false,
  completionDependent: COMPLETION_DEPENDENT,
  categories: {
    input: { includedIn: null },
    output: { includedIn: null },
    cache_read: { includedIn: null },
    cache_write: { includedIn: null },
    reasoning: { includedIn: "output" },
  },
  normalize(): MappedUsage {
    return allUnknown(this.categories);
  },
  fromTransport(report: unknown): MappedUsage {
    const parsed = parseTransportReport(report);
    if (!parsed) {
      return this.normalize(null);
    }
    return assemble({
      input: figure(parsed.input, null),
      output: figure(parsed.output, null),
      cache_read: figure(parsed.cacheRead, null),
      cache_write: figure(parsed.cacheWrite, null),
      reasoning: UNKNOWN_FIGURE("output"),
    });
  },
};

const REGISTRY: Readonly<Record<string, ProviderMeteringAdapter>> = {
  "anthropic-messages": anthropicMessagesMetering,
  "bedrock-converse-stream": bedrockConverseMetering,
  "openai-completions": openaiCompletionsMetering,
  "openai-responses": openaiResponsesMetering,
  // Aliases whose wire usage matches a mapped protocol.
  "azure-openai-responses": openaiResponsesMetering,
  "openai-codex-responses": openaiResponsesMetering,
  "mistral-conversations": openaiCompletionsMetering,
  "google-generative-ai": googleGenerativeAiMetering,
  "google-vertex": googleVertexMetering,
};

/**
 * The metering adapter for one provider protocol. A protocol without an
 * explicit adapter resolves to the transport-normalized fallback — its
 * records stay honest (`estimated`, no invented currency) instead of
 * pretending provider semantics that were never defined.
 */
export function resolveMeteringAdapter(api: string): ProviderMeteringAdapter {
  return REGISTRY[api] ?? transportNormalizedMetering;
}
