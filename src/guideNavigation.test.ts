import { describe, expect, it } from "vitest";
import { GUIDE_PAGE_SIZE, paginateGuideChannels } from "./guideNavigation";

describe("guide channel pagination", () => {
  it("keeps every channel reachable across bounded pages", () => {
    const channels = Array.from({ length: 250 }, (_, index) => `channel-${index + 1}`);
    const pages = [1, 2, 3].map((page) => paginateGuideChannels(channels, page));

    expect(GUIDE_PAGE_SIZE).toBe(100);
    expect(pages.map((result) => result.channels.length)).toEqual([100, 100, 50]);
    expect(pages.flatMap((result) => result.channels)).toEqual(channels);
    expect(pages[2]).toMatchObject({ page: 3, pageCount: 3, start: 201, end: 250, total: 250 });
  });

  it("clamps invalid pages and represents an empty country honestly", () => {
    expect(paginateGuideChannels(["one"], 99)).toMatchObject({
      channels: ["one"], page: 1, pageCount: 1, start: 1, end: 1, total: 1,
    });
    expect(paginateGuideChannels([], Number.NaN)).toEqual({
      channels: [], page: 1, pageCount: 1, start: 0, end: 0, total: 0,
    });
  });
});
