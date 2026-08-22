import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const call = (path: string, method = "GET"): Promise<Response> =>
  worker.fetch(new Request(`https://relay.example${path}`, { method }));

afterEach(() => vi.unstubAllGlobals());

describe("worker routing", () => {
  it("GET /health returns the service identity with CORS *", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({
      ok: true,
      service: "crowflix-relay",
      version: "0.1.0",
    });
  });

  it("answers CORS preflight", async () => {
    const response = await call("/stream", "OPTIONS");
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "GET",
    );
  });

  it("rejects non-GET methods with 405 JSON", async () => {
    const response = await call("/health", "POST");
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "Only GET requests are supported.",
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
});
