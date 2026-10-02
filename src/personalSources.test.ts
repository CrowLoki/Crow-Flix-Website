import { describe, expect, it, vi } from "vitest";
import {
  mergePersonalPlaylistIntoCatalog,
  parsePersonalPlaylist,
  parsePersonalXmltv,
  parsePersonalXmltvFile,
} from "./personalSources";
import type { WebCatalog, WebChannel } from "./webCatalog";

function baseChannel(): WebChannel {
  return {
    key: "ABCTV.au@main",
    id: "ABCTV.au",
    feed: null,
    name: "ABC TV",
    altNames: [],
    owners: [],
    logo: null,
    categories: ["general"],
    country: "AU",
    languages: ["English"],
    broadcastArea: ["c/AU"],
    timezones: ["Australia/Brisbane"],
    sources: [{ id: "built-in", url: "https://built-in.test/abc.m3u8" }],
    provenance: ["IPTV-org"],
    isMain: true,
  };
}

function baseCatalog(): WebCatalog {
  return {
    channels: [baseChannel()],
    categories: [{ id: "general", name: "General", count: 1 }],
    countries: [{ code: "AU", name: "Australia", flag: "🇦🇺", languages: ["eng"], count: 1 }],
    languages: [{ id: "English", name: "English", count: 1 }],
    regions: [{ code: "OCE", name: "Oceania", countries: ["AU", "NZ"], count: 1 }],
    subdivisions: [],
    cities: [],
    timezones: [{ id: "Australia/Brisbane", name: "Australia/Brisbane", count: 1 }],
    owners: [],
    networks: [],
    feeds: [{ id: "__main__", name: "Main feed", count: 1 }],
    providers: [{ id: "IPTV-org", name: "IPTV-org", count: 1 }],
    updatedAt: "2026-08-23T00:00:00.000Z",
    source: "IPTV-org API",
  };
}

describe("personal M3U imports", () => {
  it("preserves channel identity, metadata, alternate routes, and provider headers", () => {
    const channels = parsePersonalPlaylist([
      "#EXTM3U",
      '#EXTINF:-1 tvg-id="ABCTV.au" tvg-name="ABC TV" tvg-logo="https://images.test/abc.png" group-title="General" tvg-country="AU" tvg-language="English" tvg-timezone="Australia/Brisbane" quality="1080p",ABC Television',
      "#EXTVLCOPT:http-user-agent=Provider UA/1.0",
      "#EXTVLCOPT:http-referrer=https://provider.test/watch",
      "https://provider.test/abc.m3u8",
      '#EXTINF:-1 tvg-id="ABCTV.au" group-title="General",ABC TV backup',
      "https://backup.test/abc.mpd|User-Agent=Backup%20UA&Referer=https%3A%2F%2Fbackup.test%2Fwatch",
    ].join("\n"), "channels.m3u");

    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      key: "ABCTV.au@main",
      id: "ABCTV.au",
      name: "ABC TV",
      logo: "https://images.test/abc.png",
      categories: ["general"],
      country: "AU",
      languages: ["English"],
      broadcastArea: ["c/AU"],
      timezones: ["Australia/Brisbane"],
      provenance: ["Personal M3U · channels.m3u"],
    });
    expect(channels[0]?.sources).toHaveLength(2);
    expect(channels[0]?.sources[0]?.provenances).toEqual(["Personal M3U · channels.m3u"]);
    expect(channels[0]?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://provider.test/abc.m3u8",
        userAgent: "Provider UA/1.0",
        referrer: "https://provider.test/watch",
        transport: "hls",
        requiresHeaders: true,
      }),
      expect.objectContaining({
        url: "https://backup.test/abc.mpd",
        userAgent: "Backup UA",
        referrer: "https://backup.test/watch",
        transport: "dash",
        requiresHeaders: true,
      }),
    ]));
  });

  it("rejects playlists without a normal HTTP or HTTPS media entry", () => {
    expect(() => parsePersonalPlaylist([
      "#EXTM3U",
      "#EXTINF:-1,Unsafe",
      "file:///private/video.m3u8",
      "#EXTINF:-1,Credential URL",
      "https://user:password@provider.test/live.m3u8",
    ].join("\n"))).toThrow(/No playable HTTP or HTTPS channels/i);
  });

  it("merges additively, extends browse dimensions, and stays idempotent", () => {
    const imported = parsePersonalPlaylist([
      "#EXTM3U",
      '#EXTINF:-1 tvg-id="ABCTV.au" group-title="General" tvg-country="AU",ABC alternate',
      "https://personal.test/abc.m3u8",
      '#EXTINF:-1 tvg-id="NewChannel.au" group-title="Community" tvg-country="AU" tvg-language="English" tvg-timezone="Australia/Sydney",New Community',
      "https://personal.test/new.m3u8",
    ].join("\n"), "personal.m3u");

    const merged = mergePersonalPlaylistIntoCatalog(baseCatalog(), imported);
    expect(merged.channels).toHaveLength(2);
    expect(merged.channels.find((channel) => channel.key === "ABCTV.au@main")?.sources)
      .toHaveLength(2);
    expect(merged.categories.find((item) => item.id === "community")?.count).toBe(1);
    expect(merged.countries.find((item) => item.code === "AU")?.count).toBe(2);
    expect(merged.languages.find((item) => item.id === "English")?.count).toBe(2);
    expect(merged.regions.find((item) => item.code === "OCE")?.count).toBe(2);
    expect(merged.timezones.find((item) => item.id === "Australia/Sydney")?.count).toBe(1);
    expect(merged.feeds.find((item) => item.id === "__main__")?.count).toBe(2);
    expect(merged.providers.find((item) => item.name === "Personal M3U · personal.m3u")?.count).toBe(1);
    expect(merged.source).toBe("IPTV-org API + personal playlist");

    const repeated = mergePersonalPlaylistIntoCatalog(merged, imported);
    expect(repeated.channels).toHaveLength(2);
    expect(repeated.channels.find((channel) => channel.key === "ABCTV.au@main")?.sources)
      .toHaveLength(2);
    expect(repeated.countries.find((item) => item.code === "AU")?.count).toBe(2);
    expect(repeated.source).toBe("IPTV-org API + personal playlist");
  });
});

