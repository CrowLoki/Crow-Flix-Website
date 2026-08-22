import { describe, expect, it, vi } from "vitest";
import {
  loadStreamHealthIndex,
  parseStreamHealthEntries,
  STREAM_HEALTH_GZIP_URL,
  STREAM_HEALTH_MANIFEST_URL,
  streamHealthIdentity,
} from "./streamHealthIndex";

function record(
  url: string,
  status = "online",
  checkedAt = "2026-08-23T00:00:00.000Z",
) {
  return {
    url,
    referrer: null,
    user_agent: null,
    health: { status, score: 90, checked_at: checkedAt },
  };
}

describe("stream health index", () => {
  it("accepts only fresh, bounded, exact-identity health records", () => {
    const now = Date.parse("2026-08-23T01:00:00.000Z");
    const valid = record("https://provider.test/live.m3u8");
    const hints = parseStreamHealthEntries([
      valid,
      { ...valid, health: { ...valid.health, checked_at: "2026-08-23T00:30:00.000Z" } },
      record("https://provider.test/stale.m3u8", "offline", "2026-08-21T00:00:00.000Z"),
      record("https://user:pass@provider.test/secret.m3u8"),
      record("ftp://provider.test/live"),
      record("https://provider.test/bad.m3u8", "invented"),
      { ...record("https://provider.test/string-score.m3u8"), health: {
        status: "online", score: "90", checked_at: "2026-08-23T00:00:00.000Z",
      } },
    ], now);

    expect(hints.size).toBe(1);
    expect(hints.get(streamHealthIdentity(valid.url))).toEqual({
      status: "online",
      score: 90,
      checkedAt: Date.parse("2026-08-23T00:30:00.000Z"),
    });
  });

  it("loads a fresh manifest and bounded compressed index", async () => {
    const now = Date.parse("2026-08-23T01:00:00.000Z");
    const records = Array.from({ length: 1_000 }, (_, index) =>
      record(`https://provider.test/${index}.m3u8`));
    const decompressed = new TextEncoder().encode(JSON.stringify(records)).buffer;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.cache).toBe("no-store");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (String(input) === STREAM_HEALTH_MANIFEST_URL) {
        return new Response(JSON.stringify({
          name: "IPTV Nexus",
          version: "1.0.0",
          generated_at: "2026-08-23T00:30:00.000Z",
        }));
      }
      expect(String(input)).toBe(STREAM_HEALTH_GZIP_URL);
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const decompress = vi.fn(async () => decompressed);

    const loaded = await loadStreamHealthIndex(fetcher, () => now, decompress);

    expect(loaded.hints.size).toBe(1_000);
    expect(loaded.generatedAt).toBe(Date.parse("2026-08-23T00:30:00.000Z"));
    expect(decompress).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale manifest before downloading the large index", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      name: "IPTV Nexus",
      version: "1.0.0",
      generated_at: "2026-08-20T00:00:00.000Z",
    })));

    await expect(loadStreamHealthIndex(
      fetcher,
      () => Date.parse("2026-08-23T01:00:00.000Z"),
      vi.fn(),
    )).rejects.toThrow(/stale or invalid/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
