// CrowFlix web catalogue: a faithful TypeScript port of the Rust
// `build_catalog` pipeline (src-tauri/src/lib.rs) so the browser build loads
// the same authoritative IPTV-org catalogue the desktop app uses.
//
// Differences from the desktop pipeline, by design:
// - The fixed Apsattv FAST-playlist snapshots are downloaded through the
//   bounded CrowFlix relay path rather than directly from the browser.
// - Caching uses the Cache API (12 h read-through, stale-on-failure) instead
//   of the Tauri app-data cache file.

import type {
  CatalogSourceHealth,
  StreamSource,
  TransportHint,
} from "./playback/types";
import {
  loadAdditivePlaylists,
  type AdditivePlaylistEntry,
} from "./additivePlaylists";
import { RELAY_BASE } from "./relayClient";
import {
  isFreshCatalogHealth,
  loadStreamHealthIndex,
  sourceUsesLiteralIp,
  streamSourceHealthIdentity,
} from "./streamHealthIndex";

export const WEB_CATALOG_CACHE_NAME = "crowflix-catalog-v8";
export const WEB_CATALOG_CACHE_KEY = "https://crowflix.cache/web-catalog-v8";
export const MAIN_FEED_OPTION_ID = "__main__";
const WEB_CATALOG_TTL_MS = 12 * 60 * 60 * 1000;
const API_BASE = "https://iptv-org.github.io/api";
const FETCH_TIMEOUT_MS = 45_000;
const OPTIONAL_FAST_FETCH_TIMEOUT_MS = 12_000;
const MAX_OPTIONAL_FAST_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_OPTIONAL_FAST_PLAYLIST_ENTRIES = 50_000;

export const OPTIONAL_FAST_PLAYLISTS = [
  "https://www.apsattv.com/ssungaus.m3u",
  "https://www.apsattv.com/ssungnz.m3u",
  "https://www.apsattv.com/ssungph.m3u",
  "https://www.apsattv.com/ssungsg.m3u",
  "https://www.apsattv.com/ssungth.m3u",
] as const;

export const ANI_ONE_DEAD_URL = "https://amg19223-amg19223c9-amgplt0019.playout.now3.amagi.tv/playlist/amg19223-amg19223c9-amgplt0019/playlist.m3u8";
export const ANI_ONE_CURRENT_URL = "https://amg19223-amg19223c9-amgplt0352.playout.now3.amagi.tv/playlist/amg19223-amg19223c9-amgplt0352/playlist.m3u8";

export const VERIFIED_PUBLIC_FALLBACKS = [
  {
    channelId: "TVBrasil.br",
    title: "TV Brasil Internacional",
    url: "https://tvbrasilinternacional-stream.ebc.com.br/index.m3u8",
    label: "International feed",
    provenance: "EBC public TV Brasil Internacional stream",
  },
  {
    channelId: "AdvocateBroadcastingNetwork.ng",
    title: "Advocate Broadcasting Network",
    url: "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_045/Stream/playlist.m3u8",
    label: "Browser HLS fallback",
    provenance: "Free-TV public Advocate feed · media verified 2026-08-23",
  },
] as const;

export type WebChannel = {
  key: string;
  id: string;
  feed?: string | null;
  name: string;
  altNames?: string[];
  epgAliases?: string[];
  owners?: string[];
  logo?: string | null;
  categories: string[];
  country?: string | null;
  languages: string[];
  broadcastArea: string[];
  timezones?: string[];
  sources: StreamSource[];
  url?: string;
  referrer?: string | null;
  userAgent?: string | null;
  quality?: string | null;
  label?: string | null;
  format?: string | null;
  network?: string | null;
  website?: string | null;
  launched?: string | null;
  replacedBy?: string | null;
  isNsfw?: boolean;
  provenance?: string[];
  isMain: boolean;
};

export type NamedOption = { id: string; name: string; description?: string | null; count: number };
export type CountryOption = { code: string; name: string; flag: string; languages: string[]; count: number };
export type RegionOption = { code: string; name: string; countries: string[]; count: number };

export type WebCatalog = {
  channels: WebChannel[];
  categories: NamedOption[];
  countries: CountryOption[];
  languages: NamedOption[];
  regions: RegionOption[];
  subdivisions: NamedOption[];
  cities: NamedOption[];
  timezones: NamedOption[];
  owners: NamedOption[];
  networks: NamedOption[];
  feeds: NamedOption[];
  providers: NamedOption[];
  updatedAt: string;
  source: string;
};

export type ApiPayload = {
  channels: ApiChannel[];
  feeds: ApiFeed[];
  logos: ApiLogo[];
  streams: ApiStream[];
  categories: ApiCategory[];
  languages: ApiLanguage[];
  countries: ApiCountry[];
  regions: ApiRegion[];
  subdivisions: ApiSubdivision[];
  cities: ApiCity[];
  timezones: ApiTimezone[];
  blocklist: ApiBlock[];
};

type ApiChannel = {
  id: string; name: string; network?: string | null; country: string;
  alt_names?: string[]; owners?: string[]; categories?: string[];
  is_nsfw?: boolean; launched?: string | null; closed?: string | null;
  replaced_by?: string | null; website?: string | null;
};
type ApiFeed = {
  channel: string; id: string; name: string; is_main?: boolean;
  alt_names?: string[]; broadcast_area?: string[]; timezones?: string[];
  languages?: string[]; format?: string | null;
};
type ApiLogo = {
  channel: string; feed?: string | null; in_use?: boolean; tags?: string[];
  width?: number; height?: number; format?: string | null; url: string;
};
type ApiStream = {
  channel?: string | null; feed?: string | null; title: string; url: string;
  quality?: string | null; label?: string | null; user_agent?: string | null; referrer?: string | null;
};
type ApiCategory = { id: string; name: string; description: string };
type ApiLanguage = { code: string; name: string };
type ApiCountry = { name: string; code: string; languages?: string[]; flag: string };
type ApiRegion = { code: string; name: string; countries?: string[] };
type ApiSubdivision = { country: string; code: string; name: string; parent?: string | null };
type ApiCity = { country: string; subdivision?: string | null; code: string; name: string; wikidata_id?: string | null };
type ApiTimezone = { id: string; utc_offset: string; countries?: string[] };
type ApiBlock = { channel: string; reason?: string; ref?: string };

// --- helpers ported from lib.rs ---

