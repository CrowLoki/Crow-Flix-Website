import { describe, expect, it, vi } from "vitest";
import {
  LIVE_PAGE_PREFLIGHT_CHANNEL_LIMIT,
  OTHER_VIEW_PREFLIGHT_CHANNEL_LIMIT,
  boundedPreflightKeys,
  findReadyRoute,
  preflightSourceLimit,
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

  it("checks diverse visible sources but keeps the deepest checks for playback", () => {
    expect(preflightSourceLimit(false, true)).toBe(2);
    expect(preflightSourceLimit(false, false)).toBe(3);
    expect(preflightSourceLimit(true, true)).toBe(12);
  });

  it("tries a second source after failure and stops at the first ready route", async () => {
    const checked: string[] = [];
    const ready = await findReadyRoute(
      ["primary", "alternate", "unused"],
      () => null,
      async (route) => {
        checked.push(route);
        return route === "alternate" ? "ready" : "offline";
      },
    );
    expect(ready).toBe("alternate");
    expect(checked).toEqual(["primary", "alternate"]);
  });

  it("uses a cached ready route without rechecking it", async () => {
    const check = vi.fn(async () => "offline" as const);
    await expect(findReadyRoute(
      ["known-offline", "known-ready"],
      (route) => route === "known-ready" ? "ready" : "offline",
      check,
    )).resolves.toBe("known-ready");
    expect(check).not.toHaveBeenCalled();
  });
});
