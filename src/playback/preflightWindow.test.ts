import { describe, expect, it } from "vitest";
import {
  LIVE_PAGE_PREFLIGHT_CHANNEL_LIMIT,
  OTHER_VIEW_PREFLIGHT_CHANNEL_LIMIT,
  boundedPreflightKeys,
  preflightRouteLimit,
} from "./preflightWindow";

describe("visible preflight window", () => {
  it("checks the current Live TV page instead of the first catalogue page", () => {
    const visible = Array.from({ length: 48 }, (_, index) => `page-two-${index}`);
    const fallback = Array.from({ length: 48 }, (_, index) => `page-one-${index}`);
    expect(boundedPreflightKeys(
      visible,
      fallback,
      LIVE_PAGE_PREFLIGHT_CHANNEL_LIMIT,
    )).toEqual(visible);
  });

  it("deduplicates and bounds non-live windows", () => {
    const selected = boundedPreflightKeys(
      [],
      ["one", "one", ...Array.from({ length: 20 }, (_, index) => `item-${index}`)],
      OTHER_VIEW_PREFLIGHT_CHANNEL_LIMIT,
    );
    expect(selected).toHaveLength(12);
    expect(new Set(selected).size).toBe(12);
  });

  it("checks one route per visible card but keeps deep checks for playback", () => {
    expect(preflightRouteLimit(false, true)).toBe(1);
    expect(preflightRouteLimit(false, false)).toBe(3);
    expect(preflightRouteLimit(true, true)).toBe(12);
  });
});
