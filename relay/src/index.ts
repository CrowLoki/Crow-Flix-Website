import { RelayError } from "./errors";
import { loadAutoEpg } from "./epg";
import { rewriteM3u8 } from "./m3u8";
import { concatChunks, readBounded } from "./streams";
import {
  fetchValidated,
  fetchValidatedWithUrl,
  validateExternalUrl,
} from "./urls";
import {
  verifyTurnstile,
  type TurnstileEnvironment,
} from "./turnstile";

const SERVICE_VERSION = "0.2.0";

/** /fetch response cap (spec: 32 MiB, streamed-bounded). */
const FETCH_MAX_BYTES = 32 * 1024 * 1024;
/** HLS playlist cap; media segments stream through unbounded. */
const PLAYLIST_MAX_BYTES = 4 * 1024 * 1024;
const GUIDE_REQUEST_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
/** Covers upstream connection/headers and the first body byte, not playback. */
const STREAM_FIRST_BYTE_TIMEOUT_MS = 8_000;
const MAX_UA_LENGTH = 512;
const MAX_REFERER_LENGTH = 2_048;
const MAX_RANGE_LENGTH = 64;

const RELAY_UA = "crowflix-relay/0.2.0";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges",
  "Access-Control-Max-Age": "86400",
};

function json(payload: unknown, status = 200, cacheControl = "no-store"): Response {
  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", cacheControl);
  return new Response(JSON.stringify(payload), { status, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof RelayError) {
    return json({ error: error.message }, error.status);
  }
  // Deliberately do not log here: upstream URLs may carry query credentials.
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "The relay failed unexpectedly.";
  return json({ error: message }, 502);
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0) {
    throw new RelayError(400, `Provide the ${name} parameter.`);
  }
  return value;
}

function sanitizeHeaderParam(
  url: URL,
  name: string,
  maxLength: number,
): string | null {
  const value = url.searchParams.get(name);
  if (value === null) return null;
  if (value.length === 0 || value.length > maxLength) {
    throw new RelayError(400, `The ${name} parameter is not usable.`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new RelayError(400, `The ${name} parameter is not usable.`);
    }
  }
  return value;
}

/**
 * Browsers use single byte ranges for media seeking. Forward that narrow form
 * only; multipart and malformed ranges are rejected rather than reflected to
 * arbitrary upstream servers.
 */
function safeClientRange(request: Request): string | null {
  const raw = request.headers.get("range");
  if (raw === null) return null;
  if (raw.length === 0 || raw.length > MAX_RANGE_LENGTH) {
    throw new RelayError(400, "That byte range is not usable.");
  }

  const match = /^bytes=(?:(\d{1,20})-(\d{0,20})|-(\d{1,20}))$/.exec(raw);
  if (!match) {
    throw new RelayError(400, "Only one normal byte range is supported.");
  }

  const start = match[1];
  const end = match[2];
  const suffixLength = match[3];
  if (suffixLength !== undefined && BigInt(suffixLength) === 0n) {
    throw new RelayError(400, "That byte range is not usable.");
  }
  if (
    start !== undefined &&
    end !== undefined &&
    end.length > 0 &&
    BigInt(start) > BigInt(end)
  ) {
    throw new RelayError(400, "That byte range is not usable.");
  }
  return raw;
}

function handleHealth(): Response {
  return json({ ok: true, service: "crowflix-relay", version: SERVICE_VERSION });
}

