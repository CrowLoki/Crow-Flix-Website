import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuideResult } from "../src/epg";
import {
  createGuideCacheKey,
  GUIDE_CACHE_TTL_SECONDS,
  loadCachedGuide,
  MAX_CACHED_GUIDE_BYTES,
  type GuideCache,
  type GuideCacheRequest,
} from "../src/guideCache";
import worker from "../src/index";

const NOW = new Date("2026-10-01T12:30:00.000Z");
const ORIGIN = "https://relay.example";
const GUIDE_URL = "https://guides.example/ca.xml";
const ENV = {
  TURNSTILE_SECRET: "test-secret",
  TURNSTILE_ALLOWED_HOSTNAMES: "crowflix.tv",
  TURNSTILE_EXPECTED_ACTION: "epg_load",
};

function cacheRequest(overrides: Partial<GuideCacheRequest> = {}): GuideCacheRequest {
  return {
    country: "CA",
    timeZone: "America/Toronto",
    channelIds: ["ABC.ca"],
    namesByChannel: new Map([["ABC.ca", ["ABC News", "ABC"]]]),
    aliasesByProviderId: new Map([["provider-news", "ABC.ca"]]),
    ...overrides,
  };
}

function memoryCache(): GuideCache & {
  match: ReturnType<typeof vi.fn<GuideCache["match"]>>;
  put: ReturnType<typeof vi.fn<GuideCache["put"]>>;
} {
  const entries = new Map<string, Response>();
  return {
    match: vi.fn<GuideCache["match"]>(async (key) => entries.get(key.url)?.clone()),
    put: vi.fn<GuideCache["put"]>(async (key, response) => {
      entries.set(key.url, response.clone());
    }),
  };
}

function successfulGuide(): GuideResult {
  return {
    programmes: [{
      channelId: "ABC.ca",
      title: "Actual News",
      description: "Full description",
      category: "News",
      start: "2026-10-01T12:00:00.000Z",
      stop: "2026-10-01T13:00:00.000Z",
    }],
    source: "Actual source",
    matchedChannels: 1,
    updatedAt: NOW.toISOString(),
  };
}

function guideRequest(token = "verified-token", body: Record<string, unknown> = {}): Request {
  return new Request(`${ORIGIN}/epg`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Turnstile-Token": token },
    body: JSON.stringify({
      country: "CA",
      timeZone: "America/Toronto",
      channels: [{ id: "ABC.ca", names: ["ABC News"], aliases: ["provider-news"] }],
      ...body,
    }),
  });
}

