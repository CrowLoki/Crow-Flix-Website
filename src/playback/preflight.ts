import { routeDashRequestUrl, toWebPlayableSources } from "../relayClient";
import { isFreshCatalogHealth } from "../streamHealthIndex";
import { classifySource } from "./logic";
import {
  MediaRequestError,
  mediaFetch,
  type MediaFetcher,
} from "./nativeFetch";
import {
  sourceIdentifier,
  type PlaybackKind,
  type StreamSource,
} from "./types";

export const SOURCE_PREFLIGHT_STORAGE_KEY = "crowflix:source-preflight:v1";
export const SOURCE_PREFLIGHT_CHANGED_EVENT = "crowflix:source-preflight-changed";
export const SOURCE_PREFLIGHT_TTL_MS = 15 * 60 * 1000;

const PREFLIGHT_TIMEOUT_MS = 8_000;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_MEDIA_SAMPLE_BYTES = 1_024;
const MAX_KEY_BYTES = 64;
const MAX_CACHE_ENTRIES = 5_000;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HLS_PLAYLIST_DEPTH = 3;

export type SourcePreflightStatus = "ready" | "offline";

export type SourcePreflight = {
  status: SourcePreflightStatus;
  checkedAt: number;
  transport: PlaybackKind;
  httpStatus?: number;
  reason?: string;
};

type PrefixResponse = {
  bytes: Uint8Array;
  mimeType: string;
  url: string;
};

type HlsManifestReferences = {
  isMaster: boolean;
  firstUri: string | null;
  keyUri: string | null;
  mapUri: string | null;
};

export async function preflightSource(
  source: StreamSource,
  fetcher: MediaFetcher = mediaFetch,
  parentSignal?: AbortSignal,
  now: () => number = Date.now,
): Promise<SourcePreflight> {
  const checkedAt = now();
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("Readiness check timed out", "TimeoutError")),
    PREFLIGHT_TIMEOUT_MS,
  );
  let transport = classifySource(source);

  try {
    if (transport === "unsupported") {
      return offline(checkedAt, transport, "unsupported-source");
    }

    const root = await fetchPrefix(
      source.url,
      source,
      MAX_MANIFEST_BYTES,
      fetcher,
      controller.signal,
    );
    const text = new TextDecoder().decode(root.bytes);
    const classifiedSource = {
      ...source,
      url: source.delivery === "relay" ? source.logicalUrl || source.url : root.url,
    };
    transport = classifySource(classifiedSource, root.mimeType, text);

    if (transport === "hls") {
      await verifyHlsMedia(root, source, fetcher, controller.signal);
    } else if (transport === "dash") {
      await verifyDashMedia(root, source, fetcher, controller.signal);
    } else if (!root.bytes.byteLength) {
      return offline(checkedAt, transport, "empty-response");
    }

    return { status: "ready", checkedAt, transport };
  } catch (error) {
    if (parentSignal?.aborted) throw parentSignal.reason ?? error;
    const httpStatus = error instanceof MediaRequestError ? error.status : undefined;
    return offline(
      checkedAt,
      transport,
      errorName(error),
      httpStatus,
    );
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
    controller.abort();
  }
}

