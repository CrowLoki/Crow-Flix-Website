import { describe, expect, it, vi } from "vitest";
import {
  additivePlaylistConfigs,
  loadAdditivePlaylists,
  MAX_ADDITIVE_PLAYLIST_BYTES,
  parseAdditivePlaylist,
} from "./additivePlaylists";

describe("additive public playlists", () => {
  it("selects the Australian playlist matching the browser timezone", () => {
    const [brisbane] = additivePlaylistConfigs("Australia/Brisbane");
    expect(brisbane).toMatchObject({
      id: "mjh-au-brisbane",
      url: "https://i.mjh.nz/au/Brisbane/raw-tv.m3u8",
      broadcastArea: ["s/AU-QLD"],
      timezones: ["Australia/Brisbane"],
    });
  });

  it("parses provider metadata, headers, logo, group, and URL", () => {
    const config = additivePlaylistConfigs("Australia/Brisbane")[0]!;
    const entries = parseAdditivePlaylist([
      "#EXTM3U",
      '#EXTINF:-1 channel-id="mjh-seven-bri" tvg-id="mjh-seven-bri" tvg-logo="https://img.test/seven.png" group-title="Brisbane", Seven',
      "#EXTVLCOPT:http-user-agent=Provider UA",
      "#EXTVLCOPT:http-referrer=https://provider.test/",
      "https://provider.test/seven.m3u8",
    ].join("\n"), config);

    expect(entries).toEqual([{
      providerId: "mjh-seven-bri",
      name: "Seven",
      logo: "https://img.test/seven.png",
      group: "Brisbane",
      url: "https://provider.test/seven.m3u8",
      userAgent: "Provider UA",
      referrer: "https://provider.test/",
      config,
    }]);
  });

  it("rejects an oversized playlist", () => {
    const config = additivePlaylistConfigs("Australia/Brisbane")[0]!;
    expect(parseAdditivePlaylist("x".repeat(MAX_ADDITIVE_PLAYLIST_BYTES + 1), config))
      .toEqual([]);
  });

  it("loads every configured playlist through the bounded relay fetch path", async () => {
    const playlist = "#EXTM3U\n#EXTINF:-1 tvg-id=\"one\",One\nhttps://provider.test/one.m3u8\n";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/fetch");
      expect(init?.cache).toBe("no-store");
      return new Response(playlist);
    });

    const entries = await loadAdditivePlaylists("Australia/Brisbane", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.config.id)).toEqual([
      "mjh-au-brisbane",
      "mjh-nz",
      "mjh-world",
    ]);
  });
});
