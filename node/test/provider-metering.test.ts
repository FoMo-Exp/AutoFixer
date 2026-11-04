import { describe, expect, test } from "vitest";

import {
  anthropicMessagesMetering,
  bedrockConverseMetering,
  googleGenerativeAiMetering,
  openaiCompletionsMetering,
  openaiResponsesMetering,
  resolveMeteringAdapter,
  transportNormalizedMetering,
} from "../src/ledger/metering.js";

describe("provider metering adapters declare their semantics explicitly", () => {
  test("every adapter names its unit, currency and revision", () => {
    for (const adapter of [
      anthropicMessagesMetering,
      openaiCompletionsMetering,
      openaiResponsesMetering,
      bedrockConverseMetering,
      googleGenerativeAiMetering,
    ]) {
      expect(adapter.revision).toBeGreaterThanOrEqual(1);
      expect(adapter.unit).toBe("tokens");
      expect(adapter.currency).toBe("USD");
      expect(adapter.providerNative).toBe(true);
    }
  });

  test("the transport-normalized fallback establishes no currency or native semantics", () => {
    expect(transportNormalizedMetering.providerNative).toBe(false);
    expect(transportNormalizedMetering.currency).toBeNull();
  });

  test("unmapped protocols resolve to the explicit fallback instead of invented semantics", () => {
    expect(resolveMeteringAdapter("some-future-protocol")).toBe(transportNormalizedMetering);
    expect(resolveMeteringAdapter("anthropic-messages")).toBe(anthropicMessagesMetering);
    expect(resolveMeteringAdapter("openai-completions")).toBe(openaiCompletionsMetering);
    expect(resolveMeteringAdapter("openai-responses")).toBe(openaiResponsesMetering);
    expect(resolveMeteringAdapter("azure-openai-responses")).toBe(openaiResponsesMetering);
  });
});