async function verifyHlsMedia(
  root: PrefixResponse,
  source: StreamSource,
  fetcher: MediaFetcher,
  signal: AbortSignal,
): Promise<void> {
  let response = root;
  for (let depth = 0; depth < MAX_HLS_PLAYLIST_DEPTH; depth += 1) {
    const manifest = new TextDecoder().decode(response.bytes);
    if (!/^\s*#EXTM3U\b/i.test(manifest.replace(/^\uFEFF/, ""))) {
      throw new Error("invalid-hls-manifest");
    }
    const references = hlsManifestReferences(manifest);
    if (!references.firstUri) throw new Error("hls-media-unavailable");

    const keyUrl = resolveHttpUrl(references.keyUri, response.url);
    if (keyUrl) {
      const key = await fetchPrefix(
        keyUrl,
        source,
        MAX_KEY_BYTES,
        fetcher,
        signal,
        false,
      );
      if (!key.bytes.byteLength) throw new Error("empty-hls-key");
    }
    const mapUrl = resolveHttpUrl(references.mapUri, response.url);
    if (mapUrl) {
      const map = await fetchPrefix(
        mapUrl,
        source,
        MAX_MEDIA_SAMPLE_BYTES,
        fetcher,
        signal,
      );
      if (!map.bytes.byteLength || looksLikeHtml(map)) throw new Error("invalid-hls-init");
    }

    const nextUrl = resolveHttpUrl(references.firstUri, response.url);
    if (!nextUrl) throw new Error("invalid-hls-media-url");
    if (references.isMaster || looksLikePlaylistUrl(nextUrl)) {
      response = await fetchPrefix(
        nextUrl,
        source,
        MAX_MANIFEST_BYTES,
        fetcher,
        signal,
      );
      continue;
    }

    const media = await fetchPrefix(
      nextUrl,
      source,
      MAX_MEDIA_SAMPLE_BYTES,
      fetcher,
      signal,
    );
    if (!media.bytes.byteLength || looksLikeHtml(media)) throw new Error("invalid-hls-media");
    return;
  }
  throw new Error("hls-playlist-depth-exceeded");
}

async function verifyDashMedia(
  root: PrefixResponse,
  source: StreamSource,
  fetcher: MediaFetcher,
  signal: AbortSignal,
): Promise<void> {
  const manifest = new TextDecoder().decode(root.bytes);
  if (!/<MPD(?:\s|>)/i.test(manifest)) throw new Error("invalid-dash-manifest");
  const logicalManifestUrl = source.delivery === "relay"
    ? source.logicalUrl || source.url
    : root.url;
  const mediaUrl = firstDashResourceUrl(manifest, logicalManifestUrl);
  if (!mediaUrl) throw new Error("dash-media-unavailable");
  const requestUrl = routeDashRequestUrl(mediaUrl, source);
  const media = await fetchPrefix(
    requestUrl,
    source,
    MAX_MEDIA_SAMPLE_BYTES,
    fetcher,
    signal,
  );
  if (!media.bytes.byteLength || looksLikeHtml(media)) throw new Error("invalid-dash-media");
}

async function fetchPrefix(
  url: string,
  source: StreamSource,
  limit: number,
  fetcher: MediaFetcher,
  signal: AbortSignal,
  useRange = true,
): Promise<PrefixResponse> {
  const headers = new Headers({ Accept: "*/*" });
  if (useRange) headers.set("Range", `bytes=0-${limit - 1}`);
  const response = await fetcher(url, source, {
    method: "GET",
    headers,
    signal,
    cache: "no-store",
  });
  if (!response.ok && response.status !== 206) {
    await response.body?.cancel().catch(() => undefined);
    throw new MediaRequestError(response.status);
  }
  const bytes = await readPrefix(response, limit, signal);
  return {
    bytes,
    mimeType: response.headers.get("content-type") || "",
    url: response.url || url,
  };
}

