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

  it("marks a channel READY after a bounded route preflight", () => {
    const item = source("https://example.test/live.m3u8");
    const now = 100_000;
    expect(channelAvailability({ sources: [item] }, {}, now, {
      [`${sourceIdentifier(item)}:direct`]: {
        status: "ready",
        checkedAt: now - 1,
        transport: "hls",
      },
    })).toBe("ready");
    expect(availabilityLabel("ready")).toBe("READY");
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

  it("marks a channel offline only after every browser route fails a fresh preflight", () => {
    const item = source("https://example.test/live.m3u8");
    const now = 100_000;
    expect(channelAvailability({ sources: [item] }, {}, now, {
      [`${sourceIdentifier(item)}:direct`]: {
        status: "offline",
        checkedAt: now - 1,
        transport: "hls",
      },
      [`${sourceIdentifier(item)}:relay`]: {
        status: "offline",
        checkedAt: now - 1,
        transport: "hls",
      },
    })).toBe("temporarily-offline");
  });

  it("hides sources that a fresh whole-catalogue scan found dead without treating blocked sources as dead", () => {
    const now = 100_000;
    const failed = {
      ...source("https://example.test/failed.m3u8"),
      catalogHealth: { status: "offline" as const, score: 0, checkedAt: now - 1 },
    };
    const blocked = {
      ...source("https://example.test/blocked.m3u8"),
      catalogHealth: { status: "blocked" as const, score: 70, checkedAt: now - 1 },
    };
    expect(channelAvailability({ sources: [failed] }, {}, now))
      .toBe("temporarily-offline");
    expect(channelAvailability({ sources: [blocked] }, {}, now))
      .toBe("unverified");
  });

  it("ranks fresh upstream-online evidence above an otherwise equal unverified channel", () => {
    const now = 100_000;
    const online = {
      ...source("https://example.test/online.m3u8"),
      catalogHealth: { status: "online" as const, score: 95, checkedAt: now - 1 },
    };
    expect(channelReliabilityScore({ sources: [online] }, {}, now))
      .toBeGreaterThan(channelReliabilityScore({
        sources: [source("https://example.test/unknown.m3u8")],
      }, {}, now));
  });

  it("does not boost literal-IP health results above an equally unknown browser route", () => {
    const now = 100_000;
    const onlineIp = {
      ...source("http://45.162.64.114/online.m3u8"),
      catalogHealth: { status: "online" as const, score: 100, checkedAt: now - 1 },
    };
    expect(channelReliabilityScore({ sources: [onlineIp] }, {}, now)).toBe(
      channelReliabilityScore({
        sources: [source("http://45.162.64.115/unknown.m3u8")],
      }, {}, now),
    );
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
    expect(summary).toMatchObject({ ready: 0, unverified: 1, "region-limited": 1, "part-time": 1 });
    expect(availabilityLabel("unverified")).toBe("CHECK");
    expect(availabilityLabel("region-limited")).toBe("REGION");
  });
});
