import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  GUIDES_URL,
  XMLTV_MAX_DECOMPRESSED_BYTES,
  australianGuideSource,
  epgSharePrimaryTag,
  enrichGuideNames,
  loadAutoEpg,
  normalizeCountryCode,
  parseGuidesJson,
  rankGuideSources,
  streamGuidesJson,
} from "../src/epg";
import { RelayError } from "../src/errors";
import type { FetchLike } from "../src/urls";

function makeFetcher(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetcher: FetchLike = async (input) => {
    const href = typeof input === "string" ? input : input.href;
    calls.push(href);
    const handler = routes[href];
    return handler ? handler() : new Response("not found", { status: 404 });
  };
  return { calls, fetcher };
}

const GUIDES_JSON = JSON.stringify([
  {
    channel: "ABC1.au",
    site: "example.com",
    lang: "en",
    sources: [
      { url: "https://guides.example/best.xml" },
      { url: "https://guides.example/weak.xml" },
    ],
  },
  { channel: "ABC2.au", sources: [{ url: "https://guides.example/best.xml" }] },
  { channel: "OTHER.uk", sources: [{ url: "https://guides.example/other.xml" }] },
]);

const SOURCE_XML = `<tv>
  <programme start="20260816120000 +0000" stop="20260816130000 +0000" channel="ABC1.au">
    <title>Noon News</title>
    <desc>Bulletin</desc>
    <category>News</category>
  </programme>
  <programme start="20260816130000 +0000" stop="20260816140000 +0000" channel="ABC2.au">
    <title>One Thirty</title>
  </programme>
</tv>`;

const NO_MATCH_XML = `<tv>
  <programme start="20260816120000 +0000" stop="20260816130000 +0000" channel="OTHER.uk">
    <title>Not ours</title>
  </programme>
</tv>`;

const RIPPER_XML = `<tv>
  <programme start="20260816090000 +0000" stop="20260816100000 +0000" channel="RIP.au">
    <title>Ripper Breakfast</title>
  </programme>
</tv>`;

const RIPPER_AU_1 = "https://epgshare01.online/epgshare01/epg_ripper_AU1.xml.gz";
const RIPPER_AU_2 =
  "https://raw.githubusercontent.com/epgshare01/share01/master/epg_ripper_AU1.xml.gz";
const RIPPER_UK_1 = "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz";
const BRISBANE_GUIDE = "https://i.mjh.nz/au/Brisbane/epg.xml.gz";

describe("parseGuidesJson", () => {
  it("returns [] for invalid JSON and non-arrays", () => {
    expect(parseGuidesJson("not json at all{")).toEqual([]);
    expect(parseGuidesJson("{}")).toEqual([]);
  });

  it("filters malformed entries defensively", () => {
    const guides = parseGuidesJson(
      JSON.stringify([
        { channel: 42, sources: "not-an-array" },
        { channel: "A", sources: [{ url: 1 }, { url: "ok" }, null] },
        null,
        "junk",
      ]),
    );
    expect(guides).toEqual([
      { channel: undefined, sources: [] },
      { channel: "A", sources: [{ url: "ok" }] },
    ]);
  });

  it("preserves feed, site, language, display-name, and source metadata", () => {
    const [guide] = parseGuidesJson(JSON.stringify([{
      channel: "ABC.ca",
      feed: "Toronto",
      site: "provider.test",
      site_id: "abc-hd",
      site_name: "ABC Toronto HD",
      lang: "en",
      sources: [{ host: "cdn.test", url: "https://cdn.test/guide.xml", format: "XML" }],
    }]));
    expect(guide).toEqual({
      channel: "ABC.ca",
      feed: "Toronto",
      site: "provider.test",
      siteId: "abc-hd",
      siteName: "ABC Toronto HD",
      lang: "en",
      sources: [{ host: "cdn.test", url: "https://cdn.test/guide.xml", format: "XML" }],
    });
  });

  it("adds unique provider display names only to their exact requested channel", () => {
    const names = enrichGuideNames(
      new Map([["ABC.ca", ["ABC"]]]),
      parseGuidesJson(JSON.stringify([
        { channel: "ABC.ca", site_name: "ABC Toronto HD", sources: [] },
        { channel: "OTHER.ca", site_name: "Other", sources: [] },
      ])),
      ["ABC.ca"],
    );
    expect(names.get("ABC.ca")).toEqual(["ABC", "ABC Toronto HD"]);
    expect(names.has("OTHER.ca")).toBe(false);
  });
});