async function readPrefix(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const slice = value.subarray(0, Math.min(value.byteLength, limit - length));
      chunks.push(slice);
      length += slice.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function hlsManifestReferences(manifest: string): HlsManifestReferences {
  const lines = manifest.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim());
  const streamIndex = lines.findIndex((line) => /^#EXT-X-STREAM-INF:/i.test(line));
  const firstUriAfter = (index: number) => lines.slice(index + 1)
    .find((line) => line && !line.startsWith("#")) || null;
  const firstUri = streamIndex >= 0
    ? firstUriAfter(streamIndex)
    : lines.find((line) => line && !line.startsWith("#")) || null;
  const keyLine = lines.find((line) => /^#EXT-X-KEY:/i.test(line) && !/METHOD=NONE\b/i.test(line));
  const mapLine = lines.find((line) => /^#EXT-X-MAP:/i.test(line));
  return {
    isMaster: streamIndex >= 0,
    firstUri,
    keyUri: attributeValue(keyLine, "URI"),
    mapUri: attributeValue(mapLine, "URI"),
  };
}

function attributeValue(line: string | undefined, name: string): string | null {
  if (!line) return null;
  const quoted = line.match(new RegExp(`(?:^|[:,\\s])${name}="([^"]+)"`, "i"));
  if (quoted?.[1]) return quoted[1];
  const bare = line.match(new RegExp(`(?:^|[:,\\s])${name}=([^,\\s]+)`, "i"));
  return bare?.[1] || null;
}

function looksLikePlaylistUrl(value: string): boolean {
  try {
    return /\.m3u8?$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function resolveHttpUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    const resolved = new URL(value, base);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.href
      : null;
  } catch {
    return null;
  }
}

function looksLikeHtml(response: PrefixResponse): boolean {
  const mime = response.mimeType.split(";", 1)[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return true;
  const sample = new TextDecoder().decode(response.bytes.subarray(0, 256)).trimStart();
  return /^(?:<!doctype\s+html\b|<html\b)/i.test(sample);
}

export function firstDashResourceUrl(manifest: string, manifestUrl: string): string | null {
  if (typeof DOMParser !== "undefined") {
    const parsed = dashResourceFromDom(manifest, manifestUrl);
    if (parsed) return parsed;
  }
  return dashResourceFromText(manifest, manifestUrl);
}

function dashResourceFromDom(manifest: string, manifestUrl: string): string | null {
  const document = new DOMParser().parseFromString(manifest, "application/xml");
  if (document.querySelector("parsererror")) return null;
  const representation = document.querySelector("Representation");
  const adaptation = representation?.parentElement?.closest("AdaptationSet")
    || document.querySelector("AdaptationSet");
  const period = adaptation?.parentElement?.closest("Period")
    || document.querySelector("Period");
  const mpd = document.documentElement;
  const chain = [mpd, period, adaptation, representation].filter(
    (element): element is Element => Boolean(element),
  );
  let base = manifestUrl;
  for (const element of chain) {
    const baseElement = directChild(element, "BaseURL");
    const next = resolveHttpUrl(baseElement?.textContent?.trim() || null, base);
    if (next) base = next;
  }

  const template = [...chain].reverse()
    .map((element) => directChild(element, "SegmentTemplate"))
    .find((element): element is Element => Boolean(element));
  const representationId = representation?.getAttribute("id") || "1";
  const bandwidth = representation?.getAttribute("bandwidth") || "1";
  if (template) {
    const pattern = template.getAttribute("initialization") || template.getAttribute("media");
    const resource = substituteDashTemplate(
      pattern,
      representationId,
      bandwidth,
      template.getAttribute("startNumber") || "1",
      document.querySelector("SegmentTimeline S")?.getAttribute("t") || "0",
    );
    const resolved = resolveHttpUrl(resource, base);
    if (resolved) return resolved;
  }

  const segmentList = [...chain].reverse()
    .map((element) => directChild(element, "SegmentList"))
    .find((element): element is Element => Boolean(element));
  const listed = segmentList
    ? directChild(segmentList, "Initialization")?.getAttribute("sourceURL")
      || directChild(segmentList, "SegmentURL")?.getAttribute("media")
      || null
    : null;
  const listedUrl = resolveHttpUrl(listed, base);
  if (listedUrl) return listedUrl;

  const segmentBase = [...chain].reverse()
    .map((element) => directChild(element, "SegmentBase"))
    .find((element): element is Element => Boolean(element));
  const initialized = segmentBase
    ? directChild(segmentBase, "Initialization")?.getAttribute("sourceURL") || null
    : null;
  const initializedUrl = resolveHttpUrl(initialized, base);
  if (initializedUrl) return initializedUrl;
  return base !== manifestUrl ? base : null;
}

function directChild(element: Element, tagName: string): Element | null {
  return [...element.children].find((child) => child.localName === tagName) || null;
}

function dashResourceFromText(manifest: string, manifestUrl: string): string | null {
  const representation = manifest.match(/<Representation\b([^>]*)>/i)?.[1] || "";
  const representationId = xmlAttribute(representation, "id") || "1";
  const bandwidth = xmlAttribute(representation, "bandwidth") || "1";
  const baseValue = manifest.match(/<BaseURL(?:\s[^>]*)?>([^<]+)<\/BaseURL>/i)?.[1]?.trim();
  const base = resolveHttpUrl(baseValue || null, manifestUrl) || manifestUrl;
  const template = manifest.match(/<SegmentTemplate\b([^>]*)\/?>/i)?.[1] || "";
  const pattern = xmlAttribute(template, "initialization") || xmlAttribute(template, "media");
  const resource = substituteDashTemplate(
    pattern,
    representationId,
    bandwidth,
    xmlAttribute(template, "startNumber") || "1",
    manifest.match(/<S\b[^>]*\bt="([^"]+)"/i)?.[1] || "0",
  );
  const templateUrl = resolveHttpUrl(resource, base);
  if (templateUrl) return templateUrl;
  const listed = manifest.match(/<Initialization\b[^>]*\bsourceURL="([^"]+)"/i)?.[1]
    || manifest.match(/<SegmentURL\b[^>]*\bmedia="([^"]+)"/i)?.[1];
  const listedUrl = resolveHttpUrl(listed || null, base);
  if (listedUrl) return listedUrl;
  return base !== manifestUrl ? base : null;
}

function xmlAttribute(attributes: string, name: string): string | null {
  return attributes.match(new RegExp(`\\b${name}="([^"]+)"`, "i"))?.[1] || null;
}

function substituteDashTemplate(
  value: string | null,
  representationId: string,
  bandwidth: string,
  number: string,
  time: string,
): string | null {
  if (!value) return null;
  const escapedDollar = "\u0000";
  return value
    .replace(/\$\$/g, escapedDollar)
    .replace(/\$RepresentationID\$/g, representationId)
    .replace(/\$Bandwidth(?:%0(\d+)d)?\$/g, (_match, width: string | undefined) => padDashValue(bandwidth, width))
    .replace(/\$Number(?:%0(\d+)d)?\$/g, (_match, width: string | undefined) => padDashValue(number, width))
    .replace(/\$Time(?:%0(\d+)d)?\$/g, (_match, width: string | undefined) => padDashValue(time, width))
    .split(escapedDollar).join("$");
}

function padDashValue(value: string, width: string | undefined): string {
  const length = Number(width || 0);
  return Number.isInteger(length) && length > 0 && length <= 32
    ? value.padStart(length, "0")
    : value;
}

function offline(
  checkedAt: number,
  transport: PlaybackKind,
  reason: string,
  httpStatus?: number,
): SourcePreflight {
  return {
    status: "offline",
    checkedAt,
    transport,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    reason,
  };
}

function errorName(error: unknown): string {
  if (error instanceof MediaRequestError) return `http-${error.status}`;
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && /^[a-z0-9-]+$/i.test(error.message)) return error.message;
  return "network-error";
}

