import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const CATALOGUE_REGIONS = Object.freeze([
  "Adelaide", "Brisbane", "Canberra", "Darwin", "Hobart", "Melbourne", "Perth", "Sydney",
]);
export const MAX_COMPRESSED_BYTES = 25 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const OPTION_ARRAYS = [
  "categories", "countries", "languages", "regions", "subdivisions", "cities",
  "timezones", "owners", "networks", "feeds", "providers",
];
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

export function catalogueOrigin(value = "https://crowflix.tv/") {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The catalogue origin must be an HTTPS origin without credentials, path, query or fragment (loopback HTTP is allowed for tests).");
  }
  return url.origin;
}

/** Independent publication contract; no build dependencies or provider requests. */
export function validatePublishedSnapshot(value, { region, after, now = Date.now() }) {
  const invalid = () => { throw new Error(`${region}: invalid published catalogue`); };
  if (!CATALOGUE_REGIONS.includes(region) || !value || value.version !== 1 || value.region !== region) invalid();
  const catalog = value.catalog;
  if (!catalog || !Array.isArray(catalog.channels) || catalog.channels.length < 1_000
    || catalog.channels.length > 100_000 || typeof catalog.source !== "string"
    || !catalog.source.includes("prepared daily") || typeof catalog.updatedAt !== "string") invalid();
  const preparedAt = Date.parse(catalog.updatedAt);
  if (!Number.isFinite(preparedAt) || preparedAt > now + 60_000) invalid();
  if (preparedAt < after) throw new Error(`${region}: published snapshot still predates the rebuild request`);
  for (const key of OPTION_ARRAYS) {
    if (!Array.isArray(catalog[key])) invalid();
    for (const option of catalog[key]) {
      if (!option || typeof option.name !== "string" || !Number.isFinite(option.count) || option.count < 0) invalid();
      if (key === "countries") {
        if (typeof option.code !== "string" || !strings(option.languages)) invalid();
      } else if (key === "regions") {
        if (typeof option.code !== "string" || !strings(option.countries)) invalid();
      } else if (typeof option.id !== "string") invalid();
    }
  }
  const keys = new Set();
  let sources = 0;
  for (const channel of catalog.channels) {
    if (!channel || typeof channel.key !== "string" || !channel.key || keys.has(channel.key)
      || typeof channel.id !== "string" || typeof channel.name !== "string" || !channel.name
      || !strings(channel.categories) || !strings(channel.languages) || !strings(channel.broadcastArea)
      || !Array.isArray(channel.sources) || !channel.sources.length) invalid();
    keys.add(channel.key);
    for (const source of channel.sources) {
      if (!source || typeof source.url !== "string" || !source.url
        || (source.referrer != null && typeof source.referrer !== "string")
        || (source.userAgent != null && typeof source.userAgent !== "string")) invalid();
    }
    sources += channel.sources.length;
  }
  return { region, updatedAt: new Date(preparedAt).toISOString(), channels: keys.size, sources };
}

