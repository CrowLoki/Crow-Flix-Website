import { audiencePreferenceScore, isHomeEntertainmentChannel } from "./audiencePreferences";
import { canonicalCountryCode, channelMatchesCountry, type BroadcastRegion } from "./broadcastArea";
import { normalizeCatalogSearch as normalized } from "./catalogSearch";
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

export type CrowGuideIntent = "recommend" | "search" | "now" | "upcoming" | "tonight" | "favourites" | "recent";

export type CrowGuideRequest<T extends CrowGuideChannel, P extends CrowGuideProgramme = CrowGuideProgramme> = {
  channels: readonly T[];
  programmes?: readonly P[];
  recent?: readonly string[];
  favourites?: readonly string[];
  availability?: Readonly<Record<string, ChannelAvailability>>;
  query?: string;
  mode?: CrowGuideIntent;
  now?: number | Date;
  timeZone?: string;
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

const FILLER = new Set(("a all an and are but can could find for from give good i id in is it like looking me my of on only or please recommend recommendations show some something suggest suggestions the to tonight tv us want watch watching what whats with would you your channels channel now live else recently recent watched opened continue again last saved favourite favourites favorite favorites list currently playing upcoming coming up next later this evening language programmes programs programme program").split(" "));

const NOW_REQUEST = /\b(?:whats on|what is on|on now|playing now|currently on|now playing)\b/;
const FAVOURITES_REQUEST = /\b(?:favourites?|favorites?|my list|saved channels)\b/;
const RECENT_REQUEST = /\b(?:recent|recently|continue watching|watch again|last watched)\b/;
const TONIGHT_REQUEST = /\b(?:tonight|this evening)\b/;
const UPCOMING_REQUEST = /\b(?:upcoming|coming up|next|later)\b/;

const LANGUAGE_ALIASES: Record<string, readonly string[]> = {
  english: ["english", "en", "eng"],
  french: ["french", "fr", "fra", "fre"],
  spanish: ["spanish", "es", "spa"],
  german: ["german", "de", "deu", "ger"],
  italian: ["italian", "it", "ita"],
  portuguese: ["portuguese", "pt", "por"],
  japanese: ["japanese", "ja", "jpn"],
  chinese: ["chinese", "zh", "zho", "chi"],
  arabic: ["arabic", "ar", "ara"],
  hindi: ["hindi", "hi", "hin"],
  korean: ["korean", "ko", "kor"],
};

function languageName(value: string): string {
  const term = normalized(value);
  return Object.keys(LANGUAGE_ALIASES).find((name) => LANGUAGE_ALIASES[name].includes(term)) || term;
}

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

function includesPhrase(text: string, phrase: string): boolean {
  return (` ${text} `).includes(` ${phrase} `);
}

function unavailable(value: ChannelAvailability): boolean {
  return value === "temporarily-offline" || value === "unsupported";
}

function intentFor(query: string, mode?: CrowGuideIntent): CrowGuideIntent {
  if (mode) return mode;
  if (TONIGHT_REQUEST.test(query)) return "tonight";
  if (UPCOMING_REQUEST.test(query)) return "upcoming";
  if (NOW_REQUEST.test(query)) return "now";
  if (FAVOURITES_REQUEST.test(query)) return "favourites";
  if (RECENT_REQUEST.test(query)) return "recent";
  return query.split(" ").some((word) => word && !FILLER.has(word)) ? "search" : "recommend";
}

function splitExclusions(query: string): { positive: string; exclusions: string[] } {
  const parts = query.split(/\b(?:not|without|excluding|except|no)\b/);
  let positive = parts[0];
  const exclusions: string[] = [];
  for (const part of parts.slice(1)) {
    // A following preposition starts a positive constraint, e.g. "not news in English".
    const boundary = part.match(/\b(?:in|from|with|but)\b/);
    const index = boundary?.index ?? part.length;
    const excluded = part.slice(0, index).trim();
    if (excluded) exclusions.push(excluded);
    if (index < part.length) positive += ` ${part.slice(index)}`;
  }
  return { positive: positive.trim(), exclusions };
}

type GuideFilters = { countries: string[]; genres: string[]; languages: string[]; tokens: string[] };

function parseFilters(
  query: string,
  countryAliases: ReadonlyMap<string, ReadonlySet<string>>,
  languages: ReadonlySet<string>,
): GuideFilters {
  const consumed = new Set<string>();
  const consume = (phrase: string) => phrase.split(" ").forEach((word) => consumed.add(word));
  const countries: string[] = [];
  const genres: string[] = [];
  const requestedLanguages: string[] = [];
  for (const [code, aliases] of countryAliases) {
    for (const alias of aliases) if (includesPhrase(query, alias)) {
      if (!countries.includes(code)) countries.push(code);
      consume(alias);
    }
  }
  for (const [genre, terms] of Object.entries(GENRES)) {
    for (const term of terms) if (includesPhrase(query, term)) {
      if (!genres.includes(genre)) genres.push(genre);
      consume(term);
    }
  }
  for (const language of languages) {
    for (const alias of LANGUAGE_ALIASES[language] || [language]) {
      const explicit = alias.length > 3 || query === alias || includesPhrase(query, `in ${alias}`)
        || includesPhrase(query, `${alias} language`);
      if (explicit && includesPhrase(query, alias)) {
        if (!requestedLanguages.includes(language)) requestedLanguages.push(language);
        consume(alias);
      }
    }
  }
  return {
    countries, genres, languages: requestedLanguages,
    tokens: query.split(" ").filter((word) => word && !FILLER.has(word) && !consumed.has(word)),
  };
}

function guideTimeZone(timeZone?: string): string {
  try { return new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone; }
  catch { return new Intl.DateTimeFormat("en").resolvedOptions().timeZone; }
}

/** Convert the viewer's evening boundaries using offsets at each boundary (including DST). */
function tonightWindow(now: number, timeZone: string): { start: number; end: number } {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  });
  const localParts = (time: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
  };
  const date = localParts(now);
  const localToUtc = (local: number) => {
    let candidate = local;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = localParts(candidate);
      const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      candidate += local - represented;
    }
    return candidate;
  };
  return {
    start: Math.max(now, localToUtc(Date.UTC(date.year, date.month - 1, date.day, 18))),
    end: localToUtc(Date.UTC(date.year, date.month - 1, date.day + 1)),
  };
}

