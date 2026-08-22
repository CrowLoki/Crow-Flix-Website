import { describe, expect, it } from "vitest";
import {
  availabilityLabel,
  channelAvailability,
  channelReliabilityScore,
  rankChannelsByAvailability,
  summarizeAvailability,
  VERIFIED_AVAILABILITY_TTL_MS,
} from "./availability";
import { sourceIdentifier, type StreamSource } from "./types";

const source = (url: string, label: string | null = null): StreamSource => ({
  id: `source-${url}`,
  url,
  label,
});

describe("channel availability", () => {
  it("treats only recent playback success as verified", () => {
    const item = source("https://example.test/live.m3u8");
    const now = 1_800_000_000_000;
    expect(channelAvailability({ sources: [item] }, {
      [sourceIdentifier(item)]: {
        failures: 0,
        cooldownUntil: 0,
        lastSuccessAt: now - VERIFIED_AVAILABILITY_TTL_MS + 1,
      },
    }, now)).toBe("verified");
    expect(channelAvailability({ sources: [item] }, {
      [sourceIdentifier(item)]: {
        failures: 0,
        cooldownUntil: 0,
        lastSuccessAt: now - VERIFIED_AVAILABILITY_TTL_MS - 1,
      },
    }, now)).toBe("unverified");
  });

  it("recognises route-specific direct and relay health IDs", () => {
    const item = source("https://example.test/live.m3u8");
    const now = 100_000;
    expect(channelAvailability({ sources: [item] }, {
      [`${sourceIdentifier(item)}:relay`]: {
        failures: 0,
        cooldownUntil: 0,
        lastSuccessAt: now - 1,
      },
    }, now)).toBe("verified");
  });

  it("separates region, part-time, offline, and unverified channels", () => {
    const geo = source("https://example.test/geo.m3u8", "Geo-blocked");
    const partTime = source("https://example.test/part.m3u8", "Not 24/7");
    const offline = source("https://example.test/offline.m3u8");
    const now = 100_000;
    expect(channelAvailability({ sources: [geo] }, {}, now)).toBe("region-limited");
    expect(channelAvailability({ sources: [partTime] }, {}, now)).toBe("part-time");
    expect(channelAvailability({ sources: [offline] }, {
      [`${sourceIdentifier(offline)}:direct`]: { failures: 2, cooldownUntil: now + 1 },
      [`${sourceIdentifier(offline)}:relay`]: { failures: 2, cooldownUntil: now + 1 },
    }, now)).toBe("temporarily-offline");
    expect(channelAvailability({ sources: [source("https://example.test/new.m3u8")] }, {}, now))
      .toBe("unverified");
  });

  it("does not call a channel offline while an alternate route remains untried", () => {
    const item = source("https://example.test/live.m3u8");
    const now = 100_000;
    expect(channelAvailability({ sources: [item] }, {
      [`${sourceIdentifier(item)}:direct`]: { failures: 1, cooldownUntil: now + 1 },
    }, now)).toBe("unverified");
  });

  it("recognises negated geo labels as ordinary sources", () => {
    expect(channelAvailability({
      sources: [source("https://example.test/live.m3u8", "Non geo-blocked")],
    })).toBe("unverified");
  });

  it("ranks recently verified and multi-source channels first", () => {
    const verified = source("https://example.test/verified.m3u8");
    const health = {
      [sourceIdentifier(verified)]: {
        failures: 0,
        cooldownUntil: 0,
        lastSuccessAt: 99_999,
      },
    };
    expect(channelReliabilityScore({ sources: [verified] }, health, 100_000))
      .toBeGreaterThan(channelReliabilityScore({
        sources: [
          source("https://example.test/a.m3u8"),
          source("http://example.test/b.m3u8"),
        ],
      }, {}, 100_000));
  });

  it("sorts verified first and obvious restrictions last", () => {
    const verified = source("https://example.test/verified.m3u8");
    const channels = [
      { name: "Restricted", sources: [source("https://example.test/geo.m3u8", "Geo-blocked")] },
      { name: "Ordinary", sources: [source("https://example.test/ordinary.m3u8")] },
      { name: "Verified", sources: [verified] },
    ];
    expect(rankChannelsByAvailability(channels, {
      [sourceIdentifier(verified)]: {
        failures: 0,
        cooldownUntil: 0,
        lastSuccessAt: 99_999,
      },
    }, 100_000).map((channel) => channel.name))
      .toEqual(["Verified", "Ordinary", "Restricted"]);
  });

  it("summarizes channels and provides honest badge labels", () => {
    const summary = summarizeAvailability([
      { sources: [source("https://example.test/a.m3u8")] },
      { sources: [source("https://example.test/b.m3u8", "Geo-blocked")] },
      { sources: [source("https://example.test/c.m3u8", "Not always on")] },
    ]);
    expect(summary).toMatchObject({ unverified: 1, "region-limited": 1, "part-time": 1 });
    expect(availabilityLabel("unverified")).toBe("CHECK");
    expect(availabilityLabel("region-limited")).toBe("REGION");
  });
});