export function isFreshPreflight(
  result: SourcePreflight | undefined,
  now = Date.now(),
): result is SourcePreflight {
  return Boolean(
    result
    && result.checkedAt > 0
    && now - result.checkedAt <= SOURCE_PREFLIGHT_TTL_MS
    && result.checkedAt <= now + 60_000,
  );
}

export function readSourcePreflights(
  storage: Pick<Storage, "getItem"> = localStorage,
): Record<string, SourcePreflight> {
  const output: Record<string, SourcePreflight> = Object.create(null) as Record<string, SourcePreflight>;
  let parsed: unknown;
  try {
    const raw = storage.getItem(SOURCE_PREFLIGHT_STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return output;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return output;
  for (const [id, candidate] of Object.entries(parsed as Record<string, unknown>)) {
    const result = validPreflight(candidate);
    if (id && result) output[id] = result;
  }
  return output;
}

export function recordSourcePreflight(
  source: StreamSource,
  result: SourcePreflight,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): void {
  const id = sourceIdentifier(source);
  const existing = readSourcePreflights(storage);
  const oldestAllowed = result.checkedAt - MAX_CACHE_AGE_MS;
  const entries = Object.entries({ ...existing, [id]: result })
    .filter(([, value]) => value.checkedAt >= oldestAllowed)
    .sort((left, right) => right[1].checkedAt - left[1].checkedAt)
    .slice(0, MAX_CACHE_ENTRIES);
  try {
    storage.setItem(SOURCE_PREFLIGHT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* readiness caching is optional */ }
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(SOURCE_PREFLIGHT_CHANGED_EVENT));
    }
  } catch { /* the local readiness hint remains optional */ }
}

