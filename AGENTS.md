# Crow-Flix Website project guidance

## Product boundary

- This repository is the independent browser-streaming Crow-Flix website.
- A visitor opens `https://crowflix.tv/`, browses the live catalogue, selects a
  channel, and watches in the browser. Do not replace the player with a desktop
  download or information page.
- The browser source was recovered from the last verified `crow-flix-web`
  production deployment, which used `CrowLoki/Crow-Flix` commit
  `681139b6afc9189fec53a2e45b31a2bc08c2e4a3`.
- The separate Tauri desktop application remains in `CrowLoki/Crow-Flix`. Do not
  modify its source, releases, installed files, or application data from this
  repository.
- The shared visual identity and recovered frontend lineage do not merge the
  website and desktop repositories into one project.

## Stack and commands

- Stack: React, TypeScript, Vite, HLS.js, DASH.js, and a separately deployed
  Cloudflare relay Worker.
- Install the locked dependencies with `npm ci`.
- Run all website checks and generate the deployable build with `npm run check`.
- Run the development site with `npm run dev`.
- Run the built site locally with `npm run preview`.
- Cloudflare Pages project: `crow-flix`.
- Production branch: `main`.
- Build command: `npm run check`.
- Build output directory: `dist`.
- Canonical public origin: `https://crowflix.tv/`.
- `https://www.crowflix.tv/` permanently redirects to the canonical origin.

## Deployment path

- Production deploys through the existing Cloudflare Pages GitHub integration:
  `CrowLoki/Crow-Flix-Website` `main` -> `npm run check` -> `dist/`.
- Preserve the existing `crow-flix` Pages project, custom domains, proxied DNS,
  TLS, and Git connection. Do not create another Pages project or use Direct
  Upload as a replacement.
- The browser app uses the existing `crowflix-relay` Worker for live programme
  guides and sources that require provider headers. The relay does not bypass
  geographic, account, or provider restrictions.

## Repository rules

- Keep `package-lock.json` committed.
- Keep `dist/`, `node_modules/`, logs, caches, and generated output untracked.
- Preserve Crow ownership, the Crow brand licence, the asset manifest, privacy
  disclosures, and third-party notices.
- Keep canonical, Open Graph, robots, sitemap, and security metadata aligned
  with `https://crowflix.tv/`.
- Before committing, run `npm ci`, `npm run check`, `npm audit
  --audit-level=moderate`, and `git diff --check`.