async function handleEpg(
  request: Request,
  url: URL,
  env: TurnstileEnvironment,
): Promise<Response> {
  await verifyTurnstile(request, env);
  let country = url.searchParams.get("country") ?? "";
  let channelIds = (url.searchParams.get("ids") ?? "").split(",");
  let timeZone = url.searchParams.get("tz") ?? "";
  const namesByChannel = new Map<string, string[]>();
  const aliasesByProviderId = new Map<string, string>();
  if (request.method === "POST") {
    if (!request.body) throw new RelayError(400, "Provide a guide request body.");
    const { data, truncated } = await readBounded(
      request.body,
      GUIDE_REQUEST_MAX_BYTES,
    );
    if (truncated) throw new RelayError(413, "That guide request is too large.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(data));
    } catch {
      throw new RelayError(400, "Provide valid guide request JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RelayError(400, "Provide a valid guide request object.");
    }
    const body = parsed as Record<string, unknown>;
    country = typeof body.country === "string" ? body.country : "";
    timeZone = typeof body.timeZone === "string" && body.timeZone.length <= 64
      ? body.timeZone
      : "";
    const channels = Array.isArray(body.channels) ? body.channels : [];
    channelIds = [];
    for (const candidate of channels.slice(0, 2_001)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const channel = candidate as Record<string, unknown>;
      if (typeof channel.id !== "string") continue;
      channelIds.push(channel.id);
      const names = Array.isArray(channel.names)
        ? channel.names.filter((name): name is string => {
          return typeof name === "string" && name.length > 0 && name.length <= 256;
        }).slice(0, 12)
        : [];
      if (names.length) namesByChannel.set(channel.id, names);
      const aliases = Array.isArray(channel.aliases)
        ? channel.aliases.filter((alias): alias is string => {
          return typeof alias === "string" && alias.length > 0 && alias.length <= 256;
        }).slice(0, 12)
        : [];
      for (const alias of aliases) {
        const existing = aliasesByProviderId.get(alias);
        if (!existing || existing === channel.id) {
          aliasesByProviderId.set(alias, channel.id);
        }
      }
    }
  }
  const result = await loadAutoEpg(
    country,
    channelIds,
    fetch,
    timeZone,
    namesByChannel,
    aliasesByProviderId,
  );
  // Every browser guide request must reach this handler so its one-time
  // Turnstile token is verified. Upstream guide caching belongs inside the
  // Worker, never in a browser or shared HTTP cache in front of verification.
  return json(result);
}

async function handleFetch(url: URL): Promise<Response> {
  const target = validateExternalUrl(requiredParam(url, "url"));
  const response = await fetchValidated(target, {
    headers: { Accept: "*/*", "User-Agent": RELAY_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new RelayError(
      502,
      `The upstream server responded ${response.status}.`,
    );
  }
  const { data, truncated } = await readBounded(response.body, FETCH_MAX_BYTES);
  if (truncated) {
    throw new RelayError(
      502,
      "That response exceeded the 32 MiB relay limit.",
    );
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set(
    "Content-Type",
    response.headers.get("content-type") ?? "text/plain; charset=utf-8",
  );
  return new Response(data, { status: 200, headers });
}

function isPlaylistTarget(url: URL, contentType: string): boolean {
  if (contentType.toLowerCase().includes("mpegurl")) return true;
  const path = url.pathname.toLowerCase();
  return path.endsWith(".m3u8") || path.endsWith(".m3u");
}

function startsWithExtm3u(bytes: Uint8Array): boolean {
  let offset = 0;
  // Skip a UTF-8 byte-order mark (EF BB BF) if present.
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    offset = 3;
  }
  const marker = "#EXTM3U";
  if (bytes.byteLength - offset < marker.length) return false;
  for (let i = 0; i < marker.length; i++) {
    if (bytes[offset + i] !== marker.charCodeAt(i)) return false;
  }
  return true;
}

function buildStreamRelayUrl(
  origin: string,
  absolute: string,
  ua: string | null,
  referer: string | null,
): string {
  const relay = new URL("/stream", origin);
  relay.searchParams.set("url", absolute);
  if (ua !== null) relay.searchParams.set("ua", ua);
  if (referer !== null) relay.searchParams.set("referer", referer);
  return relay.toString();
}

function playlistResponse(
  body: string,
  target: URL,
  upstreamContentType: string,
  origin: string,
  ua: string | null,
  referer: string | null,
): Response {
  const rewritten = rewriteM3u8(body, target.href, (absolute) =>
    buildStreamRelayUrl(origin, absolute, ua, referer),
  );
  const headers = new Headers(CORS_HEADERS);
  headers.set(
    "Content-Type",
    upstreamContentType || "application/vnd.apple.mpegurl",
  );
  headers.set("Cache-Control", "no-store");
  return new Response(rewritten, { status: 200, headers });
}

interface PrefixRead {
  chunks: Uint8Array[];
  total: number;
  exhausted: boolean;
}

async function readPrefix(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  minimumBytes: number,
  onFirstByte: () => void,
): Promise<PrefixRead> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exhausted = false;
  let sawByte = false;
  while (total < minimumBytes) {
    const { done, value } = await reader.read();
    if (done) {
      exhausted = true;
      break;
    }
    if (value.byteLength === 0) continue;
    if (!sawByte) {
      sawByte = true;
      onFirstByte();
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { chunks, total, exhausted };
}

async function finishPlaylistRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: PrefixRead,
): Promise<Uint8Array> {
  const chunks = [...prefix.chunks];
  let total = prefix.total;
  try {
    if (total > PLAYLIST_MAX_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new RelayError(
        502,
        "That playlist exceeded the 4 MiB relay limit.",
      );
    }
    if (!prefix.exhausted) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total + value.byteLength > PLAYLIST_MAX_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new RelayError(
            502,
            "That playlist exceeded the 4 MiB relay limit.",
          );
        }
        chunks.push(value);
        total += value.byteLength;
      }
    }
    return concatChunks(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Put sniffed bytes back in front of the original reader. This avoids tee():
 * cancelling one tee branch can wait indefinitely for the untouched branch.
 */
function streamAfterPrefix(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: PrefixRead,
): ReadableStream<Uint8Array> {
  let prefixIndex = 0;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < prefix.chunks.length) {
        controller.enqueue(prefix.chunks[prefixIndex]);
        prefixIndex += 1;
        if (prefixIndex === prefix.chunks.length && prefix.exhausted) {
          release();
          controller.close();
        }
        return;
      }
      if (prefix.exhausted) {
        release();
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

function mediaResponseHeaders(upstream: Response): Headers {
  const headers = new Headers(CORS_HEADERS);
  for (const name of [
    "content-type",
    "cache-control",
    "content-range",
    "accept-ranges",
    "content-length",
  ]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

async function handleStream(
  request: Request,
  requestUrl: URL,
): Promise<Response> {
  const target = validateExternalUrl(requiredParam(requestUrl, "url"));
  const ua = sanitizeHeaderParam(requestUrl, "ua", MAX_UA_LENGTH);
  const referer = sanitizeHeaderParam(requestUrl, "referer", MAX_REFERER_LENGTH);
  const range = safeClientRange(request);

  const upstreamHeaders = new Headers();
  if (ua !== null) upstreamHeaders.set("User-Agent", ua);
  if (referer !== null) upstreamHeaders.set("Referer", referer);
  if (range !== null) upstreamHeaders.set("Range", range);

  // Bound only connection/headers and the first body byte. Once media starts,
  // the abort timer is cleared so a healthy live stream can run indefinitely.
  const abortController = new AbortController();
  let deadlineExpired = false;
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    abortController.abort();
  }, STREAM_FIRST_BYTE_TIMEOUT_MS);
  const clearDeadline = (): void => clearTimeout(deadline);

  let upstream: Response;
  let finalUrl: URL;
  try {
    ({ response: upstream, finalUrl } = await fetchValidatedWithUrl(target, {
      headers: upstreamHeaders,
      signal: abortController.signal,
    }));
  } catch (error) {
    clearDeadline();
    if (deadlineExpired) {
      throw new RelayError(504, "The stream server did not start responding.");
    }
    throw error;
  }
  if (deadlineExpired) {
    clearDeadline();
    void upstream.body?.cancel().catch(() => undefined);
    throw new RelayError(504, "The stream server did not start responding.");
  }
  if (!upstream.ok) {
    clearDeadline();
    const status = upstream.status >= 400 && upstream.status <= 599
      ? upstream.status
      : 502;
    throw new RelayError(
      status,
      `The stream provider responded ${upstream.status}.`,
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const origin = requestUrl.origin;

  if (!upstream.body) {
    clearDeadline();
    return new Response(null, {
      status: upstream.status,
      headers: mediaResponseHeaders(upstream),
    });
  }

  const reader = upstream.body.getReader();
  let prefix: PrefixRead;
  try {
    prefix = await readPrefix(reader, 8, clearDeadline);
    clearDeadline();
  } catch (error) {
    clearDeadline();
    reader.releaseLock();
    if (deadlineExpired) {
      throw new RelayError(504, "The stream server did not send media data.");
    }
    throw error;
  }

  const first = concatChunks(prefix.chunks, prefix.total);
  // The final URL is the redirect target that has already passed SSRF
  // validation. Relative HLS URIs must resolve against it, not the short URL.
  if (isPlaylistTarget(finalUrl, contentType) || startsWithExtm3u(first)) {
    const playlist = await finishPlaylistRead(reader, prefix);
    return playlistResponse(
      new TextDecoder().decode(playlist),
      finalUrl,
      contentType,
      origin,
      ua,
      referer,
    );
  }

  // Genuine media: replay the small sniffed prefix, then stream directly from
  // the same reader. There is no overall playback timeout.
  return new Response(streamAfterPrefix(reader, prefix), {
    status: upstream.status,
    headers: mediaResponseHeaders(upstream),
  });
}

export default {
  async fetch(
    request: Request,
    env: TurnstileEnvironment = {},
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (
      request.method !== "GET"
      && !(url.pathname === "/epg" && request.method === "POST")
    ) {
      return json({ error: "That method is not supported for this route." }, 405);
    }
    try {
      switch (url.pathname) {
        case "/health":
          return handleHealth();
        case "/epg":
          return await handleEpg(request, url, env);
        case "/fetch":
          return await handleFetch(url);
        case "/stream":
          return await handleStream(request, url);
        default:
          return json({ error: "Unknown relay route." }, 404);
      }
    } catch (error) {
      return errorResponse(error);
    }
  },
};
