import type { WebCatalog } from "./webCatalog";
import { readBoundedResponse } from "./playback/boundedResponse";

export const PREPARED_CATALOG_VERSION = 1;
export const PREPARED_CATALOG_CACHE_NAME = "crowflix-prepared-catalog-v1";
export const PREPARED_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PREPARED_CATALOG_BYTES = 64 * 1024 * 1024;
export const MAX_PREPARED_CATALOG_GZIP_BYTES = 25 * 1024 * 1024;

export const PREPARED_CATALOG_REGIONS = [
  "Adelaide", "Brisbane", "Canberra", "Darwin", "Hobart", "Melbourne", "Perth", "Sydney",
] as const;
export type PreparedCatalogRegion = typeof PREPARED_CATALOG_REGIONS[number];

const TIMEZONE_REGIONS: Record<string, PreparedCatalogRegion> = {
  "Australia/Adelaide": "Adelaide",
  "Australia/Brisbane": "Brisbane",
  "Australia/Broken_Hill": "Adelaide",
  "Australia/Canberra": "Canberra",
  "Australia/Darwin": "Darwin",
  "Australia/Hobart": "Hobart",
  "Australia/Lindeman": "Brisbane",
  "Australia/Lord_Howe": "Sydney",
  "Australia/Melbourne": "Melbourne",
  "Australia/Perth": "Perth",
  "Australia/Sydney": "Sydney",
};

export function preparedCatalogRegion(timeZone: string): PreparedCatalogRegion {
  return TIMEZONE_REGIONS[timeZone] || "Sydney";
}

export function preparedCatalogTimezones(region: PreparedCatalogRegion): string[] {
  return Object.entries(TIMEZONE_REGIONS)
    .filter(([, mapped]) => mapped === region)
    .map(([timeZone]) => timeZone);
}

export function preparedCatalogUrl(region: PreparedCatalogRegion): string {
  return `/catalog/${region}.json.gz`;
}

export type PreparedCatalogSnapshot = {
  version: typeof PREPARED_CATALOG_VERSION;
  region: PreparedCatalogRegion;
  catalog: WebCatalog;
};

const OPTION_ARRAYS = [
  "categories", "countries", "languages", "regions", "subdivisions", "cities",
  "timezones", "owners", "networks", "feeds", "providers",
] as const;

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function readPreparedCatalogSnapshot(
  value: unknown,
  region: PreparedCatalogRegion,
): PreparedCatalogSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.version !== PREPARED_CATALOG_VERSION || snapshot.region !== region) return null;
  const catalog = snapshot.catalog as WebCatalog | undefined;
  if (!catalog || !Array.isArray(catalog.channels) || !catalog.channels.length) return null;
  if (catalog.channels.length > 100_000 || OPTION_ARRAYS.some((key) => !Array.isArray(catalog[key]))) return null;
  if (typeof catalog.source !== "string" || typeof catalog.updatedAt !== "string" || !Number.isFinite(Date.parse(catalog.updatedAt))) return null;
  for (const key of OPTION_ARRAYS) {
    for (const option of catalog[key]) {
      if (!option || typeof option !== "object" || typeof option.name !== "string" || !Number.isFinite(option.count) || option.count < 0) return null;
      if (key === "countries") {
        if (!("code" in option) || typeof option.code !== "string" || !("languages" in option) || !stringArray(option.languages)) return null;
      } else if (key === "regions") {
        if (!("code" in option) || typeof option.code !== "string" || !("countries" in option) || !stringArray(option.countries)) return null;
      } else if (!("id" in option) || typeof option.id !== "string") return null;
    }
  }
  const keys = new Set<string>();
  for (const channel of catalog.channels) {
    if (
      !channel || typeof channel !== "object"
      || typeof channel.key !== "string" || !channel.key || keys.has(channel.key)
      || typeof channel.id !== "string" || typeof channel.name !== "string"
      || !stringArray(channel.categories) || !stringArray(channel.languages)
      || !stringArray(channel.broadcastArea) || !Array.isArray(channel.sources)
      || !channel.sources.length
      || channel.sources.some((source) => !source || typeof source.url !== "string" || !source.url
        || (source.referrer != null && typeof source.referrer !== "string")
        || (source.userAgent != null && typeof source.userAgent !== "string"))
    ) return null;
    keys.add(channel.key);
  }
  return snapshot as PreparedCatalogSnapshot;
}

