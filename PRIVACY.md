# Crow-Flix website privacy notice

Last updated: 23 August 2026

This notice describes the independent Crow-Flix browser application at
`https://crowflix.tv/` and its Crow-Flix relay. It does not describe the
separate Tauri desktop application.

## No Crow-Flix account or payment system

The website has no Crow-Flix account, login, advertising system, analytics SDK,
checkout, subscription, payment, or Stripe integration. Crow-Flix does not
centrally store a profile of what a visitor searches for, favourites, opens, or
watches.

Network use is not anonymous. Cloudflare and each external service contacted by
the application can receive the ordinary network information required to
answer a request.

## Data stored in the browser

The website stores the following data locally in browser storage:

- favourite and recently opened channel identifiers;
- user-managed Web Library destinations;
- source-health, cooldown, preferred-source, and short-lived source-readiness
  results used for playback failover and catalogue ranking; and
- cached catalogue metadata used for faster startup and stale-on-failure
  fallback.

Guide data and personal playlist additions are held in memory while the
application is open. Web Library export/import and personal M3U/XMLTV file
imports operate on files selected by the visitor and browser-local storage.
Selected file contents are parsed locally and are not uploaded to Crow-Flix.

To remove locally stored Crow-Flix data, clear site data for `crowflix.tv` in
the browser. This removes local storage, Cache API entries, and ordinary browser
caches associated with the site. Export any Web Library entries you want to
retain before clearing site data.

## Network services

Depending on the feature used, the website can connect to:

- Cloudflare Pages, which serves the website;
- IPTV-org catalogue and metadata endpoints;
- timezone-appropriate `i.mjh.nz` programme-guide files for Australian guide
  requests;
- bounded public `i.mjh.nz` Australian, New Zealand, and world playlists used
  to add regional/provider alternatives and genuinely absent channels;
- the static IPTV Nexus stream-health index, used only as an optional fresh
  hint for exact IPTV-org source identities;
- channel-logo and artwork hosts;
- media hosts and content-delivery networks listed by the catalogue;
- a bounded readiness check for a small set of currently relevant channels;
- external Web Library destinations opened by the visitor;
- the Crow-Flix relay for programme guides and media that an HTTPS browser
  cannot load directly, including HTTP, CORS-blocked, redirected, byte-range,
  DASH, or provider-header sources;
- the Crow-Flix relay when the visitor explicitly imports a public personal
  playlist or XMLTV URL; and
- Cloudflare Turnstile when a visitor requests live programme-guide data.

External providers apply their own availability, geographic, account, storage,
and privacy rules. Crow-Flix does not bypass those restrictions.

The readiness check uses at most three concurrent requests and caches a route
result for 15 minutes. Live TV sequentially checks up to two source identities
per channel on the currently visible 48-card page and stops at the first ready
route; other views use a smaller channel window. It reads only bounded manifest data and the key, initialization data, or first media
bytes needed to determine whether playback can start. It does not play or
download a complete programme in the background.

The optional health index is downloaded as a bounded compressed static file.
CrowFlix does not send searches, favourites, recent channels, Web Library data,
or a list of the visitor's channels to IPTV Nexus. The index can only annotate
an exact URL-and-header identity already present in the current IPTV-org data;
it cannot add or replace a stream by itself.

## Crow-Flix relay

The relay receives requests needed to provide programme guides, load the fixed
optional FAST fallback playlists, and route browser-incompatible media. Those
requests can include:

- the visitor IP address and request time;
- the requested relay route;
- guide country, browser timezone, channel identifiers, and public channel names
  needed to match provider XMLTV identifiers;
- media target information;
- a public personal playlist or XMLTV URL explicitly supplied by the visitor;
- provider-requested User-Agent or Referer values where required; and
- ordinary HTTP headers supplied by Cloudflare and the browser.

The relay validates external URLs and every redirect target against private and
reserved-address restrictions. It deliberately does not log complete upstream
URLs because they can contain query credentials. The relay does not bypass
provider geographic, account, subscription, or token restrictions.

## Cloudflare Turnstile

Turnstile runs only when live programme-guide retrieval needs verification. It
protects the public relay from automated guide requests that can trigger large
upstream downloads and XML parsing.

Cloudflare processes browser and network security signals needed to distinguish
automated traffic. Crow-Flix sends the resulting one-time token to the relay,
which validates it with Cloudflare before loading guide data. Tokens expire
after five minutes and are accepted only once.

Crow-Flix does not attach search text, favourites, recent channels, Web Library
content, channel lists, or other visitor content to Turnstile `cData`. Catalogue
browsing and video playback do not require Turnstile.

See Cloudflare's
[Turnstile privacy information](https://www.cloudflare.com/turnstile-privacy-policy/)
and [privacy policy](https://www.cloudflare.com/privacypolicy/) for Cloudflare's
processing terms.

## GitHub

GitHub processes information when someone visits the source repository, opens
an issue, submits a pull request, or uses private vulnerability reporting.
GitHub's own privacy terms govern that processing.

## Changes to this notice

Material privacy changes are documented in the repository. The date at the top
identifies the current revision.
