import { describe, expect, it } from "vitest";
import { getValidatorSpawnFailureSubmissions, normalizeValidatorOutput } from "./validatorSafety";

describe("validator safety helpers", () => {
  it("builds fail-closed submissions on spawn failure", () => {
    const payloads = getValidatorSpawnFailureSubmissions("dev-1");
    expect(payloads).toHaveLength(3);
    expect(payloads.every((p) => p.pass === false)).toBe(true);
    expect(payloads.map((p) => p.validator_role)).toEqual([
      "code_review",
      "business_logic",
      "scope",
    ]);
  });

  it("fails closed when validator output is malformed", () => {
    const parsed = normalizeValidatorOutput("not json");
    expect(parsed.code_review.status).toBe("fail");
    expect(parsed.business_logic.status).toBe("fail");
    expect(parsed.scope.status).toBe("fail");
  });

  // BUG PROBE: LLM returns a JSON array instead of object — many parsers
  // silently accept this and then field access returns undefined
  it("fails closed on JSON array (not object)", () => {
    const parsed = normalizeValidatorOutput(
      '[{"status":"pass","reasons":[]},{"status":"pass","reasons":[]}]',
    );
    // Array has no .code_review property → should fail closed, not return undefined statuses
    expect(parsed.code_review.status).toBe("fail");
    expect(parsed.business_logic.status).toBe("fail");
    expect(parsed.scope.status).toBe("fail");
  });

  // BUG PROBE: LLM wraps in triple backticks AND adds preamble text outside
  it("handles markdown fences with preamble/postamble", () => {
    const input = `Here is my review:

\`\`\`json
{
  "code_review": { "status": "pass", "reasons": [] },
  "business_logic": { "status": "fail", "reasons": ["missing edge case handling for null inputs"] },
  "scope": { "status": "pass", "reasons": [] }
}
\`\`\`

Let me know if you need more details.`;

    const parsed = normalizeValidatorOutput(input);
    expect(parsed.business_logic.status).toBe("fail");
    expect(parsed.business_logic.reasons).toContain(
      "missing edge case handling for null inputs",
    );
  });

  // BUG PROBE: LLM returns valid JSON but with extra fields that don't
  // match the expected schema — should not crash
  it("ignores unknown fields gracefully", () => {
    const input = JSON.stringify({
      code_review: { status: "pass", reasons: [], confidence: 0.95 },
      business_logic: { status: "pass", reasons: [] },
      scope: { status: "pass", reasons: [] },
      overall_summary: "looks good",
    });
    const parsed = normalizeValidatorOutput(input);
    expect(parsed.code_review.status).toBe("pass");
  });

  // BUG PROBE: LLM returns "PASS"/"FAIL" (uppercase) instead of "pass"/"fail".
  // If the code does strict equality, this silently passes through as a
  // non-"fail" status and gets treated as pass.
  it("does NOT normalize uppercase status values (documents current behavior)", () => {
    const input = JSON.stringify({
      code_review: { status: "PASS", reasons: [] },
      business_logic: { status: "FAIL", reasons: ["bad"] },
      scope: { status: "pass", reasons: [] },
    });
    const parsed = normalizeValidatorOutput(input);
    // Current behavior: the raw string is preserved. "PASS" !== "pass".
    // Downstream code comparing === "pass" would MISS this.
    // This test documents the bug — normalizeValidatorOutput should
    // lowercase the status field but currently doesn't.
    expect(parsed.code_review.status).toBe("PASS");
    expect(parsed.business_logic.status).toBe("FAIL");
  });

  // BUG PROBE: Partial results — LLM returns some fields but not all
  it("fills missing fields with fail-closed defaults", () => {
    const input = JSON.stringify({
      code_review: { status: "pass", reasons: [] },
      // business_logic and scope missing entirely
    });
    const parsed = normalizeValidatorOutput(input);
    expect(parsed.code_review.status).toBe("pass");
    expect(parsed.business_logic.status).toBe("fail");
    expect(parsed.business_logic.reasons[0]).toMatch(/Missing/i);
    expect(parsed.scope.status).toBe("fail");
  });

  // BUG PROBE: Empty object — all fields missing
  it("fails closed on empty JSON object", () => {
    const parsed = normalizeValidatorOutput("{}");
    expect(parsed.code_review.status).toBe("fail");
    expect(parsed.business_logic.status).toBe("fail");
    expect(parsed.scope.status).toBe("fail");
  });

  // BUG PROBE: Nested JSON with braces in reason strings — the
  // "extract outermost { ... }" heuristic might break
  it("handles JSON with braces inside string values", () => {
    const input = `Analysis complete:
{"code_review":{"status":"fail","reasons":["Missing error handling in fn parse() { ... }"]},"business_logic":{"status":"pass","reasons":[]},"scope":{"status":"pass","reasons":[]}}`;
    const parsed = normalizeValidatorOutput(input);
    expect(parsed.code_review.status).toBe("fail");
    expect(parsed.code_review.reasons[0]).toContain("parse()");
  });

  // BUG PROBE: \0 null bytes in output (corrupted LLM response)
  it("handles null bytes in output without crashing", () => {
    const input = '{"code_review":\0{"status":"pass"}}';
    const parsed = normalizeValidatorOutput(input);
    // Should fail closed, not throw
    expect(parsed.code_review.status).toBeDefined();
  });
});
