import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { build } from "vite";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "public", "catalog");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "crowflix-catalog-"));
const requiredNames = [
  "channels", "feeds", "logos", "streams", "categories", "languages",
  "countries", "regions", "subdivisions", "cities", "timezones", "blocklist",
];
const MAX_UPSTREAM_BYTES = 64 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const requests = [];
let upstreamRequests = 0;

async function fetchBytes(url, maximumBytes, timeoutMs = 90_000, signal) {
  upstreamRequests += 1;
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > maximumBytes) throw new Error(`Oversized input from ${new URL(url).hostname}`);
  if (!response.body) throw new Error(`Empty response from ${new URL(url).hostname}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximumBytes) {
      throw new Error(`Oversized input from ${new URL(url).hostname}`);
    }
    chunks.push(chunk);
  }
  requests.push({ url, bytes: size });
  return Buffer.concat(chunks, size);
}

async function previousOptionalInputs() {
  let bytes;
  try {
    bytes = await readFile(path.join(outputRoot, "optional-inputs.json.gz"));
  } catch {
    try {
      bytes = await fetchBytes(
        "https://crowflix.tv/catalog/optional-inputs.json.gz",
        25 * 1024 * 1024,
        15_000,
      );
    } catch { return {}; }
  }
  try {
    const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_UPSTREAM_BYTES }).toString("utf8"));
    return value.version === 1 && value.textByUrl && typeof value.textByUrl === "object"
      ? value.textByUrl : {};
  } catch { return {}; }
}

try {
  // Bundle only the pure preparation entry, without copying public assets.
  await build({
    root: repositoryRoot,
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      ssr: path.join(repositoryRoot, "src", "catalogPreparation.ts"),
      outDir: temporaryRoot,
      emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: "prepare-catalog.mjs" } },
    },
  });
  const pipeline = await import(pathToFileURL(path.join(temporaryRoot, "prepare-catalog.mjs")).href);
  const regionConfigs = new Map(pipeline.PREPARED_CATALOG_REGIONS.map((region) => {
    const configs = pipeline.additivePlaylistConfigs(`Australia/${region}`);
    configs[0].timezones = pipeline.preparedCatalogTimezones(region);
    return [region, configs];
  }));
  const uniqueAdditiveConfigs = new Map([...regionConfigs.values()].flat().map((config) => [config.url, config]));
  const optionalUrls = [...new Set([
    ...pipeline.OPTIONAL_FAST_PLAYLISTS,
    ...uniqueAdditiveConfigs.keys(),
  ])];

  const [requiredResults, optionalResults, streamHealth] = await Promise.all([
    Promise.all(requiredNames.map(async (name) => {
      const bytes = await fetchBytes(`https://iptv-org.github.io/api/${name}.json`, MAX_UPSTREAM_BYTES)
        .catch((error) => { throw new Error(`Required IPTV-org ${name} could not be prepared: ${error.message}`); });
      const value = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(value)) throw new Error(`IPTV-org ${name} is not an array`);
      if ((name === "streams" || name === "channels") && value.length < 1_000) {
        throw new Error(`IPTV-org ${name} is unexpectedly incomplete; retaining the previous deployment`);
      }
      return [name, value];
    })),
    Promise.allSettled(optionalUrls.map(async (url) => {
      const bytes = await fetchBytes(url, MAX_PLAYLIST_BYTES, 45_000);
      const text = bytes.toString("utf8");
      if (!/^\s*(?:\uFEFF)?#EXTM3U\b/i.test(text)) throw new Error("Invalid optional playlist");
      const parsed = uniqueAdditiveConfigs.has(url)
        ? pipeline.parseAdditivePlaylist(text, uniqueAdditiveConfigs.get(url))
        : pipeline.parseOptionalFastPlaylist(text);
      if (!parsed.length) throw new Error("Empty optional playlist");
      return text;
    })),
    pipeline.loadStreamHealthIndex(async (url, init) => new Response(await fetchBytes(
      String(url), String(url).endsWith(".gz") ? 2 * 1024 * 1024 : 64 * 1024,
      12_000, init?.signal,
    ))).catch(() => null),
  ]);
  const api = Object.fromEntries(requiredResults);
  const previous = optionalResults.some((result) => result.status === "rejected")
    ? await previousOptionalInputs() : {};
  const textByUrl = {};
  let retainedOptionalSources = 0;
  for (let index = 0; index < optionalUrls.length; index += 1) {
    const url = optionalUrls[index];
    const result = optionalResults[index];
    if (result.status === "fulfilled") textByUrl[url] = result.value;
    else if (typeof previous[url] === "string" && Buffer.byteLength(previous[url]) <= MAX_PLAYLIST_BYTES) {
      textByUrl[url] = previous[url];
      retainedOptionalSources += 1;
      console.log(`Retained the last published optional playlist: ${url}`);
    } else {
      console.warn(`Optional playlist unavailable; base catalogue remains complete: ${url}`);
    }
  }
  const fastSources = pipeline.OPTIONAL_FAST_PLAYLISTS.flatMap((url) =>
    textByUrl[url] ? pipeline.parseOptionalFastPlaylist(textByUrl[url]) : [],
  );
  const now = new Date();
  const baseCatalog = pipeline.buildCatalogFromApi(api, now);
  const sourceIdentity = (channel, source) => JSON.stringify([
    channel.key, source.url, source.referrer || "", source.userAgent || "",
  ]);
  const baseSources = new Set(baseCatalog.channels.flatMap((channel) =>
    channel.sources.map((source) => sourceIdentity(channel, source)),
  ));
  const assets = [];
  const summary = [];
  for (const region of pipeline.PREPARED_CATALOG_REGIONS) {
    const additiveEntries = regionConfigs.get(region).flatMap((config) =>
      textByUrl[config.url] ? pipeline.parseAdditivePlaylist(textByUrl[config.url], config) : [],
    );
    const catalog = pipeline.buildCatalogFromApi(api, now, fastSources, additiveEntries);
    const preparedSources = new Set(catalog.channels.flatMap((channel) =>
      channel.sources.map((source) => sourceIdentity(channel, source)),
    ));
    if ([...baseSources].some((identity) => !preparedSources.has(identity))) {
      throw new Error(`Prepared ${region} catalogue lost an IPTV-org stream; retaining the previous deployment`);
    }
    if (streamHealth && pipeline.applyStreamHealthHints(catalog.channels, streamHealth.hints) > 0) {
      catalog.source += " + recent source health";
    }
    catalog.source += " · prepared daily";
    const snapshot = { version: pipeline.PREPARED_CATALOG_VERSION, region, catalog };
    if (!pipeline.readPreparedCatalogSnapshot(snapshot, region)) {
      throw new Error(`Prepared ${region} catalogue failed validation`);
    }
    const raw = Buffer.from(JSON.stringify(snapshot));
    const gzip = gzipSync(raw, { level: 9 });
    if (raw.length > pipeline.MAX_PREPARED_CATALOG_BYTES || gzip.length > pipeline.MAX_PREPARED_CATALOG_GZIP_BYTES) {
      throw new Error(`Prepared ${region} catalogue exceeds the static-asset size limit`);
    }
    assets.push([`${region}.json.gz`, gzip]);
    summary.push({
      region, channels: catalog.channels.length,
      sources: catalog.channels.reduce((total, channel) => total + channel.sources.length, 0),
      jsonBytes: raw.length, gzipBytes: gzip.length,
    });
  }
  const optionalInputBytes = gzipSync(Buffer.from(JSON.stringify({ version: 1, updatedAt: now.toISOString(), textByUrl })), { level: 9 });
  if (optionalInputBytes.length > pipeline.MAX_PREPARED_CATALOG_GZIP_BYTES) {
    throw new Error("Optional source recovery asset exceeds the static-asset size limit");
  }
  assets.push(["optional-inputs.json.gz", optionalInputBytes]);
  // Write only after all inputs, regions and size limits pass. A failed build
  // never publishes a partial catalogue over the working Pages deployment.
  await mkdir(outputRoot, { recursive: true });
  await Promise.all(assets.map(([filename, bytes]) => writeFile(path.join(outputRoot, filename), bytes)));
  console.log(JSON.stringify({
    preparedAt: now.toISOString(), upstreamRequests,
    upstreamBytes: requests.reduce((total, request) => total + request.bytes, 0),
    retainedOptionalSources, baseChannels: baseCatalog.channels.length,
    baseSources: baseSources.size, snapshots: summary,
  }, null, 2));
} finally {
  // This path was allocated above exclusively for the build's bundled entry.
  await rm(temporaryRoot, { recursive: true, force: true });
}
