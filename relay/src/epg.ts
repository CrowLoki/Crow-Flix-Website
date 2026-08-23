import { RelayError } from "./errors";
import { fetchValidated, validateExternalUrl } from "./urls";
import type { FetchLike } from "./urls";
import { XmltvStreamParser } from "./xmltv";
import type { RelayProgramme } from "./xmltv";

export const GUIDES_URL = "https://iptv-org.github.io/api/guides.json";
export const GUIDES_MAX_BYTES = 32 * 1024 * 1024;
/** Decompressed XMLTV budget per source — the parser streams and stores matches only. */
export const XMLTV_MAX_DECOMPRESSED_BYTES = 96 * 1024 * 1024;
/** How many ranked guide sources to try before falling back. */
export const MAX_EPG_SOURCES = 3;
/** Total programme cap after combining complementary guide layers. */
export const MAX_COMBINED_PROGRAMMES = 50_000;
export const MAX_CHANNEL_IDS = 2_000;
export const MAX_CHANNEL_ID_LENGTH = 200;
export const UPSTREAM_TIMEOUT_MS = 25_000;

const RELAY_UA = "crowflix-relay/0.2.0";
const MAX_GUIDE_OBJECT_CHARS = 128 * 1024;
const MAX_MATCHED_GUIDE_ENTRIES = 50_000;

/** Wire shape mirrors the app's camelCase GuideResult. */
export interface GuideResult {
  programmes: RelayProgramme[];
  source: string;
  matchedChannels: number;
  updatedAt: string;
}

export interface GuideSourceEntry {
  url: string;
  host?: string;
  format?: string;
}

export interface GuideEntry {
  channel?: string;
  feed?: string;
  site?: string;
  siteId?: string;
  siteName?: string;
  lang?: string;
  sources: GuideSourceEntry[];
}

/** Defensive shape check of the iptv-org guides index. */
export function parseGuidesJson(text: string): GuideEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const guides: GuideEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const channel =
      typeof record.channel === "string" ? record.channel : undefined;
    const feed = typeof record.feed === "string" ? record.feed : undefined;
    const site = typeof record.site === "string" ? record.site : undefined;
    const siteId = typeof record.site_id === "string" ? record.site_id : undefined;
    const siteName = typeof record.site_name === "string" ? record.site_name : undefined;
    const lang = typeof record.lang === "string" ? record.lang : undefined;
    const rawSources = Array.isArray(record.sources) ? record.sources : [];
    const sources: GuideSourceEntry[] = [];
    for (const source of rawSources) {
      if (typeof source === "object" && source !== null) {
        const url = (source as Record<string, unknown>).url;
        const host = (source as Record<string, unknown>).host;
        const format = (source as Record<string, unknown>).format;
        if (typeof url === "string" && url.length > 0) {
          sources.push({
            url,
            ...(typeof host === "string" ? { host } : {}),
            ...(typeof format === "string" ? { format } : {}),
          });
        }
      }
    }
    guides.push({
      ...(channel !== undefined ? { channel } : {}),
      ...(feed !== undefined ? { feed } : {}),
      ...(site !== undefined ? { site } : {}),
      ...(siteId !== undefined ? { siteId } : {}),
      ...(siteName !== undefined ? { siteName } : {}),
      ...(lang !== undefined ? { lang } : {}),
      sources,
    });
  }
  return guides;
}