export async function decodePreparedCatalogResponse(
  response: Response,
  region: PreparedCatalogRegion,
): Promise<PreparedCatalogSnapshot> {
  if (!response.ok) throw new Error(`Prepared catalogue returned HTTP ${response.status}`);
  const compressed = await readBoundedResponse(
    response, MAX_PREPARED_CATALOG_GZIP_BYTES, "The prepared catalogue",
  );
  // Browsers decode an HTTP Content-Encoding automatically. Static .gz files
  // are usually served as binary bytes, so detect their magic before decoding.
  const gzipped = new Uint8Array(compressed);
  const bytes = gzipped[0] === 0x1f && gzipped[1] === 0x8b
    ? await readBoundedResponse(
      new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"))),
      MAX_PREPARED_CATALOG_BYTES,
      "The expanded prepared catalogue",
    )
    : compressed;
  if (bytes.byteLength > MAX_PREPARED_CATALOG_BYTES) throw new Error("The prepared catalogue is too large");
  const result = readPreparedCatalogSnapshot(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    region,
  );
  if (!result) throw new Error("The prepared catalogue is invalid");
  return result;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type CachedPreparedCatalog = { cachedAt: number; snapshot: PreparedCatalogSnapshot };
type CatalogCache = {
  read(region: PreparedCatalogRegion): Promise<CachedPreparedCatalog | null>;
  write(region: PreparedCatalogRegion, entry: CachedPreparedCatalog): Promise<void>;
};

const browserCache: CatalogCache = {
  async read(region) {
    try {
      if (typeof caches === "undefined") return null;
      const cache = await caches.open(PREPARED_CATALOG_CACHE_NAME);
      const response = await cache.match(preparedCatalogUrl(region));
      if (response) {
        const value = await response.json() as CachedPreparedCatalog;
        const snapshot = readPreparedCatalogSnapshot(value.snapshot, region);
        if (snapshot && Number.isFinite(value.cachedAt)) return { cachedAt: value.cachedAt, snapshot };
      }
      // Existing visitors retain their complete previous catalogue if their
      // first request after this migration happens while the network is down.
      const legacy = await caches.open("crowflix-catalog-v8");
      const previous = await legacy.match("https://crowflix.cache/web-catalog-v8");
      if (!previous) return null;
      const value = await previous.json() as { catalog?: unknown };
      const snapshot = readPreparedCatalogSnapshot({ version: 1, region, catalog: value.catalog }, region);
      return snapshot ? { cachedAt: 0, snapshot } : null;
    } catch { return null; }
  },
  async write(region, entry) {
    try {
      if (typeof caches === "undefined") return;
      const cache = await caches.open(PREPARED_CATALOG_CACHE_NAME);
      await cache.put(preparedCatalogUrl(region), new Response(JSON.stringify(entry)));
    } catch { /* Storage is optional; the static asset remains available. */ }
  },
};

export function createPreparedCatalogLoader(
  fetchImpl: FetchLike = fetch,
  cache: CatalogCache = browserCache,
  now: () => number = Date.now,
): (force?: boolean, timeZone?: string) => Promise<WebCatalog> {
  const active = new Map<PreparedCatalogRegion, Promise<WebCatalog>>();
  return (force = false, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) => {
    const region = preparedCatalogRegion(timeZone);
    const pending = active.get(region);
    if (pending) return pending;
    const request = (async () => {
      const cached = await cache.read(region);
      if (!force && cached && now() - cached.cachedAt < PREPARED_CATALOG_TTL_MS) {
        return { ...cached.snapshot.catalog, source: `${cached.snapshot.catalog.source} · browser cache` };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      try {
        const response = await fetchImpl(preparedCatalogUrl(region), {
          cache: force ? "reload" : "default",
          signal: controller.signal,
        });
        const snapshot = await decodePreparedCatalogResponse(response, region);
        await cache.write(region, { cachedAt: now(), snapshot });
        return snapshot.catalog;
      } catch (error) {
        if (cached) return { ...cached.snapshot.catalog, source: `${cached.snapshot.catalog.source} · offline cache` };
        throw error;
      } finally { clearTimeout(timer); }
    })();
    active.set(region, request);
    void request.finally(() => active.delete(region)).catch(() => undefined);
    return request;
  };
}

export const loadPreparedCatalog = createPreparedCatalogLoader();
