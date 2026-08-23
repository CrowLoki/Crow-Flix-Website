import { describe, expect, it } from "vitest";
import {
  channelMatchesMetadataFilters,
  channelProviders,
  sourceHostname,
} from "./catalogMetadata";
import { MAIN_FEED_OPTION_ID } from "./webCatalog";

const channel = {
  feed: null,
  owners: ["Crow Media"],
  network: "Crow Network",
  provenance: ["IPTV-org"],
  sources: [
    { url: "https://one.test/live.m3u8", provenance: "IPTV-org" },
    { url: "https://two.test/live.m3u8", provenance: "Regional provider" },
  ],
};

describe("catalogue metadata filters", () => {
  it("combines channel and per-source provenance without duplicates", () => {
    expect(channelProviders(channel)).toEqual(["IPTV-org", "Regional provider"]);
  });

  it("matches owner, network, main feed, and provider exactly", () => {
    expect(channelMatchesMetadataFilters(channel, {
      owner: "Crow Media",
      network: "Crow Network",
      feed: MAIN_FEED_OPTION_ID,
      provider: "Regional provider",
    })).toBe(true);
    expect(channelMatchesMetadataFilters(channel, {
      owner: "Other owner",
      network: "Crow Network",
      feed: MAIN_FEED_OPTION_ID,
      provider: "Regional provider",
    })).toBe(false);
  });

  it("keeps every channel when all metadata filters are clear", () => {
    expect(channelMatchesMetadataFilters({}, {
      owner: "all", network: "all", feed: "all", provider: "all",
    })).toBe(true);
  });

  it("shows source provenance without leaking a path or query value", () => {
    expect(sourceHostname({
      url: "https://www.provider.test/private/live.m3u8?token=hidden",
    })).toBe("provider.test");
    expect(sourceHostname({ url: "not a url" })).toBe("Unknown host");
  });
});
