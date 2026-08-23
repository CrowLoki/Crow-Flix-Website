# Crow-Flix IPTV ecosystem integration

Last audited: 23 August 2026

This document is the integration contract for the independent browser website.
It prevents future work from treating one playlist or a partial API join as the
whole Crow-Flix catalogue.

## Restored upstream source set

The repositories Crow originally supplied are restored together under:

`C:\Users\djdar\Documents\Codex\2026-07-14\iptv-org-iptv-https-github-com`

| Repository | Role in Crow-Flix |
| --- | --- |
| `iptv-org/iptv` | 17,604 stream entries, stream headers, 326 source files, 1,307 generated playlist groupings, validation and stream-testing tools |
| `iptv-org/api` | Runtime JSON contract joining the playlist, database, logos, feeds, guides, geographic dimensions and blocklist |
| `iptv-org/database` | Authoritative channel/feed/logo/category/language/geography/timezone metadata and compliance records |
| `iptv-org/epg` | 251 guide-site implementations, 538 channel mapping files, guide generation, provider identifiers and XMLTV tooling |
| `iptv-org/awesome-iptv` | Reference-player/provider capability catalogue used to check expected browser-player and TV-navigation features |

These checkouts are read-only reference/source inputs. They are not copied into
the deployable website and are not modified as part of Crow-Flix work.

## Runtime data contract

Crow-Flix loads the complete current API stream set once and derives the same
catalogue groupings locally. It must not download 1,307 overlapping M3U files
or mistake avoiding duplicate downloads for omitting their dimensions.

| API dataset | Current upstream scale | Crow-Flix use |
| --- | ---: | --- |
| `channels` | 41,085 | names, alternate names, network, owners, origin, categories, NSFW/closed/replacement and website metadata |
| `feeds` | 45,048 | feed identity, alternate names, main-feed flag, broadcast areas, timezones, languages and format |
| `streams` | 16,838 | every public URL, feed, title, quality, label, Referer and User-Agent |
| `logos` | 43,413 | in-use, feed-specific, tagged, sized and formatted logo selection |
| `categories` | 30 | category navigation and descriptions |
| `languages` | 7,893 | feed language names and language navigation |
| `countries` | 250 | origin/broadcast country navigation |
| `regions` | 42 | region coverage and navigation |
| `subdivisions` | 4,997 | exact state/province broadcast navigation |
| `cities` | 57,182 | exact city broadcast navigation |
| `timezones` | 416 | feed timezone navigation and guide-region selection |
| `guides` | 180,681 | channel/feed/site/language/provider identifiers and available guide sources |
| `blocklist` | 1,578 | DMCA/NSFW compliance reason and reference; never treated as an ordinary availability failure |

The browser catalogue preserves every non-blocklisted stream and groups only
exact logical channel/feed identities. Exact duplicate URLs with the same
header identity are deduplicated; alternate sources and regional feeds remain.

## Playlist groupings

The generated playlist catalogue is represented by first-class navigation,
not discarded:

- category;
- language;
- country and region;
- state/province;
- city;
- timezone;
- owner and network;
- logical feed;
- source provider/provenance;
- individual source alternatives.

The current additive provider layer also loads fixed bounded raw playlists for
the browser's Australian region, New Zealand, and world feeds. Known provider
IDs or unique semantic names contribute alternate sources to existing logical
feeds. Unmatched entries become provenance-labelled channels rather than being
discarded. Exact URL/header identities remain deduplicated.
An exact source shared by multiple catalogues retains all contributor names;
deduplication changes route count only and never erases lineage.
Safe provider header values are retained exactly even when an upstream Referer
uses a bare host. A verified source successor is additive: the known-dead route
remains labelled and reachable in source details while ordering favours the
current replacement.
Current individually verified public fallbacks are tracked in source with an
exact channel ID, distinct feed label, and provenance. They augment rather than
replace upstream sources.

An optional personal-source layer is available in the browser without changing
the upstream repositories or built-in catalogue. Selected M3U files are parsed
locally; public M3U URLs use the bounded SSRF-guarded relay. Exact channel IDs
gain alternate routes, genuinely new channels extend the matching browse
dimensions, and all imported routes retain personal-source provenance.

Live TV always contains the complete matching result set. `Working first` and
`A–Z` change order only. Health or availability never silently removes entries.
The bounded readiness queue follows the actual 48-card Live TV page: one best
route per visible channel, at most three concurrent requests, cached for 15
minutes. Changing pages changes the check window; health-driven reordering does
not recursively chase through or shrink the catalogue.

Current upstream SRT, RTMP, RTSP, and MMSH records are retained with an honest
`EXTERNAL` availability state rather than discarded by the HTTP normalizer.
They remain searchable and expose full metadata, host/protocol, and official
website information. The verified Free-TV Advocate HLS feed is attached to its
exact channel alongside the original SRT record; the other external-only
channels remain intact until a legitimate browser route is media-verified.

## Programme guide pipeline

Built-in guide retrieval is automatic and protected by Turnstile only at `/epg`:

1. The browser sends a bounded POST containing country, timezone, current
   channel IDs, authoritative names and alternate names.
2. The relay validates the one-time Turnstile token, exact action and hostname
   before reading the guide request body.
3. The full 25+ MiB IPTV-org guide index is streamed object-by-object; only
   requested channel records are retained. Feed/site/language/display-name
   metadata enriches matching and published source URLs are ranked.
4. XMLTV `<channel>` blocks can teach an alias only when a normalized provider
   display name uniquely matches one requested channel. Ambiguous names are
   rejected rather than guessed.
5. Complementary IPTV-org sources are merged. Once a layer succeeds, equivalent
   mirrors whose mapped channel set is already covered are skipped.
6. Australian timezones fill still-unmatched channels from the fixed city-source
   and alias table before the broad EPGShare layer fills the remaining country
   channels.
7. Provider file tags such as `US2`, `CA2` and `BE2` are tracked explicitly.
8. Gzip XMLTV is parsed as a bounded stream; only requested programmes are
   retained in memory. The combined result is deduplicated by channel/start/stop
   and bounded to 50,000 programmes.
9. The guide timeline paginates every channel in the selected country; listing
   coverage and playback health affect ordering only, never membership.

Optional personal XMLTV files are streamed through the same bounded matching
parser locally. Public personal XMLTV URLs use the bounded SSRF-guarded relay;
only known IDs and unambiguous channel-name matches are retained. Personal
programme data is additive for the current browser session and does not replace
the automatic guide pipeline.

## Capability audit still in progress

The current IPTV-org stream API explicitly removed its former `timeshift`
field and publishes no catch-up URL template or recording entitlement. CrowFlix
therefore does not fabricate catch-up/record controls from programme listings
or provider web pages. The capability can be added only when a retained source
lawfully publishes the required playback metadata.

Automated acceptance includes the full unit/relay suite, real manifest and
first-media checks, deployed-file/header verification, and the dependency-free
Chrome/Edge headless UI flow. Physical device/browser testing remains distinct
evidence; passing CI or one sample is never reported as that physical result.