function upstreamFixture() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const href = input instanceof Request ? input.url : input.toString();
    if (href.includes("/turnstile/v0/siteverify")) {
      const token = new URLSearchParams(String(init?.body)).get("response");
      return Response.json({
        success: token !== "invalid-token",
        hostname: "crowflix.tv",
        action: "epg_load",
      });
    }
    if (href === "https://iptv-org.github.io/api/guides.json") {
      return Response.json([{ channel: "ABC.ca", sources: [{ url: GUIDE_URL }] }]);
    }
    if (href === GUIDE_URL) {
      return new Response(`<tv><programme start="20261001120000 +0000" stop="20261001130000 +0000" channel="ABC.ca"><title>Actual News</title><desc>Full description</desc><category>News</category></programme></tv>`);
    }
    return new Response("unavailable", { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("protected guide result cache", () => {
  it("verifies each request while a hit skips the guide index and all XMLTV work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const cache = memoryCache();
    const fetcher = upstreamFixture();
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", fetcher);

    const first = await worker.fetch(guideRequest(), ENV);
    const firstResult = await first.json();
    expect(first.status).toBe(200);
    expect(first.headers.get("X-CrowFlix-Guide-Cache")).toBe("MISS");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(cache.put).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    vi.setSystemTime(NOW.getTime() + 60_000);

    const second = await worker.fetch(guideRequest("another-valid-token"), ENV);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-CrowFlix-Guide-Cache")).toBe("HIT");
    expect(second.headers.get("Access-Control-Expose-Headers")).toContain("X-CrowFlix-Guide-Cache");
    expect(second.headers.get("Cache-Control")).toBe("no-store");
    expect(await second.json()).toEqual(firstResult);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/turnstile/v0/siteverify");
    const [key, stored] = cache.put.mock.calls[0]!;
    expect(key.method).toBe("GET");
    const cachedHeaderNames: string[] = [];
    key.headers.forEach((_value, name) => cachedHeaderNames.push(name));
    expect(cachedHeaderNames).toEqual([]);
    expect(key.url).toMatch(/\/_internal\/guide-cache\/v1\/[a-f0-9]{64}$/);
    expect(stored.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect(await stored.clone().text()).not.toMatch(/test-secret|verified-token/);
  });

  it.each(["", "invalid-token"])("cannot read a populated cache with an unverified token '%s'", async (token) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const cache = memoryCache();
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", upstreamFixture());
    expect((await worker.fetch(guideRequest(), ENV)).status).toBe(200);
    const matchesBefore = cache.match.mock.calls.length;

    const denied = await worker.fetch(guideRequest(token), ENV);
    expect(denied.status).toBe(403);
    expect(cache.match).toHaveBeenCalledTimes(matchesBefore);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(denied.headers.get("X-CrowFlix-Guide-Cache")).toBeNull();
  });

  it("partitions real requests by timezone and effective provider aliases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const cache = memoryCache();
    const fetcher = upstreamFixture();
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", fetcher);
    expect((await worker.fetch(guideRequest(), ENV)).status).toBe(200);
    expect((await worker.fetch(guideRequest("next-token", { timeZone: "America/Vancouver" }), ENV)).status).toBe(200);
    expect((await worker.fetch(guideRequest("third-token", {
      channels: [{ id: "ABC.ca", names: ["ABC News"], aliases: ["different-provider"] }],
    }), ENV)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(new Set(cache.put.mock.calls.map(([key]) => key.url)).size).toBe(3);
  });

  it("refreshes after ten minutes without changing the public cache policy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const cache = memoryCache();
    const fetcher = upstreamFixture();
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", fetcher);
    expect((await worker.fetch(guideRequest(), ENV)).status).toBe(200);
    fetcher.mockClear();
    vi.setSystemTime(NOW.getTime() + GUIDE_CACHE_TTL_SECONDS * 1_000);

    const refreshed = await worker.fetch(guideRequest(), ENV);
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("X-CrowFlix-Guide-Cache")).toBe("MISS");
    expect(refreshed.headers.get("Cache-Control")).toBe("no-store");
    expect((await refreshed.json()).updatedAt).toBe(new Date(Date.now()).toISOString());
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(cache.put).toHaveBeenCalledTimes(2);
  });

  it("preserves the first channel's ownership of a conflicting provider alias", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const cache = memoryCache();
    const normalFetcher = upstreamFixture();
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const href = input instanceof Request ? input.url : input.toString();
      if (href === "https://iptv-org.github.io/api/guides.json") {
        return Response.json([
          { channel: "ABC.ca", sources: [{ url: GUIDE_URL }] },
          { channel: "Other.ca", sources: [{ url: GUIDE_URL }] },
        ]);
      }
      if (href === GUIDE_URL) {
        return new Response(`<tv><programme start="20261001120000 +0000" stop="20261001130000 +0000" channel="shared-provider"><title>Provider News</title></programme></tv>`);
      }
      return normalFetcher(input, init);
    }));
    const channels = [
      { id: "ABC.ca", names: ["ABC"], aliases: ["shared-provider"] },
      { id: "Other.ca", names: ["Other"], aliases: ["shared-provider"] },
    ];
    const first = await worker.fetch(guideRequest("first-token", { channels }), ENV);
    const second = await worker.fetch(guideRequest("second-token", { channels: [...channels].reverse() }), ENV);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()).programmes[0].channelId).toBe("ABC.ca");
    expect((await second.json()).programmes[0].channelId).toBe("Other.ca");
    expect(cache.put).toHaveBeenCalledTimes(2);
    expect(cache.put.mock.calls[0]![0].url).not.toBe(cache.put.mock.calls[1]![0].url);
  });
});

