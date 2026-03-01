import { describe, expect, it } from "vitest";
import { cardColorsFromId } from "./cardColors";

describe("cardColorsFromId", () => {
  it("returns deterministic colors for the same id", () => {
    const a = cardColorsFromId("agent-123");
    const b = cardColorsFromId("agent-123");
    expect(a).toEqual(b);
  });

  it("returns different colors for different ids", () => {
    const a = cardColorsFromId("agent-123");
    const b = cardColorsFromId("agent-456");
    expect(a.primary).not.toBe(b.primary);
  });
});
