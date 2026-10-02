import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

// Release budgets, not provider/Cloudflare billing limits. A larger catalogue
// needs an explicit budget review, never silently dropping channels to fit.
export const RESOURCE_BUDGETS = Object.freeze({
  initialJavaScriptBytes: 500 * 1024,
  initialJavaScriptGzipBytes: 180 * 1024,
  catalogueGzipBytes: 4 * 1024 * 1024,
  catalogueDecodedBytes: 48 * 1024 * 1024,
});
const REGIONS = ["Adelaide", "Brisbane", "Canberra", "Darwin", "Hobart", "Melbourne", "Perth", "Sydney"];

export function checkResourceSize(kind, bytes) {
  assert(Object.hasOwn(RESOURCE_BUDGETS, kind), `Unknown resource budget: ${kind}`);
  assert(Number.isSafeInteger(bytes) && bytes >= 0, `Invalid resource size: ${kind}`);
  assert(bytes <= RESOURCE_BUDGETS[kind], `${kind} exceeds release budget: ${bytes} > ${RESOURCE_BUDGETS[kind]} bytes. Review the growth; do not trim the catalogue.`);
}

export async function measureResourceBudgets(distRoot, mainScript) {
  assert(/^\/assets\/[^/\\]+\.js$/.test(mainScript), "Expected the production entry module");
  const javascript = await readFile(path.join(distRoot, mainScript.slice(1)));
  const javascriptGzip = gzipSync(javascript).byteLength;
  checkResourceSize("initialJavaScriptBytes", javascript.byteLength);
  checkResourceSize("initialJavaScriptGzipBytes", javascriptGzip);
  const catalogues = [];
  for (const region of REGIONS) {
    const compressed = await readFile(path.join(distRoot, "catalog", `${region}.json.gz`));
    checkResourceSize("catalogueGzipBytes", compressed.byteLength);
    const decoded = gunzipSync(compressed, { maxOutputLength: RESOURCE_BUDGETS.catalogueDecodedBytes });
    checkResourceSize("catalogueDecodedBytes", decoded.byteLength);
    const snapshot = JSON.parse(decoded.toString("utf8"));
    assert.equal(snapshot.region, region, "Regional snapshot identity must match its file");
    assert(snapshot.catalog?.channels?.length > 0, "Budget checks must never accept an empty catalogue");
    catalogues.push({ region, gzipBytes: compressed.byteLength, decodedBytes: decoded.byteLength,
      channels: snapshot.catalog.channels.length,
      sources: snapshot.catalog.channels.reduce((total, channel) => total + channel.sources.length, 0) });
  }
  return { initialJavaScriptBytes: javascript.byteLength, initialJavaScriptGzipBytes: javascriptGzip, catalogues };
}
