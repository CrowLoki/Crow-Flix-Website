# Crow-Flix Website project guidance

## Project boundary

- This folder is the independent static website source for Crow-Flix.
- The canonical local checkout is
  `C:\Users\djdar\Documents\Crow-Flix-Website`. Keep it as a clean `main`
  checkout and perform changes in a separate worktree created from
  `origin/main`.
- The canonical GitHub repository is `CrowLoki/Crow-Flix-Website`.
- The Crow-Flix desktop application has its own repository at
  `CrowLoki/Crow-Flix`; do not copy desktop source, build output, or runtime data
  into this website repository.
- Treat the installed desktop application and its app data as separate runtime
  state. Do not reinstall, replace, or modify them from this project.

## Stack and commands

- Stack: static HTML and CSS with a Node.js validation script.
- Install the locked toolchain state with `npm ci`.
- Run all repository checks with `npm run check`.
- Cloudflare Pages project: `crow-flix`.
- Production branch: `main`; deployable output is limited to `public/`.
- Canonical public origin: `https://crowflix.tv/`.
- `https://www.crowflix.tv/` must permanently redirect to the canonical origin
  while preserving the path and query string.
- `https://crow-flix.pages.dev/` is the underlying Cloudflare Pages hostname,
  not the public canonical identity.

## Deployment path

- Production deploys through the existing Cloudflare Pages GitHub integration:
  `CrowLoki/Crow-Flix-Website` `main` -> `npm run check` -> `public/`.
- Preserve that Git-connected project. Do not replace it with Direct Upload,
  create another Pages project, or recreate the retired `crow-flix-web` project.
- Keep both `crowflix.tv` and `www.crowflix.tv` attached to the existing
  `crow-flix` Pages project and preserve the canonical `www` redirect.

## Repository rules

- Keep `package-lock.json` committed.
- Keep documentation, workflows, validation scripts, and licences outside
  `public/`; only public website assets belong in the deployable directory.
- Preserve the Crow brand licence and asset manifest when changing brand files.
- Keep desktop release links pinned to a verified official release and update
  all version, checksum, size, tag, and source references together.
- Before committing, run `npm run check` and report anything that could not be
  verified.
