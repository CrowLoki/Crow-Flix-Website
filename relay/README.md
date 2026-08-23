# crowflix-relay

A small Cloudflare Worker that gives the CrowFlix **browser build** (hosted on
Cloudflare Pages) the two things browsers cannot do themselves:

1. **Server-side EPG pipeline** (`/epg`) — fetch and parse XMLTV programme
   guides without running into CORS.
2. **Browser-compatible stream relay** (`/stream`) — bridge HTTP/CORS sources,
   attach provider-required `User-Agent` / `Referer` headers, preserve byte
   ranges, and rewrite HLS playlists so every segment, key, and variant routes
   back through the relay.
3. **Bounded generic text fetch** (`/fetch`) — pull user-supplied M3U
   playlists and XMLTV guides for the web import feature.

Programme-guide requests are protected by Cloudflare Turnstile. The browser
sends a fresh one-time token in the `X-Turnstile-Token` header; the Worker calls
Siteverify and requires success, action `epg_load`, and an allowed hostname
before starting the guide pipeline. The secret is an encrypted Worker binding,
never source code.

The desktop (Tauri) app does not need this Worker; its Rust core already
fetches directly. This mirrors that core logic — `load_auto_epg` and
`parse_xmltv` in `src-tauri/src/lib.rs` — for the browser build.

## Honest scope statement

The relay **does not bypass provider geographic or account restrictions**.
It only supplies the headers (`User-Agent`, `Referer`) that the provider
already requires, from a server where browsers are not allowed to set them.
If a stream is geo-blocked or needs an account/token, it stays blocked.

## Deploy

```sh
cd relay
npx wrangler deploy
```

Bind `TURNSTILE_SECRET` separately in production and staging. The tracked
configuration contains only the expected action and hostname allowlists.

No build step, no runtime npm dependencies (Web standard APIs only: `fetch`,
`DecompressionStream`, `TextDecoder`, `ReadableStream`). `wrangler.toml`
carries no `account_id` — wrangler resolves it from your login. Point the web
app at the deployed origin (e.g. `https://crowflix-relay.<you>.workers.dev`).

## Routes

All responses include `Access-Control-Allow-Origin: *` and preflight
(`OPTIONS`) is answered. All failures return `{"error": "..."}` JSON with a
4xx/5xx status and CORS headers — the client never sees an opaque block.
Public data/media routes accept `GET`; `/epg` accepts bounded `POST` requests
and retains its legacy query-string `GET` form for compatibility.

### `GET /health`

```json
{ "ok": true, "service": "crowflix-relay", "version": "0.2.0" }
```

### `POST /epg`

The browser sends bounded JSON containing `country`, `timeZone`, and up to
2,000 `{id, names[]}` channel records. This avoids oversized query strings and
lets the streaming parser learn exact, unique provider display-name aliases.
The legacy query-string `GET` form remains supported for compatibility.

Pipeline (mirrors `load_auto_epg` in `src-tauri/src/lib.rs` lines 2180-2237):

1. Stream `https://iptv-org.github.io/api/guides.json`, retaining only objects
   for requested channel IDs while preserving feed, site, language, display
   name and source metadata. The 25+ MiB index is never materialized as one
   in-memory JSON array.
2. Rank guide source URLs by how many requested channel ids each covers
   (same `source_coverage` counting; stable descending sort).
3. Try up to **3** ranked sources (the Rust core tries 8; the Worker has
   tighter CPU budgets, so fewer attempts). Complementary sources are merged;
   equivalent mirrors are skipped once all of their mapped channels have
   already matched.
4. For recognised Australian browser timezones, fill still-unmatched channels
   from the matching bounded
   `i.mjh.nz/au/{City}/epg.xml.gz` guide and remap its provider ids to exact
   current CrowFlix channel ids.
5. Fill remaining channels from `epg_ripper_{TAG}.xml.gz` at
   `epgshare01.online`, then its `raw.githubusercontent.com/epgshare01` mirror,
   where the provider tag is derived from the uppercased country with `GB → UK`
   aliasing and current numbered exceptions such as `US2`, `CA2`, and `BE2`.
6. Nothing matched → `502 {"error": "No current programme listings matched the CC channels."}`.

Programmes are deduplicated by channel/start/stop across layers and the final
combined response remains capped at 50,000 entries. A tiny worldwide guide can
therefore enrich a country guide without preventing the much broader regional
match from running.

XMLTV handling: gzip is detected by magic bytes (`1f 8b`) and inflated with
`DecompressionStream("gzip")` (when upstream sets `Content-Encoding: gzip`
the runtime has already decompressed). Parsing is **streaming**: the parser
scans incrementally and keeps only programmes whose `channel` attribute maps
into the requested id set, including the same alias rules as the Rust core
(exact id, base before `@`, lowercase base). XMLTV timestamps like
`20260816120000 +0000` convert to ISO 8601 UTC; a missing timezone is treated
as UTC, matching `parse_xmltv_time`.

