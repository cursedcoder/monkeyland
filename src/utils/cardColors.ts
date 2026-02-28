/**
 * Hash-based color palette per card. Same session_id always gets the same colors.
 * Warm palette (orange / amber / yellow) to fit Monkey Land theme.
 */

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Hue range for warm colors (orange → yellow → lime), e.g. 25–75 */
const HUE_MIN = 25;
const HUE_MAX = 75;
const HUE_RANGE = HUE_MAX - HUE_MIN + 1;

/**
 * Returns a small palette derived from session_id.
 * - primary: main accent (border, title, stripe)
 * - secondary: softer variant (header tint, hover)
 */
export function cardColorsFromId(sessionId: string): {
  primary: string;
  secondary: string;
} {
  const h = hashString(sessionId);
  const hue = HUE_MIN + (h % HUE_RANGE);
  const sat = 55 + (Math.floor(h / 31) % 15); // 55–70%
  const light = 48 + (Math.floor(h / 17) % 12); // 48–60%
  const primary = `hsl(${hue}, ${sat}%, ${light}%)`;
  const secondary = `hsl(${hue}, ${Math.max(20, sat - 20)}%, ${light + 8}%)`;
  return { primary, secondary };
}
