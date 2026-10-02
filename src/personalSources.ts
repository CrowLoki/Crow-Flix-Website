import { canonicalCountryCode } from "./broadcastArea";
import { mergeChannelsByKey } from "./catalogMerge";
import {
  MAX_PLAYLIST_IMPORT_BYTES,
  MAX_XMLTV_IMPORT_BYTES,
} from "./importLimits";
import {
  sourceIdentifier,
  type StreamSource,
  type TransportHint,
} from "./playback/types";
import type {
  CountryOption,
  NamedOption,
  RegionOption,
  WebCatalog,
  WebChannel,
} from "./webCatalog";
import { MAIN_FEED_OPTION_ID } from "./webCatalog";
import { XmltvStreamParser } from "../relay/src/xmltv";

export const MAX_PERSONAL_PLAYLIST_ENTRIES = 50_000;

export type PersonalGuideChannel = {
  id: string;
  name: string;
  altNames?: string[];
};

export type PersonalGuideResult = {
  programmes: Array<{
    channelId: string;
    title: string;
    description?: string;
    category?: string;
    start: string;
    stop: string;
  }>;
  source: string;
  matchedChannels: number;
  updatedAt: string;
};

type StreamHeaders = {
  userAgent: string | null;
  referrer: string | null;
};

type PersonalXmltvFile = Pick<File, "name" | "size" | "stream">;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function plainText(value: string | null | undefined, maximum: number): string | null {
  const text = value?.trim() || "";
  return !text || text.length > maximum || CONTROL_CHARACTER.test(text)
    ? null
    : text;
}

function safeSourceName(value: string): string {
  return plainText(value, 160) || "personal import";
}

function safeHttpUrl(value: string | null | undefined): string | null {
  const text = value?.trim() || "";
  if (
    !text
    || text.length > 8_192
    || CONTROL_CHARACTER.test(text)
    || /\s/u.test(text)
  ) return null;
  try {
    const parsed = new URL(text);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || !parsed.hostname
      || parsed.username
      || parsed.password
    ) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function normalizePersonalSourceUrl(value: string): string {
  const normalized = safeHttpUrl(value);
  if (!normalized) {
    throw new Error("Enter a complete public HTTP or HTTPS source address.");
  }
  return normalized;
}

function attribute(line: string, name: string): string | null {
  return line.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"))?.[1]?.trim() || null;
}

function entryName(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === "," && !quoted) {
      return plainText(line.slice(index + 1), 256) || "Untitled channel";
    }
  }
  return "Untitled channel";
}

function splitValues(value: string | null, maximum = 32): string[] {
  if (!value) return [];
  return [...new Set(value
    .split(/[;,]/)
    .map((item) => plainText(item, 128))
    .filter((item): item is string => Boolean(item)))]
    .slice(0, maximum);
}

function categoryId(value: string | null): string {
  return (plainText(value, 80) || "other")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    || "other";
}

function streamTransport(url: string): TransportHint {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return "hls";
  if (path.endsWith(".mpd")) return "dash";
  if ([".mp4", ".m4v", ".webm", ".ts", ".m2ts", ".aac", ".m4a", ".mp3", ".ogg", ".oga"]
    .some((extension) => path.endsWith(extension))) return "direct";
  return "unknown";
}

function normalizeUserAgent(value: string | null): string | null {
  const text = plainText(value, 512);
  return text && /^[\x20-\x7e]*$/u.test(text) ? text : null;
}

function normalizeReferrer(value: string | null): string | null {
  return safeHttpUrl(value);
}

function parsePipeHeaders(value: string): { url: string; headers: StreamHeaders } {
  const separator = value.indexOf("|");
  if (separator === -1) {
    return { url: value, headers: { userAgent: null, referrer: null } };
  }
  const url = value.slice(0, separator).trim();
  const parameters = new URLSearchParams(value.slice(separator + 1));
  const userAgent = parameters.get("User-Agent")
    || parameters.get("user-agent")
    || parameters.get("UserAgent")
    || parameters.get("useragent");
  const referrer = parameters.get("Referer")
    || parameters.get("referer")
    || parameters.get("Referrer")
    || parameters.get("referrer");
  return {
    url,
    headers: {
      userAgent: normalizeUserAgent(userAgent),
      referrer: normalizeReferrer(referrer),
    },
  };
}

