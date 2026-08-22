# Crow-Flix website licensing

Copyright (C) 2026 Crow.

This repository uses a split licensing model.

## Website code and documentation

Unless a file says otherwise, React and TypeScript source, HTML, CSS, relay
source, validation scripts, configuration, workflows, and original
documentation are licensed under the GNU Affero General Public License,
version 3 only (`AGPL-3.0-only`). The complete licence is in
[`LICENSE`](LICENSE), with a second standard-location copy in
[`LICENSES/AGPL-3.0-only.txt`](LICENSES/AGPL-3.0-only.txt).

Crow is the creator and copyright holder of the Crow-Flix-Website-authored code
and original project documentation. Third-party service and component notices
identify their respective terms; they do not attribute authorship of this
website to those projects or their maintainers.

## Crow brand assets

The following are not licensed under the AGPL:

- `public/assets/brand/**`

They are official CrowFlix identity assets and are licensed only under
[`LicenseRef-Crow-Brand`](LICENSES/LicenseRef-Crow-Brand.txt). The licence
allows them to accompany the authentic, unmodified CrowFlix project and its
official website. It does not grant permission to brand a fork, unrelated
product, service, merchandise, impersonation, or endorsement.

See [`BRAND-ASSETS.md`](BRAND-ASSETS.md) and
[`ASSET-MANIFEST.sha256`](ASSET-MANIFEST.sha256) for the included inventory.

## Recovered browser lineage

The browser frontend and relay were recovered from the last verified
`crow-flix-web` source commit in the separate `CrowLoki/Crow-Flix` repository.
They now live in this repository as the independent website source. The Tauri
wrapper, Rust backend, Windows installer, and desktop release tooling remain
outside this repository.

Third-party components used by the browser application retain their own terms.
See `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES.txt`.

## External services

GitHub and Cloudflare retain their own names, marks, services, and terms. Links
to those services do not incorporate their software or content into this
repository.
