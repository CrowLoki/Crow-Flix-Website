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

Hook acceptance is not publication proof. After the existing daily rebuild,
the workflow polls the Sydney snapshot at most once per minute for twelve
minutes, then verifies all eight regions share one preparation timestamp after
the request. It validates HTTP status, gzip/JSON integrity, channel/source
structure and a minimum viable catalogue. Requests are individually bounded
and the entire verification run has a 256 MiB transfer ceiling. This checks
static Pages assets only; it adds no Worker schedule or provider probe.

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

## Local helper and search

Catalogue and in-player search share an accent-insensitive, word-order-independent
index, rebuilt only when their catalogue changes. It includes display metadata,
not media URLs or provider request headers. A local measurement using 12,975
Sydney channels returned identical ordered results in twenty paired searches:
index construction took 334 ms once, followed by 2.1–5.7 ms searches instead of
176–377 ms repeatedly normalizing every channel. These are workstation timings,
not guarantees for all visitor devices.

Baby CrowBot remains local: channel/country/language queries, exclusions such as
`English movies not news`, favourites, recent channels, and now/upcoming/tonight
queries use only the catalogue and already-loaded guide. Tonight means the
remaining 18:00–24:00 window in the device timezone. Missing listings are stated
as incomplete guide data, not invented schedules. The helper does not scan the
catalogue while closed and does not subscribe to global pointer movements.

## Release budgets and browser checks

`npm run check` enforces the following release budgets and reports measured
sizes for every regional snapshot. These are project safeguards, not billing
quotas. Exceeding one stops the release for investigation; it must never be
resolved by silently dropping baseline channels.

| Resource | Budget |
| --- | --- |
| Initial application JavaScript | 500 KiB raw / 180 KiB gzip |
| Each regional catalogue | 4 MiB compressed / 48 MiB decoded |

`npm run acceptance:ci` runs two sequential, isolated local browser suites after
the build. CI uses its preinstalled Chrome and installs the free FFmpeg package
from Ubuntu's configured repositories only if it is missing, with a three-minute
setup bound. This installation exists only on the disposable CI runner, not on
visitors' or the owner's computers. There are no new npm dependencies or paid
test services. Browser processes, profiles and synthetic
media belong to one temporary root and are cleaned up on success or failure.
If shutdown cannot be confirmed, the runner fails and reports the retained
temporary path instead of deleting a potentially active browser profile.
Application regressions have a three-minute deadline; decoded playback has
three minutes plus a bounded fifty-second outer cleanup allowance. Wrapped
browser descendants remain inside the runner's owned process group.
CI runs on pull requests and pushes to `main`, avoiding duplicate feature-branch
push and pull-request runs for the same proposed change.

The application regression suite exercises storage failures, import/refresh
races, search, exclusions and keyboard focus. Its request budget allows one
static catalogue fetch on a cold visit, none on a fresh cached reload, and no
guide, media or remote-AI fetches from ordinary search/favourites/helper use.

Decoded-playback acceptance generates under 2 MiB of synthetic video locally
and requires advancing playback time and decoded frames through the real app
and relay source. It covers progressive byte ranges/seeking, direct HLS/DASH,
redirected relay HLS/DASH, provider-header DASH and direct-failure relay recovery.
External requests are blocked. This verifies our playback paths, not the
availability, account requirements or geographic restrictions of every provider.

Cloudflare documents static Pages requests as free and unlimited when Functions
are not invoked. Worker inbound requests and CPU use their separate allocations;
subrequests are not separately billed as Worker requests. Caching reduces work,
but does not guarantee a fixed bill for unlimited relay playback traffic.
See [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
