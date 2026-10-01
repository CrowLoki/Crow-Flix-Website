import {
  normalizeChannelIds,
  normalizeCountryCode,
  type GuideResult,
} from "./epg";
import { readBounded } from "./streams";

export const GUIDE_CACHE_TTL_SECONDS = 10 * 60;
export const MAX_CACHED_GUIDE_BYTES = 8 * 1024 * 1024;
const EXPIRES_HEADER = "X-CrowFlix-Guide-Expires";
const CACHE_VERSION = "v1";

export interface GuideCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface GuideCacheRequest {
  country: string;
  timeZone: string;
  channelIds: string[];
  namesByChannel: ReadonlyMap<string, readonly string[]>;
  aliasesByProviderId: ReadonlyMap<string, string>;
}

function defaultGuideCache(): GuideCache | undefined {
  try {
    // Cloudflare adds caches.default to the standard CacheStorage interface.
    // Browsers and local test runtimes need no equivalent cache service.
    if (typeof caches === "undefined") return undefined;
    const storage: CacheStorage & { default?: GuideCache } = caches;
    return storage.default;
  } catch {
    return undefined;
  }
}

export async function createGuideCacheKey(
  input: GuideCacheRequest,
  origin: string,
): Promise<Request> {
  const material = JSON.stringify({
    country: normalizeCountryCode(input.country),
    timeZone: input.timeZone,
    channelIds: normalizeChannelIds(input.channelIds),
    // Preserve effective inputs and their order: channel/alias collisions
    // can depend on insertion order in the existing parser/request handler.
    namesByChannel: [...input.namesByChannel],
    aliasesByProviderId: [...input.aliasesByProviderId],
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  // Use an internal GET key, never the protected POST, token, or headers.
  return new Request(new URL(`/_internal/guide-cache/${CACHE_VERSION}/${hash}`, origin));
}

function isSuccessfulGuide(value: unknown): value is GuideResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<GuideResult>;
  return Array.isArray(result.programmes)
    && result.programmes.length > 0
    && typeof result.source === "string"
    && typeof result.updatedAt === "string"
    && Number.isFinite(Date.parse(result.updatedAt))
    && Number.isInteger(result.matchedChannels)
    && result.matchedChannels! > 0
    && result.programmes.every((programme) => programme
      && typeof programme === "object"
      && typeof programme.channelId === "string"
      && typeof programme.title === "string"
      && typeof programme.start === "string"
      && typeof programme.stop === "string");
}

/** Call only after the current request has passed mandatory Siteverify. */
export async function loadCachedGuide(
  input: GuideCacheRequest,
  origin: string,
  load: () => Promise<GuideResult>,
  cache: GuideCache | undefined = defaultGuideCache(),
  onCacheHit?: () => void,
): Promise<GuideResult> {
  if (!cache) return load();
  let key: Request;
  try {
    key = await createGuideCacheKey(input, origin);
    const cached = await cache.match(key);
    const expires = Number(cached?.headers.get(EXPIRES_HEADER));
    if (cached?.ok && cached.body && expires > Date.now()) {
      const { data, truncated } = await readBounded(cached.body, MAX_CACHED_GUIDE_BYTES);
      if (!truncated) {
        const result: unknown = JSON.parse(new TextDecoder().decode(data));
        if (isSuccessfulGuide(result)) {
          onCacheHit?.();
          return result;
        }
      }
    } else {
      void cached?.body?.cancel().catch(() => undefined);
    }
  } catch {
    // Cache/crypto/body failures never prevent loading a real guide.
    return load();
  }

  const result = await load();
  if (isSuccessfulGuide(result)) {
    try {
      const serialized = JSON.stringify(result);
      // Bound cache work without rejecting a valid larger guide response.
      if (serialized.length <= MAX_CACHED_GUIDE_BYTES) {
        const bytes = new TextEncoder().encode(serialized);
        if (bytes.byteLength <= MAX_CACHED_GUIDE_BYTES) {
          await cache.put(key, new Response(bytes, {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": `public, max-age=${GUIDE_CACHE_TTL_SECONDS}`,
              [EXPIRES_HEADER]: String(Date.now() + GUIDE_CACHE_TTL_SECONDS * 1_000),
            },
          }));
        }
      }
    } catch {
      // This request still succeeds when the cache cannot store its result.
    }
  }
  return result;
}
