import { describe, expect, it, vi } from "vitest";
import {
  browserPreflightRoutes,
  firstDashResourceUrl,
  hlsManifestReferences,
  isFreshPreflight,
  orderSourcesByPreflight,
  preflightSource,
  readSourcePreflights,
  recordSourcePreflight,
  runPreflightQueue,
  SOURCE_PREFLIGHT_STORAGE_KEY,
  SOURCE_PREFLIGHT_TTL_MS,
} from "./preflight";
import { sourceIdentifier, type StreamSource } from "./types";

const source = (url = "https://provider.test/live.m3u8"): StreamSource => ({
  id: `source-${url}`,
  url,
  transport: "hls",
});

function response(body: BodyInit, contentType = "application/vnd.apple.mpegurl"): Response {
  return new Response(body, { headers: { "content-type": contentType } });
}

describe("source readiness preflight", () => {
  it("checks an HLS master, media playlist, key, init map and first segment", async () => {
    const requests: Array<{ url: string; range: string | null }> = [];
    const fetcher = vi.fn(async (url: string, _source: StreamSource, init?: RequestInit) => {
      requests.push({ url, range: new Headers(init?.headers).get("Range") });
      if (url.endsWith("live.m3u8")) {
        return response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant/index.m3u8\n");
      }
      if (url.endsWith("variant/index.m3u8")) {
        return response("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nsegment.ts\n");
      }
      return response(new Uint8Array([1, 2, 3]), "application/octet-stream");
    });

    const result = await preflightSource(source(), fetcher, undefined, () => 100_000);

    expect(result).toEqual({ status: "ready", checkedAt: 100_000, transport: "hls" });
    expect(requests.map((item) => item.url)).toEqual([
      "https://provider.test/live.m3u8",
      "https://provider.test/variant/index.m3u8",
      "https://provider.test/variant/key.bin",
      "https://provider.test/variant/init.mp4",
      "https://provider.test/variant/segment.ts",
    ]);
    expect(requests[requests.length - 1]?.range).toBe("bytes=0-1023");
    expect(requests[2]?.range).toBeNull();
  });

  it("returns a safe route-specific HTTP failure", async () => {
    const fetcher = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const result = await preflightSource(source(), fetcher, undefined, () => 100_000);
    expect(result).toEqual({
      status: "offline",
      checkedAt: 100_000,
      transport: "hls",
      httpStatus: 403,
      reason: "http-403",
    });
    expect(JSON.stringify(result)).not.toContain("provider.test");
  });

  it("checks a DASH initialization resource", async () => {
    const dash: StreamSource = {
      id: "dash",
      url: "https://provider.test/live/manifest.mpd",
      transport: "dash",
    };
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      requested.push(url);
      return url.endsWith(".mpd")
        ? response("<MPD><Period><AdaptationSet><Representation id=\"v1\" bandwidth=\"800\"><SegmentTemplate initialization=\"video/$RepresentationID$/init.mp4\" media=\"video/$Number$.m4s\" /></Representation></AdaptationSet></Period></MPD>", "application/dash+xml")
        : response(new Uint8Array([0, 1, 2]), "video/mp4");
    });
    const result = await preflightSource(dash, fetcher, undefined, () => 100_000);
    expect(result.status).toBe("ready");
    expect(requested).toEqual([
      dash.url,
      "https://provider.test/live/video/v1/init.mp4",
    ]);
  });

  it("extracts HLS and DASH references without fetching unlimited media", () => {
    expect(hlsManifestReferences("#EXTM3U\n#EXTINF:4,\nsegment.ts")).toMatchObject({
      isMaster: false,
      firstUri: "segment.ts",
    });
    expect(firstDashResourceUrl(
      "<MPD><BaseURL>video/</BaseURL><Period><AdaptationSet><Representation id=\"main\" bandwidth=\"2\"><SegmentTemplate media=\"$RepresentationID$-$Number%05d$.m4s\" startNumber=\"7\" /></Representation></AdaptationSet></Period></MPD>",
      "https://provider.test/live/manifest.mpd",
    )).toBe("https://provider.test/live/video/main-00007.m4s");
  });
});

describe("source readiness cache", () => {
  it("validates persisted records and ignores malformed data", () => {
    const storage = {
      getItem: () => JSON.stringify({
        good: { status: "ready", checkedAt: 100, transport: "hls" },
        bad: { status: "ready", checkedAt: "yesterday", transport: "hls" },
      }),
    };
    expect(readSourcePreflights(storage)).toEqual({
      good: { status: "ready", checkedAt: 100, transport: "hls" },
    });
  });

  it("writes route IDs, honours freshness, and ranks READY before unknown before offline", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const ready = source("https://provider.test/ready.m3u8");
    const unknown = source("https://provider.test/unknown.m3u8");
    const offline = source("https://provider.test/offline.m3u8");
    recordSourcePreflight(ready, { status: "ready", checkedAt: 100_000, transport: "hls" }, storage);
    recordSourcePreflight(offline, { status: "offline", checkedAt: 100_000, transport: "hls" }, storage);
    const stored = readSourcePreflights(storage);
    expect(JSON.parse(values.get(SOURCE_PREFLIGHT_STORAGE_KEY) || "{}")).toHaveProperty(sourceIdentifier(ready));
    expect(isFreshPreflight(stored[sourceIdentifier(ready)], 100_000 + SOURCE_PREFLIGHT_TTL_MS)).toBe(true);
    expect(isFreshPreflight(stored[sourceIdentifier(ready)], 100_001 + SOURCE_PREFLIGHT_TTL_MS)).toBe(false);
    expect(orderSourcesByPreflight([offline, unknown, ready], stored, 100_000))
      .toEqual([ready, unknown, offline]);
  });

  it("never exceeds the configured queue concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    await runPreflightQueue([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(maximumActive).toBe(3);
    expect(active).toBe(0);
  });

  it("round-robins the preferred, HTTPS, and unknown sources before their fallbacks", () => {
    const now = 100_000;
    const sources: StreamSource[] = [
      {
        id: "preferred-http",
        url: "http://provider.test/preferred.m3u8",
        catalogHealth: { status: "online", score: 100, checkedAt: now - 1 },
      },
      {
        id: "healthy-https",
        url: "https://provider.test/healthy.m3u8",
        catalogHealth: { status: "online", score: 90, checkedAt: now - 1 },
      },
      {
        id: "failed-https",
        url: "https://provider.test/failed.m3u8",
        catalogHealth: { status: "offline", score: 0, checkedAt: now - 1 },
      },
      { id: "unknown-https", url: "https://provider.test/unknown.m3u8" },
    ];

    const routes = browserPreflightRoutes(sources, 3, now);

    expect(routes).toHaveLength(6);
    expect(routes.slice(0, 3).map((route) => route.logicalUrl)).toEqual([
      sources[0].url,
      sources[1].url,
      sources[3].url,
    ]);
  });
});
