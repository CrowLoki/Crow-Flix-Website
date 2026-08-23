import { RELAY_BASE } from "./relayClient";

export const MAX_ADDITIVE_PLAYLIST_BYTES = 2 * 1024 * 1024;
export const MAX_ADDITIVE_PLAYLIST_ENTRIES = 50_000;
const FETCH_TIMEOUT_MS = 12_000;

export type AdditivePlaylistConfig = {
  id: string;
  name: string;
  url: string;
  country: string | null;
  broadcastArea: string[];
  timezones: string[];
};

export type AdditivePlaylistEntry = {
  providerId: string;
  name: string;
  logo: string | null;
  group: string | null;
  url: string;
  userAgent: string | null;
  referrer: string | null;
  config: AdditivePlaylistConfig;
};

const AUSTRALIAN_PLAYLIST_REGIONS: Record<string, { city: string; area: string }> = {
  "Australia/Adelaide": { city: "Adelaide", area: "s/AU-SA" },
  "Australia/Brisbane": { city: "Brisbane", area: "s/AU-QLD" },
  "Australia/Broken_Hill": { city: "Adelaide", area: "s/AU-SA" },
  "Australia/Canberra": { city: "Canberra", area: "s/AU-ACT" },
  "Australia/Darwin": { city: "Darwin", area: "s/AU-NT" },
  "Australia/Hobart": { city: "Hobart", area: "s/AU-TAS" },
  "Australia/Lindeman": { city: "Brisbane", area: "s/AU-QLD" },
  "Australia/Lord_Howe": { city: "Sydney", area: "s/AU-NSW" },
  "Australia/Melbourne": { city: "Melbourne", area: "s/AU-VIC" },
  "Australia/Perth": { city: "Perth", area: "s/AU-WA" },
  "Australia/Sydney": { city: "Sydney", area: "s/AU-NSW" },
};

export function additivePlaylistConfigs(timeZone: string): AdditivePlaylistConfig[] {
  const australian = AUSTRALIAN_PLAYLIST_REGIONS[timeZone]
    || AUSTRALIAN_PLAYLIST_REGIONS["Australia/Sydney"]!;
  return [
    {
      id: `mjh-au-${australian.city.toLowerCase()}`,
      name: `i.mjh.nz Australia ${australian.city}`,
      url: `https://i.mjh.nz/au/${australian.city}/raw-tv.m3u8`,
      country: "AU",
      broadcastArea: [australian.area],
      timezones: [timeZone.startsWith("Australia/") ? timeZone : "Australia/Sydney"],
    },
    {
      id: "mjh-nz",
      name: "i.mjh.nz New Zealand",
      url: "https://i.mjh.nz/nz/raw-tv.m3u8",
      country: "NZ",
      broadcastArea: ["c/NZ"],
      timezones: ["Pacific/Auckland"],
    },
    {
      id: "mjh-world",
      name: "i.mjh.nz World",
      url: "https://i.mjh.nz/world/raw-tv.m3u8",
      country: null,
      broadcastArea: ["r/INT"],
      timezones: [],
    },
  ];
}

function attribute(line: string, name: string): string | null {
  return line.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"))?.[1]?.trim() || null;
}

function entryName(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === "," && !quoted) return line.slice(index + 1).trim();
  }
  return "Untitled channel";
}

export function parseAdditivePlaylist(
  content: string,
  config: AdditivePlaylistConfig,
): AdditivePlaylistEntry[] {
  if (new TextEncoder().encode(content).byteLength > MAX_ADDITIVE_PLAYLIST_BYTES) return [];
  const output: AdditivePlaylistEntry[] = [];
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
      userAgent = line.slice(line.indexOf("=") + 1).trim() || null;
      continue;
    }
    if (/^#EXTVLCOPT:http-referrer=/i.test(line)) {
      referrer = line.slice(line.indexOf("=") + 1).trim() || null;
      continue;
    }
    if (!metadata || !/^https?:\/\//i.test(line)) continue;
    if (output.length >= MAX_ADDITIVE_PLAYLIST_ENTRIES) return [];
    output.push({
      providerId: attribute(metadata, "tvg-id") || attribute(metadata, "channel-id") || "",
      name: entryName(metadata),
      logo: attribute(metadata, "tvg-logo"),
      group: attribute(metadata, "group-title"),
      url: line,
      userAgent,
      referrer,
      config,
    });
    metadata = null;
    userAgent = null;
    referrer = null;
  }
  return output;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function readBoundedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ADDITIVE_PLAYLIST_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > MAX_ADDITIVE_PLAYLIST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
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

async function loadOne(
  config: AdditivePlaylistConfig,
  fetchImpl: FetchLike,
): Promise<AdditivePlaylistEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const query = new URLSearchParams({ url: config.url });
    const response = await fetchImpl(`${RELAY_BASE}/fetch?${query}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const content = await readBoundedText(response);
    return content === null ? [] : parseAdditivePlaylist(content, config);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function loadAdditivePlaylists(
  timeZone: string,
  fetchImpl: FetchLike = fetch,
): Promise<AdditivePlaylistEntry[]> {
  const groups = await Promise.all(
    additivePlaylistConfigs(timeZone).map((config) => loadOne(config, fetchImpl)),
  );
  return groups.flat();
}
