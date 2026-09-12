import { audiencePreferenceScore, isHomeEntertainmentChannel } from "./audiencePreferences";
import { canonicalCountryCode, channelMatchesCountry, type BroadcastRegion } from "./broadcastArea";
import type { ChannelAvailability } from "./playback/availability";

export type CrowGuideChannel = {
  key: string;
  id: string;
  name: string;
  altNames?: readonly string[];
  epgAliases?: readonly string[];
  categories: readonly string[];
  country?: string | null;
  languages: readonly string[];
  broadcastArea?: readonly string[];
  isNsfw?: boolean;
};

export type CrowGuideProgramme = {
  channelId: string;
  title: string;
  description?: string | null;
  category?: string | null;
  start: string;
  stop: string;
};

export type CrowGuideIntent = "recommend" | "search" | "now" | "favourites" | "recent";

export type CrowGuideRequest<T extends CrowGuideChannel, P extends CrowGuideProgramme = CrowGuideProgramme> = {
  channels: readonly T[];
  programmes?: readonly P[];
  recent?: readonly string[];
  favourites?: readonly string[];
  availability?: Readonly<Record<string, ChannelAvailability>>;
  query?: string;
  mode?: CrowGuideIntent;
  now?: number | Date;
  offset?: number;
  countries?: readonly { code: string; name: string }[];
  regions?: readonly BroadcastRegion[];
  preferredCountry?: string;
  preferredCategory?: string;
  preferredLanguage?: string;
};

export type CrowGuideCandidate<T extends CrowGuideChannel, P extends CrowGuideProgramme = CrowGuideProgramme> = {
  channel: T;
  programme?: P;
  reason: string;
  availability: ChannelAvailability;
};

export type CrowGuideResponse<T extends CrowGuideChannel, P extends CrowGuideProgramme = CrowGuideProgramme> = {
  intent: CrowGuideIntent;
  message: string;
  candidates: CrowGuideCandidate<T, P>[];
  total: number;
  nextOffset: number;
  needsGuide: boolean;
};

const GENRES: Record<string, readonly string[]> = {
  animation: ["animation", "anime", "cartoons", "cartoon"],
  classic: ["classic", "classics"],
  comedy: ["comedy", "comedies", "funny"],
  cooking: ["cooking", "food", "cookery"],
  culture: ["culture", "cultural"],
  documentary: ["documentary", "documentaries"],
  education: ["education", "educational"],
  entertainment: ["entertainment"],
  family: ["family"],
  kids: ["kids", "children", "childrens"],
  movies: ["movies", "movie", "films", "film", "cinema"],
  music: ["music", "concerts", "concert"],
  news: ["news"],
  science: ["science", "scientific"],
  series: ["series", "sitcom", "sitcoms", "drama"],
  sports: ["sports", "sport"],
  travel: ["travel"],
  weather: ["weather"],
};

const COUNTRY_ALIASES: Record<string, readonly string[]> = {
  AU: ["australia", "australian", "aussie"],
  US: ["united states", "united states of america", "america", "american", "usa"],
  UK: ["united kingdom", "britain", "british", "uk", "gb"],
  NZ: ["new zealand", "new zealanders", "kiwi", "nz"],
  CA: ["canada", "canadian"],
};

const FILLER = new Set(("a all an and are can could find for from give good i id in is it like looking me my of on please recommend recommendations show some something suggest suggestions the to tonight tv us want watch watching what whats with would you your channels channel now live else recently recent watched opened continue again last saved favourite favourites favorite favorites list currently playing").split(" "));

const NOW_REQUEST = /\b(?:whats on|what is on|on now|playing now|currently on|now playing)\b/;
const FAVOURITES_REQUEST = /\b(?:favourites?|favorites?|my list|saved channels)\b/;
const RECENT_REQUEST = /\b(?:recent|recently|continue watching|watch again|last watched)\b/;

const AVAILABILITY_SCORE: Record<ChannelAvailability, number> = {
  verified: 24,
  ready: 16,
  unverified: 0,
  "part-time": -4,
  "region-limited": -8,
  "temporarily-offline": -80,
  unsupported: -100,
};