describe("guide cache boundaries", () => {
  it("normalizes equivalent countries and IDs but preserves meaningful name/channel/alias order", async () => {
    const input = cacheRequest({ country: "GB", channelIds: [" ABC.ca ", "ABC.ca"] });
    const key = await createGuideCacheKey(input, ORIGIN);
    expect((await createGuideCacheKey(cacheRequest({ country: "UK" }), ORIGIN)).url).toBe(key.url);
    expect((await createGuideCacheKey(cacheRequest({ country: "UK", namesByChannel: new Map([["ABC.ca", ["ABC", "ABC News"]]]) }), ORIGIN)).url).not.toBe(key.url);
    expect((await createGuideCacheKey(cacheRequest({ country: "UK", aliasesByProviderId: new Map([["provider-news", "Other.ca"]]) }), ORIGIN)).url).not.toBe(key.url);
    expect((await createGuideCacheKey(input, "https://staging.example")).url).not.toBe(key.url);
    expect((await createGuideCacheKey(cacheRequest({ channelIds: ["ABC.ca", "Other.ca"] }), ORIGIN)).url)
      .not.toBe((await createGuideCacheKey(cacheRequest({ channelIds: ["Other.ca", "ABC.ca"] }), ORIGIN)).url);
  });

  it("preserves complete result metadata and the original fetch timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const cache = memoryCache();
    const fullResult = { ...successfulGuide(), extraSourceMetadata: { region: "Toronto" } };
    const load = vi.fn().mockResolvedValue(fullResult);
    await loadCachedGuide(cacheRequest(), ORIGIN, load, cache);
    vi.setSystemTime(NOW.getTime() + 60_000);
    expect(await loadCachedGuide(cacheRequest(), ORIGIN, load, cache)).toEqual(fullResult);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each(["read", "write", "unavailable"])("keeps guide loading working when cache %s fails", async (mode) => {
    const cache = memoryCache();
    if (mode === "read") cache.match.mockRejectedValue(new Error("cache unavailable"));
    if (mode === "write") cache.put.mockRejectedValue(new Error("cache full"));
    if (mode === "unavailable") vi.stubGlobal("caches", undefined);
    const load = vi.fn().mockResolvedValue(successfulGuide());
    expect(await loadCachedGuide(cacheRequest(), ORIGIN, load, mode === "unavailable" ? undefined : cache))
      .toEqual(successfulGuide());
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache empty guides or failed loads", async () => {
    const cache = memoryCache();
    const empty = { ...successfulGuide(), programmes: [], matchedChannels: 0 };
    expect(await loadCachedGuide(cacheRequest(), ORIGIN, async () => empty, cache)).toEqual(empty);
    await expect(loadCachedGuide(cacheRequest(), ORIGIN, async () => { throw new Error("upstream failed"); }, cache))
      .rejects.toThrow("upstream failed");
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("ignores an empty cached payload and restores a real successful guide", async () => {
    const cache = memoryCache();
    cache.match.mockResolvedValue(Response.json({ ...successfulGuide(), programmes: [], matchedChannels: 0 }, {
      headers: { "X-CrowFlix-Guide-Expires": String(Date.now() + 60_000) },
    }));
    const load = vi.fn().mockResolvedValue(successfulGuide());
    expect(await loadCachedGuide(cacheRequest(), ORIGIN, load, cache)).toEqual(successfulGuide());
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("bounds cache storage without rejecting a larger successful guide", async () => {
    const cache = memoryCache();
    const large = successfulGuide();
    large.programmes[0]!.description = "x".repeat(MAX_CACHED_GUIDE_BYTES);
    expect(await loadCachedGuide(cacheRequest(), ORIGIN, async () => large, cache)).toBe(large);
    expect(cache.put).not.toHaveBeenCalled();
  });
});
