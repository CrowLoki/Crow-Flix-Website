# Crow-Flix-Website

Official static information and download website for the
[CrowFlix Windows desktop application](https://github.com/CrowLoki/Crow-Flix).

## Project identity

Crow-Flix-Website is an original, independent project created and owned by
Crow. It is maintained separately from Crow's other projects; shared Crow-owned
branding does not make this website a clone, fork, continuation, or derivative
of another product.

References to third-party services document their technical roles and terms.
They do not assign ownership or authorship of Crow-Flix-Website to those
services or their maintainers.

The desktop application and this website are separate projects:

- `CrowLoki/Crow-Flix` contains the Tauri desktop source and release assets.
- `CrowLoki/Crow-Flix-Website` contains this static website only.

## Local verification

```console
npm ci
npm run check
```

The checker verifies required files, internal links, release metadata, security
headers, Cloudflare limits, and common credential or workstation-path leaks.

## Cloudflare Pages

This repository is connected directly to Cloudflare Pages through its GitHub
integration. The production site is
[crow-flix.pages.dev](https://crow-flix.pages.dev/).

- Cloudflare project: `crow-flix`
- Production branch: `main`
- Framework preset: None
- Root directory: `/`
- Build command: `npm run check`
- Build output directory: `public`

Only the allowlisted `public` directory is deployed. Repository documentation,
checks, workflows, and licensing material do not become website routes.

## Release updates

When CrowFlix publishes a new desktop release, update the version, installer
URL, installer size, checksum, release tag, and source tag in
`public/index.html`, then run `npm run check` before publishing.

## Licensing

Website code and documentation are licensed under `AGPL-3.0-only`. Crow brand
assets use the separate `LicenseRef-Crow-Brand` terms. See
[`LICENSING.md`](LICENSING.md).
