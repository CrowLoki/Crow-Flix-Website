import { describe, expect, it } from "vitest";
import { byteRange, fixtureUrl } from "./playback-fixtures.mjs";

describe("owned playback fixture boundary", () => {
  it("supports bounded, open-ended and suffix byte ranges used by browser seeking", () => {
    expect(byteRange("bytes=2-5", 12)).toEqual({ start: 2, end: 5 });
    expect(byteRange("bytes=8-", 12)).toEqual({ start: 8, end: 11 });
    expect(byteRange("bytes=-4", 12)).toEqual({ start: 8, end: 11 });
    expect(byteRange("bytes=0-4095", 12)).toEqual({ start: 0, end: 11 });
  });
  it.each(["bytes=12-", "bytes=-0", "bytes=6-2", "bytes=0-1,3-4", "bytes=-", "bytes=999999999999999999999-"])(
    "rejects malformed or unsatisfiable range %s", (range) => {
      expect(() => byteRange(range, 12)).toThrow();
    },
  );
  it.each([
    "https://crowflix.tv/progressive.mp4", "http://127.0.0.1/progressive.mp4",
    "https://direct.playback.test:9999/progressive.mp4", "https://user:pass@direct.playback.test/progressive.mp4",
  ])("never maps arbitrary origins to a fixture: %s", (url) => {
    expect(() => fixtureUrl(url)).toThrow();
  });
});
