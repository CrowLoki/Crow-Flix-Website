# Crow-Flix-Website

The official browser-streaming Crow-Flix application at
[crowflix.tv](https://crowflix.tv/).

Open the website, browse the real catalogue, choose a channel, and watch in the
browser. The application includes search, categories, regions, favourites,
recent channels, programme guides, source failover, HLS and MPEG-DASH playback,
hardware-style zapping, and the user-managed Web Library.

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
data and header-aware playback where a normal browser cannot supply provider
headers.

Live programme-guide requests use Cloudflare Turnstile in Managed mode. The
browser obtains a one-time `epg_load` token, and the relay validates it through
Siteverify with exact action and hostname checks before performing guide
downloads and XML parsing. Catalogue browsing and video playback remain
unchallenged. Crow-Flix has no payment or Stripe integration.

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