function strictCountryCode(value?: string | null): string | null {
  const code = (value || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code === "GB" ? "UK" : code;
}

function fnv1a64(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function trimWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function normalizePlainText(value?: string | null, maxLen = 256): string | null {
  if (value == null) return null;
  const text = trimWrappingQuotes(value);
  if (!text || text.length > maxLen || /[\p{Cc}]/u.test(text)) return null;
  return text;
}

function normalizePlainTextList(
  values: readonly string[] | null | undefined,
  maxLen = 256,
): string[] {
  const output: string[] = [];
  for (const value of values || []) {
    const normalized = normalizePlainText(value, maxLen);
    if (normalized && !output.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
      output.push(normalized);
    }
  }
  return output.sort(compareText);
}

function normalizeUserAgent(value?: string | null): string | null {
  let text = normalizePlainText(value, 768);
  if (!text) return null;
  for (;;) {
    const lower = text.toLowerCase();
    const prefix = ["#extvlcopt:http-user-agent=", "http-user-agent=", "user-agent="]
      .find((candidate) => lower.startsWith(candidate));
    if (!prefix) break;
    text = trimWrappingQuotes(text.slice(prefix.length));
  }
  const normalized = normalizePlainText(text, 512);
  return normalized && /^[\x00-\x7F]*$/.test(normalized) ? normalized : null;
}

function normalizeHttpUrl(value: string): [string, boolean] | null {
  const text = trimWrappingQuotes(value);
  if (!text || text.length > 8_192 || /[\p{Cc}\s]/u.test(text)) return null;
  const lower = text.toLowerCase();
  let authorityStart: number;
  let isHttps: boolean;
  if (lower.startsWith("https://")) { authorityStart = 8; isHttps = true; }
  else if (lower.startsWith("http://")) { authorityStart = 7; isHttps = false; }
  else return null;
  const remainder = text.slice(authorityStart);
  const authorityEndSearch = remainder.search(/[/?#]/);
  const authority = remainder.slice(0, authorityEndSearch === -1 ? remainder.length : authorityEndSearch);
  if (!authority || authority.includes("@")) return null;
  return [text, isHttps];
}

const EXTERNAL_PLAYER_PROTOCOLS = new Set([
  "mmsh:",
  "rtmp:",
  "rtsp:",
  "srt:",
]);

function normalizeStreamUrl(value: string): [string, boolean] | null {
  const http = normalizeHttpUrl(value);
  if (http) return http;
  const text = trimWrappingQuotes(value);
  if (!text || text.length > 8_192 || /[\p{Cc}\s]/u.test(text)) return null;
  try {
    const parsed = new URL(text);
    if (
      !EXTERNAL_PLAYER_PROTOCOLS.has(parsed.protocol.toLowerCase())
      || !parsed.hostname
      || parsed.username
      || parsed.password
    ) return null;
    return [parsed.href, false];
  } catch {
    return null;
  }
}

function normalizeReferrer(value?: string | null): string | null {
  const text = normalizePlainText(value, 2_048);
  if (!text || !/^[\x00-\x7F]*$/.test(text)) return null;
  // Referer is a request-header value, not a fetch target. Some public
  // playlists intentionally publish a bare host; preserve it exactly after
  // length/control/ASCII validation rather than erasing the source identity.
  return text;
}

function streamTransport(url: string): TransportHint {
  const lower = url.toLowerCase();
  try {
    const protocol = new URL(url).protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return "unsupported";
  } catch {
    return "unsupported";
  }
  const path = lower.split(/[?#]/, 1)[0];
  if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return "hls";
  if (path.endsWith(".mpd")) return "dash";
  if ([".mp4", ".m4v", ".webm", ".ts", ".m2ts", ".aac", ".m4a", ".mp3", ".ogg", ".oga"]
    .some((extension) => path.endsWith(extension))) return "direct";
  return "unknown";
}

export function qualityHeight(quality?: string | null): number {
  if (!quality) return 0;
  const lower = quality.toLowerCase();
  if (lower.includes("4k") || lower.includes("uhd")) return 2_160;
  if (lower.includes("fhd")) return 1_080;
  if (lower === "hd") return 720;
  if (lower === "sd") return 480;
  const digits = lower.replace(/^[^\d]*/, "").replace(/[^\d].*$/, "");
  const height = Number.parseInt(digits, 10);
  return Number.isFinite(height) && height >= 100 && height <= 4_320 ? height : 0;
}

type SourceAvailability = "normal" | "part-time" | "geo-blocked" | "unavailable";

function labelWords(label: string): string[] {
  return label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function sourceAvailability(label?: string | null): SourceAvailability {
  if (!label) return "normal";
  const words = labelWords(label);
  if (words.includes("known") && words.includes("dead")) return "unavailable";
  const isGeoBlocked = words.some((word, index) =>
    word === "geo"
    && words[index + 1] === "blocked"
    && (index === 0 || (words[index - 1] !== "non" && words[index - 1] !== "not")));
  if (isGeoBlocked) return "geo-blocked";
  for (let index = 0; index + 2 < words.length; index += 1) {
    if (words[index] === "not" && words[index + 1] === "24" && words[index + 2] === "7") return "part-time";
    if (words[index] === "not" && words[index + 1] === "always" && words[index + 2] === "on") return "part-time";
  }
  for (let index = 0; index + 1 < words.length; index += 1) {
    if (words[index] === "not" && words[index + 1] === "24x7") return "part-time";
  }
  return "normal";
}

function sourcePreferenceScore(source: StreamSource, now = Date.now()): number {
  const transportScore = source.transport === "hls" ? 400
    : source.transport === "direct" ? 300
      : source.transport === "dash" ? 100
        : source.transport === "unsupported" ? -2_000 : 200;
  const browserDeliveryScore = source.transport === "unsupported" ? 0
    : sourceUsesLiteralIp(source) ? 0
    : source.isHttps ? 4_000 : 1_000;
  const qualityScore = Math.min(Math.floor(qualityHeight(source.quality) / 60), 72);
  const availabilityScore = sourceAvailability(source.label) === "normal" ? 2_000
    : sourceAvailability(source.label) === "part-time" ? 1_000
      : sourceAvailability(source.label) === "unavailable" ? -5_000 : 0;
  const healthScore = !isFreshCatalogHealth(source.catalogHealth, now) ? 20_000
    : source.catalogHealth.status === "online" && sourceUsesLiteralIp(source)
      ? 15_000 + source.catalogHealth.score * 5
      : source.catalogHealth.status === "online" ? 30_000 + source.catalogHealth.score * 10
      : source.catalogHealth.status === "blocked" ? 18_000
        : source.catalogHealth.status === "timeout" ? 5_000 : 0;
  return healthScore + availabilityScore + transportScore + browserDeliveryScore + qualityScore;
}

function sourceId(url: string, userAgent?: string | null, referrer?: string | null): string {
  return `source-${fnv1a64(`${url}\n${userAgent || ""}\n${referrer || ""}`).toString(16).padStart(16, "0")}`;
}

function makeStreamSource(
  title: string | null,
  url: string,
  referrer?: string | null,
  userAgent?: string | null,
  quality?: string | null,
  label?: string | null,
  provenance?: string | null,
  provenances: readonly string[] = [],
): StreamSource | null {
  const normalized = normalizeStreamUrl(url);
  if (!normalized) return null;
  const [normalizedUrl, isHttps] = normalized;
  const sourceLineage = normalizePlainTextList([
    ...(provenance ? [provenance] : []),
    ...provenances,
  ], 256);
  const source: StreamSource = {
    id: "",
    title: normalizePlainText(title, 256),
    url: normalizedUrl,
    referrer: normalizeReferrer(referrer),
    userAgent: normalizeUserAgent(userAgent),
    quality: normalizePlainText(quality, 64),
    label: normalizePlainText(label, 128),
    transport: streamTransport(normalizedUrl),
    isHttps,
    requiresHeaders: false,
    preferenceScore: 0,
    provenance: normalizePlainText(provenance, 256) || sourceLineage[0],
    provenances: sourceLineage,
  };
  source.requiresHeaders = Boolean(source.referrer || source.userAgent);
  source.id = sourceId(source.url, source.userAgent, source.referrer);
  source.preferenceScore = sourcePreferenceScore(source);
  return source;
}

function logicalChannelKey(id: string, feed?: string | null): string {
  return `${id}@${feed || "main"}`;
}

function channelIsClosed(closed: string | null | undefined, today: Date): boolean {
  if (!closed) return false;
  const match = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(closed);
  if (!match) return false;
  const closedDate = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return closedDate <= todayUtc;
}

function splitChannelFeed(id: string): [string, string | null] {
  const separator = id.indexOf("@");
  if (separator > 0) {
    const channel = id.slice(0, separator).trim();
    const feed = id.slice(separator + 1).trim();
    if (channel && feed) return [channel, feed];
  }
  return [id.trim(), null];
}

function compareSources(left: StreamSource, right: StreamSource): number {
  return (right.preferenceScore || 0) - (left.preferenceScore || 0)
    || qualityHeight(right.quality) - qualityHeight(left.quality)
    || (left.id || "").localeCompare(right.id || "");
}

function compareText(left: string, right: string): number {
  const lower = left.toLowerCase().localeCompare(right.toLowerCase());
  return lower || left.localeCompare(right);
}

function logoPreferenceScore(logo: ApiLogo): number {
  const tags = logo.tags || [];
  const tagged = tags.includes("horizontal") ? 1_000_000
    : tags.includes("square") ? 500_000 : 0;
  const vector = logo.format?.toUpperCase() === "SVG" ? 250_000 : 0;
  const area = Math.min(200_000, Math.max(0, (logo.width || 0) * (logo.height || 0)));
  return tagged + vector + area;
}

function chooseLogo(current: ApiLogo | undefined, candidate: ApiLogo): ApiLogo {
  if (!current) return candidate;
  return logoPreferenceScore(candidate) > logoPreferenceScore(current)
    ? candidate
    : current;
}

function chooseText(current: string | null | undefined, candidate: string | null | undefined): string | null | undefined {
  if (candidate == null || !candidate.trim()) return current;
  if (current == null || compareText(candidate, current) < 0) return candidate;
  return current;
}

function mergeSource(target: StreamSource, candidate: StreamSource): void {
  target.title = chooseText(target.title, candidate.title) ?? null;
  target.quality = chooseText(target.quality, candidate.quality) ?? null;
  target.label = chooseText(target.label, candidate.label) ?? null;
  const primaryProvenance = target.provenance || candidate.provenance;
  target.provenances = normalizePlainTextList([
    ...(target.provenances || []),
    ...(target.provenance ? [target.provenance] : []),
    ...(candidate.provenances || []),
    ...(candidate.provenance ? [candidate.provenance] : []),
  ], 256);
  target.provenance = primaryProvenance || target.provenances[0];
  target.preferenceScore = sourcePreferenceScore(target);
}

function addSource(channel: WebChannel, source: StreamSource): void {
  const existing = channel.sources.find((item) => item.id === source.id);
  if (existing) mergeSource(existing, source);
  else channel.sources.push(source);
}

function sortAndSyncSources(channel: WebChannel): void {
  channel.sources.sort(compareSources);
  const first = channel.sources[0];
  if (first) {
    channel.url = first.url;
    channel.referrer = first.referrer;
    channel.userAgent = first.userAgent;
    channel.quality = first.quality;
    channel.label = first.label;
  }
}

export function applyStreamHealthHints(
  channels: WebChannel[],
  hints: Map<string, CatalogSourceHealth>,
  now = Date.now(),
): number {
  let matched = 0;
  for (const channel of channels) {
    for (const source of channel.sources) {
      const hint = hints.get(streamSourceHealthIdentity(source));
      if (isFreshCatalogHealth(hint, now)) {
        source.catalogHealth = hint;
        matched += 1;
      } else {
        delete source.catalogHealth;
      }
      source.preferenceScore = sourcePreferenceScore(source, now);
    }
    sortAndSyncSources(channel);
  }
  return matched;
}

function refreshSourceOrdering(channels: WebChannel[]): number {
  let freshHints = 0;
  for (const channel of channels) {
    for (const source of channel.sources) {
      if (isFreshCatalogHealth(source.catalogHealth)) freshHints += 1;
      else delete source.catalogHealth;
      source.preferenceScore = sourcePreferenceScore(source);
    }
    sortAndSyncSources(channel);
  }
  return freshHints;
}

function refreshedCatalogSource(source: string, freshHints: number): string {
  return freshHints > 0
    ? source
    : source.replace(" + recent source health", "");
}

function mergeUnique(values: string[], candidates: string[]): void {
  for (const candidate of candidates) {
    if (!values.some((value) => value.toLowerCase() === candidate.toLowerCase())) {
      values.push(candidate);
    }
  }
  values.sort(compareText);
}

function chooseName(current: string, candidate: string): string {
  if (!current || compareText(candidate, current) < 0) return candidate;
  return current;
}

function normalizeChannelSources(channel: WebChannel): void {
  const existing = channel.sources;
  channel.sources = [];
  if (!existing.length) {
    const source = makeStreamSource(null, channel.url || "", channel.referrer, channel.userAgent, channel.quality, channel.label, channel.provenance?.[0]);
    if (source) addSource(channel, source);
  } else {
    for (const item of existing) {
      const source = makeStreamSource(item.title ?? null, item.url, item.referrer, item.userAgent, item.quality, item.label, item.provenance, item.provenances);
      if (source) addSource(channel, source);
    }
  }
  sortAndSyncSources(channel);
}

function mergeChannel(target: WebChannel, candidate: WebChannel): void {
  target.name = chooseName(target.name, candidate.name);
  target.altNames ||= [];
  target.epgAliases ||= [];
  target.owners ||= [];
  target.timezones ||= [];
  target.provenance ||= [];
  target.logo = chooseText(target.logo, candidate.logo) ?? null;
  target.country = chooseText(target.country, candidate.country) ?? null;
  target.format = chooseText(target.format, candidate.format) ?? null;
  target.network = chooseText(target.network, candidate.network) ?? null;
  target.website = chooseText(target.website, candidate.website) ?? null;
  mergeUnique(target.categories, candidate.categories);
  mergeUnique(target.languages, candidate.languages);
  mergeUnique(target.broadcastArea, candidate.broadcastArea);
  mergeUnique(target.altNames, candidate.altNames || []);
  mergeUnique(target.epgAliases, candidate.epgAliases || []);
  mergeUnique(target.owners, candidate.owners || []);
  mergeUnique(target.timezones, candidate.timezones || []);
  mergeUnique(target.provenance, candidate.provenance || []);
  target.launched = chooseText(target.launched, candidate.launched) ?? null;
  target.replacedBy = chooseText(target.replacedBy, candidate.replacedBy) ?? null;
  target.isNsfw = Boolean(target.isNsfw || candidate.isNsfw);
  target.isMain = target.isMain || candidate.isMain;
  for (const source of candidate.sources) addSource(target, source);
}

export function normalizeAndGroupChannels(channels: WebChannel[]): WebChannel[] {
  const grouped = new Map<string, WebChannel>();
  for (const channel of channels) {
    const [id, embeddedFeed] = splitChannelFeed(channel.id);
    if (!id) continue;
    channel.id = id;
    if (channel.feed == null) channel.feed = embeddedFeed;
    channel.key = logicalChannelKey(channel.id, channel.feed);
    normalizeChannelSources(channel);
    if (!channel.sources.length) continue;
    const existing = grouped.get(channel.key);
    if (existing) mergeChannel(existing, channel);
    else grouped.set(channel.key, channel);
  }
  const result = [...grouped.values()];
  for (const channel of result) sortAndSyncSources(channel);
  result.sort((left, right) =>
    left.name.toLowerCase().localeCompare(right.name.toLowerCase())
    || left.key.localeCompare(right.key));
  return result;
}

// --- conservative Apsattv/Amagi fallback overlay ---

function amagiIdentityToken(value: string): string | null {
  const match = /(?:^|[^a-z0-9])(amg\d+c\d+)(?![a-z0-9])/i.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Amagi deployment numbers change independently of the provider/channel pair.
 * Only accept an identity when the same complete token occurs in both the
 * Amagi hostname and path; this deliberately rejects broad provider matches.
 */
export function amagiProviderChannelIdentity(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "amagi.tv" && !hostname.endsWith(".amagi.tv")) return null;
  const hostnameIdentity = amagiIdentityToken(hostname);
  const pathIdentity = amagiIdentityToken(parsed.pathname);
  return hostnameIdentity && hostnameIdentity === pathIdentity ? hostnameIdentity : null;
}

function semanticChannelTitle(value: string): string | null {
  const words = value
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const first = words[0];
  if (first && first.length >= 3 && first.length <= 5 && /^\d+$/.test(first)) {
    words.shift();
  }
  return words.length ? words.join(" ") : null;
}

export function amagiFallbackTitleMatches(
  channelName: string,
  sourceTitle?: string | null,
  fallbackTitle?: string | null,
): boolean {
  if (!fallbackTitle) return false;
  const fallback = semanticChannelTitle(fallbackTitle);
  if (!fallback) return false;
  return (sourceTitle ? semanticChannelTitle(sourceTitle) === fallback : false)
    || semanticChannelTitle(channelName) === fallback;
}

function knownDeadAmagiReplacement(value: string): string | null {
  const baseUrl = value.split(/[?#]/, 1)[0];
  return baseUrl.toLowerCase() === ANI_ONE_DEAD_URL.toLowerCase()
    ? ANI_ONE_CURRENT_URL
    : null;
}

const AMAGI_REPLACEMENT_PROVENANCE = "CrowFlix verified Amagi replacement";

function normalizedAmagiSources(source: StreamSource): StreamSource[] {
  const replacement = knownDeadAmagiReplacement(source.url);
  const original = makeStreamSource(
    source.title ?? null,
    source.url,
    source.referrer,
    source.userAgent,
    source.quality,
    replacement
      ? [source.label, "Known-dead deployment"].filter(Boolean).join(" · ")
      : source.label,
    source.provenance,
    source.provenances,
  );
  if (!original) return [];
  if (!replacement) return [original];
  const current = makeStreamSource(
    source.title ?? null,
    replacement,
    source.referrer,
    source.userAgent,
    source.quality,
    source.label,
    AMAGI_REPLACEMENT_PROVENANCE,
  );
  return current ? [current, original] : [original];
}

/** Add the verified successor while retaining the exact published dead route. */
export function repairKnownDeadAmagiSources(channels: WebChannel[]): number {
  let repaired = 0;
  for (const channel of channels) {
    const sources = channel.sources;
    channel.sources = [];
    for (const source of sources) {
      const replacement = knownDeadAmagiReplacement(source.url);
      if (replacement) repaired += 1;
      for (const normalized of normalizedAmagiSources(source)) {
        addSource(channel, normalized);
      }
    }
    sortAndSyncSources(channel);
  }
  return repaired;
}

function extinfName(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      return line.slice(index + 1).trim() || "Untitled channel";
    }
  }
  return "Untitled channel";
}

/** Parse only the title and playable URL pairs needed for the fixed overlay. */
export function parseOptionalFastPlaylist(content: string): StreamSource[] {
  if (new TextEncoder().encode(content).byteLength > MAX_OPTIONAL_FAST_PLAYLIST_BYTES) return [];
  const sources: StreamSource[] = [];
  let pendingTitle: string | null = null;
  let playableEntries = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^\uFEFF/, "");
    if (/^#extinf\b/i.test(line)) {
      pendingTitle = extinfName(line);
      continue;
    }
    if (!line || line.startsWith("#") || pendingTitle === null) continue;

    playableEntries += 1;
    if (playableEntries > MAX_OPTIONAL_FAST_PLAYLIST_ENTRIES) return [];
    const rawUrl = line.split("|", 1)[0].trim();
    const normalized = normalizedAmagiSources({
      title: pendingTitle,
      url: rawUrl,
      provenance: "Apsattv public FAST playlist",
    });
    pendingTitle = null;
    sources.push(...normalized);
  }

  return sources;
}

/**
 * Add only same-identity, same-title Amagi deployments to existing channels.
 * Existing channel and regional metadata remains canonical.
 */
export function overlayAmagiFastFallbacks(
  channels: WebChannel[],
  rawFallbackSources: readonly StreamSource[],
): number {
  const fallbacksByIdentity = new Map<string, StreamSource[]>();
  for (const rawSource of rawFallbackSources) {
    for (const source of normalizedAmagiSources(rawSource)) {
      const identity = amagiProviderChannelIdentity(source.url);
      if (!identity) continue;
      const candidates = fallbacksByIdentity.get(identity) ?? [];
      const existing = candidates.find((candidate) => candidate.id === source.id);
      if (existing) mergeSource(existing, source);
      else candidates.push(source);
      fallbacksByIdentity.set(identity, candidates);
    }
  }
  for (const candidates of fallbacksByIdentity.values()) candidates.sort(compareSources);

  let added = 0;
  for (const channel of channels) {
    const templates = new Map<string, StreamSource>();
    for (const source of channel.sources) {
      const identity = amagiProviderChannelIdentity(source.url);
      if (identity && !templates.has(identity)) templates.set(identity, source);
    }

    for (const [identity, template] of [...templates.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      for (const fallback of fallbacksByIdentity.get(identity) ?? []) {
        if (!amagiFallbackTitleMatches(channel.name, template.title, fallback.title)) continue;
        const candidate = makeStreamSource(
          template.title ?? fallback.title ?? null,
          fallback.url,
          fallback.referrer ?? template.referrer,
          fallback.userAgent ?? template.userAgent,
          fallback.quality ?? template.quality,
          fallback.label ?? template.label,
          fallback.provenance ?? template.provenance,
          fallback.provenances ?? template.provenances,
        );
        if (!candidate) continue;
        if (!channel.sources.some((source) => source.id === candidate.id)) added += 1;
        addSource(channel, candidate);
        if (candidate.provenance) {
          channel.provenance ||= [];
          mergeUnique(channel.provenance, [candidate.provenance]);
        }
      }
    }
    sortAndSyncSources(channel);
  }
  return added;
}

function mappedMjhChannelId(providerId: string): string | null {
  const fixed: Record<string, string> = {
    "mjh-abc-kids": "ABCKids.au",
    "mjh-abc-me": "ABCEntertains.au",
    "mjh-abc-news": "ABCNews.au",
    "mjh-abc-tv-plus": "ABCTVPlus.au",
    "mjh-ausbiz-fast": "AusbizTV.au",
    "mjh-cricketgold-fast": "CricketGold.au",
    "mjh-racing-fast": "Racingcom.au",
    "mjh-sbs-6nat": "SBSWorldWatch.au",
    "mjh-sky-racing-1": "SkyRacing1.au",
    "mjh-sky-racing-2": "SkyRacing2.au",
    "mjh-sky-racing-thoroughbred": "SkyThoroughbredCentral.au",
    "mjh-tvsn-fast": "TVSN.au",
  };
  if (fixed[providerId]) return fixed[providerId];
  if (/^mjh-abc-(?:act|nsw|nt|qld|sa|tas|vic|wa)$/.test(providerId)) return "ABCTV.au";
  if (/^mjh-seven-/.test(providerId)) return "Channel7.au";
  if (/^mjh-channel-9-/.test(providerId)) return "Channel9.au";
  if (/^mjh-gem-/.test(providerId)) return "9Gem.au";
  if (/^mjh-go-/.test(providerId)) return "9Go.au";
  if (/^mjh-life-/.test(providerId)) return "9Life.au";
  if (/^mjh-10bold-/.test(providerId)) return "10Bold.au";
  return null;
}

function chooseMappedChannel(
  channels: WebChannel[],
  entry: AdditivePlaylistEntry,
): WebChannel | undefined {
  const mappedId = mappedMjhChannelId(entry.providerId);
  let candidates = mappedId
    ? channels.filter((channel) => channel.id === mappedId)
    : [];
  if (!candidates.length) {
    const title = semanticChannelTitle(entry.name);
    if (title) {
      candidates = channels.filter((channel) => {
        return (!entry.config.country || channel.country === entry.config.country)
          && semanticChannelTitle(channel.name.replace(/\s+—\s+.+$/, "")) === title;
      });
    }
  }
  if (!candidates.length) return undefined;
  return candidates.find((channel) => {
    return entry.config.broadcastArea.some((area) => channel.broadcastArea.includes(area));
  }) || candidates.find((channel) => channel.isMain) || candidates[0];
}

export function overlayAdditivePlaylists(
  channels: WebChannel[],
  entries: readonly AdditivePlaylistEntry[],
): { addedSources: number; addedChannels: number } {
  let addedSources = 0;
  let addedChannels = 0;
  for (const entry of entries) {
    const source = makeStreamSource(
      entry.name,
      entry.url,
      entry.referrer,
      entry.userAgent,
      null,
      null,
      entry.config.name,
    );
    if (!source) continue;
    source.provenance = entry.config.name;
    let channel = chooseMappedChannel(channels, entry);
    if (!channel) {
      const identity = `${entry.config.id}\u0000${entry.providerId}\u0000${entry.name}`;
      const id = `external-${fnv1a64(identity).toString(16).padStart(16, "0")}`;
      channel = {
        key: logicalChannelKey(id, entry.config.id),
        id,
        feed: entry.config.id,
        name: entry.name,
      altNames: [],
      epgAliases: [],
        owners: [],
        logo: entry.logo,
        categories: ["undefined"],
        country: entry.config.country,
        languages: [],
        broadcastArea: [...entry.config.broadcastArea],
        timezones: [...entry.config.timezones],
        sources: [],
        format: null,
        network: "i.mjh.nz",
        website: "https://i.mjh.nz/",
        launched: null,
        replacedBy: null,
        isNsfw: false,
        provenance: [entry.config.name],
        isMain: true,
      };
      channels.push(channel);
      addedChannels += 1;
    }
    channel.provenance ||= [];
    channel.epgAliases ||= [];
    if (entry.providerId) mergeUnique(channel.epgAliases, [entry.providerId]);
    mergeUnique(channel.provenance, [entry.config.name]);
    const before = channel.sources.length;
    addSource(channel, source);
    if (channel.sources.length > before) addedSources += 1;
    sortAndSyncSources(channel);
  }
  channels.sort((left, right) =>
    left.name.toLowerCase().localeCompare(right.name.toLowerCase())
    || left.key.localeCompare(right.key));
  return { addedSources, addedChannels };
}

export function overlayVerifiedPublicFallbacks(channels: WebChannel[]): number {
  let added = 0;
  for (const fallback of VERIFIED_PUBLIC_FALLBACKS) {
    const channel = channels.find((candidate) => candidate.id === fallback.channelId);
    if (!channel) continue;
    const source = makeStreamSource(
      fallback.title,
      fallback.url,
      null,
      null,
      null,
      fallback.label,
      fallback.provenance,
    );
    if (!source) continue;
    source.provenance = fallback.provenance;
    const before = channel.sources.length;
    addSource(channel, source);
    if (channel.sources.length > before) added += 1;
    channel.provenance ||= [];
    mergeUnique(channel.provenance, [fallback.provenance]);
    sortAndSyncSources(channel);
  }
  return added;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function readBoundedPlaylist(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OPTIONAL_FAST_PLAYLIST_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > MAX_OPTIONAL_FAST_PLAYLIST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function fetchOptionalFastPlaylist(source: string, fetchImpl: FetchLike): Promise<StreamSource[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPTIONAL_FAST_FETCH_TIMEOUT_MS);
  try {
    const relayUrl = new URL(`${RELAY_BASE}/fetch`);
    relayUrl.searchParams.set("url", source);
    const response = await fetchImpl(relayUrl, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const content = await readBoundedPlaylist(response);
    return content === null ? [] : parseOptionalFastPlaylist(content);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch all five fixed snapshots concurrently; every result is optional. */
export async function loadOptionalFastFallbacks(fetchImpl: FetchLike = fetch): Promise<StreamSource[]> {
  const playlists = await Promise.all(
    OPTIONAL_FAST_PLAYLISTS.map((source) => fetchOptionalFastPlaylist(source, fetchImpl)),
  );
  const merged: StreamSource[] = [];
  for (const source of playlists.flat()) {
    const existing = merged.find((candidate) => candidate.id === source.id);
    if (existing) mergeSource(existing, source);
    else merged.push(source);
  }
  merged.sort(compareSources);
  return merged;
}

function normalizedChannelTitle(value: string): [string, string] | null {
  const display = normalizePlainText(value.split(/\s+/).join(" "), 256);
  return display ? [display, display.toLowerCase()] : null;
}

function countryFromId(id: string): string | null {
  const base = id.split("@", 1)[0];
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return strictCountryCode(base.slice(dot + 1));
}

function channelFromApiStream(
  stream: ApiStream,
  channelMap: Map<string, ApiChannel>,
  excludedChannelIds: Set<string>,
  feedMap: Map<string, ApiFeed>,
  mainFeedMap: Map<string, ApiFeed>,
  channelLogos: Map<string, ApiLogo>,
  feedLogos: Map<string, ApiLogo>,
  languageNames: Map<string, string>,
): WebChannel | null {
  const channelId = stream.channel ?? null;

  if (!channelId) {
    const title = normalizedChannelTitle(stream.title);
    if (!title) return null;
    const [displayName, identity] = title;
    const id = `uncatalogued-${fnv1a64(identity).toString(16).padStart(16, "0")}`;
    const source = makeStreamSource(displayName, stream.url, stream.referrer, stream.user_agent, stream.quality, stream.label, "IPTV-org");
    if (!source) return null;
    return {
      key: logicalChannelKey(id, null), id, feed: null, name: displayName, logo: null,
      categories: ["undefined"], country: null, languages: [], broadcastArea: [],
      sources: [source], url: source.url, referrer: source.referrer, userAgent: source.userAgent,
      quality: source.quality, label: source.label, format: null, network: null, website: null, isMain: true,
      provenance: ["IPTV-org"],
    };
  }

  // A channel ID can temporarily appear in streams.json before channels.json.
  // Keep that stream unless the channel is known and intentionally excluded.
  if (excludedChannelIds.has(channelId)) return null;

  const explicitFeedId = normalizePlainText(stream.feed, 128);
  const feed = explicitFeedId
    ? feedMap.get(`${channelId}
${explicitFeedId}`)
    : mainFeedMap.get(channelId);
  // A stream's explicit feed is authoritative even when feeds.json is temporarily behind it.
  const feedId = explicitFeedId ?? feed?.id ?? null;
  const logo = ((feedId && feedLogos.get(`${channelId}
${feedId}`)) || channelLogos.get(channelId))?.url || null;
  const languages = (feed?.languages || []).map((code) => languageNames.get(code) || code);
  const feedAltNames = normalizePlainTextList(feed?.alt_names, 256);
  const timezones = normalizePlainTextList(feed?.timezones, 128);
  const source = makeStreamSource(stream.title, stream.url, stream.referrer, stream.user_agent, stream.quality, stream.label, "IPTV-org");
  if (!source) return null;

  const apiChannel = channelMap.get(channelId);
  if (!apiChannel) {
    const title = normalizedChannelTitle(stream.title);
    if (!title) return null;
    const [baseName] = title;
    const displayName = feed
      ? (feed.is_main || (feed.name.toLowerCase() === baseName.toLowerCase()) ? baseName : `${baseName} — ${feed.name}`)
      : explicitFeedId ? `${baseName} — ${explicitFeedId}` : baseName;
    return {
      key: logicalChannelKey(channelId, feedId), id: channelId, feed: feedId, name: displayName, logo,
      altNames: feedAltNames, owners: [], categories: ["undefined"], country: countryFromId(channelId), languages,
      broadcastArea: feed?.broadcast_area || [],
      timezones,
      sources: [source], url: source.url, referrer: source.referrer, userAgent: source.userAgent,
      quality: source.quality, label: source.label, format: feed?.format ?? null,
      network: null, website: null, launched: null, replacedBy: null,
      isNsfw: false, provenance: ["IPTV-org"], isMain: feed?.is_main ?? !explicitFeedId,
    };
  }

  const displayName = feed
    ? (feed.is_main || (feed.name.toLowerCase() === apiChannel.name.toLowerCase())
      ? apiChannel.name
      : `${apiChannel.name} — ${feed.name}`)
    : explicitFeedId ? `${apiChannel.name} — ${explicitFeedId}` : apiChannel.name;
  return {
    key: logicalChannelKey(channelId, feedId), id: channelId, feed: feedId, name: displayName, logo,
    altNames: normalizePlainTextList([
      ...(apiChannel.alt_names || []),
      ...feedAltNames,
    ], 256),
    owners: normalizePlainTextList(apiChannel.owners, 256),
    categories: apiChannel.categories?.length ? apiChannel.categories : ["undefined"],
    country: apiChannel.country, languages, broadcastArea: feed?.broadcast_area || [],
    timezones,
    sources: [source], url: source.url, referrer: source.referrer, userAgent: source.userAgent,
    quality: source.quality, label: source.label, format: feed?.format ?? null,
    network: apiChannel.network ?? null, website: apiChannel.website ?? null,
    launched: apiChannel.launched ?? null,
    replacedBy: apiChannel.replaced_by ?? null,
    isNsfw: Boolean(apiChannel.is_nsfw),
    provenance: ["IPTV-org"],
    isMain: feed?.is_main ?? !explicitFeedId,
  };
}

function coverageOptionCounts(
  channels: WebChannel[],
  apiRegions: ApiRegion[],
): [Map<string, number>, Map<string, number>] {
  const regionCountries = new Map<string, Set<string>>();
  const countryRegions = new Map<string, Set<string>>();
  for (const region of apiRegions) {
    const regionCode = region.code.trim().toUpperCase();
    for (const country of region.countries || []) {
      const countryCode = strictCountryCode(country);
      if (!countryCode) continue;
      if (!regionCountries.has(regionCode)) regionCountries.set(regionCode, new Set());
      regionCountries.get(regionCode)!.add(countryCode);
      if (!countryRegions.has(countryCode)) countryRegions.set(countryCode, new Set());
      countryRegions.get(countryCode)!.add(regionCode);
    }
  }

  const countryCounts = new Map<string, number>();
  const regionCounts = new Map<string, number>();
  for (const channel of channels) {
    const channelCountries = new Set<string>();
    const channelRegions = new Set<string>();
    if (!channel.broadcastArea.length) {
      const country = strictCountryCode(channel.country);
      if (country) channelCountries.add(country);
    } else {
      for (const area of channel.broadcastArea) {
        const separator = area.trim().indexOf("/");
        if (separator < 1) continue;
        const kind = area.trim().slice(0, separator).toLowerCase();
        const value = area.trim().slice(separator + 1);
        if (kind === "c") {
          const country = strictCountryCode(value);
          if (country) channelCountries.add(country);
        } else if (kind === "s") {
          const country = strictCountryCode(value.split("-", 1)[0]);
          if (country) channelCountries.add(country);
        } else if (kind === "ct") {
          const country = strictCountryCode(value.slice(0, 2));
          if (country) channelCountries.add(country);
        } else if (kind === "r") {
          const region = value.trim().toUpperCase();
          const countries = regionCountries.get(region);
          if (countries) {
            channelRegions.add(region);
            for (const country of countries) channelCountries.add(country);
          }
        }
      }
    }
    for (const country of channelCountries) {
      for (const region of countryRegions.get(country) || []) channelRegions.add(region);
    }
    for (const country of channelCountries) countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
    for (const region of channelRegions) regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
  }
  return [countryCounts, regionCounts];
}

function preciseDimensionCounts(channels: WebChannel[]): {
  subdivisions: Map<string, number>;
  cities: Map<string, number>;
  timezones: Map<string, number>;
} {
  const subdivisionCounts = new Map<string, number>();
  const cityCounts = new Map<string, number>();
  const timezoneCounts = new Map<string, number>();
  for (const channel of channels) {
    const subdivisions = new Set<string>();
    const cities = new Set<string>();
    for (const rawArea of channel.broadcastArea) {
      const [kind, rawValue] = rawArea.trim().split("/", 2);
      const value = rawValue?.trim().toUpperCase();
      if (!value) continue;
      if (kind?.toLowerCase() === "s") subdivisions.add(value);
      if (kind?.toLowerCase() === "ct") cities.add(value);
    }
    for (const subdivision of subdivisions) {
      subdivisionCounts.set(subdivision, (subdivisionCounts.get(subdivision) || 0) + 1);
    }
    for (const city of cities) cityCounts.set(city, (cityCounts.get(city) || 0) + 1);
    for (const timezone of new Set(channel.timezones || [])) {
      timezoneCounts.set(timezone, (timezoneCounts.get(timezone) || 0) + 1);
    }
  }
  return {
    subdivisions: subdivisionCounts,
    cities: cityCounts,
    timezones: timezoneCounts,
  };
}

/** Build the catalogue from already-fetched IPTV-org API payloads. Pure. */
export function buildCatalogFromApi(
  api: ApiPayload,
  now = new Date(),
  optionalFastFallbacks: readonly StreamSource[] = [],
  additivePlaylistEntries: readonly AdditivePlaylistEntry[] = [],
): WebCatalog {
  const blocked = new Set(api.blocklist.map((item) => item.channel));
  const excludedChannelIds = new Set<string>(blocked);
  for (const channel of api.channels) {
    if (blocked.has(channel.id) || channelIsClosed(channel.closed, now)) {
      excludedChannelIds.add(channel.id);
    }
  }
  const channelMap = new Map<string, ApiChannel>();
  for (const channel of api.channels) {
    if (!blocked.has(channel.id) && !channelIsClosed(channel.closed, now)) {
      channelMap.set(channel.id, channel);
    }
  }

  const feedMap = new Map<string, ApiFeed>();
  const mainFeedMap = new Map<string, ApiFeed>();
  for (const feed of api.feeds) {
    if (feed.is_main) mainFeedMap.set(feed.channel, feed);
    feedMap.set(`${feed.channel}
${feed.id}`, feed);
  }

  const channelLogos = new Map<string, ApiLogo>();
  const feedLogos = new Map<string, ApiLogo>();
  for (const logo of api.logos) {
    if (!logo.in_use) continue;
    if (logo.feed) {
      const key = `${logo.channel}
${logo.feed}`;
      feedLogos.set(key, chooseLogo(feedLogos.get(key), logo));
    } else {
      channelLogos.set(
        logo.channel,
        chooseLogo(channelLogos.get(logo.channel), logo),
      );
    }
  }

  const languageNames = new Map(api.languages.map((language) => [language.code, language.name]));

  const channels = normalizeAndGroupChannels(
    api.streams
      .map((stream) => channelFromApiStream(stream, channelMap, excludedChannelIds, feedMap, mainFeedMap, channelLogos, feedLogos, languageNames))
      .filter((channel): channel is WebChannel => Boolean(channel)),
  );
  const repairedAmagiSources = repairKnownDeadAmagiSources(channels);
  const addedFastFallbacks = overlayAmagiFastFallbacks(channels, optionalFastFallbacks);
  const additive = overlayAdditivePlaylists(channels, additivePlaylistEntries);
  const verifiedPublicFallbacks = overlayVerifiedPublicFallbacks(channels);

  const categoryCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  const ownerCounts = new Map<string, number>();
  const networkCounts = new Map<string, number>();
  const feedCounts = new Map<string, number>();
  const providerCounts = new Map<string, number>();
  for (const channel of channels) {
    for (const category of channel.categories) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    for (const language of channel.languages) languageCounts.set(language, (languageCounts.get(language) || 0) + 1);
    for (const owner of new Set(channel.owners || [])) ownerCounts.set(owner, (ownerCounts.get(owner) || 0) + 1);
    if (channel.network) networkCounts.set(channel.network, (networkCounts.get(channel.network) || 0) + 1);
    const feed = channel.feed || MAIN_FEED_OPTION_ID;
    feedCounts.set(feed, (feedCounts.get(feed) || 0) + 1);
    const providers = new Set([
      ...(channel.provenance || []),
      ...channel.sources.flatMap((source) => [
        ...(source.provenances || []),
        ...(source.provenance ? [source.provenance] : []),
      ]),
    ]);
    for (const provider of providers) providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
  }
  const [countryCounts, regionCounts] = coverageOptionCounts(channels, api.regions);
  const dimensionCounts = preciseDimensionCounts(channels);

  const categories: NamedOption[] = api.categories
    .map((category) => ({ id: category.id, name: category.name, description: category.description, count: categoryCounts.get(category.id) || 0 }))
    .filter((category) => category.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const countries: CountryOption[] = api.countries
    .map((country) => ({ code: country.code, name: country.name, flag: country.flag, languages: country.languages || [], count: countryCounts.get(country.code) || 0 }))
    .filter((country) => country.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const languages: NamedOption[] = [...languageCounts.entries()]
    .map(([name, count]) => ({ id: name, name, description: null, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const regions: RegionOption[] = api.regions
    .map((region) => ({ code: region.code, name: region.name, countries: region.countries || [], count: regionCounts.get(region.code.toUpperCase()) || 0 }))
    .filter((region) => region.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const subdivisions: NamedOption[] = api.subdivisions
    .map((subdivision) => ({
      id: subdivision.code,
      name: `${subdivision.name} (${subdivision.country})`,
      description: subdivision.parent || null,
      count: dimensionCounts.subdivisions.get(subdivision.code.toUpperCase()) || 0,
    }))
    .filter((subdivision) => subdivision.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const cities: NamedOption[] = api.cities
    .map((city) => ({
      id: city.code,
      name: `${city.name} (${city.country})`,
      description: city.subdivision || city.wikidata_id || null,
      count: dimensionCounts.cities.get(city.code.toUpperCase()) || 0,
    }))
    .filter((city) => city.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const timezones: NamedOption[] = api.timezones
    .map((timezone) => ({
      id: timezone.id,
      name: timezone.id.split("_").join(" "),
      description: timezone.utc_offset,
      count: dimensionCounts.timezones.get(timezone.id) || 0,
    }))
    .filter((timezone) => timezone.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const namedOptions = (
    counts: Map<string, number>,
    display: (id: string) => string = (id) => id,
  ): NamedOption[] => [...counts.entries()]
    .map(([id, count]) => ({ id, name: display(id), description: null, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const owners = namedOptions(ownerCounts);
  const networks = namedOptions(networkCounts);
  const feeds = namedOptions(feedCounts, (id) => id === MAIN_FEED_OPTION_ID ? "Main feed" : id);
  const providers = namedOptions(providerCounts);

  return {
    channels, categories, countries, languages, regions,
    subdivisions, cities, timezones, owners, networks, feeds, providers,
    updatedAt: now.toISOString(),
    source: [
      "IPTV-org API",
      ...(repairedAmagiSources + addedFastFallbacks > 0 ? ["current FAST fallbacks"] : []),
      ...(additive.addedSources > 0 ? ["regional/provider playlists"] : []),
      ...(verifiedPublicFallbacks > 0 ? ["verified public fallbacks"] : []),
    ].join(" + "),
  };
}

// --- browser loading with Cache API read-through ---

type CachedCatalog = { cachedAt: number; catalog: WebCatalog };

async function readCache(): Promise<CachedCatalog | null> {
  try {
    if (typeof caches === "undefined") return null;
    const cache = await caches.open(WEB_CATALOG_CACHE_NAME);
    const response = await cache.match(WEB_CATALOG_CACHE_KEY);
    if (!response) return null;
    const parsed = await response.json() as CachedCatalog;
    return parsed?.catalog?.channels?.length ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(catalog: WebCatalog): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const cache = await caches.open(WEB_CATALOG_CACHE_NAME);
    const payload: CachedCatalog = { cachedAt: Date.now(), catalog };
    await cache.put(WEB_CATALOG_CACHE_KEY, new Response(JSON.stringify(payload)));
  } catch {
    // Caching is best-effort; the catalogue still loads without it.
  }
}

async function fetchJson<T>(name: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/${name}.json`, { signal: controller.signal });
    if (!response.ok) throw new Error(`IPTV-org ${name} returned HTTP ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the real IPTV-org catalogue in the browser. Twelve-hour Cache API
 * read-through; a failed refresh serves the stale cache rather than nothing.
 */
export async function loadWebCatalog(force = false): Promise<WebCatalog> {
  const cached = await readCache();
  if (!force && cached && Date.now() - cached.cachedAt < WEB_CATALOG_TTL_MS) {
    const freshHints = refreshSourceOrdering(cached.catalog.channels);
    return {
      ...cached.catalog,
      source: `${refreshedCatalogSource(cached.catalog.source, freshHints)} · browser cache`,
    };
  }
  try {
    const requiredCatalog = Promise.all([
        fetchJson<ApiChannel[]>("channels"),
        fetchJson<ApiFeed[]>("feeds"),
        fetchJson<ApiLogo[]>("logos"),
        fetchJson<ApiStream[]>("streams"),
        fetchJson<ApiCategory[]>("categories"),
        fetchJson<ApiLanguage[]>("languages"),
        fetchJson<ApiCountry[]>("countries"),
        fetchJson<ApiRegion[]>("regions"),
        fetchJson<ApiSubdivision[]>("subdivisions"),
        fetchJson<ApiCity[]>("cities"),
        fetchJson<ApiTimezone[]>("timezones"),
        fetchJson<ApiBlock[]>("blocklist"),
      ]);
    const [
      [channels, feeds, logos, streams, categories, languages, countries, regions, subdivisions, cities, timezones, blocklist],
      optionalFastFallbacks,
      streamHealth,
      additivePlaylistEntries,
    ] = await Promise.all([
      requiredCatalog,
      loadOptionalFastFallbacks().catch(() => []),
      loadStreamHealthIndex().catch(() => null),
      loadAdditivePlaylists(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ).catch(() => []),
    ]);
    const catalog = buildCatalogFromApi(
      { channels, feeds, logos, streams, categories, languages, countries, regions, subdivisions, cities, timezones, blocklist },
      new Date(),
      optionalFastFallbacks,
      additivePlaylistEntries,
    );
    const matchedHealth = streamHealth
      ? applyStreamHealthHints(catalog.channels, streamHealth.hints)
      : 0;
    if (matchedHealth > 0) catalog.source += " + recent source health";
    void writeCache(catalog);
    return catalog;
  } catch (error) {
    if (cached) {
      const freshHints = refreshSourceOrdering(cached.catalog.channels);
      return {
        ...cached.catalog,
        source: `${refreshedCatalogSource(cached.catalog.source, freshHints)} · offline cache`,
      };
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}
