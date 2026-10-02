import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import {
  CATALOGUE_REGIONS, MAX_COMPRESSED_BYTES, MAX_EXPANDED_BYTES, catalogueOrigin, decodePublishedResponse,
  validatePublishedSnapshot, verifyPublishedCatalogue,
} from "./verify-published-catalogue.mjs";

const requestedAt = Date.parse("2026-10-02T00:00:00.000Z");
const preparedAt = requestedAt + 60_000;
function snapshot(region = "Sydney", updatedAt = preparedAt) {
  return {
    version: 1, region,
    catalog: {
      channels: Array.from({ length: 1_000 }, (_, index) => ({
        key: `channel-${index}`, id: `channel-${index}`, name: `Channel ${index}`,
        categories: ["news"], languages: ["English"], broadcastArea: ["c/AU"],
        sources: [{ url: `https://media.example/${index}/live.m3u8` }],
      })),
      categories: [{ id: "news", name: "News", count: 1_000 }],
      countries: [{ code: "AU", name: "Australia", languages: ["eng"], count: 1_000 }],
      languages: [], regions: [], subdivisions: [], cities: [], timezones: [],
      owners: [], networks: [], feeds: [], providers: [],
      source: "IPTV-org API · prepared daily", updatedAt: new Date(updatedAt).toISOString(),
    },
  };
}
const response = (value) => new Response(gzipSync(JSON.stringify(value)));
function harness(fetcher, options = {}) {
  let clock = preparedAt + 1_000;
  return {
    after: requestedAt, now: () => clock,
    wait: vi.fn(async (milliseconds) => { clock += milliseconds; }),
    timeoutMs: 5_000, pollIntervalMs: 1_000, requestTimeoutMs: 500,
    fetchImpl: vi.fn(fetcher), log: vi.fn(), ...options,
  };
}
const regionAt = (input) => /\/([^/]+)\.json\.gz$/.exec(new URL(input).pathname)[1];

describe("published catalogue integrity", () => {
  it("requires a fresh prepared version and matching region with real source counts", () => {
    expect(validatePublishedSnapshot(snapshot(), { region: "Sydney", after: requestedAt, now: preparedAt }))
      .toEqual({ region: "Sydney", updatedAt: new Date(preparedAt).toISOString(), channels: 1_000, sources: 1_000 });
  });

  it.each([
    ["wrong version", (item) => { item.version = 2; }],
    ["wrong region", (item) => { item.region = "Perth"; }],
    ["old build", (item) => { item.catalog.updatedAt = new Date(requestedAt - 1).toISOString(); }],
    ["future build", (item) => { item.catalog.updatedAt = new Date(preparedAt + 60_001).toISOString(); }],
    ["missing preparation marker", (item) => { item.catalog.source = "preview"; }],
    ["incomplete catalogue", (item) => { item.catalog.channels.pop(); }],
    ["duplicate channel", (item) => { item.catalog.channels[1].key = item.catalog.channels[0].key; }],
    ["empty channel source", (item) => { item.catalog.channels[0].sources = []; }],
    ["invalid source headers", (item) => { item.catalog.channels[0].sources[0].referrer = {}; }],
    ["missing browse dimension", (item) => { delete item.catalog.providers; }],
    ["invalid count", (item) => { item.catalog.categories[0].count = -1; }],
  ])("rejects %s", (_label, mutate) => {
    const item = snapshot();
    mutate(item);
    expect(() => validatePublishedSnapshot(item, { region: "Sydney", after: requestedAt, now: preparedAt })).toThrow();
  });

  it("reads gzip and already HTTP-decoded JSON without double decoding", async () => {
    const item = snapshot();
    expect((await decodePublishedResponse(response(item))).value).toEqual(item);
    expect((await decodePublishedResponse(new Response(JSON.stringify(item), { headers: { "Content-Encoding": "gzip" } }))).value).toEqual(item);
  });

  it.each([204, 206, 301, 404, 503])("requires HTTP 200, not %i", async (status) => {
    await expect(decodePublishedResponse(new Response(null, { status }))).rejects.toThrow(`HTTP ${status}`);
  });

  it("rejects corrupt gzip and HTML error documents", async () => {
    const bytes = gzipSync(JSON.stringify(snapshot()));
    await expect(decodePublishedResponse(new Response(bytes.subarray(0, -8)))).rejects.toThrow(/corrupt/);
    await expect(decodePublishedResponse(new Response("<html>not a catalogue</html>"))).rejects.toThrow(/invalid JSON/);
  });

  it("rejects gzip expansion beyond the separate decompression limit", async () => {
    const compressed = gzipSync(Buffer.alloc(MAX_EXPANDED_BYTES + 1, 0x20));
    expect(compressed.byteLength).toBeLessThan(MAX_COMPRESSED_BYTES);
    await expect(decodePublishedResponse(new Response(compressed))).rejects.toThrow(/expanded limit/);
  });

  it("cancels oversized declared and streamed bodies without retaining them", async () => {
    const declaredCancel = vi.fn();
    await expect(decodePublishedResponse(new Response(new ReadableStream({ cancel: declaredCancel }), {
      headers: { "Content-Length": String(MAX_COMPRESSED_BYTES + 1) },
    }))).rejects.toThrow(/transfer limit/);
    expect(declaredCancel).toHaveBeenCalledOnce();
    const streamedCancel = vi.fn();
    await expect(decodePublishedResponse(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_COMPRESSED_BYTES + 1)); }, cancel: streamedCancel,
    })))).rejects.toThrow(/transfer limit/);
    expect(streamedCancel).toHaveBeenCalledOnce();
  });
});