export async function streamGuidesJson(
  body: ReadableStream<Uint8Array>,
  wantedIds: Iterable<string>,
  maximumBytes = GUIDES_MAX_BYTES,
): Promise<GuideEntry[]> {
  const wanted = new Set(wantedIds);
  const output: GuideEntry[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let current = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let oversized = false;

  const consume = (text: string) => {
    for (const character of text) {
      if (depth === 0) {
        if (character !== "{") continue;
        depth = 1;
        current = "{";
        oversized = false;
        inString = false;
        escaped = false;
        continue;
      }
      if (!oversized) {
        current += character;
        if (current.length > MAX_GUIDE_OBJECT_CHARS) {
          current = "";
          oversized = true;
        }
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        if (!oversized) {
          const [entry] = parseGuidesJson(`[${current}]`);
          if (entry?.channel && wanted.has(entry.channel)) output.push(entry);
        }
        current = "";
        oversized = false;
        if (output.length >= MAX_MATCHED_GUIDE_ENTRIES) return false;
      }
    }
    return true;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RelayError(502, "The guides index exceeded the relay size limit.");
      }
      if (!consume(decoder.decode(value, { stream: true }))) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    consume(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return output;
}

function copyGuideNames(
  input: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  return new Map([...input].map(([id, names]) => [id, [...names]]));
}

export function enrichGuideNames(
  namesByChannel: ReadonlyMap<string, readonly string[]>,
  guides: GuideEntry[],
  wantedIds: Iterable<string>,
): Map<string, string[]> {
  const output = copyGuideNames(namesByChannel);
  const wanted = new Set(wantedIds);
  for (const guide of guides) {
    if (!guide.channel || !wanted.has(guide.channel) || !guide.siteName) continue;
    const names = output.get(guide.channel) || [];
    if (!names.some((name) => name.toLowerCase() === guide.siteName!.toLowerCase())) {
      names.push(guide.siteName);
    }
    output.set(guide.channel, names);
  }
  return output;
}

/**
 * Mirror of the source_coverage ranking in load_auto_epg
 * (src-tauri/src/lib.rs lines 2180-2212): score each guide source URL by how
 * many of the requested channel ids it covers, sorted descending.
 */
export function rankGuideSources(
  guides: GuideEntry[],
  wantedIds: Iterable<string>,
): string[] {
  const coverage = guideSourceCoverage(guides, wantedIds);
  return [...coverage.entries()]
    .map(([url, channels]) => ({ url, count: channels.size }))
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.url);
}

function guideSourceCoverage(
  guides: GuideEntry[],
  wantedIds: Iterable<string>,
): Map<string, Set<string>> {
  const wanted = new Set(wantedIds);
  const coverage = new Map<string, Set<string>>();
  for (const guide of guides) {
    const channel = guide.channel;
    if (channel === undefined || !wanted.has(channel)) continue;
    for (const source of guide.sources) {
      let set = coverage.get(source.url);
      if (!set) {
        set = new Set();
        coverage.set(source.url, set);
      }
      set.add(channel);
    }
  }
  return coverage;
}

export function normalizeChannelIds(raw: string[]): string[] {
  const ids = raw.map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new RelayError(400, "Provide at least one channel id.");
  }
  if (ids.length > MAX_CHANNEL_IDS) {
    throw new RelayError(
      400,
      `That guide request contains more than ${MAX_CHANNEL_IDS} channel identifiers.`,
    );
  }
  for (const id of ids) {
    if (id.length > MAX_CHANNEL_ID_LENGTH) {
      throw new RelayError(400, "A channel id in that request is too long.");
    }
    for (let i = 0; i < id.length; i++) {
      const code = id.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) {
        throw new RelayError(
          400,
          "Channel ids must not contain control characters.",
        );
      }
    }
  }
  return [...new Set(ids)];
}

/** Normalise a country code for the ripper filename; GB maps to UK. */
export function normalizeCountryCode(country: string): string {
  const code = country.trim().toUpperCase();
  if (code === "") return "";
  if (!/^[A-Z0-9]{2,8}$/.test(code)) {
    throw new RelayError(400, "Provide a valid country code.");
  }
  return code === "GB" ? "UK" : code;
}

/**
 * Feed a (possibly gzipped) XMLTV body into the parser, bounding the
 * decompressed byte count. Detects gzip by magic bytes (0x1f 0x8b), which
 * covers .gz files served without a Content-Encoding header; when upstream
 * sets Content-Encoding: gzip the runtime has already decompressed for us.
 */
export async function streamXmltvBody(
  body: ReadableStream<Uint8Array>,
  parser: XmltvStreamParser,
  maxDecompressedBytes = XMLTV_MAX_DECOMPRESSED_BYTES,
): Promise<{ truncated: boolean }> {
  const probe = body.getReader();

  // Accumulate at least 2 bytes so the gzip magic check is reliable.
  let first = new Uint8Array(0);
  for (;;) {
    const { done, value } = await probe.read();
    if (done) break;
    const merged = new Uint8Array(first.byteLength + value.byteLength);
    merged.set(first);
    merged.set(value, first.byteLength);
    first = merged;
    if (first.byteLength >= 2) break;
  }
  if (first.byteLength === 0) {
    probe.releaseLock();
    return { truncated: false };
  }

  const reassembled = prependChunk(first, probe);
  const isGzip = first[0] === 0x1f && first[1] === 0x8b;
  const stream = isGzip
    ? reassembled.pipeThrough(new DecompressionStream("gzip"))
    : reassembled;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxDecompressedBytes) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      parser.push(decoder.decode(value, { stream: true }));
      if (parser.truncated) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  parser.push(decoder.decode());
  return { truncated: truncated || parser.truncated };
}

function prependChunk(
  first: Uint8Array,
  rest: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(first);
      try {
        for (;;) {
          const { done, value } = await rest.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        rest.releaseLock();
      }
    },
    async cancel(reason) {
      await rest.cancel(reason).catch(() => undefined);
      rest.releaseLock();
    },
  });
}