function validPreflight(candidate: unknown): SourcePreflight | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (value.status !== "ready" && value.status !== "offline") return null;
  if (!Number.isFinite(value.checkedAt) || Number(value.checkedAt) <= 0) return null;
  if (!["hls", "dash", "progressive", "unknown", "unsupported"].includes(String(value.transport))) {
    return null;
  }
  const httpStatus = value.httpStatus === undefined ? undefined : Number(value.httpStatus);
  if (httpStatus !== undefined && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
    return null;
  }
  const reason = typeof value.reason === "string" && value.reason.length <= 80
    ? value.reason
    : undefined;
  return {
    status: value.status,
    checkedAt: Number(value.checkedAt),
    transport: value.transport as PlaybackKind,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function orderSourcesByPreflight(
  sources: StreamSource[],
  results: Record<string, SourcePreflight>,
  now = Date.now(),
): StreamSource[] {
  return sources.map((source, index) => ({ source, index })).sort((left, right) => {
    const leftResult = results[sourceIdentifier(left.source)];
    const rightResult = results[sourceIdentifier(right.source)];
    const rank = (result: SourcePreflight | undefined) => {
      if (!isFreshPreflight(result, now)) return 1;
      return result.status === "ready" ? 0 : 2;
    };
    return rank(leftResult) - rank(rightResult) || left.index - right.index;
  }).map(({ source }) => source);
}

export function browserPreflightRoutes(
  sources: StreamSource[],
  maximumSources: number,
  now = Date.now(),
): StreamSource[] {
  const playableSources = sources.filter(
    (source) => classifySource(source) !== "unsupported",
  );
  const selected: StreamSource[] = [];
  const selectedIds = new Set<string>();
  const add = (source: StreamSource | undefined) => {
    if (!source) return;
    const id = sourceIdentifier(source);
    if (selectedIds.has(id)) return;
    selectedIds.add(id);
    selected.push(source);
  };

  add(playableSources[0]);
  add(playableSources.find((source) => source.url.toLowerCase().startsWith("https://")));
  add(playableSources.find((source) => !isFreshCatalogHealth(source.catalogHealth, now)));
  for (const source of playableSources) add(source);

  const groups = selected.slice(0, Math.max(0, Math.floor(maximumSources)))
    .map(toWebPlayableSources);
  const routes: StreamSource[] = [];
  const routeIds = new Set<string>();
  const rounds = Math.max(0, ...groups.map((group) => group.length));
  for (let round = 0; round < rounds; round += 1) {
    for (const group of groups) {
      const route = group[round];
      if (!route) continue;
      const id = sourceIdentifier(route);
      if (routeIds.has(id)) continue;
      routeIds.add(id);
      routes.push(route);
    }
  }
  return routes;
}

export async function runPreflightQueue<T>(
  items: T[],
  maximumConcurrency: number,
  task: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(Math.floor(maximumConcurrency), items.length));
  const worker = async () => {
    while (!signal?.aborted) {
      const item = items[cursor];
      cursor += 1;
      if (item === undefined) return;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