describe("bounded publication wait", () => {
  it("polls only Sydney until fresh, then verifies one consistent eight-region set", async () => {
    let first = true;
    const options = harness(async (url) => {
      const region = regionAt(url);
      const date = first ? requestedAt - 1 : preparedAt;
      first = false;
      return response(snapshot(region, date));
    });
    const result = await verifyPublishedCatalogue(options);
    expect(result.status).toBe("publication-verified");
    expect(result.attempts).toBe(2);
    expect(result.requests).toBe(9);
    expect(result.snapshots.map((item) => item.region)).toEqual(CATALOGUE_REGIONS);
    expect(options.fetchImpl.mock.calls.slice(0, 2).map(([url]) => regionAt(url))).toEqual(["Sydney", "Sydney"]);
    const [firstUrl, init] = options.fetchImpl.mock.calls[0];
    const secondUrl = options.fetchImpl.mock.calls[1][0];
    expect(firstUrl).not.toBe(secondUrl);
    expect(new URL(firstUrl).origin).toBe("https://crowflix.tv");
    expect(init).toMatchObject({ cache: "no-store", redirect: "error", headers: { "Cache-Control": "no-cache, no-store" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(options.log.mock.calls.flat().join(" ")).not.toContain("media.example");
  });

  it("does not accept mixed fresh deployment generations", async () => {
    const options = harness(async (url) => response(snapshot(regionAt(url), regionAt(url) === "Adelaide" ? preparedAt + 1 : preparedAt)), { timeoutMs: 2_000 });
    await expect(verifyPublishedCatalogue(options)).rejects.toThrow(/different builds/);
    expect(options.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("fails within its polling limit when the trigger never yields a fresh build", async () => {
    const options = harness(async () => response(snapshot("Sydney", requestedAt - 1)), { timeoutMs: 3_000 });
    await expect(verifyPublishedCatalogue(options)).rejects.toThrow(/Publication was not verified/);
    expect(options.fetchImpl).toHaveBeenCalledTimes(3);
    expect(options.wait).toHaveBeenCalledTimes(2);
  });

  it("retries a transient response failure without considering it a publication", async () => {
    let first = true;
    const options = harness(async (url) => {
      if (first) { first = false; return new Response(null, { status: 503 }); }
      return response(snapshot(regionAt(url)));
    });
    expect((await verifyPublishedCatalogue(options)).attempts).toBe(2);
  });

  it("cancels before issuing a request when interrupted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const options = harness(vi.fn(), { signal: controller.signal });
    await expect(verifyPublishedCatalogue(options)).rejects.toThrow("stopped");
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects absent timestamps and unsafe origins before any request", async () => {
    const options = harness(vi.fn(), { after: undefined });
    await expect(verifyPublishedCatalogue(options)).rejects.toThrow(/--after/);
    for (const origin of ["http://crowflix.tv/", "https://user:pass@crowflix.tv/", "https://crowflix.tv/secret", "https://crowflix.tv/?token=value"]) {
      expect(() => catalogueOrigin(origin)).toThrow();
    }
    expect(catalogueOrigin("http://127.0.0.1:4189/")).toBe("http://127.0.0.1:4189");
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });
});