function parseExtHttp(line: string): StreamHeaders {
  const json = line.slice(line.indexOf(":") + 1).trim();
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const userAgent = typeof parsed["User-Agent"] === "string"
      ? parsed["User-Agent"]
      : typeof parsed["user-agent"] === "string" ? parsed["user-agent"] : null;
    const referrer = typeof parsed.Referer === "string"
      ? parsed.Referer
      : typeof parsed.Referrer === "string" ? parsed.Referrer : null;
    return {
      userAgent: normalizeUserAgent(userAgent),
      referrer: normalizeReferrer(referrer),
    };
  } catch {
    return { userAgent: null, referrer: null };
  }
}

function providerIdentity(raw: string | null, fallback: string): {
  id: string;
  feed: string | null;
  key: string;
} {
  const normalized = plainText(raw, 200);
  if (!normalized || /\s/u.test(normalized)) {
    return { id: `Personal.${fallback}`, feed: null, key: `Personal.${fallback}@main` };
  }
  const separator = normalized.indexOf("@");
  const id = separator > 0 ? normalized.slice(0, separator) : normalized;
  const feed = separator > 0 ? plainText(normalized.slice(separator + 1), 100) : null;
  return { id, feed, key: `${id}@${feed || "main"}` };
}

function countryCode(metadata: string): string | null {
  const raw = splitValues(attribute(metadata, "tvg-country"), 1)[0];
  const code = canonicalCountryCode(raw);
  return /^[A-Z]{2}$/u.test(code) ? code : null;
}

/** Parse a user-selected M3U locally. No file content is uploaded. */
export function parsePersonalPlaylist(
  content: string,
  sourceName = "personal import",
): WebChannel[] {
  const size = new TextEncoder().encode(content).byteLength;
  if (size > MAX_PLAYLIST_IMPORT_BYTES) {
    throw new Error("That personal playlist exceeds the 16 MiB import limit.");
  }

  const provenance = `Personal M3U · ${safeSourceName(sourceName)}`;
  const channels: WebChannel[] = [];
  let metadata: string | null = null;
  let userAgent: string | null = null;
  let referrer: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^\uFEFF/, "");
    if (/^#EXTINF\b/i.test(line)) {
      metadata = line;
      userAgent = null;
      referrer = null;
      continue;
    }
    if (/^#EXTVLCOPT:http-user-agent=/i.test(line)) {
      userAgent = normalizeUserAgent(line.slice(line.indexOf("=") + 1));
      continue;
    }
    if (/^#EXTVLCOPT:http-referrer=/i.test(line)) {
      referrer = normalizeReferrer(line.slice(line.indexOf("=") + 1));
      continue;
    }
    if (/^#EXTHTTP:/i.test(line)) {
      const headers = parseExtHttp(line);
      userAgent = headers.userAgent || userAgent;
      referrer = headers.referrer || referrer;
      continue;
    }
    if (!metadata || line.startsWith("#")) continue;

    const piped = parsePipeHeaders(line);
    const url = safeHttpUrl(piped.url);
    if (!url) {
      metadata = null;
      userAgent = null;
      referrer = null;
      continue;
    }
    if (channels.length >= MAX_PERSONAL_PLAYLIST_ENTRIES) {
      throw new Error(`That playlist contains more than ${MAX_PERSONAL_PLAYLIST_ENTRIES.toLocaleString()} entries.`);
    }

    const name = plainText(attribute(metadata, "tvg-name"), 256)
      || entryName(metadata);
    const source: StreamSource = {
      url,
      userAgent: piped.headers.userAgent || userAgent,
      referrer: piped.headers.referrer || referrer,
      quality: plainText(attribute(metadata, "quality"), 64),
      label: "Personal source",
      transport: streamTransport(url),
      isHttps: url.startsWith("https://"),
      requiresHeaders: Boolean(
        piped.headers.userAgent
        || userAgent
        || piped.headers.referrer
        || referrer
      ),
      provenance,
      provenances: [provenance],
    };
    source.id = sourceIdentifier(source);
    const identity = providerIdentity(
      attribute(metadata, "tvg-id"),
      source.id || sourceIdentifier(source),
    );
    const country = countryCode(metadata);
    const alternateName = entryName(metadata);
    channels.push({
      key: identity.key,
      id: identity.id,
      feed: identity.feed,
      name,
      altNames: alternateName !== name ? [alternateName] : [],
      owners: [],
      logo: safeHttpUrl(attribute(metadata, "tvg-logo")),
      categories: [categoryId(attribute(metadata, "group-title"))],
      country,
      languages: splitValues(attribute(metadata, "tvg-language")),
      broadcastArea: country ? [`c/${country}`] : [],
      timezones: splitValues(attribute(metadata, "tvg-timezone")),
      sources: [source],
      url: source.url,
      referrer: source.referrer,
      userAgent: source.userAgent,
      quality: source.quality,
      label: source.label,
      format: source.quality,
      network: null,
      website: null,
      launched: null,
      replacedBy: null,
      isNsfw: false,
      provenance: [provenance],
      isMain: identity.feed === null,
    });
    metadata = null;
    userAgent = null;
    referrer = null;
  }

  const merged = mergeChannelsByKey([], channels);
  if (!merged.length) {
    throw new Error("No playable HTTP or HTTPS channels were found in that playlist.");
  }
  return merged;
}