/** Answers only from the supplied catalogue, local preferences and already-loaded guide. */
export function answerCrowGuide<T extends CrowGuideChannel, P extends CrowGuideProgramme = CrowGuideProgramme>(
  request: CrowGuideRequest<T, P>,
): CrowGuideResponse<T, P> {
  const query = normalized((request.query || "").slice(0, 300));
  const { positive: positiveQuery, exclusions } = splitExclusions(query);
  const intent = intentFor(query, request.mode);
  const scheduleIntent = intent === "now" || intent === "upcoming" || intent === "tonight";
  const futureIntent = intent === "upcoming" || intent === "tonight";
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

  const timeZone = guideTimeZone(request.timeZone);
  const evening = intent === "tonight" ? tonightWindow(now, timeZone) : undefined;
  const programmeTime = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const listings = new Map<string, Array<{ programme: P; start: number }>>();
  for (const programme of request.programmes || []) {
    const start = Date.parse(programme.start);
    const stop = Date.parse(programme.stop);
    if (!(Number.isFinite(start) && Number.isFinite(stop) && start < stop)) continue;
    if (evening ? !(start < evening.end && stop > evening.start)
      : intent === "upcoming" ? start <= now : !(start <= now && now < stop)) continue;
    const entries = listings.get(programme.channelId) || [];
    entries.push({ programme, start });
    listings.set(programme.channelId, entries);
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
  for (const [code, names] of aliases) {
    const codeWord = code.toLowerCase();
    // Avoid reading conversational "show us" or "in" as US/India filters.
    if (query === codeWord || (request.query || "").split(/\W+/).includes(code) || includesPhrase(query, `from ${codeWord}`)) names.add(codeWord);
  }
  const knownLanguages = new Set(Object.keys(LANGUAGE_ALIASES));
  for (const channel of request.channels) {
    for (const language of channel.languages) knownLanguages.add(languageName(language));
  }
  const filters = parseFilters(positiveQuery, aliases, knownLanguages);
  const excludedFilters = exclusions.map((part) => parseFilters(part, aliases, knownLanguages));
  const requestedCountries = new Set(filters.countries);
  const requestedGenres = new Set(filters.genres);
  const tokens = filters.tokens;
  const queryHasFilters = requestedCountries.size > 0 || requestedGenres.size > 0 || filters.languages.length > 0 || tokens.length > 0 || exclusions.length > 0;
  const scored: Array<CrowGuideCandidate<T, P> & { score: number }> = [];
  let matchingWithoutGuide = 0;
  for (const channel of request.channels) {
    if (favouriteScope && !favourites.has(channel.key)) continue;
    if (recentScope && !recentOrder.has(channel.key)) continue;
    const names = [channel.name, ...(channel.altNames || [])].map(normalized);
    const categories = channel.categories.map(normalized);
    const languages = channel.languages.map(languageName);
    const channelText = [...names, ...categories, ...languages].join(" ");
    const exactName = Boolean(positiveQuery && names.includes(positiveQuery));
    const namePhrase = Boolean(positiveQuery && names.some((name) => name && includesPhrase(positiveQuery, name)));
    // Keep ordinary genre recommendations from introducing adult channels.
    if (channel.isNsfw && !namePhrase && !/\b(?:adult|xxx|porn|pornography)\b/.test(positiveQuery)
      && !favouriteScope && !recentScope) continue;
    const countryMatch = [...requestedCountries].some((code) => channelMatchesCountry(channel, code, request.regions || []));
    if (requestedCountries.size > 0 && !countryMatch) continue;
    if (filters.languages.length && !filters.languages.some((language) => languages.includes(language))) continue;
    matchingWithoutGuide += 1;
    const channelListings = [...new Set([channel.id, ...(channel.epgAliases || [])])]
      .flatMap((id) => listings.get(id) || [])
      .sort((left, right) => (futureIntent ? left.start - right.start : right.start - left.start)
        || left.programme.title.localeCompare(right.programme.title, "en"));
    const options: Array<P | undefined> = futureIntent ? channelListings.map((entry) => entry.programme)
      : [channelListings[0]?.programme];
    let match: { programme?: P; programmeText: string; matchedGenres: string[] } | undefined;
    for (const programme of options) {
      if (scheduleIntent && !programme) continue;
      const programmeText = programme ? normalized(`${programme.title} ${programme.category || ""} ${programme.description || ""}`) : "";
      const text = `${channelText} ${programmeText}`;
      const genresFor = (genres: readonly string[]) => genres.filter((genre) => categories.includes(genre)
        || GENRES[genre].some((term) => includesPhrase(programmeText, term)));
      const matchedGenres = genresFor(filters.genres);
      if (!exactName && ((requestedGenres.size > 0 && matchedGenres.length === 0 && !namePhrase)
        || !tokens.every((token) => text.includes(token)))) continue;
      const excluded = excludedFilters.some((filter) => {
        const hasTerms = filter.countries.length || filter.languages.length || filter.genres.length || filter.tokens.length;
        return hasTerms
          && (!filter.countries.length || filter.countries.some((code) => channelMatchesCountry(channel, code, request.regions || [])))
          && (!filter.languages.length || filter.languages.some((language) => languages.includes(language)))
          && (!filter.genres.length || genresFor(filter.genres).length > 0 || filter.genres.some((genre) => GENRES[genre].some((term) => names.some((name) => includesPhrase(name, term)))))
          && filter.tokens.every((token) => text.includes(token));
      });
      if (!excluded) { match = { programme, programmeText, matchedGenres }; break; }
    }
    if (!match) continue;
    const { programme, programmeText, matchedGenres } = match;

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
    if (request.preferredLanguage && languages.includes(languageName(request.preferredLanguage))) score += 12;

    let reason: string;
    if (intent === "now" && programme) reason = `On the loaded guide now: ${programme.title}.`;
    else if (futureIntent && programme) reason = `In the loaded guide ${intent === "tonight" ? "tonight" : "upcoming"} at ${programmeTime.format(Date.parse(programme.start))} (${timeZone}): ${programme.title}.`;
    else if (exactName) reason = "Exact channel-name match.";
    else if (namePhrase) reason = "Channel-name match.";
    else if (tokens.length && programme && tokens.every((token) => programmeText.includes(token))) reason = `Matches the current programme: ${programme.title}.`;
    else if (queryHasFilters) {
      const matches = [...matchedGenres, ...filters.languages, ...[...requestedCountries].filter((code) => channelMatchesCountry(channel, code, request.regions || [])).map((code) => countryNames.get(code) || code)];
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
    .sort((a, b) => (futureIntent ? Date.parse(a.programme!.start) - Date.parse(b.programme!.start) : 0)
      || b.score - a.score || a.channel.name.localeCompare(b.channel.name, "en") || a.channel.key.localeCompare(b.channel.key, "en"));
  const offset = Number.isFinite(request.offset) ? Math.max(0, Math.trunc(request.offset!)) : 0;
  const start = ranked.length ? offset % ranked.length : 0;
  const candidates = ranked.slice(start, start + 3).map(({ score: _score, ...candidate }) => candidate);
  const needsGuide = scheduleIntent && ranked.length === 0 && matchingWithoutGuide > 0;
  let message: string;
  if (!request.channels.length) message = "The catalogue is not loaded yet. Load it to search or get suggestions.";
  else if (favouriteScope && !favourites.size) message = "Your My List is empty. Save a channel with its heart button, then I can help you choose.";
  else if (recentScope && !recent.length) message = "You have not opened any channels on this device yet. Ask for a channel or genre to get started.";
  else if (needsGuide) message = `I found no matching ${intent === "now" ? "current" : intent === "tonight" ? "tonight" : "upcoming"} programme listings in the loaded guide. Its schedule may be incomplete, so I cannot tell whether a matching programme is available. Open Guide to load or refresh listings.`;
  else if (!ranked.length) message = intent === "favourites" && !favourites.size
    ? "Your My List is empty. Save a channel with its heart button, then I can help you choose."
    : intent === "recent" && !recent.length
      ? "You have not opened any channels on this device yet. Ask for a channel or genre to get started."
      : "I could not find a match in the loaded catalogue. Try a channel name, genre or country.";
  else if (!hasViable) message = "I found matching channels, but their sources are currently unavailable or unsupported. Check their details before trying playback.";
  else if (futureIntent) message = `These are ${intent === "tonight" ? `tonight's remaining programmes (18:00–24:00, ${timeZone})` : "upcoming programmes"}${favouriteScope ? " on channels in your My List" : recentScope ? " on channels you opened recently" : ""} from the loaded guide. Loaded listings may be incomplete. Programme listings do not verify playback.`;
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
