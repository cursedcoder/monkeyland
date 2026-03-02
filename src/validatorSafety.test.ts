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

  it("parses clean JSON validator output", () => {
    const input = JSON.stringify({
      code_review: { status: "pass", reasons: [] },
      business_logic: { status: "pass", reasons: [] },
      scope: { status: "pass", reasons: [] },
    });
    const parsed = normalizeValidatorOutput(input);
    expect(parsed.code_review.status).toBe("pass");
    expect(parsed.business_logic.status).toBe("pass");
    expect(parsed.scope.status).toBe("pass");
  });

  it("parses JSON wrapped in markdown code fences", () => {
    const input = `\`\`\`json
{
  "code_review": { "status": "pass", "reasons": [] },
  "business_logic": { "status": "fail", "reasons": ["missing edge case"] },
  "scope": { "status": "pass", "reasons": [] }
}
\`\`\``;
    const parsed = normalizeValidatorOutput(input);
    expect(parsed.code_review.status).toBe("pass");
    expect(parsed.business_logic.status).toBe("fail");
    expect(parsed.business_logic.reasons).toContain("missing edge case");
  });

  it("extracts JSON from LLM preamble/postamble text", () => {
    const input = `Here is my analysis:
{
  "code_review": { "status": "pass", "reasons": [] },
  "business_logic": { "status": "pass", "reasons": [] },
  "scope": { "status": "fail", "reasons": ["touched unrelated files"] }
}
I hope this helps!`;
    const parsed = normalizeValidatorOutput(input);
    expect(parsed.code_review.status).toBe("pass");
    expect(parsed.scope.status).toBe("fail");
    expect(parsed.scope.reasons).toContain("touched unrelated files");
  });

  it("fills missing validator roles with fail-closed defaults", () => {
    const input = JSON.stringify({
      code_review: { status: "pass", reasons: [] },
    });
    const parsed = normalizeValidatorOutput(input);
    expect(parsed.code_review.status).toBe("pass");
    expect(parsed.business_logic.status).toBe("fail");
    expect(parsed.business_logic.reasons[0]).toContain("Missing");
    expect(parsed.scope.status).toBe("fail");
  });

  it("preserves optional visual field when present", () => {
    const input = JSON.stringify({
      code_review: { status: "pass", reasons: [] },
      business_logic: { status: "pass", reasons: [] },
      scope: { status: "pass", reasons: [] },
      visual: { status: "fail", reasons: ["UI regression"] },
    });
    const parsed = normalizeValidatorOutput(input);
    expect(parsed.visual).toBeDefined();
    expect(parsed.visual!.status).toBe("fail");
  });

  it("fails closed on deeply nested/invalid JSON", () => {
    const parsed = normalizeValidatorOutput("{{{invalid}}}");
    expect(parsed.code_review.status).toBe("fail");
    expect(parsed.business_logic.status).toBe("fail");
    expect(parsed.scope.status).toBe("fail");
  });

  it("fails closed on empty string", () => {
    const parsed = normalizeValidatorOutput("");
    expect(parsed.code_review.status).toBe("fail");
  });

  it("fails closed on JSON array instead of object", () => {
    const parsed = normalizeValidatorOutput('[{"status":"pass"}]');
    expect(parsed.code_review.status).toBe("fail");
    expect(parsed.business_logic.status).toBe("fail");
  });
});
