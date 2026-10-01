# Crow-Flix operating usage

Ordinary visits load static Cloudflare Pages files. The catalogue is prepared
at build time, rather than downloaded and rebuilt for each visitor. Search,
filters, favourites, Baby CrowBot suggestions and Web Library edits work in
the browser. Video requests start only when a viewer opens a channel.

## Catalogue preparation

`npm run catalog:prepare` downloads the twelve IPTV-org metadata inputs and
the fixed bounded provider playlists directly from their public origins.
The existing catalogue builder preserves all non-blocklisted source URL/header
identities, metadata and provenance. Eight Australian city snapshots preserve
regional selection; visitors elsewhere use Sydney as the existing default.

The output is generated under ignored `public/catalog/` and copied into `dist/`
by the production build. Each compressed catalogue is approximately 1.87 MB
in the October 1, 2026 measurement. Optional provider outages reuse the last
published input where available. Required input failure stops the build, so
the existing working Pages deployment remains published.

The `Refresh prepared catalogue` GitHub workflow invokes the existing Pages
`main` deploy hook once daily at 18:23 UTC and can also be run manually. The
hook URL exists only in the encrypted Actions secret
`CROWFLIX_CATALOG_REBUILD_HOOK`. It uses the existing Git integration and does
not upload a replacement Pages project or introduce a Worker cron.

Refresh catalogue reloads the published static snapshot. It does not rebuild
the upstream catalogue. Browser storage reuses that snapshot for 24 hours and
serves it if a later refresh fails. Static files advertise a one-hour HTTP
cache lifetime. The catalogue's `updatedAt` records its preparation time.

## Guide and playback

Guide retrieval is requested by the viewer. Previously verified public
listings remain available on the device for one hour, including after reload.
Manual Refresh reuses a result less than ten minutes old. There is no automatic
network refresh timer; the on-screen clock chooses current/next programmes
from the already loaded listings.

Every new `/epg` request still validates Turnstile success, hostname and
`epg_load` action. Only after that does the Worker check its ten-minute parsed
guide cache. Keys include all effective matching inputs. Responses retain
`no-store`, metadata and original `updatedAt`; tokens are never cached.
Cache hits avoid guide-index and XMLTV downloads, decompression and parsing.
They still invoke the Worker, and the cache is local to each data centre.

Hovering a channel card performs no video fetch. Opening a channel uses the
playback controller's existing check and source failover; the previous
parallel background readiness scan has been removed. Normal HTTPS sources
remain direct-first. HTTP, header-required and CORS-incompatible routes can
still require the Worker for manifests and individual media requests during
watching. That remaining usage depends on viewers and stream segment sizes.

## Verified request savings

| Action | Previous implementation | Prepared implementation |
| --- | --- | --- |
| Uncached catalogue visit | 22 data requests; 8 Worker calls | 1 static download; 0 catalogue Worker calls |
| Fresh cached catalogue visit | 0 catalogue data requests | 0 catalogue data requests |
| Catalogue Refresh | 22 data requests; 8 Worker calls | 1 static download; 0 catalogue Worker calls |
| Hover a card | Starts video playback requests | No video request |
| Reopen/reload a verified guide within one hour | Reload loses listings and needs retrieval | Reuses browser listings; 0 guide Worker calls |
| Same guide requested again from the same edge within ten minutes | Repeats guide parsing | Siteverify plus parsed cache lookup |

The guide integration fixture reduces three upstream calls to one on a shared
cache hit: verification remains, guide-index and XMLTV calls disappear.
Release measurements must distinguish cold requests from cache hits.

Cloudflare documents static Pages requests as free and unlimited when Functions
are not invoked. Worker inbound requests and CPU use their separate allocations;
subrequests are not separately billed as Worker requests. Caching reduces work,
but does not guarantee a fixed bill for unlimited relay playback traffic.
See [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
