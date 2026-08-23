import { describe, expect, it, vi } from "vitest";
import {
  ANI_ONE_CURRENT_URL,
  ANI_ONE_DEAD_URL,
  OPTIONAL_FAST_PLAYLISTS,
  applyStreamHealthHints,
  amagiFallbackTitleMatches,
  amagiProviderChannelIdentity,
  buildCatalogFromApi,
  loadOptionalFastFallbacks,
  normalizeAndGroupChannels,
  overlayAmagiFastFallbacks,
  parseOptionalFastPlaylist,
  qualityHeight,
  repairKnownDeadAmagiSources,
  type ApiPayload,
  type WebChannel,
} from "./webCatalog";
import { streamHealthIdentity } from "./streamHealthIndex";

function payload(overrides: Partial<ApiPayload> = {}): ApiPayload {
  return {
    channels: [],
    feeds: [],
    logos: [],
    streams: [],
    categories: [],
    languages: [],
    countries: [],
    regions: [],
    blocklist: [],
    ...overrides,
  };
}

describe("qualityHeight", () => {
  it("parses common quality labels", () => {
    expect(qualityHeight("1080p")).toBe(1080);
    expect(qualityHeight("4K")).toBe(2160);
    expect(qualityHeight("FHD")).toBe(1080);
    expect(qualityHeight("HD")).toBe(720);
    expect(qualityHeight("SD")).toBe(480);
    expect(qualityHeight(null)).toBe(0);
    expect(qualityHeight("nonsense")).toBe(0);
  });
});