Success response (mirrors the app's camelCase `GuideResult`; XMLTV `<desc>`
is returned as `description`):

```json
{
  "programmes": [
    {
      "channelId": "ABC1.au",
      "title": "News at Noon & Weather",
      "description": "Midday bulletin — top stories.",
      "category": "News",
      "start": "2026-08-16T12:00:00.000Z",
      "stop": "2026-08-16T13:00:00.000Z"
    }
  ],
  "source": "IPTV-org EPG · https://.../guide.xml + Automatic regional guide · US",
  "matchedChannels": 167,
  "updatedAt": "2026-08-16T05:00:00.000Z"
}
```

Successful `/epg` responses carry `Cache-Control: no-store`. Every guide
request must reach the Worker so its one-time Turnstile token is validated;
browser or shared HTTP caching must not bypass that check. Any future caching
of upstream guide files belongs behind verification inside the Worker.

Input rules: 1-2000 channel ids, each ≤ 200 chars, no control characters;
`country` optional but must be 2-8 alphanumerics when present.

### `GET /fetch?url=<encoded>`

Bounded generic text fetch for user-supplied M3U playlists / XMLTV guides.

- URL validation: http/https only, no embedded credentials, SSRF guard
  (rejects `localhost`/`*.localhost`, loopback, private, link-local, CGNAT,
  multicast and IPv4-mapped IPv6 literals; redirects are followed manually
  and **every hop is re-validated**).
- Response capped at **32 MiB**, counted while streaming; over the cap → 502.
- Upstream `Content-Type` is passed through. 30 s upstream timeout.

### `GET /stream?url=<encoded>&referer=<encoded>&ua=<encoded>`

Browser-compatible stream relay. Same URL validation as `/fetch`. The supplied
`ua` / `referer` values (both optional, sanitised) become upstream
`User-Agent` / `Referer` headers. A single safe browser `Range` is forwarded;
multipart and malformed ranges are rejected.

- If the response is an HLS playlist — content type contains `mpegurl`, URL
  path ends `.m3u8`/`.m3u`, **or** the body starts with `#EXTM3U` (sniffed with
  a replayed single-reader prefix so mislabeled playlists still work) — the playlist is read within a
  **4 MiB** cap and every URI is rewritten through `/stream` with the same
  `ua`/`referer`: both `#EXT-X-...:URI="..."` attributes (KEY, MAP, MEDIA,
  ...) and bare URI lines, with relative URIs resolved against the playlist
  URL after all validated redirects. Non-http(s) URIs (e.g. `data:`) are left
  untouched.
- Anything else (media segments, live streams) streams through **unbounded**
  and untouched. Upstream `206`, `Content-Range`, `Accept-Ranges`, and
  `Content-Length` are preserved. Connection and first byte are bounded to
  eight seconds; after media begins there is no overall timeout because live
  IPTV streams are long-lived.
- For a relayed DASH source, the browser keeps provider-facing logical URLs
  for MPD resolution while routing MPD, initialization, ordinary media, and
  `availabilityTimeComplete=false` FetchLoader requests individually through
  `/stream`.
- Full URLs are never logged (they may carry query credentials); error
  messages quote upstream status codes only.

## Limits summary

| Bound                                    | Value   |
| ---------------------------------------- | ------- |
| Channel ids per `/epg` request           | 2,000   |
| Ranked guide sources tried               | 3       |
| Kept programmes per parse                | 50,000  |
| Kept programmes after combining layers   | 50,000  |
| Decompressed XMLTV per source            | 96 MiB  |
| guides.json index                        | 32 MiB streamed |
| `/fetch` response                        | 32 MiB  |
| Rewritten playlist body                  | 4 MiB   |
| Redirects followed (re-validated)        | 5       |

## Development

From the **repo root** (uses the root's existing vitest/typescript installs —
the relay adds no dependencies of its own):

```sh
npx vitest run relay                  # relay test suite
cd relay && npx tsc --noEmit -p tsconfig.json   # typecheck
npx wrangler dev                      # local Worker dev server
```

Layout: `src/index.ts` (routing + routes), `src/epg.ts` (EPG pipeline),
`src/xmltv.ts` (streaming parser), `src/m3u8.ts` (playlist rewriting),
`src/urls.ts` (URL validation + redirect-safe fetch), `src/streams.ts`
(bounded readers), `src/errors.ts` (`RelayError`), `test/` (vitest).
