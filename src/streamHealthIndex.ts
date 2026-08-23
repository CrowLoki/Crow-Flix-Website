import { readBoundedResponse } from "./playback/boundedResponse";
import type {
  CatalogSourceHealth,
  CatalogSourceHealthStatus,
  StreamSource,
} from "./playback/types";

export const STREAM_HEALTH_MANIFEST_URL =
  "https://dearbulut.github.io/iptv/api/v1/index.json";
export const STREAM_HEALTH_GZIP_URL =
  "https://dearbulut.github.io/iptv/api/v1/streams.json.gz";
export const STREAM_HEALTH_TTL_MS = 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 12_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 50_000;
const MIN_PRODUCTION_RECORDS = 1_000;
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type HealthManifest = {
  name?: unknown;
  version?: unknown;
  generated_at?: unknown;
};

type HealthRecord = {
  url?: unknown;
  referrer?: unknown;
  user_agent?: unknown;
  health?: unknown;
};

export type LoadedStreamHealthIndex = {
  generatedAt: number;
  hints: Map<string, CatalogSourceHealth>;
};

export function streamHealthIdentity(
  url: string,
  referrer?: string | null,
  userAgent?: string | null,
): string {
  return `${url}\u0000${referrer || ""}\u0000${userAgent || ""}`;
}

export function streamSourceHealthIdentity(source: StreamSource): string {
  return streamHealthIdentity(source.url, source.referrer, source.userAgent);
}

export function isFreshCatalogHealth(
  health: CatalogSourceHealth | undefined,
  now = Date.now(),
): health is CatalogSourceHealth {
  return Boolean(
    health
    && health.checkedAt > 0
    && now - health.checkedAt <= STREAM_HEALTH_TTL_MS
    && health.checkedAt <= now + MAX_FUTURE_SKEW_MS,
  );
}

export function sourceUsesLiteralIp(source: Pick<StreamSource, "url">): boolean {
  try {
    const hostname = new URL(source.url).hostname;
    return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(":");
  } catch {
    return false;
  }
}

export function catalogHealthSupportsBrowserRanking(
  source: StreamSource,
  now = Date.now(),
): boolean {
  return isFreshCatalogHealth(source.catalogHealth, now)
    && source.catalogHealth.status === "online"
    && !sourceUsesLiteralIp(source);
}

export function parseStreamHealthEntries(
  candidate: unknown,
  now = Date.now(),
): Map<string, CatalogSourceHealth> {
  const hints = new Map<string, CatalogSourceHealth>();
  if (!Array.isArray(candidate) || candidate.length > MAX_RECORDS) return hints;

  for (const item of candidate as HealthRecord[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const url = validExternalUrl(item.url);
    const referrer = optionalText(item.referrer, 2_048);
    const userAgent = optionalText(item.user_agent, 512);
    if (!url || referrer === undefined || userAgent === undefined) continue;
    if (!item.health || typeof item.health !== "object" || Array.isArray(item.health)) continue;
    const health = item.health as Record<string, unknown>;
    const status = health.status;
    if (!isHealthStatus(status)) continue;
    if (typeof health.score !== "number" || typeof health.checked_at !== "string") continue;
    const score = health.score;
    const checkedAt = Date.parse(health.checked_at);
    if (!Number.isFinite(score) || score < 0 || score > 100) continue;
    const parsed: CatalogSourceHealth = { status, score, checkedAt };
    if (!isFreshCatalogHealth(parsed, now)) continue;

    const identity = streamHealthIdentity(url, referrer, userAgent);
    const existing = hints.get(identity);
    if (!existing || existing.checkedAt < parsed.checkedAt) hints.set(identity, parsed);
  }
  return hints;
}

export async function loadStreamHealthIndex(
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
  decompress: (input: ArrayBuffer) => Promise<ArrayBuffer> = decompressGzip,
  minimumRecords = MIN_PRODUCTION_RECORDS,
): Promise<LoadedStreamHealthIndex> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const manifestResponse = await fetchImpl(STREAM_HEALTH_MANIFEST_URL, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!manifestResponse.ok) {
      throw new Error(`Stream health manifest returned HTTP ${manifestResponse.status}`);
    }
    const manifest = await readJson<HealthManifest>(
      manifestResponse,
      MAX_MANIFEST_BYTES,
      "The stream health manifest",
    );
    const generatedAt = validManifestTimestamp(manifest, now());

    const gzipResponse = await fetchImpl(STREAM_HEALTH_GZIP_URL, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!gzipResponse.ok) {
      throw new Error(`Stream health index returned HTTP ${gzipResponse.status}`);
    }
    const compressed = await readBoundedResponse(
      gzipResponse,
      MAX_COMPRESSED_BYTES,
      "The compressed stream health index",
    );
    const decompressed = await decompress(compressed);
    if (decompressed.byteLength > MAX_DECOMPRESSED_BYTES) {
      throw new Error("The stream health index exceeded its decompressed safety limit");
    }
    const records = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(decompressed),
    ) as unknown;
    const hints = parseStreamHealthEntries(records, now());
    if (hints.size < minimumRecords) {
      throw new Error("The stream health index did not contain enough valid records");
    }
    return { generatedAt, hints };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readJson<T>(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<T> {
  const bytes = await readBoundedResponse(response, maximumBytes, label);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
}

async function decompressGzip(input: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot read the compressed stream health index");
  }
  const decompressed = new Blob([input]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return readBoundedResponse(
    new Response(decompressed),
    MAX_DECOMPRESSED_BYTES,
    "The decompressed stream health index",
  );
}

function validManifestTimestamp(manifest: HealthManifest, now: number): number {
  if (manifest.name !== "IPTV Nexus" || manifest.version !== "1.0.0") {
    throw new Error("The stream health manifest identity was invalid");
  }
  const generatedAt = Date.parse(String(manifest.generated_at || ""));
  if (
    !Number.isFinite(generatedAt)
    || now - generatedAt > STREAM_HEALTH_TTL_MS
    || generatedAt > now + MAX_FUTURE_SKEW_MS
  ) {
    throw new Error("The stream health manifest was stale or invalid");
  }
  return generatedAt;
}

function validExternalUrl(candidate: unknown): string | null {
  if (typeof candidate !== "string" || !candidate || candidate.length > 8_192) return null;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
    ) return null;
    return candidate;
  } catch {
    return null;
  }
}

function optionalText(candidate: unknown, maximumLength: number): string | null | undefined {
  if (candidate === null || candidate === undefined || candidate === "") return null;
  return typeof candidate === "string" && candidate.length <= maximumLength
    && !/[\p{Cc}]/u.test(candidate)
    ? candidate
    : undefined;
}

function isHealthStatus(candidate: unknown): candidate is CatalogSourceHealthStatus {
  return candidate === "online"
    || candidate === "offline"
    || candidate === "blocked"
    || candidate === "timeout"
    || candidate === "error";
}