describe("buildCatalogFromApi", () => {
  it("joins streams onto channels with feed metadata and logos", () => {
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "News.us", name: "Crow News", country: "US", categories: ["news"], network: "CrowNet", website: "https://example.com" }],
      feeds: [{ channel: "News.us", id: "main", name: "Crow News", is_main: true, broadcast_area: ["c/US"], languages: ["eng"], format: "1080p" }],
      logos: [{ channel: "News.us", feed: null, in_use: true, url: "https://example.com/logo.png" }],
      streams: [{ channel: "News.us", feed: null, title: "Crow News", url: "https://cdn.example.com/news.m3u8", quality: "1080p" }],
      categories: [{ id: "news", name: "News", description: "News channels" }],
      languages: [{ code: "eng", name: "English" }],
      countries: [{ name: "United States", code: "US", languages: ["eng"], flag: "🇺🇸" }],
      regions: [{ code: "AMER", name: "Americas", countries: ["US"] }],
    }));
    expect(catalog.channels).toHaveLength(1);
    const channel = catalog.channels[0];
    expect(channel.key).toBe("News.us@main");
    expect(channel.name).toBe("Crow News");
    expect(channel.logo).toBe("https://example.com/logo.png");
    expect(channel.languages).toEqual(["English"]);
    expect(channel.broadcastArea).toEqual(["c/US"]);
    expect(channel.sources[0].transport).toBe("hls");
    expect(channel.sources[0].isHttps).toBe(true);
    expect(catalog.categories[0]).toMatchObject({ id: "news", count: 1 });
    expect(catalog.countries[0]).toMatchObject({ code: "US", count: 1 });
    expect(catalog.regions[0]).toMatchObject({ code: "AMER", count: 1 });
    expect(catalog.languages[0]).toMatchObject({ name: "English", count: 1 });
  });

  it("excludes blocklisted and closed channels but keeps unknown channel ids", () => {
    const today = new Date("2026-08-16T00:00:00Z");
    const catalog = buildCatalogFromApi(payload({
      channels: [
        { id: "Blocked.us", name: "Blocked", country: "US" },
        { id: "Gone.us", name: "Gone", country: "US", closed: "2026-01-01" },
      ],
      blocklist: [{ channel: "Blocked.us" }],
      streams: [
        { channel: "Blocked.us", title: "Blocked", url: "https://x.example.com/a.m3u8" },
        { channel: "Gone.us", title: "Gone", url: "https://x.example.com/b.m3u8" },
        { channel: "Fresh.us", title: "Fresh", url: "https://x.example.com/c.m3u8" },
      ],
    }), today);
    expect(catalog.channels.map((channel) => channel.id)).toEqual(["Fresh.us"]);
    expect(catalog.channels[0].country).toBe("US");
  });

  it("keeps uncatalogued streams with a deterministic hashed identity", () => {
    const first = buildCatalogFromApi(payload({
      streams: [{ channel: null, title: "  Mystery   Feed ", url: "https://x.example.com/m.m3u8" }],
    }));
    const second = buildCatalogFromApi(payload({
      streams: [{ channel: null, title: "Mystery Feed", url: "https://x.example.com/m.m3u8" }],
    }));
    expect(first.channels).toHaveLength(1);
    expect(first.channels[0].name).toBe("Mystery Feed");
    expect(first.channels[0].id).toMatch(/^uncatalogued-[0-9a-f]{16}$/);
    expect(first.channels[0].id).toBe(second.channels[0].id);
    expect(first.channels[0].categories).toEqual(["undefined"]);
  });

  it("rejects streams with non-HTTP or credential-bearing URLs", () => {
    const catalog = buildCatalogFromApi(payload({
      streams: [
        { channel: null, title: "Bad", url: "rtmp://x.example.com/live" },
        { channel: null, title: "Creds", url: "https://user:pass@x.example.com/c.m3u8" },
        { channel: null, title: "Good", url: "https://x.example.com/good.m3u8" },
      ],
    }));
    expect(catalog.channels.map((channel) => channel.name)).toEqual(["Good"]);
  });

  it("merges duplicate channel keys and ranks the best source first", () => {
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "News.us", name: "Crow News", country: "US" }],
      streams: [
        { channel: "News.us", title: "Crow News SD", url: "http://cdn.example.com/sd.m3u8", quality: "480p" },
        { channel: "News.us", title: "Crow News HD", url: "https://cdn.example.com/hd.m3u8", quality: "1080p" },
      ],
    }));
    expect(catalog.channels).toHaveLength(1);
    const channel = catalog.channels[0];
    expect(channel.sources).toHaveLength(2);
    expect(channel.url).toBe("https://cdn.example.com/hd.m3u8");
    expect(channel.quality).toBe("1080p");
  });

  it("uses fresh exact-identity health hints to put a working source first", () => {
    const now = Date.parse("2026-08-23T01:00:00.000Z");
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "News.us", name: "Crow News", country: "US" }],
      streams: [
        { channel: "News.us", title: "Dead HD", url: "https://cdn.example.com/dead.m3u8", quality: "1080p" },
        { channel: "News.us", title: "Working SD", url: "https://cdn.example.com/working.m3u8", quality: "480p" },
      ],
    }));
    const matched = applyStreamHealthHints(catalog.channels, new Map([
      [streamHealthIdentity("https://cdn.example.com/dead.m3u8"), {
        status: "offline" as const,
        score: 0,
        checkedAt: now - 1,
      }],
      [streamHealthIdentity("https://cdn.example.com/working.m3u8"), {
        status: "online" as const,
        score: 96,
        checkedAt: now - 1,
      }],
    ]), now);

    expect(matched).toBe(2);
    expect(catalog.channels[0].sources.map((source) => source.url)).toEqual([
      "https://cdn.example.com/working.m3u8",
      "https://cdn.example.com/dead.m3u8",
    ]);
    expect(catalog.channels[0].url).toBe("https://cdn.example.com/working.m3u8");
  });

  it("prefers an online HTTPS source over a higher-scored literal-IP HTTP feed", () => {
    const now = Date.parse("2026-08-23T01:00:00.000Z");
    const ip = "http://45.162.64.114/live.m3u8";
    const https = "https://provider.test/live.m3u8";
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "News.us", name: "Crow News", country: "US" }],
      streams: [
        { channel: "News.us", title: "IP feed", url: ip },
        { channel: "News.us", title: "HTTPS feed", url: https },
      ],
    }));
    applyStreamHealthHints(catalog.channels, new Map([
      [streamHealthIdentity(ip), { status: "online", score: 100, checkedAt: now - 1 }],
      [streamHealthIdentity(https), { status: "online", score: 85, checkedAt: now - 1 }],
    ]), now);

    expect(catalog.channels[0].url).toBe(https);
  });

  it("deprioritises geo-blocked sources in ordering", () => {
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "News.us", name: "Crow News", country: "US" }],
      streams: [
        { channel: "News.us", title: "Geo", url: "https://cdn.example.com/geo.m3u8", quality: "1080p", label: "Geo-blocked" },
        { channel: "News.us", title: "Open", url: "https://cdn.example.com/open.m3u8", quality: "720p" },
      ],
    }));
    expect(catalog.channels[0].url).toBe("https://cdn.example.com/open.m3u8");
  });

  it("counts region coverage from broadcast-area region codes", () => {
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "World.int", name: "World", country: "US" }],
      feeds: [{ channel: "World.int", id: "main", name: "World", is_main: true, broadcast_area: ["r/EUR"] }],
      streams: [{ channel: "World.int", title: "World", url: "https://x.example.com/w.m3u8" }],
      countries: [
        { name: "France", code: "FR", flag: "🇫🇷" },
        { name: "Germany", code: "DE", flag: "🇩🇪" },
      ],
      regions: [{ code: "EUR", name: "Europe", countries: ["FR", "DE"] }],
    }));
    expect(catalog.regions[0]).toMatchObject({ code: "EUR", count: 1 });
    expect(catalog.countries.map((country) => country.code).sort()).toEqual(["DE", "FR"]);
  });
});