describe("streamGuidesJson", () => {
  it("retains only requested guide objects across tiny chunks", async () => {
    const payload = JSON.stringify([
      { channel: "OTHER.us", site_name: "Other", sources: [] },
      {
        channel: "ABC.ca",
        feed: "Toronto",
        site_name: "ABC {Toronto}",
        sources: [{ url: "https://guide.test/abc.xml" }],
      },
    ]);
    const bytes = new TextEncoder().encode(payload);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 7) {
          controller.enqueue(bytes.subarray(index, index + 7));
        }
        controller.close();
      },
    });

    const guides = await streamGuidesJson(body, ["ABC.ca"]);

    expect(guides).toEqual([expect.objectContaining({
      channel: "ABC.ca",
      feed: "Toronto",
      siteName: "ABC {Toronto}",
      sources: [{ url: "https://guide.test/abc.xml" }],
    })]);
  });

  it("rejects an index that exceeds its streaming byte budget", async () => {
    const body = new Response(JSON.stringify([{ channel: "ABC.ca", sources: [] }])).body!;
    await expect(streamGuidesJson(body, ["ABC.ca"], 8))
      .rejects.toThrow(/exceeded the relay size limit/);
  });
});

describe("rankGuideSources", () => {
  it("scores sources by requested-id coverage, descending, stable ties", () => {
    const guides = parseGuidesJson(
      JSON.stringify([
        { channel: "A", sources: [{ url: "one" }, { url: "two" }] },
        { channel: "B", sources: [{ url: "two" }] },
        { channel: "C", sources: [{ url: "two" }, { url: "three" }] },
        { channel: "D", sources: [{ url: "unwanted" }] },
      ]),
    );
    expect(rankGuideSources(guides, ["A", "B", "C"])).toEqual([
      "two",
      "one",
      "three",
    ]);
  });

  it("ignores guides whose channel is not requested", () => {
    expect(rankGuideSources(parseGuidesJson(GUIDES_JSON), ["ABC1.au"])).toEqual(
      ["https://guides.example/best.xml", "https://guides.example/weak.xml"],
    );
  });
});

describe("normalizeCountryCode", () => {
  it("uppercases and aliases GB to UK", () => {
    expect(normalizeCountryCode(" au ")).toBe("AU");
    expect(normalizeCountryCode("gb")).toBe("UK");
    expect(normalizeCountryCode("")).toBe("");
  });

  it("rejects codes unsafe for a URL path", () => {
    expect(() => normalizeCountryCode("A/U")).toThrowError(RelayError);
    expect(() => normalizeCountryCode("../etc")).toThrowError(RelayError);
  });

  it("uses the provider's current numbered primary tags", () => {
    expect(epgSharePrimaryTag("US")).toBe("US2");
    expect(epgSharePrimaryTag("CA")).toBe("CA2");
    expect(epgSharePrimaryTag("BE")).toBe("BE2");
    expect(epgSharePrimaryTag("gb")).toBe("UK1");
    expect(epgSharePrimaryTag("AU")).toBe("AU1");
  });
});

describe("Australian regional guide mapping", () => {
  it("maps current CrowFlix channel IDs to the browser timezone without guessing another city", () => {
    const source = australianGuideSource([
      "ABCTV.au",
      "ABCNews.au",
      "9Gem.au",
      "Channel7.au",
      "SkyThoroughbredCentral.au",
      "Unmapped.au",
    ], "Australia/Brisbane");

    expect(source).toMatchObject({ city: "Brisbane", url: BRISBANE_GUIDE });
    expect(Object.fromEntries(source!.aliases)).toMatchObject({
      "mjh-abc-qld": "ABCTV.au",
      "mjh-abc-news": "ABCNews.au",
      "mjh-gem-qld": "9Gem.au",
      "mjh-seven-bri": "Channel7.au",
      "mjh-sky-racing-thoroughbred": "SkyThoroughbredCentral.au",
    });
    expect([...source!.aliases.values()]).not.toContain("Unmapped.au");
    expect(australianGuideSource(["ABCTV.au"], "Europe/London")).toBeNull();
  });

  it("keeps the broad fallback streaming limit large enough for current regional files", () => {
    expect(XMLTV_MAX_DECOMPRESSED_BYTES).toBe(96 * 1024 * 1024);
  });
});

