import { describe, expect, it } from "vitest";
import { rectIntersects } from "./useViewportBounds";

describe("rectIntersects", () => {
  it("detects overlap without margin", () => {
    const a = { left: 0, top: 0, right: 100, bottom: 100 };
    const b = { left: 90, top: 90, right: 200, bottom: 200 };
    expect(rectIntersects(a, b, 0)).toBe(true);
  });

  it("detects non-overlap without margin", () => {
    const a = { left: 0, top: 0, right: 100, bottom: 100 };
    const b = { left: 120, top: 120, right: 200, bottom: 200 };
    expect(rectIntersects(a, b, 0)).toBe(false);
  });

  it("includes margin when checking overlap", () => {
    const a = { left: 0, top: 0, right: 100, bottom: 100 };
    const b = { left: 120, top: 120, right: 200, bottom: 200 };
    expect(rectIntersects(a, b, 30)).toBe(true);
  });
});