describe("normalizeAndGroupChannels", () => {
  it("drops channels that end up without a playable source", () => {
    const channels: WebChannel[] = [{
      key: "x@main", id: "x", name: "Broken", categories: [], languages: [], broadcastArea: [],
      sources: [], url: "notaurl", isMain: true,
    }];
    expect(normalizeAndGroupChannels(channels)).toEqual([]);
  });

  it("splits embedded feed ids and sorts by name", () => {
    const channels: WebChannel[] = [
      {
        key: "b", id: "Zed.us@HD", feed: null, name: "Zed", categories: [], languages: [], broadcastArea: [],
        sources: [{ url: "https://x.example.com/z.m3u8" }], isMain: false,
      },
      {
        key: "a", id: "Alpha.us", feed: null, name: "Alpha", categories: [], languages: [], broadcastArea: [],
        sources: [{ url: "https://x.example.com/a.m3u8" }], isMain: true,
      },
    ];
    const grouped = normalizeAndGroupChannels(channels);
    expect(grouped.map((channel) => channel.name)).toEqual(["Alpha", "Zed"]);
    expect(grouped[1].key).toBe("Zed.us@HD");
  });
});

describe("Apsattv Amagi fallbacks", () => {
  const regionalUrl = "https://amg11111-amg11111c22-amgplt0001.playout.now3.amagi.tv/playlist/amg11111-amg11111c22-amgplt0001/playlist.m3u8";
  const currentUrl = "https://amg11111-amg11111c22-amgplt0099.playout.now3.amagi.tv/playlist/amg11111-amg11111c22-amgplt0099/playlist.m3u8";

  it("extracts only complete matching Amagi provider/channel identities", () => {
    expect(amagiProviderChannelIdentity(ANI_ONE_DEAD_URL)).toBe("amg19223c9");
    expect(amagiProviderChannelIdentity(
      "https://AMG12345C67.playout.now3.amagi.tv/AMG12345C67/playlist.m3u8?tenant=amg12345",
    )).toBe("amg12345c67");
    for (const invalid of [
      "https://playout.now3.amagi.tv/amg12345/playlist.m3u8",
      "https://playout.now3.amagi.tv/amg12345c/playlist.m3u8",
      "https://playout.now3.amagi.tv/xamg12345c67/playlist.m3u8",
      "https://playout.now3.amagi.tv/amg12345c67extra/playlist.m3u8",
      "https://amg12345c67.playout.now3.amagi.tv/amg12345c68/playlist.m3u8",
      "https://example.test/amg12345c67/playlist.m3u8",
    ]) {
      expect(amagiProviderChannelIdentity(invalid)).toBeNull();
    }
  });

  it("requires conservative semantic title equivalence", () => {
    expect(amagiFallbackTitleMatches("Ani-One — SD", "Ani-Blast", "4065 Ani Blast")).toBe(true);
    expect(amagiFallbackTitleMatches("Crow News", null, "4100 Crow-News")).toBe(true);
    expect(amagiFallbackTitleMatches("Come Dine with Me", "Come Dine with Me", "Hell's Kitchen")).toBe(false);
    expect(amagiFallbackTitleMatches("Antiques Road Trip", "Antiques Road Trip", "PBS History")).toBe(false);
    expect(amagiFallbackTitleMatches("Racer", "Racer", "MavTV")).toBe(false);
    expect(amagiFallbackTitleMatches("Untitled", "Untitled", null)).toBe(false);
  });

  it("replaces the dead Ani-One deployment in both catalogue and playlist input", () => {
    const channels = normalizeAndGroupChannels([{
      key: "AniOne.hk@SD",
      id: "AniOne.hk",
      feed: "SD",
      name: "Ani-One — SD",
      categories: ["animation"],
      country: "HK",
      languages: ["Chinese"],
      broadcastArea: ["c/HK"],
      sources: [{
        title: "Ani-Blast",
        url: `${ANI_ONE_DEAD_URL}?stale=true`,
        quality: "720p",
      }],
      isMain: false,
    }]);

    expect(repairKnownDeadAmagiSources(channels)).toBe(1);
    expect(channels[0].sources).toHaveLength(1);
    expect(channels[0].sources[0]).toMatchObject({
      url: ANI_ONE_CURRENT_URL,
      title: "Ani-Blast",
      quality: "720p",
    });
    expect(channels[0].url).toBe(ANI_ONE_CURRENT_URL);
    expect(channels[0].sources.some((source) => source.url.startsWith(ANI_ONE_DEAD_URL))).toBe(false);

    const parsed = parseOptionalFastPlaylist(
      `#EXTM3U\n#EXTINF:-1,4065 Ani Blast\n${ANI_ONE_DEAD_URL}\n`,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe(ANI_ONE_CURRENT_URL);
  });

  it("preserves regional metadata, rejects title collisions, and deduplicates", () => {
    const [channel] = normalizeAndGroupChannels([{
      key: "Regional.au@AU",
      id: "Regional.au",
      feed: "AU",
      name: "Regional",
      logo: "https://regional.example/logo.png",
      categories: ["entertainment"],
      country: "AU",
      languages: ["English"],
      broadcastArea: ["c/AU"],
      sources: [{
        title: "Regional",
        url: regionalUrl,
        referrer: "https://regional.example/watch",
        userAgent: "Regional Agent/1.0",
        quality: "720p",
        label: "Geo-blocked",
      }],
      network: "Regional Network",
      isMain: false,
    }]);
    const fallbacks = parseOptionalFastPlaylist([
      "#EXTM3U",
      "#EXTINF:-1,4099 Regional",
      currentUrl,
      "#EXTINF:-1,4099 Regional",
      currentUrl,
      "#EXTINF:-1,Hell's Kitchen",
      currentUrl.replace(/0099/g, "0100"),
    ].join("\n"));

    expect(overlayAmagiFastFallbacks([channel], fallbacks)).toBe(1);
    expect(channel.sources).toHaveLength(2);
    expect(channel.sources.some((source) => source.url === regionalUrl)).toBe(true);
    expect(channel).toMatchObject({
      country: "AU",
      languages: ["English"],
      broadcastArea: ["c/AU"],
      network: "Regional Network",
    });
    expect(channel.sources.find((source) => source.url === currentUrl)).toMatchObject({
      title: "Regional",
      referrer: "https://regional.example/watch",
      userAgent: "Regional Agent/1.0",
      quality: "720p",
      label: "Geo-blocked",
    });
    expect(overlayAmagiFastFallbacks([channel], fallbacks)).toBe(0);
    expect(channel.sources).toHaveLength(2);
  });

  it("uses all five fixed relay fetches while treating failures and oversized results as optional", async () => {
    const playlist = `#EXTM3U\n#EXTINF:-1,4099 Regional\n${currentUrl}\n`;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input));
      const source = requestUrl.searchParams.get("url");
      expect(requestUrl.pathname).toBe("/fetch");
      expect(init?.cache).toBe("no-store");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (source?.endsWith("ssungnz.m3u")) throw new Error("optional network failure");
      if (source?.endsWith("ssungph.m3u")) return new Response("unavailable", { status: 503 });
      if (source?.endsWith("ssungsg.m3u")) {
        return new Response("#EXTM3U", {
          headers: { "content-length": String(2 * 1024 * 1024 + 1) },
        });
      }
      return new Response(playlist, { status: 200 });
    });

    const sources = await loadOptionalFastFallbacks(fetcher);

    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("url")).sort())
      .toEqual([...OPTIONAL_FAST_PLAYLISTS].sort());
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe(currentUrl);
  });

  it("aborts slow optional playlist requests after twelve seconds", async () => {
    vi.useFakeTimers();
    try {
      let aborted = 0;
      const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted += 1;
            reject(new Error("aborted"));
          }, { once: true });
        }));
      const pending = loadOptionalFastFallbacks(fetcher);

      await vi.advanceTimersByTimeAsync(12_000);

      await expect(pending).resolves.toEqual([]);
      expect(aborted).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps required catalogue construction successful when no optional fallbacks load", () => {
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "News.us", name: "Crow News", country: "US" }],
      streams: [{ channel: "News.us", title: "Crow News", url: "https://cdn.example.com/news.m3u8" }],
    }), new Date("2026-08-23T00:00:00Z"), []);

    expect(catalog.channels).toHaveLength(1);
    expect(catalog.source).toBe("IPTV-org API");
  });

  it("applies matched fallback sources during catalogue construction", () => {
    const fallbackSources = parseOptionalFastPlaylist(
      `#EXTM3U\n#EXTINF:-1,4099 Regional\n${currentUrl}\n`,
    );
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "Regional.au", name: "Regional", country: "AU" }],
      streams: [{ channel: "Regional.au", title: "Regional", url: regionalUrl }],
    }), new Date("2026-08-23T00:00:00Z"), fallbackSources);

    expect(catalog.channels).toHaveLength(1);
    expect(catalog.channels[0].sources.map((source) => source.url)).toEqual(
      expect.arrayContaining([regionalUrl, currentUrl]),
    );
    expect(catalog.source).toBe("IPTV-org API + current FAST fallbacks");
  });
});
