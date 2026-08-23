import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const call = (path: string, method = "GET"): Promise<Response> =>
  worker.fetch(new Request(`https://relay.example${path}`, { method }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("worker routing", () => {
  it("GET /health returns the service identity with CORS *", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({
      ok: true,
      service: "crowflix-relay",
      version: "0.2.0",
    });
  });

  it("answers CORS preflight", async () => {
    const response = await call("/stream", "OPTIONS");
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "GET",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST",
    );
  });

  it("rejects non-GET methods with 405 JSON", async () => {
    const response = await call("/health", "POST");
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "That method is not supported for this route.",
    });
  });

  it("returns 404 JSON for unknown routes, with CORS", async () => {
    const response = await call("/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({ error: "Unknown relay route." });
  });
});

describe("worker input validation (no network is touched)", () => {
  it("/fetch without url is a 400", async () => {
    const response = await call("/fetch");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/url parameter/);
  });

  it("/fetch rejects private addresses with a 400 and CORS", async () => {
    const response = await call(
      `/fetch?url=${encodeURIComponent("http://127.0.0.1/")}`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await response.json()).error).toMatch(/local or private/);
  });

  it("/fetch rejects embedded credentials", async () => {
    const response = await call(
      `/fetch?url=${encodeURIComponent("https://user:pass@example.com/")}`,
    );
    expect(response.status).toBe(400);
  });

  it("/fetch rejects non-http schemes", async () => {
    const response = await call(
      `/fetch?url=${encodeURIComponent("ftp://example.com/x")}`,
    );
    expect(response.status).toBe(400);
  });

  it("/stream validates the target before any upstream fetch", async () => {
    const response = await call(
      `/stream?url=${encodeURIComponent("http://192.168.0.1/")}`,
    );
    expect(response.status).toBe(400);
  });

  it("/stream rejects control characters in the ua parameter", async () => {
    const response = await call(
      `/stream?url=${encodeURIComponent("https://example.com/x.m3u8")}&ua=bad%0Avalue`,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/ua parameter/);
  });

  it("/epg fails closed before guide work when verification is unavailable", async () => {
    const response = await call("/epg?country=AU");
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/verification is temporarily unavailable/i);
  });

  it("/epg validates Turnstile before guide work and is never HTTP-cached", async () => {
    const guideUrl = "https://guides.example/au.xml";
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const href = input instanceof Request ? input.url : input.toString();
      if (href.includes("/turnstile/v0/siteverify")) {
        return new Response(JSON.stringify({
          success: true,
          hostname: "crowflix.tv",
          action: "epg_load",
        }), { status: 200 });
      }
      if (href === "https://iptv-org.github.io/api/guides.json") {
        return new Response(JSON.stringify([
          { channel: "ABC.au", sources: [{ url: guideUrl }] },
        ]), { status: 200 });
      }
      if (href === guideUrl) {
        return new Response(`<tv><programme start="20260823120000 +0000" stop="20260823130000 +0000" channel="ABC.au"><title>News</title></programme></tv>`, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(new Request(
      "https://relay.example/epg?country=AU&ids=ABC.au",
      { headers: { "X-Turnstile-Token": "verified-token" } },
    ), {
      TURNSTILE_SECRET: "test-secret",
      TURNSTILE_ALLOWED_HOSTNAMES: "crowflix.tv",
      TURNSTILE_EXPECTED_ACTION: "epg_load",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).matchedChannels).toBe(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
  });

  it("/epg accepts a bounded POST and learns an exact provider-name alias", async () => {
    const regional = "https://epgshare01.online/epgshare01/epg_ripper_CA2.xml.gz";
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const href = input instanceof Request ? input.url : input.toString();
      if (href.includes("/turnstile/v0/siteverify")) {
        return new Response(JSON.stringify({
          success: true,
          hostname: "crowflix.tv",
          action: "epg_load",
        }), { status: 200 });
      }
      if (href === "https://iptv-org.github.io/api/guides.json") {
        return new Response("unavailable", { status: 503 });
      }
      if (href === regional) {
        return new Response(`<tv>
          <channel id="Citytv.Toronto.HD.ca2"><display-name>Citytv Toronto HD</display-name></channel>
          <programme start="20260823120000 +0000" stop="20260823130000 +0000" channel="Citytv.Toronto.HD.ca2"><title>Toronto News</title></programme>
        </tv>`, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(new Request(
      "https://relay.example/epg",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Turnstile-Token": "verified-token",
        },
        body: JSON.stringify({
          country: "CA",
          timeZone: "America/Toronto",
          channels: [{ id: "CitytvToronto.ca", names: ["Citytv Toronto"] }],
        }),
      },
    ), {
      TURNSTILE_SECRET: "test-secret",
      TURNSTILE_ALLOWED_HOSTNAMES: "crowflix.tv",
      TURNSTILE_EXPECTED_ACTION: "epg_load",
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { programmes: Array<{ channelId: string; title: string }> };
    expect(body.programmes).toEqual([expect.objectContaining({
      channelId: "CitytvToronto.ca",
      title: "Toronto News",
    })]);
  });

  it("/epg maps a bounded provider-id alias onto the CrowFlix channel id", async () => {
    const guideUrl = "https://guides.example/provider.xml";
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const href = input instanceof Request ? input.url : input.toString();
      if (href.includes("/turnstile/v0/siteverify")) {
        return new Response(JSON.stringify({
          success: true,
          hostname: "crowflix.tv",
          action: "epg_load",
        }), { status: 200 });
      }
      if (href === "https://iptv-org.github.io/api/guides.json") {
        return new Response(JSON.stringify([
          { channel: "Channel7.au", sources: [{ url: guideUrl }] },
        ]), { status: 200 });
      }
      if (href === guideUrl) {
        return new Response(`<tv><programme start="20260823120000 +0000" stop="20260823130000 +0000" channel="mjh-seven-bri"><title>Real programme</title></programme></tv>`, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(new Request(
      "https://relay.example/epg",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Turnstile-Token": "verified-token",
        },
        body: JSON.stringify({
          country: "AU",
          timeZone: "Australia/Brisbane",
          channels: [{
            id: "Channel7.au",
            names: ["Channel 7", "Seven"],
            aliases: ["mjh-seven-bri"],
          }],
        }),
      },
    ), {
      TURNSTILE_SECRET: "test-secret",
      TURNSTILE_ALLOWED_HOSTNAMES: "crowflix.tv",
      TURNSTILE_EXPECTED_ACTION: "epg_load",
    });

    expect(response.status).toBe(200);
    expect((await response.json()).programmes).toEqual([
      expect.objectContaining({
        channelId: "Channel7.au",
        title: "Real programme",
      }),
    ]);
  });
});

describe("stream relay transport", () => {
  it.each([401, 403, 404, 410, 429, 451, 503])(
    "preserves an upstream HTTP %i so the player can explain the failure",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
        new Response("provider detail must not be relayed", { status }),
      ));
      const target = encodeURIComponent("https://media.example/live.m3u8");

      const response = await call(`/stream?url=${target}`);

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: `The stream provider responded ${status}.`,
      });
    },
  );

  it("resolves relative HLS entries against the validated cross-host redirect target", async () => {
    const startUrl = "https://short.example/channel";
    const finalUrl = "https://media.example/live/path/master.m3u8?token=abc";
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const href = input instanceof Request ? input.url : input.toString();
      expect(init?.redirect).toBe("manual");
      if (href === startUrl) {
        return new Response(null, {
          status: 302,
          headers: { Location: finalUrl },
        });
      }
      if (href === finalUrl) {
        return new Response("#EXTM3U\nsegments/chunk-1.ts\n", {
          status: 200,
          headers: { "Content-Type": "application/vnd.apple.mpegurl" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await call(`/stream?url=${encodeURIComponent(startUrl)}`);

    expect(response.status).toBe(200);
    const segmentLine = (await response.text())
      .split("\n")
      .find((line) => line.startsWith("https://relay.example/stream"));
    expect(segmentLine).toBeDefined();
    const relayedSegment = new URL(segmentLine!);
    expect(relayedSegment.searchParams.get("url")).toBe(
      "https://media.example/live/path/segments/chunk-1.ts",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("forwards one safe byte range and preserves a 206 media response", async () => {
    const media = new Uint8Array([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=1024-2047");
      return new Response(media, {
        status: 206,
        headers: {
          "Content-Type": "video/mp2t",
          "Content-Range": "bytes 1024-1035/4096",
          "Accept-Ranges": "bytes",
          "Content-Length": String(media.byteLength),
        },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const target = encodeURIComponent("https://media.example/segment.ts");
    const response = await worker.fetch(new Request(
      `https://relay.example/stream?url=${target}`,
      { headers: { Range: "bytes=1024-2047" } },
    ));

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 1024-1035/4096");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe("12");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain(
      "Content-Range",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(media);
  });

  it("rejects multipart byte ranges before contacting upstream", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const target = encodeURIComponent("https://media.example/segment.ts");

    const response = await worker.fetch(new Request(
      `https://relay.example/stream?url=${target}`,
      { headers: { Range: "bytes=0-10,20-30" } },
    ));

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds an upstream connection that never starts responding", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })
    );
    vi.stubGlobal("fetch", fetcher);

    const target = encodeURIComponent("https://media.example/live");
    const responsePromise = call(`/stream?url=${target}`);
    await vi.advanceTimersByTimeAsync(8_001);
    const response = await responsePromise;

    expect(response.status).toBe(504);
    expect((await response.json()).error).toMatch(/did not start responding/i);
  });

  it("does not keep an overall timer after live media sends its first bytes", async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | null | undefined;
    const liveBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
      },
    });
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      upstreamSignal = init?.signal;
      return new Response(liveBody, {
        status: 200,
        headers: { "Content-Type": "video/mp2t" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const target = encodeURIComponent("https://media.example/live.ts");
    const response = await call(`/stream?url=${target}`);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(response.status).toBe(200);
    expect(upstreamSignal?.aborted).toBe(false);
    await response.body?.cancel();
  });
});