describe("personal XMLTV imports", () => {
  const xmltv = [
    "<?xml version=\"1.0\"?>",
    "<tv>",
    '<channel id="provider-abc"><display-name>ABC TV HD</display-name></channel>',
    '<channel id="unknown"><display-name>Unknown</display-name></channel>',
    '<programme channel="provider-abc" start="20260823100000 +1000" stop="20260823110000 +1000"><title>Morning News</title><desc>Live bulletin</desc><category>News</category></programme>',
    '<programme channel="unknown" start="20260823100000 +1000" stop="20260823110000 +1000"><title>Discard me</title></programme>',
    "</tv>",
  ].join("");
  const channels = [{ id: "ABCTV.au", name: "ABC TV", altNames: ["ABC Television"] }];

  it("matches known channel names and discards unrelated programmes", () => {
    const result = parsePersonalXmltv(xmltv, channels, "guide.xml");
    expect(result).toMatchObject({
      source: "Personal XMLTV · guide.xml",
      matchedChannels: 1,
    });
    expect(result.programmes).toEqual([expect.objectContaining({
      channelId: "ABCTV.au",
      title: "Morning News",
      description: "Live bulletin",
      category: "News",
    })]);
  });

  it("streams a selected file through the same bounded parser", async () => {
    const bytes = new TextEncoder().encode(xmltv);
    const file = {
      name: "streamed.xmltv",
      size: bytes.byteLength,
      stream: () => new Blob([bytes]).stream(),
    };
    const result = await parsePersonalXmltvFile(file, channels);
    expect(result.source).toBe("Personal XMLTV · streamed.xmltv");
    expect(result.matchedChannels).toBe(1);
    expect(result.programmes[0]?.title).toBe("Morning News");
  });

  it.each([
    "", "provider failed", "\u001f\u008bcompressed gibberish", "<html><body>Error</body></html>",
    "<tv><channel></tv>", "<tv>", `${xmltv}<tv/>`, `<tv>${xmltv}</tv>`,
    '<tv><channel id=unquoted/></tv>', '<tv><channel id="a" id="b"/></tv>',
    '<tv><channel id="abc"><display-name>ABC & bad</display-name></channel></tv>',
    '<tv><channel id="abc"><display-name>&#0;</display-name></channel></tv>',
    `${xmltv}trailing garbage`, "<tv><!-- unfinished</tv>",
    "<tv><!-- invalid -- comment --></tv>", "<tv><![CDATA[unfinished</tv>",
    "<tv>invalid ]]> text</tv>",
    '<!DOCTYPE tv [<!ENTITY name "ABC">]><tv/>',
  ])("rejects malformed or non-XMLTV input before returning a result: %s", async (content) => {
    expect(() => parsePersonalXmltv(content, channels)).toThrow(/XMLTV|XML/i);
    const bytes = new TextEncoder().encode(content);
    await expect(parsePersonalXmltvFile({
      name: "broken.xml", size: bytes.byteLength, stream: () => new Blob([bytes]).stream(),
    }, channels)).rejects.toThrow(/XMLTV|XML/i);
  });

  it("accepts valid empty and unmatched guides without treating them as corrupt", async () => {
    expect(parsePersonalXmltv("<tv/>", channels).programmes).toEqual([]);
    expect(parsePersonalXmltv(xmltv, [{ id: "Other.au", name: "Other channel" }]))
      .toMatchObject({ programmes: [], matchedChannels: 0 });
    const content = '<?xml version="1.0"?><!DOCTYPE tv SYSTEM "xmltv.dtd"><tv><!-- note --></tv>';
    const bytes = new TextEncoder().encode(content);
    await expect(parsePersonalXmltvFile({
      name: "empty.xml", size: bytes.byteLength, stream: () => new Blob([bytes]).stream(),
    }, channels)).resolves.toMatchObject({ programmes: [], matchedChannels: 0 });
  });

  it("validates tags and entities split across single-byte file chunks", async () => {
    const content = xmltv.replace("<tv>", '<tv generator-info-name="Test ]]> source"><?info provider > source?><!-- comment --><![CDATA[metadata <only>]]>')
      .replace("Morning News", "News &amp; Weather");
    const bytes = new TextEncoder().encode(content);
    let offset = 0;
    const result = await parsePersonalXmltvFile({
      name: "chunked.xml", size: bytes.byteLength,
      stream: () => new ReadableStream({
        pull(controller) {
          if (offset < bytes.byteLength) controller.enqueue(bytes.slice(offset, ++offset));
          else controller.close();
        },
      }),
    }, channels);
    expect(result.programmes[0]?.title).toBe("News & Weather");
  });

  it("cancels a selected file as soon as malformed XML is detected", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("<html>")); }, cancel,
    });
    await expect(parsePersonalXmltvFile({ name: "error.xml", size: 6, stream: () => stream }, channels))
      .rejects.toThrow(/XMLTV|XML/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects oversized files before opening their stream", async () => {
    const stream = vi.fn();
    await expect(parsePersonalXmltvFile({ name: "large.xml", size: 128 * 1024 * 1024 + 1, stream }, channels))
      .rejects.toThrow(/128 MiB/);
    expect(stream).not.toHaveBeenCalled();
  });
});
