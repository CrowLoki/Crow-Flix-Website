import type { RelayGuideChannel, RelayGuideResult } from "./relayClient";

export const GUIDE_REUSE_MS = 60 * 60 * 1000;
export const GUIDE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const CACHE_NAME = "crowflix-guide-v1";
const MAX_CACHED_GUIDES = 4;
const MAX_CACHED_BYTES = 8 * 1024 * 1024;

export function guideIsFresh(
  result: RelayGuideResult,
  maximumAge = GUIDE_REUSE_MS,
  now = Date.now(),
): boolean {
  const updated = Date.parse(result.updatedAt);
  return Number.isFinite(updated) && updated <= now + 60_000 && now - updated < maximumAge;
}

async function guideKey(
  country: string,
  channels: RelayGuideChannel[],
  timeZone: string,
): Promise<string> {
  const input = JSON.stringify({ country, timeZone, channels });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const id = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `https://crowflix.cache/guide/${id}`;
}

function validGuide(value: unknown): value is RelayGuideResult {
  if (!value || typeof value !== "object") return false;
  const guide = value as Partial<RelayGuideResult>;
  return typeof guide.source === "string"
    && typeof guide.updatedAt === "string"
    && typeof guide.matchedChannels === "number"
    && Array.isArray(guide.programmes)
    && guide.programmes.length > 0
    && guide.programmes.every((programme) => programme
      && typeof programme.channelId === "string"
      && typeof programme.title === "string"
      && Number.isFinite(Date.parse(programme.start))
      && Number.isFinite(Date.parse(programme.stop)));
}

/** Reuse a guide already retrieved through verification; no token is stored. */
export async function readSavedGuide(
  country: string,
  channels: RelayGuideChannel[],
  timeZone: string,
): Promise<RelayGuideResult | null> {
  try {
    if (typeof caches === "undefined") return null;
    const cache = await caches.open(CACHE_NAME);
    const key = await guideKey(country, channels, timeZone);
    const response = await cache.match(key);
    if (!response) return null;
    const guide: unknown = await response.json();
    if (validGuide(guide) && guideIsFresh(guide)) return guide;
    await cache.delete(key);
  } catch { /* Storage is optional; a fresh request can still be verified. */ }
  return null;
}

export async function saveGuide(
  country: string,
  channels: RelayGuideChannel[],
  timeZone: string,
  guide: RelayGuideResult,
): Promise<void> {
  try {
    if (typeof caches === "undefined" || !validGuide(guide) || !guideIsFresh(guide)) return;
    const body = JSON.stringify(guide);
    if (new TextEncoder().encode(body).byteLength > MAX_CACHED_BYTES) return;
    const cache = await caches.open(CACHE_NAME);
    const key = await guideKey(country, channels, timeZone);
    await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json" } }));
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_GUIDES))) {
      await cache.delete(old);
    }
  } catch { /* Guide display must not depend on storage availability. */ }
}
