# Crow-Flix Website project guidance

## Project boundary

- This folder is the independent static website source for Crow-Flix.
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

## Repository rules

- Keep `package-lock.json` committed.
- Keep documentation, workflows, validation scripts, and licences outside
  `public/`; only public website assets belong in the deployable directory.
- Preserve the Crow brand licence and asset manifest when changing brand files.
- Keep desktop release links pinned to a verified official release and update
  all version, checksum, size, tag, and source references together.
- Before committing, run `npm run check` and report anything that could not be
  verified.
