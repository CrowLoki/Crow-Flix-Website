# Crow-Flix-Website

The official browser-streaming Crow-Flix application at
[crowflix.tv](https://crowflix.tv/).

Open the website, browse the real catalogue, choose a channel, and watch in the
browser. The application includes search, categories, regions, favourites,
recent channels, programme guides, source failover, HLS and MPEG-DASH playback,
hardware-style zapping, and the user-managed Web Library.

The catalogue and interface load without either large playback engine. HLS.js
and DASH.js are separate on-demand chunks fetched only when their transport is
selected; native HLS remains available on browsers that provide it. This keeps
the initial minified JavaScript below 500 KiB while preserving the full player.

## Project identity

Crow-Flix-Website is an original project created and owned by Crow. It is the
independent web deployment of Crow-Flix, not a desktop installer page and not a
replacement for the separate Tauri desktop repository.

The browser frontend was recovered from the final verified production source
of the former `crow-flix-web` Pages deployment:

```text
CrowLoki/Crow-Flix commit 681139b6afc9189fec53a2e45b31a2bc08c2e4a3
Cloudflare deployment 48e4fc15-8acd-4747-b620-c648c7f1d48b
```

The recovered browser source now lives here so the public website and desktop
application can be maintained as separate projects.

Machine-readable recovery evidence is preserved in `RECOVERY-PROVENANCE.json`.
The complete upstream catalogue/guide integration contract is documented in
[`docs/IPTV-ECOSYSTEM.md`](docs/IPTV-ECOSYSTEM.md).

## Local verification

```console
npm ci
npm run check
npm audit --audit-level=moderate
```

`npm run check` type-checks the source, runs the frontend and relay test suites,
builds the browser application, and validates the deployable `dist/` tree,
canonical metadata, security headers, Crow brand assets, and common secret or
workstation-path leaks.

For local browser development:

```console
npm run dev
```

## Cloudflare deployment

- Canonical site: `https://crowflix.tv/`
- `www` redirect: `https://www.crowflix.tv/` -> canonical apex
- Pages project: `crow-flix`
- GitHub source: `CrowLoki/Crow-Flix-Website`
- Production branch: `main`
- Build command: `npm run check`
- Output directory: `dist`
- Infrastructure hostname: `https://crow-flix.pages.dev/`

The existing Git-connected Pages project publishes merged `main` commits. The
browser app calls the separately deployed `crowflix-relay` Worker for live EPG
data and media routes a normal HTTPS browser cannot load directly. Ordinary
HTTPS sources remain direct-first; Crow-Flix automatically falls back through
the relay for CORS failures, uses it for HTTP and provider-header sources, and
preserves redirected HLS, DASH child requests, and byte-range media.

The catalogue distinguishes recently played `LIVE` routes, bounded-preflight
`READY` routes, unverified entries, part-time sources, regional sources, and
temporarily failed entries. CrowFlix checks only a small set of currently
relevant channels with at most three concurrent requests, caches each result
for 15 minutes, and reads no more than the manifest plus the key,
initialization data, and first media bytes needed to prove that a route starts.
Live and ready routes rank first, while every matching regional, part-time,
offline, and unverified catalogue entry remains visible and reachable. The Live
TV order can switch between working-first and alphabetical without removing a
channel from the result set.

Opening a multi-source channel starts a three-way bounded check across its
current preferred source, its best HTTPS option, and an unverified alternative.
As those checks finish, CrowFlix reorders only the routes it has not tried yet,
so a newly proven route can jump ahead without restarting or replaying a failed
attempt. Remaining checks stop as soon as one route proves ready. The route
indicator in the player opens a complete source chooser, where any preserved
feed and its direct or relay delivery route can be selected explicitly without
exposing provider URLs, credentials, or request headers.

Because IPTV-org no longer publishes stream-status fields, the browser also
uses the free, MIT-licensed
[IPTV Nexus](https://github.com/dearbulut/iptv) static health index as an
optional whole-catalogue hint. CrowFlix accepts only fresh records that match an existing IPTV-org URL,
Referer, and User-Agent exactly; it never imports an unknown URL from the index.
An `online` hint improves source order, while a recent `offline`, `timeout`, or
`error` result marks and ranks a dead-only channel lower without removing it. A local
CrowFlix preflight or successful playback always takes priority, and failure of
the optional index leaves the normal catalogue path working.

A remote `online` result for a literal-IP feed remains available but does not
receive the same browser-ranking boost as a hostname-based source. Those feeds
often work from the scanner's network while rejecting the Cloudflare relay an
HTTPS browser needs, so CrowFlix waits for local evidence before promoting them.

The catalogue is additive. In addition to every current non-blocklisted
IPTV-org stream, CrowFlix loads bounded timezone-appropriate Australian, New
Zealand, and world provider playlists through the relay. Exact mapped channels
gain alternate sources; genuinely absent channels are retained as new entries
with their public playlist provenance, headers, logo, broadcast area, and
timezone. Failure of an optional playlist never replaces the base catalogue.
Individually media-verified public fallbacks may also be attached to an exact
channel ID with a clear feed label and provenance; the original sources remain.

Live programme-guide requests use Cloudflare Turnstile in Managed mode. The
browser obtains a one-time `epg_load` token, and the relay validates it through
Siteverify with exact action and hostname checks before performing guide
downloads and XML parsing. Catalogue browsing and video playback remain
unchallenged. Crow-Flix has no payment or Stripe integration.

After verification, the relay uses full IPTV-org guide mappings first, then a
timezone-specific Australian regional guide when applicable, followed by the
larger country fallback. Complementary results are combined and deduplicated;
a small worldwide match no longer prevents still-unmatched channels from being
filled by the regional layers. XMLTV is decompressed and parsed as a bounded
stream; only programmes matching requested channels are retained in memory.
Guide requests use bounded POST bodies rather than placing large country
catalogues in a URL. Authoritative and alternate channel names are used only
for exact, unambiguous XMLTV display-name matching. The timeline ranks channels
with listings first and paginates the complete country result instead of hiding
everything beyond a fixed row cap.

The built-in catalogue and automatic guide require no personal setup. The
browser also offers an optional Add source dialog for a public M3U or XMLTV URL
or a file selected from the visitor's device. Selected files are parsed locally
and never replace the built-in catalogue; matching M3U entries become alternate
routes, genuinely new entries remain visible, and personal XMLTV is matched
only to known channel IDs or unambiguous channel names. URL imports use the
bounded, SSRF-guarded relay path for browser compatibility. Personal imports
remain in the current browser session.

## Content and availability

Crow-Flix does not host, sell, or relicense television channels. It consumes
metadata and source information published by configured upstream services.
Provider availability, permissions, geographic restrictions, and account
requirements remain in force. The relay supplies normal provider-requested
headers; it does not bypass access controls.

## Licensing

Website code and documentation are licensed under `AGPL-3.0-only`. Crow brand
assets use the separate `LicenseRef-Crow-Brand` terms. See `LICENSING.md`,
`BRAND-ASSETS.md`, `ASSET-MANIFEST.sha256`, and `THIRD_PARTY_NOTICES.md`.
