import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadRelayGuide,
  relayStreamUrl,
  toWebPlayableSource,
  RELAY_BASE,
} from "./relayClient";

afterEach(() => vi.unstubAllGlobals());

describe("loadRelayGuide", () => {
  it("sends the Turnstile token in a header, never the URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      programmes: [],
      source: "test",
      matchedChannels: 0,
      updatedAt: "2026-08-23T00:00:00Z",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await loadRelayGuide("AU", ["ABC.au"], "turnstile-token");
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("turnstile-token");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("X-Turnstile-Token")).toBe("turnstile-token");
  });

  it("preserves the relay status on verification failure", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Complete browser verification." }), { status: 403 }),
    ));
    await expect(loadRelayGuide("AU", ["ABC.au"], "bad-token"))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe("relayStreamUrl", () => {
  it("wraps the url with encoded provider headers", () => {
    const url = relayStreamUrl({
      url: "https://cdn.example.com/live.m3u8?token=a b",
      userAgent: "Provider UA/1.0",
      referrer: "https://provider.example.com/",
    });
    expect(url).toContain(`${RELAY_BASE}/stream?`);
    const query = new URL(url!).searchParams;
    expect(query.get("url")).toBe("https://cdn.example.com/live.m3u8?token=a b");
    expect(query.get("ua")).toBe("Provider UA/1.0");
    expect(query.get("referer")).toBe("https://provider.example.com/");
  });

  it("omits absent headers and rejects non-HTTP urls", () => {
    const url = relayStreamUrl({ url: "https://cdn.example.com/live.m3u8" });
    expect(new URL(url!).searchParams.has("ua")).toBe(false);
    expect(relayStreamUrl({ url: "rtmp://x" })).toBeNull();
    expect(relayStreamUrl({ url: "" })).toBeNull();
  });
});

describe("toWebPlayableSource", () => {
  it("passes through sources that need no headers", () => {
    const source = { url: "https://cdn.example.com/a.m3u8", requiresHeaders: false };
    expect(toWebPlayableSource(source)).toBe(source);
  });

  it("relays header-locked sources with headers baked in and hint preserved", () => {
    const relayed = toWebPlayableSource({
      url: "https://cdn.example.com/a.m3u8",
      requiresHeaders: true,
      userAgent: "UA",
      referrer: "https://ref.example.com/",
      transport: "hls",
    });
    expect(relayed.url).toContain("/stream?");
    expect(relayed.userAgent).toBeNull();
    expect(relayed.referrer).toBeNull();
    expect(relayed.requiresHeaders).toBe(false);
    expect(relayed.transport).toBe("hls");
  });
});
