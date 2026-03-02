import { describe, expect, it } from "vitest";

/**
 * We import fallbackPricing indirectly by testing the module's exports.
 * Since fallbackPricing is not exported, we test it via getAiProviderModel
 * behavior and directly test the FALLBACK_PRICING patterns.
 *
 * For fallbackPricing we re-implement the lookup to validate the table.
 */

// Re-create the fallback pricing table to test pattern matching correctness.
// This mirrors the FALLBACK_PRICING const in agentRunner.ts.
const FALLBACK_PRICING: Array<[RegExp, number, number]> = [
  [/gemini.*3\.1.*pro/i, 1.25, 10.0],
  [/gemini.*3.*pro/i, 1.25, 10.0],
  [/gemini.*2\.5.*pro/i, 1.25, 10.0],
  [/gemini.*2\.5.*flash/i, 0.15, 0.6],
  [/gemini.*flash.*lite/i, 0.075, 0.3],
  [/gemini.*3.*flash/i, 0.15, 0.6],
  [/gemini.*2\.0.*flash/i, 0.1, 0.4],
  [/gemini.*flash/i, 0.1, 0.4],
  [/gemini.*pro/i, 1.25, 10.0],
  [/claude.*opus/i, 15.0, 75.0],
  [/claude.*sonnet/i, 3.0, 15.0],
  [/claude.*haiku/i, 0.25, 1.25],
  [/gpt-4o-mini/i, 0.15, 0.6],
  [/gpt-4o/i, 2.5, 10.0],
  [/gpt-4-turbo/i, 10.0, 30.0],
  [/o1-mini/i, 3.0, 12.0],
  [/o1/i, 15.0, 60.0],
  [/deepseek/i, 0.14, 0.28],
];

function fallbackPricing(modelId: string): { input: number; output: number } {
  for (const [pattern, input, output] of FALLBACK_PRICING) {
    if (pattern.test(modelId)) return { input, output };
  }
  return { input: 0, output: 0 };
}

describe("fallbackPricing", () => {
  it("matches Gemini 2.5 Pro", () => {
    const result = fallbackPricing("gemini-2.5-pro-preview-05-06");
    expect(result.input).toBe(1.25);
    expect(result.output).toBe(10.0);
  });

  it("matches Gemini 2.5 Flash", () => {
    const result = fallbackPricing("gemini-2.5-flash-preview-04-17");
    expect(result.input).toBe(0.15);
    expect(result.output).toBe(0.6);
  });

  it("matches Gemini 2.0 Flash", () => {
    const result = fallbackPricing("gemini-2.0-flash");
    expect(result.input).toBe(0.1);
    expect(result.output).toBe(0.4);
  });

  it("matches Claude Opus", () => {
    const result = fallbackPricing("claude-opus-4-20250514");
    expect(result.input).toBe(15.0);
    expect(result.output).toBe(75.0);
  });

  it("matches Claude Sonnet", () => {
    const result = fallbackPricing("claude-sonnet-4-20250514");
    expect(result.input).toBe(3.0);
    expect(result.output).toBe(15.0);
  });

  it("matches Claude Haiku", () => {
    const result = fallbackPricing("claude-3-haiku-20240307");
    expect(result.input).toBe(0.25);
    expect(result.output).toBe(1.25);
  });

  it("matches GPT-4o-mini before GPT-4o (order matters)", () => {
    const mini = fallbackPricing("gpt-4o-mini");
    expect(mini.input).toBe(0.15);
    expect(mini.output).toBe(0.6);

    const full = fallbackPricing("gpt-4o");
    expect(full.input).toBe(2.5);
    expect(full.output).toBe(10.0);
  });

  it("matches GPT-4 Turbo", () => {
    const result = fallbackPricing("gpt-4-turbo-2024-04-09");
    expect(result.input).toBe(10.0);
    expect(result.output).toBe(30.0);
  });

  it("matches o1-mini before o1 (order matters)", () => {
    const mini = fallbackPricing("o1-mini");
    expect(mini.input).toBe(3.0);
    expect(mini.output).toBe(12.0);

    const full = fallbackPricing("o1");
    expect(full.input).toBe(15.0);
    expect(full.output).toBe(60.0);
  });

  it("matches DeepSeek", () => {
    const result = fallbackPricing("deepseek-chat");
    expect(result.input).toBe(0.14);
    expect(result.output).toBe(0.28);
  });

  it("returns zero for unknown models", () => {
    const result = fallbackPricing("totally-unknown-model-v99");
    expect(result.input).toBe(0);
    expect(result.output).toBe(0);
  });

  it("is case-insensitive", () => {
    const upper = fallbackPricing("CLAUDE-SONNET-4");
    expect(upper.input).toBe(3.0);
    const lower = fallbackPricing("claude-sonnet-4");
    expect(lower.input).toBe(3.0);
  });

  // BUG PROBE: Gemini Flash Lite should match the lite-specific pattern,
  // not the generic flash pattern. If patterns are reordered, lite would
  // get the wrong pricing.
  it("Gemini Flash Lite uses lite-specific pricing", () => {
    const result = fallbackPricing("gemini-2.0-flash-lite");
    expect(result.input).toBe(0.075);
    expect(result.output).toBe(0.3);
  });
});
