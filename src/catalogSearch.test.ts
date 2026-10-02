import { describe, expect, it } from "vitest";
import { createChannelSearchIndex, matchesChannelSearch, normalizeCatalogSearch } from "./catalogSearch";

const channel = {
  id: "CafeCulture.fr", name: "Café-Culture", altNames: ["L’Écran Français"],
  epgAliases: ["culture-paris"], country: "FR", countryName: "France",
  categories: ["culture"], languages: ["French"], owners: ["Public Media"],
  network: "Europe Network", feed: "Paris HD", provenance: ["Public Directory"],
  timezones: ["Europe/Paris"], broadcastArea: ["c/FR"],
  sources: [{ provenance: "Regional Provider", provenances: ["Official Feed"] }],
};

describe("shared catalogue search", () => {
  it("normalizes accents, case, punctuation and apostrophes consistently", () => {
    expect(normalizeCatalogSearch("  L’ÉCRAN — Café!  ")).toBe("lecran cafe");
    expect(matchesChannelSearch(channel, "CAFE culture")).toBe(true);
    expect(matchesChannelSearch(channel, "l'ecran francais")).toBe(true);
  });

  it.each([
    "culture french", "france culture", "public media", "europe network",
    "paris hd", "public directory", "europe/paris", "c/fr", "culture-paris",
    "CafeCulture.fr", "regional provider", "official feed",
  ])("matches shared channel metadata for %s", (query) => {
    expect(matchesChannelSearch(channel, query)).toBe(true);
  });

  it("requires every query term, preserves non-Latin text and accepts an empty query", () => {
    expect(matchesChannelSearch(channel, "culture german")).toBe(false);
    expect(matchesChannelSearch(channel, "   ")).toBe(true);
    expect(matchesChannelSearch({ name: "東京 ニュース" }, "東京")).toBe(true);
    expect(matchesChannelSearch({ name: "東京 ニュース" }, "大阪")).toBe(false);
  });

  it("does not search media URLs or provider headers", () => {
    const source = { provenance: "Official", url: "https://private.test/secret-token", referrer: "https://referrer.test/" };
    expect(matchesChannelSearch({ name: "Example", sources: [source] }, "secret-token")).toBe(false);
    expect(matchesChannelSearch({ name: "Example", sources: [source] }, "referrer")).toBe(false);
  });

  it("returns the same deterministic results from a full-size catalogue index", () => {
    const channels = Array.from({ length: 13_000 }, (_, index) => ({
      ...channel, id: `channel-${index}`, name: `Channel ${index}`,
      categories: [index % 5 === 0 ? "comedy" : "news"],
      languages: [index % 2 === 0 ? "English" : "French"],
      countryName: index % 2 === 0 ? "Australia" : "France",
    }));
    const indexedSearch = createChannelSearchIndex(channels);
    const expected = channels.filter((_item, index) => index % 10 === 0);
    expect(indexedSearch("english COMÉDY")).toEqual(expected);
    expect(indexedSearch("english comedy")).toEqual(expected);
    expect(indexedSearch("comedy english")).toEqual(expected);
    expect(indexedSearch("doesnotexist")).toEqual([]);
    expect(indexedSearch("")).toEqual(channels);
    expect(indexedSearch("channel 12000")).toEqual(channels.filter((item) => matchesChannelSearch(item, "channel 12000")));
  });

  it("keeps indexed channel order and builds a fresh index for changed metadata", () => {
    const original = Object.freeze([{ name: "First" }, { name: "Second" }]);
    const search = createChannelSearchIndex(original);
    expect(search("")).toEqual(original);
    expect(search("")).not.toBe(original);
    expect(createChannelSearchIndex([{ name: "Renamed" }])("renamed")).toEqual([{ name: "Renamed" }]);
  });
});