const AVAILABILITY_NOTE: Partial<Record<ChannelAvailability, string>> = {
  unverified: "Playback has not been checked yet.",
  ready: "A source responded; playback is not yet verified.",
  "part-time": "This channel may only broadcast at certain times.",
  "region-limited": "This channel may be restricted in your region.",
  "temporarily-offline": "Its playback routes recently failed.",
  unsupported: "Its sources are unsupported in this browser.",
};

function normalized(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en")
    .replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function includesPhrase(text: string, phrase: string): boolean {
  return (` ${text} `).includes(` ${phrase} `);
}

function unavailable(value: ChannelAvailability): boolean {
  return value === "temporarily-offline" || value === "unsupported";
}

function intentFor(query: string, mode?: CrowGuideIntent): CrowGuideIntent {
  if (mode) return mode;
  if (NOW_REQUEST.test(query)) return "now";
  if (FAVOURITES_REQUEST.test(query)) return "favourites";
  if (RECENT_REQUEST.test(query)) return "recent";
  return query.split(" ").some((word) => word && !FILLER.has(word)) ? "search" : "recommend";
}

/** Answers only from the supplied catalogue, local preferences and already-loaded guide. */
export function answerCrowGuide<T extends CrowGuideChannel, P extends CrowGuideProgramme = CrowGuideProgramme>(
  request: CrowGuideRequest<T, P>,
): CrowGuideResponse<T, P> {
  const query = normalized((request.query || "").slice(0, 300));
  const intent = intentFor(query, request.mode);
  const favouriteScope = request.mode === "favourites" || FAVOURITES_REQUEST.test(query);
  const recentScope = !favouriteScope && (request.mode === "recent" || RECENT_REQUEST.test(query));
  const now = request.now instanceof Date ? request.now.getTime() : request.now ?? Date.now();
  const channelsByKey = new Map(request.channels.map((channel) => [channel.key, channel]));
  const recent = [...new Set(request.recent || [])].filter((key) => channelsByKey.has(key));
  const favourites = new Set((request.favourites || []).filter((key) => channelsByKey.has(key)));
  const recentOrder = new Map(recent.map((key, index) => [key, index]));
  const categoryWeights = new Map<string, number>();
  const favouriteCategories = new Set<string>();
  for (const key of favourites) {
    for (const category of channelsByKey.get(key)!.categories) {
      const value = normalized(category);
      favouriteCategories.add(value);
      categoryWeights.set(value, (categoryWeights.get(value) || 0) + 12);
    }
  }
  recent.forEach((key, index) => {
    for (const category of channelsByKey.get(key)!.categories) {
      const value = normalized(category);
      categoryWeights.set(value, (categoryWeights.get(value) || 0) + 24 / (index + 1));
    }
  });

  const current = new Map<string, { programme: P; start: number }>();
  for (const programme of request.programmes || []) {
    const start = Date.parse(programme.start);
    const stop = Date.parse(programme.stop);
    if (!(start <= now && now < stop)) continue;
    const existing = current.get(programme.channelId);
    if (!existing || start > existing.start || (start === existing.start && programme.title < existing.programme.title)) {
      current.set(programme.channelId, { programme, start });
    }
  }

  const countryNames = new Map<string, string>();
  const aliases = new Map<string, Set<string>>();
  for (const [code, names] of Object.entries(COUNTRY_ALIASES)) aliases.set(code, new Set(names));
  for (const country of request.countries || []) {
    const code = canonicalCountryCode(country.code);
    countryNames.set(code, country.name);
    const names = aliases.get(code) || new Set<string>();
    names.add(normalized(country.name));
    aliases.set(code, names);
  }
  for (const channel of request.channels) {
    const code = canonicalCountryCode(channel.country);
    if (code && !aliases.has(code)) aliases.set(code, new Set());
  }
  const requestedCountries = new Set<string>();
  const consumed = new Set<string>();
  const consume = (phrase: string) => phrase.split(" ").forEach((word) => consumed.add(word));
  for (const [code, names] of aliases) {
    const codeWord = code.toLowerCase();
    // Avoid reading conversational "show us" or "in" as US/India filters.
    if (query === codeWord || (request.query || "").split(/\W+/).includes(code) || includesPhrase(query, `from ${codeWord}`)) names.add(codeWord);
    for (const name of names) {
      if (name && includesPhrase(query, name)) {
        requestedCountries.add(code);
        consume(name);
      }
    }
  }
  const requestedGenres = new Set<string>();
  for (const [genre, terms] of Object.entries(GENRES)) {
    for (const term of terms) {
      if (includesPhrase(query, term)) {
        requestedGenres.add(genre);
        consume(term);
      }
    }
  }
  const tokens = query.split(" ").filter((word) => word && !FILLER.has(word) && !consumed.has(word));
  const queryHasFilters = requestedCountries.size > 0 || requestedGenres.size > 0 || tokens.length > 0;
  const scored: Array<CrowGuideCandidate<T, P> & { score: number }> = [];
  let matchingWithoutGuide = 0;
  for (const channel of request.channels) {
    if (favouriteScope && !favourites.has(channel.key)) continue;
    if (recentScope && !recentOrder.has(channel.key)) continue;
    const programme = [channel.id, ...(channel.epgAliases || [])]
      .map((id) => current.get(id)?.programme).find((item) => item !== undefined);
    const names = [channel.name, ...(channel.altNames || [])].map(normalized);
    const categories = channel.categories.map(normalized);
    const programmeText = programme ? normalized(`${programme.title} ${programme.category || ""} ${programme.description || ""}`) : "";
    const text = [...names, ...categories, ...channel.languages.map(normalized), programmeText].join(" ");
    const exactName = Boolean(query && names.includes(query));
    const namePhrase = Boolean(query && names.some((name) => name && includesPhrase(query, name)));
    // Keep ordinary genre recommendations from introducing adult channels.
    if (channel.isNsfw && !namePhrase && !/\b(?:adult|xxx|porn|pornography)\b/.test(query)
      && !favouriteScope && !recentScope) continue;
    const countryMatch = [...requestedCountries].some((code) => channelMatchesCountry(channel, code, request.regions || []));
    const matchedGenres = [...requestedGenres].filter((genre) => categories.includes(genre)
      || GENRES[genre].some((term) => includesPhrase(programmeText, term)));
    if (!exactName && ((requestedCountries.size > 0 && !countryMatch)
      || (requestedGenres.size > 0 && matchedGenres.length === 0 && !namePhrase)
      || !tokens.every((token) => text.includes(token)))) continue;
    matchingWithoutGuide += 1;
    if (intent === "now" && !programme) continue;

    const availability = request.availability?.[channel.key] || "unverified";
    const historyMatch = categories.filter((category) => categoryWeights.has(category))
      .sort((a, b) => (categoryWeights.get(b) || 0) - (categoryWeights.get(a) || 0) || a.localeCompare(b))[0];
    let score = AVAILABILITY_SCORE[availability] + audiencePreferenceScore(channel);
    if (exactName) score += 120;
    else if (namePhrase) score += 90;
    if (tokens.length) score += names.some((name) => tokens.every((token) => name.includes(token))) ? 70 : 35;
    score += matchedGenres.length * 16;
    if (requestedCountries.has(canonicalCountryCode(channel.country))) score += 12;
    if (favourites.has(channel.key)) score += 26;
    if (historyMatch) score += categoryWeights.get(historyMatch) || 0;
    const recentIndex = recentOrder.get(channel.key);
    if (intent === "recent") score = 10_000 - (recentIndex ?? 10_000);
    else if (intent === "recommend" && recentIndex !== undefined) score -= 35;
    if (intent === "recommend" && isHomeEntertainmentChannel(channel)) score += 10;
    if (request.preferredCountry && request.preferredCountry !== "all"
      && channelMatchesCountry(channel, request.preferredCountry, request.regions || [])) score += 18;
    if (request.preferredCategory && categories.includes(normalized(request.preferredCategory))) score += 18;
    if (request.preferredLanguage && channel.languages.some((language) => normalized(language) === normalized(request.preferredLanguage!))) score += 12;

    let reason: string;
    if (intent === "now" && programme) reason = `On the loaded guide now: ${programme.title}.`;
    else if (exactName) reason = "Exact channel-name match.";
    else if (namePhrase) reason = "Channel-name match.";
    else if (tokens.length && programme && tokens.every((token) => programmeText.includes(token))) reason = `Matches the current programme: ${programme.title}.`;
    else if (queryHasFilters) {
      const matches = [...matchedGenres, ...[...requestedCountries].filter((code) => channelMatchesCountry(channel, code, request.regions || [])).map((code) => countryNames.get(code) || code)];
      reason = matches.length ? `Matches ${matches.join(" · ")}.` : "Matches your channel search.";
    } else if (intent === "recent") reason = "One of your recently opened channels.";
    else if (favourites.has(channel.key)) reason = "Saved in your My List.";
    else if (historyMatch) reason = favouriteCategories.has(historyMatch)
      ? `More ${historyMatch}, like channels in your My List.`
      : `More ${historyMatch}, like channels you opened recently.`;
    else reason = "A catalogue pick to get you started.";
    const note = AVAILABILITY_NOTE[availability];
    scored.push({ channel, programme, availability, reason: note ? `${reason} ${note}` : reason, score });
  }
  const hasViable = scored.some((item) => !unavailable(item.availability));
  const ranked = scored.filter((item) => !hasViable || !unavailable(item.availability))
    .sort((a, b) => b.score - a.score || a.channel.name.localeCompare(b.channel.name, "en") || a.channel.key.localeCompare(b.channel.key, "en"));
  const offset = Number.isFinite(request.offset) ? Math.max(0, Math.trunc(request.offset!)) : 0;
  const start = ranked.length ? offset % ranked.length : 0;
  const candidates = ranked.slice(start, start + 3).map(({ score: _score, ...candidate }) => candidate);
  const needsGuide = intent === "now" && ranked.length === 0 && matchingWithoutGuide > 0;
  let message: string;
  if (!request.channels.length) message = "The catalogue is not loaded yet. Load it to search or get suggestions.";
  else if (favouriteScope && !favourites.size) message = "Your My List is empty. Save a channel with its heart button, then I can help you choose.";
  else if (recentScope && !recent.length) message = "You have not opened any channels on this device yet. Ask for a channel or genre to get started.";
  else if (needsGuide) message = "I do not have current programme listings for these channels. Open Guide to load what is on now.";
  else if (!ranked.length) message = intent === "favourites" && !favourites.size
    ? "Your My List is empty. Save a channel with its heart button, then I can help you choose."
    : intent === "recent" && !recent.length
      ? "You have not opened any channels on this device yet. Ask for a channel or genre to get started."
      : "I could not find a match in the loaded catalogue. Try a channel name, genre or country.";
  else if (!hasViable) message = "I found matching channels, but their sources are currently unavailable or unsupported. Check their details before trying playback.";
  else if (intent === "now" && favouriteScope) message = "These programmes are on now on channels in your My List, according to the loaded guide. Programme listings do not verify playback.";
  else if (intent === "now" && recentScope) message = "These programmes are on now on channels you opened recently, according to the loaded guide. Programme listings do not verify playback.";
  else if (intent === "now") message = "These programmes are on now according to your loaded guide. Programme listings do not verify playback.";
  else if (intent === "favourites") message = "Here are channels saved in your My List.";
  else if (intent === "recent") message = "Here are channels you opened recently. Opening a channel does not confirm it played.";
  else if (intent === "search" || queryHasFilters) message = `I found ${ranked.length.toLocaleString("en")} matching ${ranked.length === 1 ? "channel" : "channels"} in the loaded catalogue.`;
  else if (recent.length || favourites.size) message = "These picks use your recent channels and My List on this device. Choose something else for more options.";
  else message = "Here are a few starting picks. Tell me a channel, genre or country and I can narrow them down.";
  return { intent, message, candidates, total: ranked.length, nextOffset: ranked.length ? (start + candidates.length) % ranked.length : 0, needsGuide };
}
