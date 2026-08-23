# Security policy

## Website reports

Report a suspected website vulnerability privately through the
[Crow-Flix-Website security-advisory form](https://github.com/CrowLoki/Crow-Flix-Website/security/advisories/new).
Do not place exploit details, credentials, private URLs, personal data, stream
tokens, playlist credentials, or account information in a public issue.

Include the affected URL, browser, observed security impact, and minimal
reproduction steps. For vulnerabilities that exist only in the separate Tauri
desktop application, use the
[Crow-Flix desktop security policy](https://github.com/CrowLoki/Crow-Flix/security/policy).

The website and relay do not bypass provider geographic, subscription, token,
or account restrictions. A provider outage, moved stream, unavailable guide,
or regional restriction is not by itself a Crow-Flix security vulnerability.

Optional whole-catalogue stream-health data is treated as untrusted. CrowFlix
accepts it only when its manifest and individual checks are fresh, its bounded
compressed and decompressed payloads validate, and each record matches an
existing IPTV-org URL, Referer, and User-Agent exactly. Health data can change
ordering or hide a recently failed source; it cannot introduce a new playback
URL, override a successful local preflight, or bypass a provider restriction.
Remote health for a literal-IP stream is not treated as strong browser
reachability evidence because the website cannot load HTTP media directly and
the provider can independently reject Cloudflare relay traffic.

Live guide retrieval is protected by Cloudflare Turnstile with server-side
Siteverify validation. Report any apparent token replay, hostname/action
validation bypass, leaked widget secret, or way to invoke protected guide work
without successful verification through the private advisory form.
