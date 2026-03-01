import { describe, expect, it } from "vitest";
import { getValidatorSpawnFailureSubmissions, normalizeValidatorOutput } from "./validatorSafety";

describe("validator safety helpers", () => {
  it("builds fail-closed submissions on spawn failure", () => {
    const payloads = getValidatorSpawnFailureSubmissions("dev-1");
    expect(payloads).toHaveLength(3);
    expect(payloads.every((p) => p.pass === false)).toBe(true);
  });

  it("fails closed when validator output is malformed", () => {
    const parsed = normalizeValidatorOutput("not json");
    expect(parsed.code_review.status).toBe("fail");
    expect(parsed.business_logic.status).toBe("fail");
    expect(parsed.scope.status).toBe("fail");
  });
});