function titleCase(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function optionCounts(
  channels: readonly WebChannel[],
  values: (channel: WebChannel) => Iterable<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const channel of channels) {
    for (const value of new Set(values(channel))) {
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return counts;
}

function bumpNamedOptions(
  existing: readonly NamedOption[],
  increments: ReadonlyMap<string, number>,
  display: (id: string) => string,
): NamedOption[] {
  const byCanonical = new Map(existing.map((item) => [item.id.toLowerCase(), { ...item }]));
  for (const [id, count] of increments) {
    const canonical = id.toLowerCase();
    const current = byCanonical.get(canonical);
    if (current) current.count += count;
    else byCanonical.set(canonical, { id, name: display(id), description: null, count });
  }
  return [...byCanonical.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function channelCountries(channel: WebChannel): Set<string> {
  const countries = new Set<string>();
  const fallback = canonicalCountryCode(channel.country);
  if (/^[A-Z]{2}$/u.test(fallback)) countries.add(fallback);
  for (const area of channel.broadcastArea) {
    const [kind, rawValue] = area.split("/", 2);
    const value = rawValue?.trim().toUpperCase() || "";
    let code = "";
    if (kind?.toLowerCase() === "c") code = value;
    if (kind?.toLowerCase() === "s" || kind?.toLowerCase() === "ct") code = value.slice(0, 2);
    code = canonicalCountryCode(code);
    if (/^[A-Z]{2}$/u.test(code)) countries.add(code);
  }
  return countries;
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(code === "UK" ? "GB" : code) || code;
  } catch {
    return code;
  }
}

function countryFlag(code: string): string {
  const regional = code === "UK" ? "GB" : code;
  return /^[A-Z]{2}$/u.test(regional)
    ? [...regional].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join("")
    : "";
}

function bumpCountryOptions(
  existing: readonly CountryOption[],
  increments: ReadonlyMap<string, number>,
): CountryOption[] {
  const byCode = new Map(existing.map((item) => [canonicalCountryCode(item.code), { ...item }]));
  for (const [rawCode, count] of increments) {
    const code = canonicalCountryCode(rawCode);
    const current = byCode.get(code);
    if (current) current.count += count;
    else byCode.set(code, { code, name: countryName(code), flag: countryFlag(code), languages: [], count });
  }
  return [...byCode.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function bumpRegionOptions(
  existing: readonly RegionOption[],
  added: readonly WebChannel[],
): RegionOption[] {
  return existing.map((region) => ({
    ...region,
    count: region.count + added.filter((channel) => {
      const countries = channelCountries(channel);
      return region.countries.some((code) => countries.has(canonicalCountryCode(code)));
    }).length,
  })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

/** Merge imported channels additively and extend every affected browse dimension. */
export function mergePersonalPlaylistIntoCatalog(
  catalog: WebCatalog,
  imported: readonly WebChannel[],
): WebCatalog {
  const existingKeys = new Set(catalog.channels.map((channel) => channel.key));
  const channels = mergeChannelsByKey(catalog.channels, imported);
  const added = channels.filter((channel) => !existingKeys.has(channel.key));
  const subdivisionCounts = optionCounts(added, (channel) => channel.broadcastArea
    .filter((area) => area.toLowerCase().startsWith("s/"))
    .map((area) => area.slice(2).trim().toUpperCase()));
  const cityCounts = optionCounts(added, (channel) => channel.broadcastArea
    .filter((area) => area.toLowerCase().startsWith("ct/"))
    .map((area) => area.slice(3).trim().toUpperCase()));
  const label = "personal playlist";
  return {
    ...catalog,
    channels,
    categories: bumpNamedOptions(
      catalog.categories,
      optionCounts(added, (channel) => channel.categories),
      titleCase,
    ),
    countries: bumpCountryOptions(
      catalog.countries,
      optionCounts(added, channelCountries),
    ),
    languages: bumpNamedOptions(
      catalog.languages,
      optionCounts(added, (channel) => channel.languages),
      (id) => id,
    ),
    regions: bumpRegionOptions(catalog.regions, added),
    subdivisions: bumpNamedOptions(catalog.subdivisions, subdivisionCounts, (id) => id),
    cities: bumpNamedOptions(catalog.cities, cityCounts, (id) => id),
    timezones: bumpNamedOptions(
      catalog.timezones,
      optionCounts(added, (channel) => channel.timezones || []),
      (id) => id.replace(/_/g, " "),
    ),
    owners: bumpNamedOptions(
      catalog.owners,
      optionCounts(added, (channel) => channel.owners || []),
      (id) => id,
    ),
    networks: bumpNamedOptions(
      catalog.networks,
      optionCounts(added, (channel) => channel.network ? [channel.network] : []),
      (id) => id,
    ),
    feeds: bumpNamedOptions(
      catalog.feeds,
      optionCounts(added, (channel) => [channel.feed || MAIN_FEED_OPTION_ID]),
      (id) => id === MAIN_FEED_OPTION_ID ? "Main feed" : id,
    ),
    providers: bumpNamedOptions(
      catalog.providers,
      optionCounts(added, (channel) => [
        ...(channel.provenance || []),
        ...channel.sources.flatMap((source) => [
          ...(source.provenances || []),
          ...(source.provenance ? [source.provenance] : []),
        ]),
      ]),
      (id) => id,
    ),
    updatedAt: new Date().toISOString(),
    source: catalog.source.toLowerCase().includes(label)
      ? catalog.source
      : `${catalog.source} + ${label}`,
  };
}

const XML_NAME = "[\\p{L}_:][\\p{L}\\p{N}\\p{M}_.:\\-\\u00b7]*";
const XML_OPEN_TAG = new RegExp(`^<(${XML_NAME})`, "u");
const XML_ATTRIBUTE = new RegExp(`^\\s+(${XML_NAME})\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')`, "u");

function invalidXmltv(): never {
  throw new Error("That source is not a complete, valid XMLTV document. Choose a guide with a <tv> root element.");
}

function validateXmlText(text: string): void {
  const remainder = text.replace(/&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, (entity) => {
    if (entity.startsWith("&#")) {
      const point = entity.startsWith("&#x")
        ? Number.parseInt(entity.slice(3, -1), 16)
        : Number.parseInt(entity.slice(2, -1), 10);
      if (!(point === 9 || point === 10 || point === 13
        || (point >= 0x20 && point <= 0xd7ff)
        || (point >= 0xe000 && point <= 0xfffd)
        || (point >= 0x10000 && point <= 0x10ffff))) invalidXmltv();
    }
    return "";
  });
  if (remainder.includes("&")) invalidXmltv();
}

/** Validate the document envelope and XML structure without retaining the guide.
 * Programme extraction stays in the shared XMLTV parser. External DTDs are
 * accepted as declarations only; personal imports never fetch or expand them.
 */
class PersonalXmltvValidator {
  private buffer = "";
  private readonly stack: string[] = [];
  private rootSeen = false;
  private doctypeSeen = false;
  private declarationSeen = false;
  private section: "comment" | "cdata" | null = null;

  push(chunk: string): void {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(chunk)) invalidXmltv();
    this.buffer += chunk;
    for (;;) {
      if (this.section) {
        const close = this.section === "comment" ? "-->" : "]]>";
        const end = this.buffer.indexOf(close);
        const content = end < 0 ? this.buffer.slice(0, -2) : this.buffer.slice(0, end);
        if (this.section === "comment" && (content.includes("--")
          || (end >= 0 && content.endsWith("-"))
          || (end < 0 && this.buffer.slice(0, -1).includes("--")))) invalidXmltv();
        if (end < 0) {
          this.buffer = this.buffer.slice(-2);
          return;
        }
        this.buffer = this.buffer.slice(end + close.length);
        this.section = null;
      }
      if (!this.buffer) return;
      if (!this.buffer.startsWith("<")) {
        const nextTag = this.buffer.indexOf("<");
        if ((nextTag < 0 ? this.buffer : this.buffer.slice(0, nextTag)).includes("]]>")) invalidXmltv();
        // Retain a split entity and the ]]> sentinel across chunk boundaries.
        const ampersand = this.buffer.lastIndexOf("&");
        const textEnd = Math.max(0, this.buffer.length - 2);
        const entityEnd = this.buffer.indexOf(";", ampersand);
        const partialEntity = ampersand >= 0 && (entityEnd < 0 || entityEnd >= textEnd);
        const end = nextTag >= 0 ? nextTag
          : Math.min(textEnd, partialEntity ? ampersand : this.buffer.length);
        const text = this.buffer.slice(0, end);
        if (!this.stack.length && text.trim()) invalidXmltv();
        validateXmlText(text);
        this.buffer = this.buffer.slice(end);
        if (nextTag < 0) break;
        continue;
      }
      if (this.buffer.startsWith("<!--")) {
        this.buffer = this.buffer.slice(4);
        this.section = "comment";
        continue;
      }
      if (this.buffer.startsWith("<![CDATA[")) {
        if (!this.stack.length) invalidXmltv();
        this.buffer = this.buffer.slice(9);
        this.section = "cdata";
        continue;
      }
      // Quoted attribute values can contain >; stop at the unquoted terminator.
      const token = this.buffer.startsWith("<?")
        ? /^<\?[\s\S]*?\?>/u.exec(this.buffer)?.[0]
        : /^<(?:[^>"']|"[^"]*"|'[^']*')*>/u.exec(this.buffer)?.[0];
      if (!token) break;
      if (token.length > 64 * 1024) throw new Error("That XMLTV document contains an oversized XML tag.");
      this.buffer = this.buffer.slice(token.length);
      if (token.startsWith("<?")) {
        if (!/^<\?[\w:-]+(?:\s[\s\S]*)?\?>$/u.test(token)) invalidXmltv();
        if (/^<\?xml(?:\s|\?)/i.test(token)) {
          if (this.rootSeen || this.doctypeSeen || this.declarationSeen
            || !/^<\?xml\s+version\s*=\s*(["'])1\.[01]\1(?:\s+(?:encoding|standalone)\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\?>$/u.test(token)) invalidXmltv();
          this.declarationSeen = true;
        }
        continue;
      }
      if (token.startsWith("<!DOCTYPE")) {
        if (this.rootSeen || this.doctypeSeen
          || !/^<!DOCTYPE\s+tv(?:\s+SYSTEM\s+(?:"[^"]*"|'[^']*')|\s+PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*'))?\s*>$/u.test(token)) {
          throw new Error("That XMLTV declaration is invalid or uses unsupported internal entities. Import a guide without an internal DTD subset.");
        }
        this.doctypeSeen = true;
        continue;
      }
      if (token.startsWith("</")) {
        const name = token.slice(2, -1).trimEnd();
        if (this.stack.pop() !== name) invalidXmltv();
        continue;
      }
      const name = XML_OPEN_TAG.exec(token)?.[1];
      if (!name) invalidXmltv();
      if (!this.stack.length) {
        if (this.rootSeen || name !== "tv") invalidXmltv();
        this.rootSeen = true;
      } else if (name === "tv") invalidXmltv();
      let rest = token.slice(name.length + 1);
      const attributes = new Set<string>();
      while (!/^\s*\/?>$/u.test(rest)) {
        const attribute = XML_ATTRIBUTE.exec(rest);
        if (!attribute || attributes.has(attribute[1])) invalidXmltv();
        attributes.add(attribute[1]);
        const value = attribute[2] ?? attribute[3];
        if (value.includes("<")) invalidXmltv();
        validateXmlText(value);
        rest = rest.slice(attribute[0].length);
      }
      if (!rest.trimStart().startsWith("/")) this.stack.push(name);
      if (this.stack.length > 64) throw new Error("That XMLTV document is nested too deeply for a browser import.");
    }
    if (this.buffer.length > 64 * 1024) throw new Error("That XMLTV document contains an oversized XML tag or entity.");
  }

  end(): void {
    if (!this.rootSeen || this.stack.length || this.section || this.buffer.trim()) invalidXmltv();
  }
}

function guideParser(channels: readonly PersonalGuideChannel[]) {
  const ids = [...new Set(channels.map((channel) => channel.id).filter(Boolean))];
  const names = new Map<string, string[]>();
  for (const channel of channels) {
    const values = [...new Set([channel.name, ...(channel.altNames || [])]
      .map((name) => plainText(name, 256))
      .filter((name): name is string => Boolean(name)))];
    if (values.length) names.set(channel.id, values.slice(0, 12));
  }
  const parser = new XmltvStreamParser(ids, {}, names);
  const validator = new PersonalXmltvValidator();
  return {
    push(chunk: string) { validator.push(chunk); parser.push(chunk); },
    end() { validator.end(); return parser.end(); },
  };
}

function personalGuideResult(
  parser: ReturnType<typeof guideParser>,
  sourceName: string,
): PersonalGuideResult {
  const programmes = parser.end();
  return {
    programmes,
    source: `Personal XMLTV · ${safeSourceName(sourceName)}`,
    matchedChannels: new Set(programmes.map((programme) => programme.channelId)).size,
    updatedAt: new Date().toISOString(),
  };
}

/** Parse bounded XMLTV text locally and retain only programmes for known channels. */
export function parsePersonalXmltv(
  content: string,
  channels: readonly PersonalGuideChannel[],
  sourceName = "personal import",
): PersonalGuideResult {
  if (new TextEncoder().encode(content).byteLength > MAX_XMLTV_IMPORT_BYTES) {
    throw new Error("That personal programme guide exceeds the 128 MiB import limit.");
  }
  const parser = guideParser(channels);
  for (let offset = 0; offset < content.length; offset += 64 * 1024) {
    parser.push(content.slice(offset, offset + 64 * 1024));
  }
  return personalGuideResult(parser, sourceName);
}

/** Stream a selected XMLTV file into the bounded parser without loading it all at once. */
export async function parsePersonalXmltvFile(
  file: PersonalXmltvFile,
  channels: readonly PersonalGuideChannel[],
): Promise<PersonalGuideResult> {
  if (file.size > MAX_XMLTV_IMPORT_BYTES) {
    throw new Error(`${file.name} exceeds the 128 MiB programme-guide import limit.`);
  }
  const parser = guideParser(channels);
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_XMLTV_IMPORT_BYTES) {
        throw new Error(`${file.name} exceeds the 128 MiB programme-guide import limit.`);
      }
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    const result = personalGuideResult(parser, file.name);
    completed = true;
    return result;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
