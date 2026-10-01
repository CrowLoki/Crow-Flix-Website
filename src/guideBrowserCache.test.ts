import { afterEach, describe, expect, it, vi } from "vitest";
import { GUIDE_REFRESH_INTERVAL_MS, GUIDE_REUSE_MS, guideIsFresh, readSavedGuide, saveGuide } from "./guideBrowserCache";
import type { RelayGuideResult } from "./relayClient";

const channels = [{ id: "ABC.au", names: ["ABC"], aliases: ["abc.provider"] }];
function result(): RelayGuideResult {
  return {
    source: "Verified guide", matchedChannels: 1, updatedAt: new Date().toISOString(),
    programmes: [{ channelId: "ABC.au", title: "Current show", start: new Date(Date.now() - 60_000).toISOString(), stop: new Date(Date.now() + 60_000).toISOString() }],
  };
}

function storage() {
  const records = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: string) => records.get(key)?.clone()),
    put: vi.fn(async (key: string, response: Response) => { records.set(key, response.clone()); }),
    delete: vi.fn(async (key: string | Request) => records.delete(typeof key === "string" ? key : key.url)),
    keys: vi.fn(async () => [...records.keys()].map((key) => new Request(key))),
  };
  vi.stubGlobal("caches", { open: async () => cache });
  return { records, cache };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("saved verified browser guides", () => {
  it("survives reloads without a network request and expires after an hour", async () => {
    vi.useFakeTimers();
    const { records } = storage();
    const guide = result();
    await saveGuide("AU", channels, "Australia/Brisbane", guide);
    expect(await readSavedGuide("AU", channels, "Australia/Brisbane")).toEqual(guide);
    vi.advanceTimersByTime(GUIDE_REUSE_MS);
    expect(await readSavedGuide("AU", channels, "Australia/Brisbane")).toBeNull();
    expect(records.size).toBe(0);
  });

  it("separates country, regional timezone, channel names and provider aliases", async () => {
    storage();
    await saveGuide("AU", channels, "Australia/Brisbane", result());
    expect(await readSavedGuide("AU", channels, "Australia/Sydney")).toBeNull();
    expect(await readSavedGuide("NZ", channels, "Australia/Brisbane")).toBeNull();
    expect(await readSavedGuide("AU", [{ ...channels[0]!, names: ["Different name"] }], "Australia/Brisbane")).toBeNull();
    expect(await readSavedGuide("AU", [{ ...channels[0]!, aliases: ["different.provider"] }], "Australia/Brisbane")).toBeNull();
  });

  it("bounds storage and never caches empty results", async () => {
    const { records } = storage();
    for (const country of ["AU", "NZ", "US", "CA", "GB"]) await saveGuide(country, channels, "UTC", result());
    expect(records.size).toBe(4);
    expect(await readSavedGuide("AU", channels, "UTC")).toBeNull();
    await saveGuide("FR", channels, "UTC", { ...result(), programmes: [] });
    expect(records.size).toBe(4);
  });

  it("keeps guide retrieval usable if browser storage fails or is unavailable", async () => {
    vi.stubGlobal("caches", { open: () => Promise.reject(new Error("Disabled")) });
    expect(await readSavedGuide("AU", channels, "UTC")).toBeNull();
    await expect(saveGuide("AU", channels, "UTC", result())).resolves.toBeUndefined();
    vi.stubGlobal("caches", undefined);
    expect(await readSavedGuide("AU", channels, "UTC")).toBeNull();
  });

  it("limits repeated Refresh clicks to the shared guide refresh interval", () => {
    const guide = result();
    expect(guideIsFresh(guide, GUIDE_REFRESH_INTERVAL_MS)).toBe(true);
    expect(guideIsFresh(guide, GUIDE_REFRESH_INTERVAL_MS, Date.now() + GUIDE_REFRESH_INTERVAL_MS)).toBe(false);
    expect(guideIsFresh(guide, GUIDE_REUSE_MS, Date.now() + GUIDE_REFRESH_INTERVAL_MS)).toBe(true);
    expect(guideIsFresh({ ...guide, updatedAt: "invalid" })).toBe(false);
  });
});