describe("loadAutoEpg", () => {
  it("fetches the highest-coverage source first and returns its programmes", async () => {
    const { calls, fetcher } = makeFetcher({
      [GUIDES_URL]: () => new Response(GUIDES_JSON, { status: 200 }),
      "https://guides.example/best.xml": () =>
        new Response(SOURCE_XML, { status: 200 }),
    });
    const result = await loadAutoEpg("AU", ["ABC1.au", "ABC2.au"], fetcher);

    expect(result.source).toBe("IPTV-org EPG · https://guides.example/best.xml");
    expect(result.matchedChannels).toBe(2);
    expect(result.programmes).toHaveLength(2);
    expect(result.programmes[0]).toMatchObject({
      channelId: "ABC1.au",
      title: "Noon News",
      description: "Bulletin",
      category: "News",
      start: "2026-08-16T12:00:00.000Z",
    });
    expect(Number.isNaN(new Date(result.updatedAt).getTime())).toBe(false);
    expect(calls).toEqual([GUIDES_URL, "https://guides.example/best.xml"]);
  });

  it("falls through when a ranked source errors", async () => {
    const { calls, fetcher } = makeFetcher({
      [GUIDES_URL]: () => new Response(GUIDES_JSON, { status: 200 }),
      "https://guides.example/weak.xml": () =>
        new Response(SOURCE_XML, { status: 200 }),
      // best.xml unmapped → 404 from the default handler
    });
    const result = await loadAutoEpg("AU", ["ABC1.au"], fetcher);
    expect(result.source).toBe("IPTV-org EPG · https://guides.example/weak.xml");
    expect(calls).toEqual([
      GUIDES_URL,
      "https://guides.example/best.xml",
      "https://guides.example/weak.xml",
    ]);
  });

  it("falls through when a ranked source has no matching programmes", async () => {
    const { fetcher } = makeFetcher({
      [GUIDES_URL]: () => new Response(GUIDES_JSON, { status: 200 }),
      "https://guides.example/best.xml": () =>
        new Response(NO_MATCH_XML, { status: 200 }),
      "https://guides.example/weak.xml": () =>
        new Response(SOURCE_XML, { status: 200 }),
    });
    const result = await loadAutoEpg("AU", ["ABC1.au"], fetcher);
    expect(result.source).toBe("IPTV-org EPG · https://guides.example/weak.xml");
  });

  it("loads and remaps the timezone-specific Australian guide before the broad ripper", async () => {
    const regionalXml = `<tv>
      <programme start="20260823120000 +0000" stop="20260823130000 +0000" channel="mjh-abc-qld"><title>Queensland News</title></programme>
      <programme start="20260823130000 +0000" stop="20260823140000 +0000" channel="mjh-gem-qld"><title>Gem Programme</title></programme>
    </tv>`;
    const { calls, fetcher } = makeFetcher({
      [GUIDES_URL]: () => new Response("unavailable", { status: 503 }),
      [BRISBANE_GUIDE]: () => new Response(gzipSync(regionalXml), { status: 200 }),
    });

    const result = await loadAutoEpg(
      "AU",
      ["ABCTV.au", "9Gem.au"],
      fetcher,
      "Australia/Brisbane",
    );

    expect(result.source).toBe("Australian Brisbane guide");
    expect(result.matchedChannels).toBe(2);
    expect(result.programmes.map((programme) => programme.channelId))
      .toEqual(["ABCTV.au", "9Gem.au"]);
    expect(calls).toEqual([GUIDES_URL, BRISBANE_GUIDE]);
  });

  it("tries at most 3 ranked sources before falling back", async () => {
    const manySources = JSON.stringify([
      {
        channel: "ABC1.au",
        sources: [1, 2, 3, 4, 5].map((n) => ({
          url: `https://guides.example/${n}.xml`,
        })),
      },
    ]);
    const { calls, fetcher } = makeFetcher({
      [GUIDES_URL]: () => new Response(manySources, { status: 200 }),
    });
    await expect(
      loadAutoEpg("AU", ["ABC1.au"], fetcher),
    ).rejects.toThrowError(/No current programme listings/);
    const sourceCalls = calls.filter((href) => href.includes("guides.example/"));
    expect(sourceCalls).toEqual([
      "https://guides.example/1.xml",
      "https://guides.example/2.xml",
      "https://guides.example/3.xml",
    ]);
  });

  it("falls back to the ripper with the GB to UK alias and gunzips it", async () => {
    const { calls, fetcher } = makeFetcher({
      [GUIDES_URL]: () => new Response("boom", { status: 500 }),
      [RIPPER_UK_1]: () => new Response(gzipSync(RIPPER_XML), { status: 200 }),
    });
    const result = await loadAutoEpg("gb", ["RIP.au"], fetcher);
    expect(result.source).toBe("Automatic regional guide · UK");
    expect(result.matchedChannels).toBe(1);
    expect(result.programmes[0].title).toBe("Ripper Breakfast");
    expect(calls).toEqual([GUIDES_URL, RIPPER_UK_1]);
  });

  it("uses the GitHub ripper mirror when the first ripper fails", async () => {
    const { calls, fetcher } = makeFetcher({
      [GUIDES_URL]: () => new Response("boom", { status: 500 }),
      [RIPPER_AU_2]: () => new Response(RIPPER_XML, { status: 200 }),
    });
    const result = await loadAutoEpg("AU", ["RIP.au"], fetcher);
    expect(result.source).toBe("Automatic regional guide · AU");
    expect(calls).toEqual([GUIDES_URL, RIPPER_AU_1, RIPPER_AU_2]);
  });

  it("treats a malformed guides index as unavailable and uses the ripper", async () => {
    const { fetcher } = makeFetcher({
      [GUIDES_URL]: () => new Response("not json at all{", { status: 200 }),
      [RIPPER_AU_1]: () => new Response(RIPPER_XML, { status: 200 }),
    });
    const result = await loadAutoEpg("AU", ["RIP.au"], fetcher);
    expect(result.source).toBe("Automatic regional guide · AU");
  });

  it("fails with a 502 RelayError when nothing matches", async () => {
    const { fetcher } = makeFetcher({
      [GUIDES_URL]: () => new Response("boom", { status: 500 }),
    });
    try {
      await loadAutoEpg("AU", ["ABC1.au"], fetcher);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RelayError);
      expect((error as RelayError).status).toBe(502);
      expect((error as RelayError).message).toMatch(
        /No current programme listings matched the AU channels/,
      );
    }
  });

  it("reports the requested channels wording when no country is given", async () => {
    const { fetcher } = makeFetcher({
      [GUIDES_URL]: () => new Response("boom", { status: 500 }),
    });
    await expect(loadAutoEpg("", ["ABC1.au"], fetcher)).rejects.toThrowError(
      /matched the requested channels/,
    );
  });

  it("rejects invalid channel id input before any fetch", async () => {
    const { calls, fetcher } = makeFetcher({});
    await expect(loadAutoEpg("AU", [], fetcher)).rejects.toThrowError(
      /at least one channel id/,
    );
    await expect(loadAutoEpg("AU", ["", "  "], fetcher)).rejects.toThrowError(
      /at least one channel id/,
    );
    await expect(
      loadAutoEpg("AU", Array(2_001).fill("x"), fetcher),
    ).rejects.toThrowError(/more than 2000 channel identifiers/);
    await expect(
      loadAutoEpg("AU", ["x".repeat(201)], fetcher),
    ).rejects.toThrowError(/too long/);
    expect(calls).toEqual([]);
  });

  it("rejects an unsafe country code before any fetch", async () => {
    const { calls, fetcher } = makeFetcher({});
    try {
      await loadAutoEpg("A/U", ["ABC1.au"], fetcher);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as RelayError).status).toBe(400);
      expect((error as RelayError).message).toMatch(/valid country code/);
    }
    expect(calls).toEqual([]);
  });
});