describe("openai-completions wire payload mapping", () => {
  const wire = {
    prompt_tokens: 1000,
    completion_tokens: 500,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 120 },
    completion_tokens_details: { reasoning_tokens: 120 },
  };

  test("cache and reasoning categories are distinct and never double-counted", () => {
    const mapped = openaiCompletionsMetering.normalize(wire);
    // OpenAI meters cache and reasoning INSIDE prompt/completion tokens.
    expect(mapped.input).toMatchObject({ tokens: 1000, included_in: null, completeness: "known" });
    expect(mapped.cache_read).toMatchObject({ tokens: 300, included_in: "input" });
    expect(mapped.cache_write).toMatchObject({ tokens: 120, included_in: "input" });
    expect(mapped.output).toMatchObject({ tokens: 500, included_in: null });
    expect(mapped.reasoning).toMatchObject({ tokens: 120, included_in: "output" });
    // Total counts only the provider's own lines: 1000 + 500, never 1920.
    expect(mapped.total_tokens).toBe(1500);
  });

  test("omitted detail fields are the provider's reported zeros, not missing figures", () => {
    const mapped = openaiCompletionsMetering.normalize({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(mapped.cache_read).toMatchObject({ tokens: 0, completeness: "known" });
    expect(mapped.cache_write).toMatchObject({ tokens: 0, completeness: "known" });
    expect(mapped.reasoning).toMatchObject({ tokens: 0, completeness: "known" });
    expect(mapped.total_tokens).toBe(15);
  });

  test("a missing required field is unknown, never a zero", () => {
    const mapped = openaiCompletionsMetering.normalize({
      prompt_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    expect(mapped.output).toMatchObject({ tokens: null, completeness: "unknown" });
    expect(mapped.total_tokens).toBeNull();
  });

  test("a malformed payload maps to all-unknown figures without throwing", () => {
    for (const payload of [null, "nonsense", { prompt_tokens: "1000", completion_tokens: -1 }]) {
      const mapped = openaiCompletionsMetering.normalize(payload);
      expect(mapped.input.tokens).toBeNull();
      expect(mapped.output.tokens).toBeNull();
      expect(mapped.total_tokens).toBeNull();
    }
  });
});

describe("anthropic-messages wire payload mapping", () => {
  const wire = {
    input_tokens: 900,
    output_tokens: 450,
    cache_read_input_tokens: 250,
    cache_creation_input_tokens: 80,
  };

  test("cache is metered on its own lines and reasoning rides inside output as unknown", () => {
    const mapped = anthropicMessagesMetering.normalize(wire);
    expect(mapped.input).toMatchObject({ tokens: 900, included_in: null });
    expect(mapped.cache_read).toMatchObject({ tokens: 250, included_in: null });
    expect(mapped.cache_write).toMatchObject({ tokens: 80, included_in: null });
    expect(mapped.output).toMatchObject({ tokens: 450, included_in: null });
    // Thinking tokens are metered inside output_tokens and never reported
    // apart: unknown — explicitly not zero.
    expect(mapped.reasoning).toMatchObject({
      tokens: null,
      completeness: "unknown",
      included_in: "output",
    });
    expect(mapped.total_tokens).toBe(900 + 450 + 250 + 80);
  });

  test("a missing metered field is unknown, not zero", () => {
    const mapped = anthropicMessagesMetering.normalize({
      input_tokens: 900,
      output_tokens: 450,
      cache_read_input_tokens: 250,
    });
    expect(mapped.cache_write).toMatchObject({ tokens: null, completeness: "unknown" });
    expect(mapped.total_tokens).toBeNull();
  });
});

describe("transport report mapping", () => {
  const report = { input: 700, output: 260, cacheRead: 300, cacheWrite: 120, totalTokens: 1380 };

  test("the openai adapter reconstructs the provider's input total from the transport frame", () => {
    const mapped = openaiCompletionsMetering.fromTransport(report);
    // The transport subtracts cache from input; the provider's prompt_tokens
    // is their sum again.
    expect(mapped.input).toMatchObject({ tokens: 1120, included_in: null });
    expect(mapped.cache_read).toMatchObject({ tokens: 300, included_in: "input" });
    expect(mapped.cache_write).toMatchObject({ tokens: 120, included_in: "input" });
    expect(mapped.output).toMatchObject({ tokens: 260, included_in: null });
    // The transport drops reasoning counts: unknown-but-included, never zero.
    expect(mapped.reasoning).toMatchObject({ tokens: null, completeness: "unknown" });
    expect(mapped.total_tokens).toBe(1380);
  });

  test("the anthropic adapter keeps cache on its own lines in the transport frame", () => {
    const mapped = anthropicMessagesMetering.fromTransport(report);
    expect(mapped.input).toMatchObject({ tokens: 700, included_in: null });
    expect(mapped.cache_read).toMatchObject({ tokens: 300, included_in: null });
    expect(mapped.total_tokens).toBe(700 + 260 + 300 + 120);
    expect(mapped.reasoning).toMatchObject({ tokens: null, completeness: "unknown" });
  });

  test("an all-zero transport report is unreported usage, not reported zeros", () => {
    // pi-ai zero-fills usage the provider never sent; a metered invocation
    // always reports at least its prompt tokens.
    const mapped = openaiCompletionsMetering.fromTransport({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });
    expect(mapped.input).toMatchObject({ tokens: null, completeness: "unknown" });
    expect(mapped.output).toMatchObject({ tokens: null, completeness: "unknown" });
    expect(mapped.total_tokens).toBeNull();
  });

  test("a real all-cached zero-input report is not mistaken for unreported usage", () => {
    const mapped = openaiCompletionsMetering.fromTransport({
      input: 0,
      output: 17,
      cacheRead: 500,
      cacheWrite: 0,
      totalTokens: 517,
    });
    expect(mapped.input.tokens).toBe(500);
    expect(mapped.cache_read.tokens).toBe(500);
    expect(mapped.output.tokens).toBe(17);
    expect(mapped.total_tokens).toBe(517);
  });
});

describe("other provider frames", () => {
  test("openai-responses keeps cache-in-input and exposes reasoning tokens", () => {
    const mapped = openaiResponsesMetering.normalize({
      input_tokens: 640,
      output_tokens: 200,
      total_tokens: 840,
      input_tokens_details: { cached_tokens: 240 },
      output_tokens_details: { reasoning_tokens: 90 },
    });
    expect(mapped.input.tokens).toBe(640);
    expect(mapped.cache_read).toMatchObject({ tokens: 240, included_in: "input" });
    expect(mapped.reasoning).toMatchObject({ tokens: 90, included_in: "output" });
    expect(mapped.total_tokens).toBe(840);
  });

  test("bedrock meters cache on its own lines", () => {
    const mapped = bedrockConverseMetering.normalize({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 30,
      cacheWriteInputTokens: 20,
      totalTokens: 200,
    });
    expect(mapped.total_tokens).toBe(200);
    expect(mapped.cache_read).toMatchObject({ tokens: 30, included_in: null });
    expect(mapped.reasoning).toMatchObject({ tokens: null, completeness: "unknown" });
  });

  test("google exposes thinking tokens inside the output total", () => {
    const mapped = googleGenerativeAiMetering.normalize({
      promptTokenCount: 400,
      candidatesTokenCount: 120,
      thoughtsTokenCount: 60,
      cachedContentTokenCount: 100,
      totalTokenCount: 580,
    });
    expect(mapped.input.tokens).toBe(400);
    expect(mapped.cache_read).toMatchObject({ tokens: 100, included_in: "input" });
    expect(mapped.output).toMatchObject({ tokens: 180 });
    expect(mapped.reasoning).toMatchObject({ tokens: 60, included_in: "output" });
    expect(mapped.total_tokens).toBe(580);
  });
});

describe("transport-normalized fallback for unmapped protocols", () => {
  test("refuses to invent wire semantics but maps the transport frame", () => {
    const mapped = transportNormalizedMetering.normalize({ prompt_tokens: 123 });
    expect(mapped.input).toMatchObject({ tokens: null, completeness: "unknown" });

    const fromTransport = transportNormalizedMetering.fromTransport({
      input: 10,
      output: 20,
      cacheRead: 5,
      cacheWrite: 6,
      totalTokens: 41,
    });
    expect(fromTransport.input).toMatchObject({ tokens: 10 });
    expect(fromTransport.cache_read).toMatchObject({ tokens: 5, included_in: null });
    expect(fromTransport.total_tokens).toBe(41);
    expect(fromTransport.reasoning).toMatchObject({ tokens: null, completeness: "unknown" });
  });
});
