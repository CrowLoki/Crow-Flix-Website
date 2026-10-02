import { describe, expect, it } from "vitest";
import { answerCrowGuide, type CrowGuideChannel, type CrowGuideProgramme } from "./crowGuide";

const now = Date.parse("2026-09-12T10:00:00Z");
const channel = (key: string, overrides: Partial<CrowGuideChannel> = {}): CrowGuideChannel => ({
  key, id: key, name: key, categories: ["movies"], country: "AU", languages: ["English"], ...overrides,
});
const programme = (channelId: string, title: string, overrides: Partial<CrowGuideProgramme> = {}): CrowGuideProgramme => ({
  channelId, title, start: "2026-09-12T19:30:00+10:00", stop: "2026-09-12T20:30:00+10:00", ...overrides,
});

describe("CrowFlix local helper", () => {
  it("gives honest first-visit choices without claiming viewing history or verified playback", () => {
    const result = answerCrowGuide({ channels: [channel("Films"), channel("Comedy", { categories: ["comedy"] })], now });
    expect(result.message).toContain("starting picks");
    expect(result.message).not.toContain("recent");
    expect(result.candidates[0].reason).toContain("Playback has not been checked");
    expect(result.candidates.every((item) => item.availability === "unverified")).toBe(true);
  });

  it("weights recent interests by recency and recommends a new channel", () => {
    const channels = [channel("seen-comedy", { categories: ["comedy"] }), channel("seen-music", { categories: ["music"] }), channel("new-music", { categories: ["music"] }), channel("new-comedy", { categories: ["comedy"] })];
    const result = answerCrowGuide({ channels, recent: ["seen-comedy", "seen-music"], now });
    expect(result.candidates[0].channel.key).toBe("new-comedy");
    expect(result.candidates[0].reason).toContain("comedy, like channels you opened recently");
  });

  it("uses favourites and their categories, ignores stale keys, and supports My List requests", () => {
    const channels = [channel("favourite", { categories: ["science"] }), channel("science", { categories: ["science"] }), channel("movies")];
    const picks = answerCrowGuide({ channels, favourites: ["favourite", "missing"], now });
    expect(picks.candidates[0].channel.key).toBe("favourite");
    expect(picks.candidates.find((item) => item.channel.key === "science")?.reason).toContain("like channels in your My List");
    const saved = answerCrowGuide({ channels, favourites: ["favourite", "missing"], query: "show my favourites", now });
    expect(saved.intent).toBe("favourites");
    expect(saved.candidates.map((item) => item.channel.key)).toEqual(["favourite"]);
  });

  it("matches natural channel, genre and country queries without ignoring unknown terms", () => {
    const channels = [channel("au-comedy", { name: "Laughs Australia", categories: ["comedy"] }), channel("us-comedy", { name: "American Laughs", country: "US", categories: ["comedy"] }), channel("au-news", { name: "ABC News", categories: [], altNames: ["ABC News 24"] })];
    expect(answerCrowGuide({ channels, query: "find Australian comedy please", now }).candidates.map((item) => item.channel.key)).toEqual(["au-comedy"]);
    expect(answerCrowGuide({ channels, query: "ABC News 24", now }).candidates[0].channel.key).toBe("au-news");
    expect(answerCrowGuide({ channels, query: "show ABC News", now }).candidates[0].channel.key).toBe("au-news");
    expect(answerCrowGuide({ channels, query: "ABC News Australia", now }).candidates[0].channel.key).toBe("au-news");
    expect(answerCrowGuide({ channels, query: "show us comedy", now }).total).toBe(2);
    expect(answerCrowGuide({ channels, query: "US comedy", now }).candidates[0].channel.key).toBe("us-comedy");
    expect(answerCrowGuide({ channels, query: "unicorn orchestra", now }).candidates).toEqual([]);
  });

  it("supports catalogue country names, genre synonyms and broadcast-region mappings", () => {
    const channels = [channel("French Films", { country: "FR", languages: ["French"] }), channel("Regional Films", { country: "NZ", broadcastArea: ["r/OCE"] })];
    expect(answerCrowGuide({ channels, query: "movies from France", countries: [{ code: "FR", name: "France" }], now }).candidates[0].channel.key).toBe("French Films");
    expect(answerCrowGuide({ channels, query: "Australian films", regions: [{ code: "OCE", countries: ["AU", "NZ"] }], now }).candidates[0].channel.key).toBe("Regional Films");
  });

  it("uses current programme titles with timezone-aware, stop-exclusive windows", () => {
    const channels = [channel("documentary", { categories: ["documentary"] }), channel("future"), channel("ended")];
    const programmes = [programme("documentary", "Ocean Wonders"), programme("future", "Ocean Tomorrow", { start: "2026-09-12T11:00:00Z", stop: "2026-09-12T12:00:00Z" }), programme("ended", "Ocean Yesterday", { stop: "2026-09-12T10:00:00Z" })];
    const result = answerCrowGuide({ channels, programmes, query: "what's on now", now });
    expect(result.intent).toBe("now");
    expect(result.candidates.map((item) => item.channel.key)).toEqual(["documentary"]);
    expect(result.candidates[0].programme?.title).toBe("Ocean Wonders");
    expect(result.message).toContain("do not verify playback");
    expect(answerCrowGuide({ channels, programmes, query: "ocean wonders", now }).candidates[0].reason).toContain("Matches the current programme");
  });

  it("keeps My List and recent scope when asking what is on now", () => {
    const channels = [channel("saved"), channel("other"), channel("recent")];
    const programmes = [programme("saved", "Saved show"), programme("other", "Other show"), programme("recent", "Recent show")];
    const saved = answerCrowGuide({ channels, programmes, favourites: ["saved"], query: "what is on my favourites now", now });
    expect(saved.intent).toBe("now");
    expect(saved.candidates.map((item) => item.channel.key)).toEqual(["saved"]);
    expect(saved.message).toContain("My List");
    const recent = answerCrowGuide({ channels, programmes, recent: ["recent"], query: "what is on recently opened channels now", now });
    expect(recent.intent).toBe("now");
    expect(recent.candidates.map((item) => item.channel.key)).toEqual(["recent"]);
    expect(recent.message).toContain("opened recently");
  });

  it("requests guide loading rather than inventing current programmes", () => {
    const result = answerCrowGuide({ channels: [channel("Films")], query: "what is on now", programmes: [programme("Films", "Invalid", { start: "bad date" })], now });
    expect(result.needsGuide).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.message).toContain("Open Guide");
  });

  it("avoids offline and unsupported favourites when viable matches exist", () => {
    const channels = [channel("dead"), channel("unsupported"), channel("ready"), channel("unknown")];
    const result = answerCrowGuide({ channels, favourites: ["dead", "unsupported"], availability: { dead: "temporarily-offline", unsupported: "unsupported", ready: "ready" }, now });
    expect(result.candidates.map((item) => item.channel.key)).toEqual(["ready", "unknown"]);
    const exact = answerCrowGuide({ channels, query: "dead", availability: { dead: "temporarily-offline" }, now });
    expect(exact.candidates[0].channel.key).toBe("dead");
    expect(exact.message).toContain("unavailable or unsupported");
    expect(exact.candidates[0].reason).toContain("recently failed");
  });

  it("returns deterministic distinct pages with a bounded something-else offset", () => {
    const channels = ["E", "A", "F", "B", "D", "C", "G"].map((key) => channel(key));
    const first = answerCrowGuide({ channels, now });
    const second = answerCrowGuide({ channels: [...channels].reverse(), offset: first.nextOffset, now });
    const third = answerCrowGuide({ channels, offset: second.nextOffset, now });
    expect(first.candidates.map((item) => item.channel.key)).toEqual(["A", "B", "C"]);
    expect(second.candidates.map((item) => item.channel.key)).toEqual(["D", "E", "F"]);
    expect(third.candidates.map((item) => item.channel.key)).toEqual(["G"]);
    expect(third.nextOffset).toBe(0);
    expect(answerCrowGuide({ channels, offset: Number.NaN, now }).candidates).toEqual(first.candidates);
  });

  it("keeps recent history ordered without claiming the channels were watched successfully", () => {
    const channels = [channel("older"), channel("latest")];
    const result = answerCrowGuide({ channels, query: "continue watching", recent: ["missing", "latest", "older", "latest"], now });
    expect(result.candidates.map((item) => item.channel.key)).toEqual(["latest", "older"]);
    expect(result.message).toContain("does not confirm it played");
  });

  it("uses current browsing preferences without deleting alternatives", () => {
    const channels = [channel("Australian Films"), channel("French Music", { country: "FR", languages: ["French"], categories: ["music"] })];
    const result = answerCrowGuide({ channels, preferredCountry: "FR", preferredCategory: "music", preferredLanguage: "French", now });
    expect(result.candidates[0].channel.key).toBe("French Music");
    expect(result.total).toBe(2);
  });

  it("handles empty catalogue, empty lists, and unsolicited adult entries honestly", () => {
    expect(answerCrowGuide({ channels: [], now }).message).toContain("not loaded");
    const channels = [channel("Adult", { isNsfw: true }), channel("Family")];
    expect(answerCrowGuide({ channels, now }).candidates.map((item) => item.channel.key)).toEqual(["Family"]);
    expect(answerCrowGuide({ channels, query: "show all movies", now }).candidates.map((item) => item.channel.key)).toEqual(["Family"]);
    expect(answerCrowGuide({ channels, mode: "favourites", now }).message).toContain("My List is empty");
    expect(answerCrowGuide({ channels, mode: "recent", now }).message).toContain("not opened any channels");
    expect(answerCrowGuide({ channels, query: "Adult", now }).candidates[0].channel.key).toBe("Adult");
  });

  it("does not mutate catalogue, preference, programme, or availability inputs", () => {
    const channels = Object.freeze([Object.freeze(channel("Films"))]);
    const programmes = Object.freeze([Object.freeze(programme("Films", "Evening Film"))]);
    const favourites = Object.freeze(["Films"]);
    const recent = Object.freeze(["Films"]);
    const availability = Object.freeze({ Films: "ready" as const });
    expect(() => answerCrowGuide({ channels, programmes, favourites, recent, availability, query: "on now", now })).not.toThrow();
  });
});

