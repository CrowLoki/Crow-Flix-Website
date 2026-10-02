import { describe, expect, it } from "vitest";
import {
  availabilityLabel,
  channelAvailability,
  channelReliabilityScore,
  rankChannelsByAvailability,
  summarizeAvailability,
  VERIFIED_AVAILABILITY_TTL_MS,
} from "./availability";
import { sourceIdentifier, type SourceHealth, type StreamSource } from "./types";
import { type SourcePreflight } from "./preflight";

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

  it.each([false, true])("invalidates both failed routes even after cooldown expires (%s)", (expired) => {
    const item = source("https://example.test/live.m3u8");
    const now = 100_000;
    const failed = { failures: 1, cooldownUntil: now + (expired ? -1 : 1), lastSuccessAt: now - 10 };
    expect(channelAvailability({ sources: [item] }, {
      [`${sourceIdentifier(item)}:direct`]: failed,
      [`${sourceIdentifier(item)}:relay`]: failed,
    }, now)).toBe(expired ? "unverified" : "temporarily-offline");
  });

  it.each(["direct", "relay"])("keeps a currently successful %s route verified independently", (workingRoute) => {
    const item = source("https://example.test/live.m3u8");
    const now = 100_000;
    const failedRoute = workingRoute === "direct" ? "relay" : "direct";
    expect(channelAvailability({ sources: [item] }, {
      [`${sourceIdentifier(item)}:${failedRoute}`]: {
        failures: 1, cooldownUntil: now + 1, lastSuccessAt: now - 10,
      },
      [`${sourceIdentifier(item)}:${workingRoute}`]: {
        failures: 0, cooldownUntil: 0, lastSuccessAt: now - 20,
      },
    }, now)).toBe("verified");
  });

  it("restores verification when playback resets the failed route after recovery", () => {
    const item = source("https://example.test/live.m3u8");
    const now = 100_000;
    const key = `${sourceIdentifier(item)}:relay`;
    const health: Record<string, SourceHealth> = {
      [key]: { failures: 1, cooldownUntil: now + 1, lastSuccessAt: now - 20 },
    };
    expect(channelAvailability({ sources: [item] }, health, now)).toBe("unverified");
    health[key] = { failures: 0, cooldownUntil: 0, lastSuccessAt: now };
    expect(channelAvailability({ sources: [item] }, health, now)).toBe("verified");
  });

  it.each([
    { failures: 1, cooldownUntil: 0, lastSuccessAt: 99_999 },
    { failures: 0, cooldownUntil: 99_999, lastSuccessAt: 99_998 },
    { failures: 0, cooldownUntil: 0, lastSuccessAt: 100_001 },
    { failures: 0, cooldownUntil: 0, lastSuccessAt: Number.POSITIVE_INFINITY },
    { failures: 0, cooldownUntil: 0, lastSuccessAt: Number.NaN },
    { failures: 0, cooldownUntil: 0 },
  ])("does not verify failed or ambiguous legacy health: %j", (state) => {
    const item = source("https://example.test/live.m3u8");
    expect(channelAvailability({ sources: [item] }, {
      [sourceIdentifier(item)]: state,
    }, 100_000)).toBe("unverified");
  });

  it("does not let an unsuffixed legacy success override route-specific failures", () => {
    const item = source("https://example.test/live.m3u8");
    const now = 100_000;
    const key = sourceIdentifier(item);
    const health: Record<string, SourceHealth> = {
      [key]: { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 10 },
      [`${key}:direct`]: { failures: 1, cooldownUntil: now + 1 },
    };
    expect(channelAvailability({ sources: [item] }, health, now)).toBe("unverified");
    health[`${key}:relay`] = { failures: 1, cooldownUntil: now + 1 };
    expect(channelAvailability({ sources: [item] }, health, now)).toBe("temporarily-offline");
  });

  it.each([
    { url: "https://example.test/live.m3u8", referrer: "https://example.test", rejected: "direct", accepted: "relay" },
    { url: "https://example.test/live.m3u8", userAgent: "Provider Player", rejected: "direct", accepted: "relay" },
    { url: "https://example.test/live.m3u8", requiresHeaders: true, rejected: "direct", accepted: "relay" },
    { url: "http://example.test/live.m3u8", rejected: "direct", accepted: "https-upgrade" },
  ])("uses only eligible browser routes for $url ($accepted)", ({ rejected, accepted, ...item }) => {
    const now = 100_000;
    const key = sourceIdentifier(item);
    const success = { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 1 };
    expect(channelAvailability({ sources: [item] }, { [`${key}:${rejected}`]: success }, now))
      .toBe("unverified");
    expect(channelAvailability({ sources: [item] }, { [`${key}:${accepted}`]: success }, now))
      .toBe("verified");
  });

  it("keeps already-routed and header-specific source identities independent", () => {
    const now = 100_000;
    const success = { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 1 };
    const routed: StreamSource = {
      url: "https://example.test/live.m3u8", sourceId: "chosen-route", delivery: "direct",
    };
    expect(channelAvailability({ sources: [routed] }, { "chosen-route:relay": success }, now))
      .toBe("unverified");
    expect(channelAvailability({ sources: [routed] }, { "chosen-route": success }, now))
      .toBe("verified");
    const item = { url: routed.url, referrer: "https://provider.test/one" };
    const otherHeaders = { ...item, referrer: "https://provider.test/two" };
    expect(channelAvailability({ sources: [item] }, {
      [`${sourceIdentifier(otherHeaders)}:relay`]: success,
    }, now)).toBe("unverified");
  });

  it("lets newer offline preflight evidence supersede success only for that route", () => {
    const item = source("https://example.test/live.m3u8");
    const now = 100_000;
    const key = sourceIdentifier(item);
    const success = { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 20 };
    const health: Record<string, SourceHealth> = { [`${key}:direct`]: success, [`${key}:relay`]: success };
    const preflights: Record<string, SourcePreflight> = {
      [`${key}:direct`]: { status: "offline", checkedAt: now - 10, transport: "hls" },
    };
    expect(channelAvailability({ sources: [item] }, health, now, preflights)).toBe("verified");
    preflights[`${key}:relay`] = { status: "offline", checkedAt: now - 10, transport: "hls" };
    expect(channelAvailability({ sources: [item] }, health, now, preflights)).toBe("temporarily-offline");
    health[`${key}:relay`] = { ...success, lastSuccessAt: now - 1 };
    expect(channelAvailability({ sources: [item] }, health, now, preflights)).toBe("verified");
  });

  it("does not revive old playback success when newer offline preflight evidence expires", () => {
    const item = source("https://example.test/live.m3u8");
    const now = 2_000_000;
    expect(channelAvailability({ sources: [item] }, {
      [`${sourceIdentifier(item)}:direct`]: { failures: 0, cooldownUntil: 0, lastSuccessAt: 1 },
    }, now, {
      [`${sourceIdentifier(item)}:direct`]: { status: "offline", checkedAt: 2, transport: "hls" },
    })).toBe("unverified");
  });

  it("does not use ambiguous legacy success when an eligible route later fails preflight", () => {
    const item = source("https://example.test/live.m3u8");
    const now = 100_000;
    expect(channelAvailability({ sources: [item] }, {
      [sourceIdentifier(item)]: { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 10 },
    }, now, {
      [`${sourceIdentifier(item)}:direct`]: { status: "offline", checkedAt: now - 1, transport: "hls" },
    })).toBe("unverified");
  });

  it.each([
    ["Not 24/7", "part-time"],
    ["Geo-blocked", "region-limited"],
  ])("preserves the %s distinction after old success is invalidated", (label, availability) => {
    const item = source("https://example.test/live.m3u8", label);
    const now = 100_000;
    const failed = { failures: 1, cooldownUntil: now + 1, lastSuccessAt: now - 10 };
    expect(channelAvailability({ sources: [item] }, {
      [`${sourceIdentifier(item)}:direct`]: failed,
      [`${sourceIdentifier(item)}:relay`]: failed,
    }, now)).toBe(availability);
  });

  it("keeps preflight and upstream-online hints below verified after playback failure", () => {
    const now = 100_000;
    const item: StreamSource = {
      ...source("https://example.test/live.m3u8"),
      catalogHealth: { status: "online", checkedAt: now - 1, score: 100 },
    };
    const key = sourceIdentifier(item);
    const failed = { failures: 1, cooldownUntil: now + 1, lastSuccessAt: now - 20 };
    const health = { [`${key}:direct`]: failed, [`${key}:relay`]: failed };
    expect(channelAvailability({ sources: [item] }, health, now)).toBe("temporarily-offline");
    expect(channelAvailability({ sources: [item] }, health, now, {
      [`${key}:relay`]: { status: "ready", checkedAt: now, transport: "hls" },
    })).toBe("ready");
  });

  it("requires a working route on some source in a mixed-source channel", () => {
    const failed = source("https://example.test/failed.m3u8");
    const alternate = source("https://example.test/alternate.m3u8");
    const now = 100_000;
    const failedState = { failures: 1, cooldownUntil: now + 1, lastSuccessAt: now - 1 };
    const health: Record<string, SourceHealth> = {
      [`${sourceIdentifier(failed)}:direct`]: failedState,
      [`${sourceIdentifier(failed)}:relay`]: failedState,
    };
    expect(channelAvailability({ sources: [failed, alternate] }, health, now)).toBe("unverified");
    health[`${sourceIdentifier(alternate)}:relay`] = { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 1 };
    expect(channelAvailability({ sources: [failed, alternate] }, health, now)).toBe("verified");
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

  it("labels channels whose only sources require an external streaming protocol", () => {
    const external = source("rtmp://provider.test/live/channel");
    expect(channelAvailability({ sources: [external] })).toBe("unsupported");
    expect(availabilityLabel("unsupported")).toBe("EXTERNAL");
    expect(channelAvailability({
      sources: [external, source("https://provider.test/live.m3u8")],
    })).toBe("unverified");
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

  it("ranks sources that a fresh whole-catalogue scan found dead without treating blocked sources as dead", () => {
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
    expect(summary).toMatchObject({ ready: 0, unverified: 1, "region-limited": 1, "part-time": 1, unsupported: 0 });
    expect(availabilityLabel("unverified")).toBe("CHECK");
    expect(availabilityLabel("region-limited")).toBe("REGION");
  });
});