async function fetchGuides(
  fetcher: FetchLike,
  wantedIds: Iterable<string>,
): Promise<GuideEntry[]> {
  const response = await fetchValidated(
    new URL(GUIDES_URL),
    {
      headers: { Accept: "application/json", "User-Agent": RELAY_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
    fetcher,
  );
  if (!response.ok || !response.body) {
    throw new RelayError(
      502,
      `The guides index responded ${response.status}.`,
    );
  }
  return streamGuidesJson(response.body, wantedIds);
}

async function fetchSourceProgrammes(
  sourceUrl: string,
  channelIds: string[],
  fetcher: FetchLike,
  aliases: ReadonlyMap<string, string> = new Map(),
  namesByChannel: ReadonlyMap<string, readonly string[]> = new Map(),
): Promise<RelayProgramme[]> {
  const target = validateExternalUrl(sourceUrl);
  const response = await fetchValidated(
    target,
    {
      headers: {
        Accept: "application/xml, text/xml, */*",
        "User-Agent": RELAY_UA,
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
    fetcher,
  );
  if (!response.ok || !response.body) {
    throw new RelayError(502, `The guide source responded ${response.status}.`);
  }
  const parser = new XmltvStreamParser(
    [...channelIds, ...aliases.keys()],
    {},
    namesByChannel,
  );
  await streamXmltvBody(response.body, parser);
  return parser.end().map((programme) => ({
    ...programme,
    channelId: aliases.get(programme.channelId) || programme.channelId,
  }));
}

type AustralianGuideSource = {
  city: string;
  url: string;
  aliases: Map<string, string>;
};

type AustralianGuideRegion = {
  city: string;
  abc: string;
  commercial: string;
  seven: string;
};

const AUSTRALIAN_GUIDE_REGIONS: Record<string, AustralianGuideRegion> = {
  "Australia/Adelaide": { city: "Adelaide", abc: "sa", commercial: "sa", seven: "ade" },
  "Australia/Brisbane": { city: "Brisbane", abc: "qld", commercial: "qld", seven: "bri" },
  "Australia/Broken_Hill": { city: "Adelaide", abc: "sa", commercial: "sa", seven: "ade" },
  "Australia/Canberra": { city: "Canberra", abc: "act", commercial: "nsw", seven: "syd" },
  "Australia/Darwin": { city: "Darwin", abc: "nt", commercial: "sa", seven: "ade" },
  "Australia/Hobart": { city: "Hobart", abc: "tas", commercial: "vic", seven: "mel" },
  "Australia/Lindeman": { city: "Brisbane", abc: "qld", commercial: "qld", seven: "bri" },
  "Australia/Lord_Howe": { city: "Sydney", abc: "nsw", commercial: "nsw", seven: "syd" },
  "Australia/Melbourne": { city: "Melbourne", abc: "vic", commercial: "vic", seven: "mel" },
  "Australia/Perth": { city: "Perth", abc: "wa", commercial: "wa", seven: "per" },
  "Australia/Sydney": { city: "Sydney", abc: "nsw", commercial: "nsw", seven: "syd" },
};

const AUSTRALIAN_FIXED_ALIASES: Record<string, string> = {
  "ABCKids.au": "mjh-abc-kids",
  "ABCEntertains.au": "mjh-abc-me",
  "ABCNews.au": "mjh-abc-news",
  "ABCTVPlus.au": "mjh-abc-tv-plus",
  "AusbizTV.au": "mjh-ausbiz-fast",
  "CricketGold.au": "mjh-cricketgold-fast",
  "Racingcom.au": "mjh-racing-fast",
  "SBSWorldWatch.au": "mjh-sbs-6nat",
  "SkyRacing1.au": "mjh-sky-racing-1",
  "SkyRacing2.au": "mjh-sky-racing-2",
  "SkyThoroughbredCentral.au": "mjh-sky-racing-thoroughbred",
  "TVSN.au": "mjh-tvsn-fast",
};

const EPGSHARE_PRIMARY_TAGS: Record<string, string> = {
  BE: "BE2",
  CA: "CA2",
  US: "US2",
};

export function epgSharePrimaryTag(countryCode: string): string {
  const code = normalizeCountryCode(countryCode);
  return EPGSHARE_PRIMARY_TAGS[code] || `${code}1`;
}

export function australianGuideSource(
  channelIds: Iterable<string>,
  timeZone: string,
): AustralianGuideSource | null {
  const region = AUSTRALIAN_GUIDE_REGIONS[timeZone];
  if (!region) return null;
  const requested = new Set(channelIds);
  const aliases = new Map<string, string>();
  const add = (channelId: string, alias: string) => {
    if (requested.has(channelId)) aliases.set(alias, channelId);
  };

  for (const [channelId, alias] of Object.entries(AUSTRALIAN_FIXED_ALIASES)) {
    add(channelId, alias);
  }
  add("ABCTV.au", `mjh-abc-${region.abc}`);
  add("Channel7.au", `mjh-seven-${region.seven}`);
  add("Channel9.au", `mjh-channel-9-${region.commercial}`);
  add("9Gem.au", `mjh-gem-${region.commercial}`);
  add("9Go.au", `mjh-go-${region.commercial}`);
  add("9Life.au", `mjh-life-${region.commercial}`);
  add("10Bold.au", `mjh-10bold-${region.commercial}`);
  if (!aliases.size) return null;

  return {
    city: region.city,
    url: `https://i.mjh.nz/au/${region.city}/epg.xml.gz`,
    aliases,
  };
}

/**
 * Mirror of load_auto_epg in src-tauri/src/lib.rs (lines 2180-2237):
 * rank iptv-org guide sources by requested-id coverage, try the best few,
 * then fall back to the regional epgshare01 ripper files.
 */
export async function loadAutoEpg(
  country: string,
  channelIds: string[],
  fetcher: FetchLike = fetch,
  timeZone = "",
  namesByChannel: ReadonlyMap<string, readonly string[]> = new Map(),
): Promise<GuideResult> {
  const ids = normalizeChannelIds(channelIds);
  const code = normalizeCountryCode(country);
  let resolvedNames = copyGuideNames(namesByChannel);
  const combined = new Map<string, RelayProgramme>();
  const matched = new Set<string>();
  const sourceLabels: string[] = [];
  const remainingIds = () => ids.filter((id) => !matched.has(id));
  const addLayer = (programmes: RelayProgramme[], label: string): boolean => {
    let added = false;
    for (const programme of programmes) {
      const identity = `${programme.channelId}\u0000${programme.start}\u0000${programme.stop}`;
      if (combined.has(identity)) {
        matched.add(programme.channelId);
        continue;
      }
      if (combined.size >= MAX_COMBINED_PROGRAMMES) break;
      combined.set(identity, programme);
      matched.add(programme.channelId);
      added = true;
    }
    if (added && !sourceLabels.includes(label)) sourceLabels.push(label);
    return added;
  };

  try {
    const guides = await fetchGuides(fetcher, ids);
    resolvedNames = enrichGuideNames(resolvedNames, guides, ids);
    const ranked = rankGuideSources(guides, ids);
    const coverage = guideSourceCoverage(guides, ids);
    let attempts = 0;
    for (const source of ranked) {
      if (combined.size >= MAX_COMBINED_PROGRAMMES) break;
      const expected = coverage.get(source);
      if (expected && [...expected].every((id) => matched.has(id))) continue;
      if (attempts >= MAX_EPG_SOURCES) break;
      attempts += 1;
      try {
        const programmes = await fetchSourceProgrammes(
          source,
          remainingIds(),
          fetcher,
          new Map(),
          resolvedNames,
        );
        addLayer(programmes, `IPTV-org EPG · ${source}`);
      } catch {
        // Try the next ranked source.
      }
    }
  } catch {
    // guides.json unavailable — fall through to the regional ripper.
  }

  if (code === "AU" && combined.size < MAX_COMBINED_PROGRAMMES) {
    const regional = australianGuideSource(remainingIds(), timeZone);
    if (regional) {
      try {
        const programmes = await fetchSourceProgrammes(
          regional.url,
          remainingIds(),
          fetcher,
          regional.aliases,
          resolvedNames,
        );
        addLayer(programmes, `Australian ${regional.city} guide`);
      } catch {
        // Fall through to the broad EPGShare file.
      }
    }
  }

  if (
    code.length > 0
    && combined.size < MAX_COMBINED_PROGRAMMES
    && remainingIds().length > 0
  ) {
    const filename = `epg_ripper_${epgSharePrimaryTag(code)}.xml.gz`;
    for (const source of [
      `https://epgshare01.online/epgshare01/${filename}`,
      `https://raw.githubusercontent.com/epgshare01/share01/master/${filename}`,
    ]) {
      try {
        const programmes = await fetchSourceProgrammes(
          source,
          remainingIds(),
          fetcher,
          new Map(),
          resolvedNames,
        );
        if (addLayer(programmes, `Automatic regional guide · ${code}`)) break;
      } catch {
        // Try the next ripper mirror.
      }
    }
  }

  if (combined.size > 0) {
    const programmes = [...combined.values()].sort((left, right) =>
      left.start.localeCompare(right.start)
      || left.channelId.localeCompare(right.channelId));
    return guideResult(programmes, sourceLabels.join(" + "));
  }

  throw new RelayError(
    502,
    `No current programme listings matched the ${code || "requested"} channels.`,
  );
}

/** Mirror of guide_result() in lib.rs. */
export function guideResult(
  programmes: RelayProgramme[],
  source: string,
): GuideResult {
  return {
    programmes,
    source,
    matchedChannels: new Set(programmes.map((p) => p.channelId)).size,
    updatedAt: new Date().toISOString(),
  };
}
