import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(repositoryRoot, "dist");
const canonicalOrigin = "https://crowflix.tv";
const relayOrigin = "https://crowflix-relay.djdarren2056.workers.dev";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(fullPath)));
    else if (entry.isFile()) files.push(fullPath);
    else throw new Error(`Unsupported deployable filesystem entry: ${fullPath}`);
  }
  return files;
}

function relative(filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

for (const file of [
  "index.html",
  "src/main.tsx",
  "src/App.tsx",
  "src/App.css",
  "src/webCatalog.ts",
  "src/additivePlaylists.ts",
  "src/catalogMetadata.ts",
  "src/guideNavigation.ts",
  "src/personalSources.ts",
  "src/streamHealthIndex.ts",
  "src/relayClient.ts",
  "src/TurnstileGuideGate.tsx",
  "src/playback/usePlaybackController.ts",
  "scripts/headless-acceptance.mjs",
  "src/playback/preflightWindow.ts",
  "relay/src/index.ts",
  "relay/src/turnstile.ts",
  "RECOVERY-PROVENANCE.json",
  "docs/IPTV-ECOSYSTEM.md",
  "dist/index.html",
  "dist/_headers",
  "dist/_redirects",
  "dist/robots.txt",
  "dist/sitemap.xml",
  "dist/.well-known/security.txt",
  "dist/assets/brand/crow-head.png",
  "dist/assets/brand/crow-mascot.png",
]) {
  const details = await stat(path.join(repositoryRoot, file)).catch(() => null);
  assert(details?.isFile(), `Required website file is missing: ${file}`);
}

const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
assert(packageJson.name === "crow-flix-website", "package.json has the wrong package name");
assert(packageJson.homepage === `${canonicalOrigin}/`, "package.json has the wrong homepage");
assert(
  packageJson.repository?.url === "https://github.com/CrowLoki/Crow-Flix-Website.git",
  "package.json has the wrong repository",
);
assert(packageJson.scripts?.["acceptance:headless"] === "node scripts/headless-acceptance.mjs", "The headless browser acceptance command is missing");

const provenance = JSON.parse(await readFile(path.join(repositoryRoot, "RECOVERY-PROVENANCE.json"), "utf8"));
assert(
  provenance.recovered_from?.source_commit === "681139b6afc9189fec53a2e45b31a2bc08c2e4a3",
  "Recovery provenance has the wrong source commit",
);
assert(
  provenance.recovered_from?.cloudflare_deployment_id === "48e4fc15-8acd-4747-b620-c648c7f1d48b",
  "Recovery provenance has the wrong deployment ID",
);

const sourceIndex = await readFile(path.join(repositoryRoot, "index.html"), "utf8");
for (const value of [
  `<link rel="canonical" href="${canonicalOrigin}/"`,
  `<meta property="og:url" content="${canonicalOrigin}/"`,
  `<meta property="og:image" content="${canonicalOrigin}/assets/brand/crow-mascot.png"`,
  `<meta name="twitter:image" content="${canonicalOrigin}/assets/brand/crow-mascot.png"`,
  `<script type="module" src="/src/main.tsx"></script>`,
]) {
  assert(sourceIndex.includes(value), `index.html is missing: ${value}`);
}

const app = await readFile(path.join(repositoryRoot, "src", "App.tsx"), "utf8");
for (const value of ["Watch live", "loadWebCatalog", "toWebPlayableSources", "preflightSource", "availabilitySummary.ready", "<video", "Next route", "Playback sources", "playback.selectSource", 'import("./personalSources")', "relayFetchText", "guidePageCount", "channels total", "Source providers", "Channel details", "Broadcast areas", "Provider headers", "external streaming protocol", "Channel website", "Working first", "A–Z", "complete matching catalogue stays visible"]) {
  assert(app.includes(value), `The browser player source is missing: ${value}`);
}

const sourcePreflight = await readFile(path.join(repositoryRoot, "src", "playback", "preflight.ts"), "utf8");
for (const value of ["browserPreflightRoutes", "runPreflightQueue", "verifyHlsMedia", "verifyDashMedia"]) {
  assert(sourcePreflight.includes(value), `Source readiness routing is missing: ${value}`);
}

const preflightWindow = await readFile(path.join(repositoryRoot, "src", "playback", "preflightWindow.ts"), "utf8");
for (const value of ["LIVE_PAGE_PREFLIGHT_CHANNEL_LIMIT", "LIVE_CARD_PREFLIGHT_ROUTE_LIMIT", "boundedPreflightKeys", "preflightRouteLimit"]) {
  assert(preflightWindow.includes(value), `Visible-page readiness routing is missing: ${value}`);
}

const playbackController = await readFile(path.join(repositoryRoot, "src", "playback", "usePlaybackController.ts"), "utf8");
for (const value of ['import("hls.js")', 'import("dashjs")', "reorderRemainingSources", "orderSourcesByPreflight", "sourceOptions", "selectSource", "Trying the next playback route"]) {
  assert(playbackController.includes(value), `Dynamic playback failover is missing: ${value}`);
}
assert(!/^import Hls from "hls\.js";/m.test(playbackController), "HLS.js is still bundled into initial page startup");
assert(!app.includes("Download Crow-Flix for Windows"), "The browser app was replaced by a desktop download page");
assert(!app.includes("showAllCatalogued"), "Live TV still defaults to hiding catalogue entries");
assert(!app.includes("limited/offline hidden"), "Live TV still reports silently hidden channels");
assert(!app.includes(".slice(0, 140)"), "The programme guide still hides channels behind a fixed row cap");
assert(app.includes("https://github.com/CrowLoki/Crow-Flix-Website/blob/main/PRIVACY.md"), "The About page does not link to the website privacy notice");
assert(app.includes("https://github.com/CrowLoki/Crow-Flix-Website/blob/main/SECURITY.md"), "The About page does not link to the website security policy");
assert(!app.includes("A cinematic desktop IPTV player"), "The About page still identifies the website as the desktop app");

const relayClient = await readFile(path.join(repositoryRoot, "src", "relayClient.ts"), "utf8");
assert(relayClient.includes(relayOrigin), "The browser app is not wired to the CrowFlix relay");
assert(relayClient.includes("X-Turnstile-Token"), "Guide requests do not send the Turnstile token in a header");
for (const value of ["toWebPlayableSources", "https-upgrade", "routeDashRequestUrl", 'delivery: "relay"', 'method: "POST"', "timeZone", "channels"]) {
  assert(relayClient.includes(value), `Browser playback routing is missing: ${value}`);
}

const relayIndex = await readFile(path.join(repositoryRoot, "relay", "src", "index.ts"), "utf8");
for (const value of ["fetchValidatedWithUrl", 'upstreamHeaders.set("Range"', '"content-range"', "STREAM_FIRST_BYTE_TIMEOUT_MS"]) {
  assert(relayIndex.includes(value), `Relay playback transport is missing: ${value}`);
}

const relayEpg = await readFile(path.join(repositoryRoot, "relay", "src", "epg.ts"), "utf8");
for (const value of ["streamGuidesJson", "32 * 1024 * 1024", "australianGuideSource", "epgSharePrimaryTag", "Australia/Brisbane", "96 * 1024 * 1024", "MAX_COMBINED_PROGRAMMES", "remainingIds", "sourceLabels", "i.mjh.nz/au/"]) {
  assert(relayEpg.includes(value), `Relay guide integration is missing: ${value}`);
}

const webCatalog = await readFile(path.join(repositoryRoot, "src", "webCatalog.ts"), "utf8");
for (const value of ["OPTIONAL_FAST_PLAYLISTS", "VERIFIED_PUBLIC_FALLBACKS", "AdvocateBroadcastingNetwork.ng", "viewmedia7219.bozztv.com", "overlayAmagiFastFallbacks", "overlayVerifiedPublicFallbacks", "loadStreamHealthIndex", "applyStreamHealthHints", "loadAdditivePlaylists", "overlayAdditivePlaylists", "normalizeStreamUrl", "EXTERNAL_PLAYER_PROTOCOLS", "provenances", "Known-dead deployment", "CrowFlix verified Amagi replacement", "Referer is a request-header value", "regional/provider playlists", "verified public fallbacks", "recent source health", "current FAST fallbacks", "crowflix-catalog-v7", "ownerCounts", "networkCounts", "feedCounts", "providerCounts", 'fetchJson<ApiSubdivision[]>("subdivisions")', 'fetchJson<ApiCity[]>("cities")', 'fetchJson<ApiTimezone[]>("timezones")']) {
  assert(webCatalog.includes(value), `Catalogue fallback repair is missing: ${value}`);
}

const additivePlaylists = await readFile(path.join(repositoryRoot, "src", "additivePlaylists.ts"), "utf8");
for (const value of ["raw-tv.m3u8", "MAX_ADDITIVE_PLAYLIST_BYTES", "MAX_ADDITIVE_PLAYLIST_ENTRIES", "Australia/Brisbane", "mjh-nz", "mjh-world"]) {
  assert(additivePlaylists.includes(value), `Additive playlist integration is missing: ${value}`);
}

const personalSources = await readFile(path.join(repositoryRoot, "src", "personalSources.ts"), "utf8");
for (const value of ["parsePersonalPlaylist", "mergePersonalPlaylistIntoCatalog", "parsePersonalXmltv", "parsePersonalXmltvFile", "MAX_PERSONAL_PLAYLIST_ENTRIES", "Personal M3U", "Personal XMLTV"]) {
  assert(personalSources.includes(value), `Personal browser source support is missing: ${value}`);
}

const catalogMetadata = await readFile(path.join(repositoryRoot, "src", "catalogMetadata.ts"), "utf8");
for (const value of ["channelProviders", "sourceProvenances", "channelMatchesMetadataFilters", "sourceHostname", "sourceProtocol", "MAIN_FEED_OPTION_ID"]) {
  assert(catalogMetadata.includes(value), `Catalogue metadata navigation is missing: ${value}`);
}

const streamHealth = await readFile(path.join(repositoryRoot, "src", "streamHealthIndex.ts"), "utf8");
for (const value of ["streams.json.gz", "DecompressionStream", "MAX_COMPRESSED_BYTES", "MAX_DECOMPRESSED_BYTES", "streamHealthIdentity", "catalogHealthSupportsBrowserRanking", "sourceUsesLiteralIp", "STREAM_HEALTH_TTL_MS"]) {
  assert(streamHealth.includes(value), `Whole-catalogue health safety is missing: ${value}`);
}

const turnstileGate = await readFile(path.join(repositoryRoot, "src", "TurnstileGuideGate.tsx"), "utf8");
for (const value of ["https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", "epg_load", "VITE_TURNSTILE_SITEKEY"]) {
  assert(turnstileGate.includes(value), `Turnstile guide gate is missing: ${value}`);
}

const relayTurnstile = await readFile(path.join(repositoryRoot, "relay", "src", "turnstile.ts"), "utf8");
for (const value of ["https://challenges.cloudflare.com/turnstile/v0/siteverify", "TURNSTILE_SECRET", "TURNSTILE_ALLOWED_HOSTNAMES", "TURNSTILE_EXPECTED_ACTION"]) {
  assert(relayTurnstile.includes(value), `Relay Turnstile validation is missing: ${value}`);
}
assert(!relayTurnstile.includes("VITE_TURNSTILE_SECRET"), "The Turnstile secret is exposed as a Vite variable");

const files = await walk(distRoot);
assert(files.length <= 20_000, `Cloudflare Pages file limit exceeded: ${files.length}`);
for (const file of files) {
  const details = await stat(file);
  assert(details.size <= 25 * 1024 * 1024, `Cloudflare Pages file-size limit exceeded: ${relative(file)}`);
  assert(!/\.(?:env|key|log|map|p12|pem|pfx)$/i.test(file), `Forbidden deployable file: ${relative(file)}`);
}

const builtIndex = await readFile(path.join(distRoot, "index.html"), "utf8");
assert(builtIndex.includes(`${canonicalOrigin}/`), "Built index has the wrong canonical origin");
assert(/<script[^>]+type="module"[^>]+src="\/assets\/[^"]+\.js"/.test(builtIndex), "Built index has no Vite module bundle");
assert(/<link[^>]+rel="stylesheet"[^>]+href="\/assets\/[^"]+\.css"/.test(builtIndex), "Built index has no Vite stylesheet bundle");
assert(!builtIndex.includes("crow-flix.pages.dev"), "Built index uses the infrastructure hostname as public identity");

const mainScript = builtIndex.match(/<script[^>]+type="module"[^>]+src="(\/assets\/[^"]+\.js)"/)?.[1];
assert(mainScript, "Built index does not identify its main module bundle");
const mainScriptDetails = await stat(path.join(distRoot, mainScript.replace(/^\//, "")));
assert(mainScriptDetails.size <= 500 * 1024, `Initial JavaScript exceeds 500 KiB: ${mainScriptDetails.size} bytes`);
assert(files.some((file) => /[\\/]hls-[^\\/]+\.js$/i.test(file)), "The production build has no lazy HLS.js chunk");

for (const match of builtIndex.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
  const target = path.join(distRoot, match[1].replace(/^\//, ""));
  const details = await stat(target).catch(() => null);
  assert(details?.isFile(), `Built index references a missing asset: ${match[1]}`);
}

const headers = await readFile(path.join(distRoot, "_headers"), "utf8");
for (const value of [
  "Content-Security-Policy:",
  "connect-src 'self' https:",
  "media-src 'self' blob: https:",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "Strict-Transport-Security:",
  "X-Content-Type-Options:",
  "X-Frame-Options:",
]) {
  assert(headers.includes(value), `_headers is missing: ${value}`);
}
assert(!headers.includes("script-src 'none'"), "_headers still disables the browser application");
assert(!headers.includes("unsafe-eval"), "_headers permits unsafe-eval");

const privacy = await readFile(path.join(repositoryRoot, "PRIVACY.md"), "utf8");
for (const value of ["Cloudflare Turnstile", "No Crow-Flix account or payment system", "IPTV Nexus", "personal playlist or XMLTV URL", "does not attach search text", "clear site data for `crowflix.tv`"]) {
  assert(privacy.includes(value), `PRIVACY.md is missing: ${value}`);
}

const ecosystem = await readFile(path.join(repositoryRoot, "docs", "IPTV-ECOSYSTEM.md"), "utf8");
for (const value of ["iptv-org/iptv", "iptv-org/api", "iptv-org/database", "iptv-org/epg", "iptv-org/awesome-iptv", "subdivisions", "cities", "timezones", "Live TV always contains the complete matching result set"]) {
  assert(ecosystem.includes(value), `IPTV ecosystem contract is missing: ${value}`);
}

const robots = await readFile(path.join(distRoot, "robots.txt"), "utf8");
const sitemap = await readFile(path.join(distRoot, "sitemap.xml"), "utf8");
const security = await readFile(path.join(distRoot, ".well-known", "security.txt"), "utf8");
assert(robots.includes(`Sitemap: ${canonicalOrigin}/sitemap.xml`), "robots.txt has the wrong sitemap URL");
assert(sitemap.includes(`<loc>${canonicalOrigin}/</loc>`), "sitemap.xml has the wrong canonical URL");
assert(security.includes(`Canonical: ${canonicalOrigin}/.well-known/security.txt`), "security.txt has the wrong canonical URL");

const textFiles = files.filter((file) => /\.(?:css|html|js|json|svg|txt|xml)$|[\\/](?:_headers|_redirects)$/i.test(file));
const forbiddenPatterns = [
  { name: "desktop installer call to action", regex: /Download Crow-Flix for Windows/i },
  { name: "Windows installer filename", regex: /CrowFlix_[0-9.]+_x64-setup\.exe/i },
  { name: "Windows user-profile path", regex: /[A-Za-z]:[\\/]+Users[\\/]+/i },
  { name: "GitHub access token", regex: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { name: "OpenAI API key", regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: "AWS access key", regex: /AKIA[0-9A-Z]{16}/ },
  { name: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];
for (const file of textFiles) {
  const content = await readFile(file, "utf8");
  for (const pattern of forbiddenPatterns) {
    assert(!pattern.regex.test(content), `${relative(file)} contains forbidden ${pattern.name}`);
  }
}

const manifest = await readFile(path.join(repositoryRoot, "ASSET-MANIFEST.sha256"), "utf8");
for (const line of manifest.trim().split(/\r?\n/)) {
  const match = line.match(/^([0-9a-f]{64})  (.+)$/);
  assert(match, `Malformed asset-manifest line: ${line}`);
  const [, expected, file] = match;
  const bytes = await readFile(path.join(repositoryRoot, file));
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert(actual === expected, `Asset hash mismatch: ${file}`);
}

const totalBytes = (await Promise.all(files.map(async (file) => (await stat(file)).size))).reduce((a, b) => a + b, 0);
console.log(`Crow-Flix browser verification passed: ${files.length} deployable files, ${totalBytes} bytes.`);