describe("CrowGuide local query corpus", () => {
  const channels = [
    channel("comedy", { name: "Laughs", categories: ["comedy"], languages: ["eng"] }),
    channel("mixed", { name: "Comedy News", categories: ["comedy", "news"], languages: ["English"] }),
    channel("news", { name: "Newsroom", categories: ["news"] }),
    channel("french", { name: "Rires", categories: ["comedy"], country: "FR", languages: ["fra"] }),
    channel("unknown-language", { name: "Unlabelled Laughs", categories: ["comedy"], languages: [] }),
  ];

  it.each(["comedy not news", "comedy without news", "comedy excluding news", "comedy but not news"])("respects exclusions in %s", (query) => {
    const result = answerCrowGuide({ channels, query, now });
    expect(result.candidates.map((item) => item.channel.key).sort()).toEqual(["comedy", "french", "unknown-language"]);
  });

  it.each(["English comedy not news", "comedy not news in English", "comedy in en", "English-only comedy without news"])("uses language metadata as a constraint for %s", (query) => {
    const result = answerCrowGuide({ channels: channels.filter((item) => item.key !== "mixed"), query, now });
    expect(result.candidates.map((item) => item.channel.key)).toEqual(["comedy"]);
  });

  it("recognizes language names and excludes languages without confusing channel titles", () => {
    expect(answerCrowGuide({ channels, query: "French comedy", now }).candidates.map((item) => item.channel.key)).toEqual(["french"]);
    expect(answerCrowGuide({ channels, query: "comedy not French", now }).candidates.some((item) => item.channel.key === "french")).toBe(false);
    expect(answerCrowGuide({ channels: [channel("false", { name: "English Comedy", languages: ["Spanish"] })], query: "comedy in English", now }).total).toBe(0);
  });

  it("keeps country aliases and My List constraints with exclusions", () => {
    const result = answerCrowGuide({ channels, favourites: ["comedy", "mixed", "french"], query: "my favourites Australian comedy not news in English", now });
    expect(result.candidates.map((item) => item.channel.key)).toEqual(["comedy"]);
    expect(result.intent).toBe("favourites");
  });

  const scheduleChannels = [channel("first"), channel("later"), channel("tomorrow"), channel("no-guide")];
  const programmes = [
    programme("first", "Current News", { category: "news" }),
    programme("first", "Evening Laughs", { start: "2026-09-12T20:30:00+10:00", stop: "2026-09-12T21:30:00+10:00", category: "comedy" }),
    programme("later", "Late Laughs", { start: "2026-09-12T22:30:00+10:00", stop: "2026-09-12T23:30:00+10:00", category: "comedy" }),
    programme("tomorrow", "Tomorrow Laughs", { start: "2026-09-13T00:00:00+10:00", stop: "2026-09-13T01:00:00+10:00", category: "comedy" }),
  ];

  it.each(["upcoming comedy", "comedy coming up", "what is on next comedy"])("finds future programme metadata for %s", (query) => {
    const result = answerCrowGuide({ channels: scheduleChannels, programmes, query, now, timeZone: "Australia/Sydney" });
    expect(result.intent).toBe("upcoming");
    expect(result.candidates.map((item) => item.programme?.title)).toEqual(["Evening Laughs", "Late Laughs", "Tomorrow Laughs"]);
    expect(result.candidates[0].reason).toContain("20:30");
    expect(result.message).toContain("loaded guide");
    expect(result.message).toContain("do not verify playback");
  });

  it("uses the requested timezone and stop-exclusive evening window for tonight", () => {
    const result = answerCrowGuide({ channels: scheduleChannels, programmes, query: "comedy tonight not news", now, timeZone: "Australia/Sydney" });
    expect(result.intent).toBe("tonight");
    expect(result.candidates.map((item) => item.programme?.title)).toEqual(["Evening Laughs", "Late Laughs"]);
    expect(result.message).toContain("18:00");
    expect(result.message).toContain("Australia/Sydney");
    expect(result.candidates.every((item) => item.programme)).toBe(true);
  });

  it("searches later matching programmes on the same channel and supports EPG aliases", () => {
    const result = answerCrowGuide({
      channels: [channel("alias", { epgAliases: ["first"] })],
      programmes, query: "Evening Laughs upcoming", now,
    });
    expect(result.candidates[0].programme?.title).toBe("Evening Laughs");
  });

  it("preserves favourite scope and paginates future matches deterministically", () => {
    const result = answerCrowGuide({ channels: scheduleChannels, programmes, favourites: ["later"], query: "my favourites tonight", now, timeZone: "Australia/Sydney" });
    expect(result.candidates.map((item) => item.channel.key)).toEqual(["later"]);
    expect(result.message).toContain("My List");
    expect(result.nextOffset).toBe(0);
  });

  it.each(["comedy tonight", "upcoming ocean documentary"])("reports absent or insufficient schedules for %s", (query) => {
    const result = answerCrowGuide({ channels: scheduleChannels, programmes: [programmes[0]], query, now, timeZone: "Australia/Sydney" });
    expect(result.candidates).toEqual([]);
    expect(result.needsGuide).toBe(true);
    expect(result.message).toContain("loaded guide");
    expect(result.message).toContain("Open Guide");
  });

  it("does not claim a title is unavailable when a loaded schedule is incomplete", () => {
    const result = answerCrowGuide({ channels: scheduleChannels, programmes, query: "unlisted programme tonight", now, timeZone: "Australia/Sydney" });
    expect(result.candidates).toEqual([]);
    expect(result.message).toContain("cannot tell");
    expect(result.message).not.toContain("loaded catalogue");
  });

  it("keeps future schedule answers independent of current programme exclusions", () => {
    const result = answerCrowGuide({ channels: [scheduleChannels[0]], programmes, query: "comedy upcoming not news", now });
    expect(result.candidates[0].programme?.title).toBe("Evening Laughs");
  });

  it("excludes finished, invalid and next-day programmes from tonight across DST", () => {
    const channels = ["finished", "ongoing", "evening", "tomorrow", "invalid"].map((key) => channel(key));
    const result = answerCrowGuide({
      channels, query: "tonight", now: Date.parse("2026-10-04T09:00:00Z"), timeZone: "Australia/Sydney",
      programmes: [
        programme("finished", "Finished", { start: "2026-10-04T19:00:00+11:00", stop: "2026-10-04T20:00:00+11:00" }),
        programme("ongoing", "Ongoing", { start: "2026-10-04T19:30:00+11:00", stop: "2026-10-04T20:30:00+11:00" }),
        programme("evening", "Late", { start: "2026-10-04T23:00:00+11:00", stop: "2026-10-05T00:00:00+11:00" }),
        programme("tomorrow", "Tomorrow", { start: "2026-10-05T00:00:00+11:00", stop: "2026-10-05T01:00:00+11:00" }),
        programme("invalid", "Invalid", { start: "invalid", stop: "invalid" }),
      ],
    });
    expect(result.candidates.map((item) => item.programme?.title)).toEqual(["Ongoing", "Late"]);
  });

  it("limits tonight to the evening when it is still afternoon in the viewer timezone", () => {
    const result = answerCrowGuide({ channels: [channel("films")], query: "tonight", now: Date.parse("2026-09-12T03:00:00Z"), timeZone: "Australia/Sydney", programmes: [
      programme("films", "Afternoon", { start: "2026-09-12T13:00:00+10:00", stop: "2026-09-12T17:00:00+10:00" }),
      programme("films", "Evening", { start: "2026-09-12T18:00:00+10:00", stop: "2026-09-12T20:00:00+10:00" }),
    ] });
    expect(result.candidates[0].programme?.title).toBe("Evening");
  });

  it("keeps upcoming pagination stable across input order and reports the next loaded title", () => {
    const channels = ["d", "a", "e", "b", "c"].map((key) => channel(key));
    const programmes = channels.map((item) => programme(item.id, `${item.name} future`, {
      start: "2026-09-12T11:00:00Z", stop: "2026-09-12T12:00:00Z",
    }));
    const first = answerCrowGuide({ channels, programmes, query: "upcoming", now });
    const second = answerCrowGuide({ channels: [...channels].reverse(), programmes: [...programmes].reverse(), query: "upcoming", offset: first.nextOffset, now });
    expect(first.candidates.map((item) => item.channel.key)).toEqual(["a", "b", "c"]);
    expect(second.candidates.map((item) => item.channel.key)).toEqual(["d", "e"]);
    expect(second.nextOffset).toBe(0);
  });
});
