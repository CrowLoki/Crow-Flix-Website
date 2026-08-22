import { afterEach, describe, expect, it, vi } from "vitest";
import { orderPlaybackSources } from "./playback/logic";
import {
  loadRelayGuide,
  logicalDashRequestUrl,
  relayStreamUrl,
  routeDashRequestUrl,
  toWebPlayableSource,
  toWebPlayableSources,
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
  it("keeps the direct route first for ordinary HTTPS and adds a distinct relay fallback", () => {
    const source = { url: "https://cdn.example.com/a.m3u8", requiresHeaders: false };
    const routes = toWebPlayableSources(source);
    expect(routes).toHaveLength(2);
    expect(routes.map((route) => route.delivery)).toEqual(["direct", "relay"]);
    expect(routes[0]?.url).toBe(source.url);
    expect(routes[1]?.url).toContain(`${RELAY_BASE}/stream?`);
    expect(routes[0]?.id).not.toBe(routes[1]?.id);
    expect(toWebPlayableSources(source).map((route) => route.id))
      .toEqual(routes.map((route) => route.id));
    expect(orderPlaybackSources(routes).map((route) => route.delivery))
      .toEqual(["direct", "relay"]);
    expect(toWebPlayableSource(source)).toEqual(routes[0]);
  });

  it("tracks direct and relay health separately and moves only a cooling route", () => {
    const routes = toWebPlayableSources({
      id: "health-source",
      url: "https://cdn.example.com/a.m3u8",
    });
    expect(orderPlaybackSources(routes, {
      "health-source:direct": { failures: 1, cooldownUntil: 10_000 },
    }, undefined, 5_000).map((route) => route.id)).toEqual([
      "health-source:relay",
      "health-source:direct",
    ]);
  });

  it("tries relay then an upgraded HTTPS route without handing raw HTTP to the browser", () => {
    const source = { id: "24-horas", url: "http://provider.example/live.m3u8" };
    const routes = toWebPlayableSources(source);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      id: "24-horas:relay",
      delivery: "relay",
      logicalUrl: source.url,
    });
    expect(routes[1]).toMatchObject({
      id: "24-horas:https-upgrade",
      delivery: "direct",
      url: "https://provider.example/live.m3u8",
      logicalUrl: "https://provider.example/live.m3u8",
    });
    expect(routes.every((route) => route.url.startsWith("https://"))).toBe(true);
    expect(new URL(routes[0]!.url).searchParams.get("url")).toBe(source.url);
  });

  it("keeps a header-required HTTP source relay-only", () => {
    const routes = toWebPlayableSources({
      id: "http-header-source",
      url: "http://provider.example/live.m3u8",
      referrer: "https://provider.example/watch",
    });
    expect(routes).toHaveLength(1);
    expect(routes[0]?.id).toBe("http-header-source:relay");
  });

  it("uses only the relay for header-locked sources with headers and hint preserved", () => {
    const routes = toWebPlayableSources({
      id: "header-source",
      url: "https://cdn.example.com/a.m3u8",
      requiresHeaders: true,
      userAgent: "UA",
      referrer: "https://ref.example.com/",
      transport: "hls",
    });
    expect(routes).toHaveLength(1);
    const [relayed] = routes;
    expect(relayed.url).toContain("/stream?");
    expect(relayed.userAgent).toBeNull();
    expect(relayed.referrer).toBeNull();
    expect(relayed.requiresHeaders).toBe(false);
    expect(relayed.transport).toBe("hls");
    expect(relayed.id).toBe("header-source:relay");
  });
});

describe("routeDashRequestUrl", () => {
  it("wraps logical DASH child and initialization requests through the same relay", () => {
    const [source] = toWebPlayableSources({
      id: "dash-header",
      url: "https://provider.example/live/channel.mpd",
      userAgent: "Provider UA",
      referrer: "https://provider.example/watch",
      transport: "dash",
    });
    const child = routeDashRequestUrl(
      "https://provider.example/live/video/init-1.mp4",
      source!,
    );
    const query = new URL(child).searchParams;
    expect(query.get("url")).toBe("https://provider.example/live/video/init-1.mp4");
    expect(query.get("ua")).toBe("Provider UA");
    expect(query.get("referer")).toBe("https://provider.example/watch");
  });

  it("resolves a relative DASH request against the logical provider MPD", () => {
    const [source] = toWebPlayableSources({
      id: "dash-relative",
      url: "https://provider.example/live/channel.mpd",
      userAgent: "Provider UA",
      transport: "dash",
    });
    const child = routeDashRequestUrl("video/segment-1.m4s", source!);
    expect(new URL(child).searchParams.get("url"))
      .toBe("https://provider.example/live/video/segment-1.m4s");
  });

  it("recovers the logical provider URL from a relayed DASH request", () => {
    const [source] = toWebPlayableSources({
      id: "dash-logical",
      url: "https://provider.example/live/channel.mpd",
      userAgent: "Provider UA",
      transport: "dash",
    });
    const relayed = routeDashRequestUrl(
      "https://provider.example/live/video/segment-1.m4s",
      source!,
    );
    expect(logicalDashRequestUrl(relayed, source!))
      .toBe("https://provider.example/live/video/segment-1.m4s");
  });

  it("does not double-wrap relay URLs and leaves direct/native requests alone", () => {
    const [, relay] = toWebPlayableSources({
      id: "dash-open",
      url: "https://provider.example/live/channel.mpd",
      transport: "dash",
    });
    expect(routeDashRequestUrl(relay!.url, relay!)).toBe(relay!.url);
    expect(routeDashRequestUrl(
      "https://provider.example/live/segment.m4s",
      { id: "native", url: "https://provider.example/live/channel.mpd" },
    )).toBe("https://provider.example/live/segment.m4s");
  });
});
