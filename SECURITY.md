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
ordering or rank a recently failed source lower; it cannot introduce a new
playback URL, override a successful local preflight, hide a source or channel,
or bypass a provider restriction.
Remote health for a literal-IP stream is not treated as strong browser
reachability evidence because the website cannot load HTTP media directly and
the provider can independently reject Cloudflare relay traffic.

Live guide retrieval is protected by Cloudflare Turnstile with server-side
Siteverify validation. Report any apparent token replay, hostname/action
validation bypass, leaked widget secret, or way to invoke protected guide work
without successful verification through the private advisory form.

Australian regional guide URLs and channel aliases are selected only from a
fixed timezone table; the browser timezone cannot become an arbitrary upstream
URL. Regional and broad fallback XMLTV bodies are decompressed and parsed as
bounded streams, retaining only requested-channel programmes.

Additive playlist URLs are selected from a fixed configuration, fetched through
the SSRF-guarded relay, capped before parsing, and accepted only as HTTP(S)
media entries. Exact URL/header identities are deduplicated and every retained
source records its public playlist provenance.

Optional personal M3U and XMLTV files are size-bounded and parsed locally.
Personal URL imports use the same SSRF-guarded, redirect-validating relay and a
bounded browser reader. Only normal HTTP(S) media entries are accepted;
embedded username/password URLs and non-web protocols are rejected. Personal
imports are additive and cannot replace or suppress the built-in catalogue.
