import { describe, expect, it, vi } from "vitest";
import type { WebCatalog } from "./webCatalog";
import {
  createPreparedCatalogLoader, decodePreparedCatalogResponse,
  PREPARED_CATALOG_TTL_MS, preparedCatalogRegion, readPreparedCatalogSnapshot,
} from "./preparedCatalog";

function catalog(): WebCatalog {
  return {
    channels: [{
      key: "Test.au@main", id: "Test.au", name: "Test channel", isMain: true,
      categories: ["news"], languages: ["English"], broadcastArea: ["c/AU"],
      sources: [{ url: "https://provider.test/live.m3u8", provenance: "IPTV-org" }],
    }],
    categories: [], countries: [], languages: [], regions: [], subdivisions: [],
    cities: [], timezones: [], owners: [], networks: [], feeds: [], providers: [],
    updatedAt: "2026-10-01T00:00:00.000Z", source: "IPTV-org API · prepared daily",
  };
}

const envelope = () => ({ version: 1 as const, region: "Sydney" as const, catalog: catalog() });
const response = async (value = envelope()) => new Response(await new Response(
  new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip")),
).arrayBuffer());

describe("prepared static catalogue", () => {
  it("keeps the existing Australian regional mappings including half-hour zones", () => {
    expect(preparedCatalogRegion("Australia/Brisbane")).toBe("Brisbane");
    expect(preparedCatalogRegion("Australia/Broken_Hill")).toBe("Adelaide");
    expect(preparedCatalogRegion("Australia/Lindeman")).toBe("Brisbane");
    expect(preparedCatalogRegion("Australia/Lord_Howe")).toBe("Sydney");
    expect(preparedCatalogRegion("America/New_York")).toBe("Sydney");
  });

  it("decodes gzip and preserves catalogue metadata and exact provider headers", async () => {
    const snapshot = envelope();
    snapshot.catalog.channels[0].sources[0].referrer = "https://provider.test/player";
    snapshot.catalog.channels[0].sources[0].userAgent = "Provider agent";
    const result = await decodePreparedCatalogResponse(await response(snapshot), "Sydney");
    expect(result).toEqual(snapshot);
  });

  it("accepts HTTP-decoded gzip responses without decompressing twice", async () => {
    const result = await decodePreparedCatalogResponse(new Response(JSON.stringify(envelope())), "Sydney");
    expect(result.catalog).toEqual(catalog());
  });

  it("rejects wrong regions, incomplete schemas, and duplicate channel keys", () => {
    expect(readPreparedCatalogSnapshot(envelope(), "Brisbane")).toBeNull();
    expect(readPreparedCatalogSnapshot({ ...envelope(), version: 2 }, "Sydney")).toBeNull();
    const duplicate = envelope();
    duplicate.catalog.channels.push(duplicate.catalog.channels[0]);
    expect(readPreparedCatalogSnapshot(duplicate, "Sydney")).toBeNull();
    expect(readPreparedCatalogSnapshot({ ...envelope(), catalog: { ...catalog(), providers: null } }, "Sydney")).toBeNull();
  });

  it("coalesces simultaneous initial and forced loads into one same-origin request", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
    const cache = { read: vi.fn(async () => null), write: vi.fn(async () => undefined) };
    const load = createPreparedCatalogLoader(fetchImpl, cache);
    const first = load(false, "Australia/Sydney");
    const second = load(true, "Australia/Sydney");
    expect(first).toBe(second);
    expect(await first).toEqual(catalog());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("/catalog/Sydney.json.gz");
    expect(cache.write).toHaveBeenCalledTimes(1);
  });

  it("reuses the browser snapshot and refreshes only the static asset when requested", async () => {
    const now = 10_000;
    const entry = { cachedAt: now, snapshot: envelope() };
    const cache = { read: vi.fn(async () => entry), write: vi.fn(async () => undefined) };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
    const load = createPreparedCatalogLoader(fetchImpl, cache, () => now);
    expect((await load(false, "Australia/Sydney")).source).toContain("browser cache");
    expect(fetchImpl).not.toHaveBeenCalled();
    await load(true, "Australia/Sydney");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.cache).toBe("reload");
  });

  it("preserves the full stale catalogue when the static asset is unavailable or invalid", async () => {
    const entry = { cachedAt: 1, snapshot: envelope() };
    const cache = { read: vi.fn(async () => entry), write: vi.fn(async () => undefined) };
    const load = createPreparedCatalogLoader(
      async () => new Response("<html>Not found</html>", { status: 404 }),
      cache, () => PREPARED_CATALOG_TTL_MS + 2,
    );
    const result = await load(false, "Australia/Sydney");
    expect(result.channels).toEqual(catalog().channels);
    expect(result.source).toContain("offline cache");
    expect(cache.write).not.toHaveBeenCalled();
  });
});
