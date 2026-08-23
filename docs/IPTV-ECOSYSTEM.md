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
- logical feed and source alternatives.

The current additive provider layer also loads fixed bounded raw playlists for
the browser's Australian region, New Zealand, and world feeds. Known provider
IDs or unique semantic names contribute alternate sources to existing logical
feeds. Unmatched entries become provenance-labelled channels rather than being
discarded. Exact URL/header identities remain deduplicated.
Current individually verified public fallbacks are tracked in source with an
exact channel ID, distinct feed label, and provenance. They augment rather than
replace upstream sources.

Live TV always contains the complete matching result set. `Working first` and
`A–Z` change order only. Health or availability never silently removes entries.

## Programme guide pipeline

Guide retrieval is automatic and protected by Turnstile only at `/epg`:

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
5. Australian timezones use the fixed city-source and alias table from the
   restored EPG configuration before the broad EPGShare fallback.
6. Provider file tags such as `US2`, `CA2` and `BE2` are tracked explicitly.
7. Gzip XMLTV is parsed as a bounded stream; only requested programmes are
   retained in memory.

## Capability audit still in progress

The full goal remains active. Important remaining work includes deeper source
group/provenance navigation, richer owner/network/feed detail in channel UI,
more guide providers and mappings for countries with low coverage, explicit
source selection, catch-up/recording only where a source lawfully publishes the
required metadata, and broader real-device/browser acceptance. Passing CI or a
single sample is not completion evidence for those items.
