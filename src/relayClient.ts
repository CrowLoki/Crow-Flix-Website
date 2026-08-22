// Client for the CrowFlix relay (Cloudflare Worker). The relay supplies what
// browsers cannot do directly: server-side EPG guide retrieval, and streams
// whose providers require User-Agent/Referer headers.
//
// The relay never bypasses provider geographic or account restrictions.

import { sourceIdentifier, type StreamSource } from "./playback/types";

export const RELAY_BASE = (
  (import.meta.env.VITE_RELAY_BASE as string | undefined)?.trim()
  || "https://crowflix-relay.djdarren2056.workers.dev"
).replace(/\/+$/, "");

export class RelayRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RelayRequestError";
    this.status = status;
  }
}

export type RelayProgramme = {
  channelId: string;
  title: string;
  description?: string | null;
  category?: string | null;
  start: string;
  stop: string;
};

export type RelayGuideResult = {
  programmes: RelayProgramme[];
  source: string;
  matchedChannels: number;
  updatedAt: string;
};

const REQUEST_TIMEOUT_MS = 90_000;

export async function loadRelayGuide(
  country: string,
  channelIds: string[],
  turnstileToken: string,
): Promise<RelayGuideResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const query = new URLSearchParams({ country, ids: channelIds.join(",") });
    const response = await fetch(`${RELAY_BASE}/epg?${query}`, {
      cache: "no-store",
      headers: { "X-Turnstile-Token": turnstileToken },
      signal: controller.signal,
    });
    const body = await response.json() as RelayGuideResult & { error?: string };
    if (!response.ok || body.error) {
      throw new RelayRequestError(
        response.status,
        body.error || `Relay returned HTTP ${response.status}`,
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Route a header-locked source through the relay. Returns null when the
 * source cannot be relayed (no usable URL).
 */
export function relayStreamUrl(source: StreamSource): string | null {
  if (!source.url || !/^https?:\/\//i.test(source.url)) return null;
  const query = new URLSearchParams({ url: source.url });
  if (source.userAgent) query.set("ua", source.userAgent);
  if (source.referrer) query.set("referer", source.referrer);
  return `${RELAY_BASE}/stream?${query}`;
}

function browserRouteId(
  source: StreamSource,
  route: "direct" | "relay" | "https-upgrade",
): string {
  return `${sourceIdentifier(source)}:${route}`;
}

function directWebSource(
  source: StreamSource,
  url = source.url,
  route: "direct" | "https-upgrade" = "direct",
): StreamSource {
  return {
    ...source,
    id: browserRouteId(source, route),
    sourceId: undefined,
    url,
    delivery: "direct",
    logicalUrl: url,
  };
}

function httpsUpgradeSource(source: StreamSource): StreamSource | null {
  try {
    const upgraded = new URL(source.url);
    if (upgraded.protocol !== "http:") return null;
    upgraded.protocol = "https:";
    return directWebSource(source, upgraded.href, "https-upgrade");
  } catch {
    return null;
  }
}

function relayedWebSource(source: StreamSource): StreamSource | null {
  const url = relayStreamUrl(source);
  if (!url) return null;
  return {
    ...source,
    id: browserRouteId(source, "relay"),
    sourceId: undefined,
    url,
    logicalUrl: source.url,
    delivery: "relay",
    referrer: null,
    userAgent: null,
    requiresHeaders: false,
    // The relay path ends in /stream, so keep the original transport hint.
    transport: source.transport ?? null,
  };
}

/**
 * Build deterministic browser playback attempts for one provider source.
 *
 * - ordinary HTTPS is tried directly, then through the relay;
 * - HTTP first uses the relay, then an HTTPS-upgraded direct attempt when no
 *   restricted headers are needed; raw HTTP never reaches the HTTPS page;
 * - sources that require restricted headers use the relay exclusively.
 *
 * Native/Tauri callers do not use this mapping and keep their original source.
 */
export function toWebPlayableSources(source: StreamSource): StreamSource[] {
  if (!source.url || !/^https?:\/\//i.test(source.url)) return [source];
  const relayed = relayedWebSource(source);
  const needsHeaders = Boolean(source.requiresHeaders || source.referrer || source.userAgent);
  if (needsHeaders) return relayed ? [relayed] : [];
  if (source.url.toLowerCase().startsWith("http://")) {
    const upgraded = httpsUpgradeSource(source);
    return [relayed, upgraded].filter((route): route is StreamSource => Boolean(route));
  }
  return relayed ? [directWebSource(source), relayed] : [directWebSource(source)];
}

/** Compatibility helper for callers that only accept one route. */
export function toWebPlayableSource(source: StreamSource): StreamSource {
  return toWebPlayableSources(source)[0] ?? source;
}

function relayParameters(source: StreamSource): {
  base: URL;
  userAgent: string | null;
  referrer: string | null;
} | null {
  if (source.delivery !== "relay") return null;
  try {
    const base = new URL(source.url);
    const configuredRelay = new URL(RELAY_BASE);
    if (
      base.origin !== configuredRelay.origin
      || base.pathname !== "/stream"
      || !base.searchParams.has("url")
    ) return null;
    return {
      base,
      userAgent: base.searchParams.get("ua"),
      referrer: base.searchParams.get("referer"),
    };
  } catch {
    return null;
  }
}

/**
 * Route a dash.js provider request through the same relay source. dash.js is
 * still given logical provider URLs, so relative BaseURL, initialization and
 * media references resolve against the provider rather than `/stream`.
 */
export function routeDashRequestUrl(requestUrl: string, source: StreamSource): string {
  const parameters = relayParameters(source);
  if (!parameters) return requestUrl;
  try {
    const logicalBase = source.logicalUrl
      || parameters.base.searchParams.get("url")
      || undefined;
    const request = new URL(requestUrl, logicalBase);
    if (
      request.origin === parameters.base.origin
      && request.pathname === parameters.base.pathname
      && request.searchParams.has("url")
    ) {
      return request.href;
    }
    if (request.protocol !== "http:" && request.protocol !== "https:") return requestUrl;
    const relay = new URL("/stream", parameters.base.origin);
    relay.searchParams.set("url", request.href);
    if (parameters.userAgent !== null) relay.searchParams.set("ua", parameters.userAgent);
    if (parameters.referrer !== null) relay.searchParams.set("referer", parameters.referrer);
    return relay.href;
  } catch {
    return requestUrl;
  }
}

/** Recover the provider-facing URL from one relayed DASH request. */
export function logicalDashRequestUrl(
  requestUrl: string,
  source: StreamSource,
): string {
  if (source.delivery !== "relay") return requestUrl;
  try {
    const request = new URL(requestUrl, source.logicalUrl || undefined);
    const relay = new URL(RELAY_BASE);
    if (request.origin !== relay.origin || request.pathname !== "/stream") {
      return request.href;
    }
    const logical = request.searchParams.get("url");
    if (!logical) return source.logicalUrl || requestUrl;
    const parsed = new URL(logical);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : source.logicalUrl || requestUrl;
  } catch {
    return source.logicalUrl || requestUrl;
  }
}

/** Bounded fetch of a user-supplied playlist/guide URL through the relay. */
export async function relayFetchText(url: string): Promise<string> {
  const query = new URLSearchParams({ url });
  const response = await fetch(`${RELAY_BASE}/fetch?${query}`);
  if (!response.ok) {
    let message = `Relay returned HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) message = body.error;
    } catch { /* keep the status message */ }
    throw new Error(message);
  }
  return response.text();
}