export async function decodePublishedResponse(response, { onBytes = () => {} } = {}) {
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`catalogue asset returned HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("catalogue asset has no readable body");
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_COMPRESSED_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("catalogue asset exceeds its transfer limit");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { completed = true; break; }
      received += value.byteLength;
      onBytes(value.byteLength);
      if (received > MAX_COMPRESSED_BYTES) throw new Error("catalogue asset exceeds its transfer limit");
      chunks.push(value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    const bytes = Buffer.concat(chunks, received);
    // Native fetch already decodes Content-Encoding; static .gz files may not.
    const expanded = bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES }) : bytes;
    if (expanded.byteLength > MAX_EXPANDED_BYTES) throw new Error("oversized");
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(expanded)),
      receivedBytes: received,
      expandedBytes: expanded.byteLength,
    };
  } catch {
    throw new Error("catalogue asset is corrupt, invalid JSON, or exceeds its expanded limit");
  }
}

/** Poll one canary, then check all eight snapshots belong to one fresh build. */
export async function verifyPublishedCatalogue({
  after,
  origin = "https://crowflix.tv/",
  timeoutMs = 12 * 60_000,
  pollIntervalMs = 60_000,
  requestTimeoutMs = 20_000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  wait = (ms, signal) => delay(ms, undefined, { signal }),
  signal,
  log = console.log,
} = {}) {
  const afterTime = typeof after === "number" ? after : Date.parse(after);
  if (!Number.isFinite(afterTime) || afterTime <= 0 || afterTime > now() + 60_000) {
    throw new Error("Supply --after with the rebuild-request UTC timestamp, not a future timestamp.");
  }
  if (![timeoutMs, pollIntervalMs, requestTimeoutMs].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Verification time limits must be positive finite numbers.");
  }
  const base = catalogueOrigin(origin);
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let receivedBytes = 0;
  let requests = 0;
  let lastFailure = "no fresh publication observed";
  const fetchRegion = async (region) => {
    signal?.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("publication deadline exceeded");
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(Math.max(1, Math.floor(Math.min(requestTimeoutMs, remaining)))),
      ...(signal ? [signal] : []),
    ]);
    const url = new URL(`/catalog/${region}.json.gz`, base);
    // The normal asset has max-age=3600 plus stale-while-revalidate. A unique
    // query and no-cache request must not accept that ordinary cached copy.
    url.searchParams.set("crowflix_verify", `${afterTime}-${attempts}-${region}`);
    requests += 1;
    const response = await fetchImpl(url.href, {
      cache: "no-store", redirect: "error", signal: requestSignal,
      headers: { "Cache-Control": "no-cache, no-store", Pragma: "no-cache" },
    });
    const decoded = await decodePublishedResponse(response, { onBytes(bytes) {
      receivedBytes += bytes;
      if (receivedBytes > MAX_TOTAL_BYTES) throw new Error("publication verification exceeded its total transfer budget");
    } });
    return {
      ...validatePublishedSnapshot(decoded.value, { region, after: afterTime, now: now() }),
      receivedBytes: decoded.receivedBytes,
      expandedBytes: decoded.expandedBytes,
      httpStatus: response.status,
    };
  };
  // Both wall-clock and attempt limits apply, including under unusual clocks.
  const maximumAttempts = Math.ceil(timeoutMs / pollIntervalMs);
  while (now() < deadline && attempts < maximumAttempts) {
    attempts += 1;
    signal?.throwIfAborted();
    try {
      const canary = await fetchRegion("Sydney");
      const snapshots = [canary];
      for (const region of CATALOGUE_REGIONS.filter((name) => name !== "Sydney")) {
        const snapshot = await fetchRegion(region);
        if (snapshot.updatedAt !== canary.updatedAt) throw new Error(`${region}: regional snapshots are from different builds`);
        snapshots.push(snapshot);
      }
      if (now() > deadline) throw new Error("publication deadline exceeded");
      const result = {
        status: "publication-verified", origin: base,
        requestedAfter: new Date(afterTime).toISOString(), updatedAt: canary.updatedAt,
        attempts, requests, receivedBytes,
        snapshots: snapshots.sort((left, right) => left.region.localeCompare(right.region)),
      };
      log(JSON.stringify(result));
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (receivedBytes > MAX_TOTAL_BYTES) throw new Error("Publication verification exceeded its bounded transfer budget.");
      lastFailure = error instanceof Error ? error.message : "catalogue verification failed";
      // Never print response bodies, source URLs, hook URLs or environment data.
      log(`Publication not verified (attempt ${attempts}): ${lastFailure}`);
    }
    const remaining = deadline - now();
    if (remaining > 0 && attempts < maximumAttempts) await wait(Math.min(pollIntervalMs, remaining), signal);
  }
  throw new Error(`Publication was not verified within the bounded wait after the supplied rebuild-request timestamp: ${lastFailure}`);
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--after", "--origin"].includes(args[index]) || !args[index + 1]) {
      throw new Error("Usage: node scripts/verify-published-catalogue.mjs --after <UTC timestamp> [--origin <origin>]");
    }
    options[args[index].slice(2)] = args[index + 1];
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Publication verification interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await verifyPublishedCatalogue({ ...options, signal: controller.signal }); }
  finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
