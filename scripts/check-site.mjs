import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(repositoryRoot, "public");
const canonicalOrigin = "https://crowflix.tv";

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

function publicPathToFile(reference) {
  const clean = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
  if (clean === "/" || clean === "") return path.join(publicRoot, "index.html");
  const candidate = path.resolve(publicRoot, clean.replace(/^\/+/, ""));
  assert(
    candidate === publicRoot || candidate.startsWith(`${publicRoot}${path.sep}`),
    `Local reference escapes public/: ${reference}`,
  );
  return clean.endsWith("/") ? path.join(candidate, "index.html") : candidate;
}

const required = [
  "public/index.html",
  "public/404.html",
  "public/styles.css",
  "public/favicon.png",
  "public/_headers",
  "public/_redirects",
  "public/robots.txt",
  "public/sitemap.xml",
  "public/.well-known/security.txt",
  "public/images/crowflix-mascot.png",
  "public/images/crowflix-app-preview.png",
];

for (const file of required) {
  const details = await stat(path.join(repositoryRoot, file));
  assert(details.isFile(), `Required deployable file is missing: ${file}`);
}

const files = await walk(publicRoot);
assert(files.length <= 20_000, `Cloudflare Pages file limit exceeded: ${files.length}`);
for (const file of files) {
  const details = await stat(file);
  assert(details.size <= 25 * 1024 * 1024, `Cloudflare Pages file-size limit exceeded: ${relative(file)}`);
  assert(!/\.(?:env|key|log|map|p12|pem|pfx)$/i.test(file), `Forbidden deployable file: ${relative(file)}`);
}

const indexPath = path.join(publicRoot, "index.html");
const index = await readFile(indexPath, "utf8");
const requiredIndexText = [
  "CROW-FLIX 0.5.1",
  "CrowFlix_0.5.1_x64-setup.exe",
  "e685dcfef2b8a3489f91eed558174b96b0ddf7bd86c6937a557d4e00f9017812",
  "https://github.com/CrowLoki/Crow-Flix/releases/tag/v0.5.1",
  "https://github.com/CrowLoki/Crow-Flix/tree/v0.5.1",
  "https://github.com/CrowLoki/Crow-Flix-Website",
  `<meta property="og:url" content="${canonicalOrigin}/"/>`,
  `<meta property="og:image" content="${canonicalOrigin}/images/crowflix-app-preview.png"/>`,
  `<meta name="twitter:image" content="${canonicalOrigin}/images/crowflix-app-preview.png"/>`,
  `<link rel="canonical" href="${canonicalOrigin}/"/>`,
];
for (const value of requiredIndexText) assert(index.includes(value), `index.html is missing: ${value}`);
assert(!index.includes("crow-flix.pages.dev"), "index.html uses the infrastructure hostname as public identity");
assert(!index.includes("/crowflix.html"), "index.html still links to the retired nested CrowFlix route");
assert(!/<script\b/i.test(index), "index.html contains script despite a script-src 'none' policy");

const robots = await readFile(path.join(publicRoot, "robots.txt"), "utf8");
assert(robots.includes(`Sitemap: ${canonicalOrigin}/sitemap.xml`), "robots.txt has the wrong sitemap origin");

const sitemap = await readFile(path.join(publicRoot, "sitemap.xml"), "utf8");
assert(sitemap.includes(`<loc>${canonicalOrigin}/</loc>`), "sitemap.xml has the wrong canonical origin");

const securityText = await readFile(path.join(publicRoot, ".well-known", "security.txt"), "utf8");
assert(
  securityText.includes(`Canonical: ${canonicalOrigin}/.well-known/security.txt`),
  "security.txt has the wrong canonical URL",
);

const textFiles = files.filter((file) => /\.(?:css|html|svg|txt|xml)$|[\\/](?:_headers|_redirects)$/i.test(file));
const forbiddenPatterns = [
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

for (const htmlFile of files.filter((file) => file.endsWith(".html"))) {
  const html = await readFile(htmlFile, "utf8");
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const reference = match[1];
    if (reference.startsWith("#")) {
      assert(html.includes(`id="${reference.slice(1)}"`), `${relative(htmlFile)} has a missing anchor: ${reference}`);
      continue;
    }
    if (/^https:\/\//.test(reference)) continue;
    assert(!/^[a-z]+:/i.test(reference), `${relative(htmlFile)} has a non-HTTPS external reference: ${reference}`);
    const target = publicPathToFile(reference);
    const details = await stat(target).catch(() => null);
    assert(details?.isFile(), `${relative(htmlFile)} has a missing local reference: ${reference}`);
  }
}

const css = await readFile(path.join(publicRoot, "styles.css"), "utf8");
for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
  const reference = match[1];
  if (/^data:/.test(reference)) continue;
  const target = publicPathToFile(reference);
  const details = await stat(target).catch(() => null);
  assert(details?.isFile(), `styles.css has a missing local reference: ${reference}`);
}

const headers = await readFile(path.join(publicRoot, "_headers"), "utf8");
for (const name of [
  "Content-Security-Policy",
  "Permissions-Policy",
  "Referrer-Policy",
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "X-Frame-Options",
]) {
  assert(headers.includes(`${name}:`), `_headers is missing ${name}`);
}
assert(headers.includes("script-src 'none'"), "_headers does not prohibit scripts");
assert(!headers.includes("unsafe-eval"), "_headers enables unsafe-eval");

const headerBlocks = headers
  .split(/\r?\n\s*\r?\n/)
  .map((block) => block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  .filter((lines) => lines.length > 0)
  .map(([pattern, ...lines]) => ({
    pattern,
    names: lines.map((line) => line.replace(/^!\s+/, "").split(":", 1)[0].toLowerCase()),
  }));
const universalHeaders = new Set(headerBlocks.find((block) => block.pattern === "/*")?.names ?? []);
for (const block of headerBlocks) {
  const seen = new Set();
  for (const name of block.names) {
    assert(!seen.has(name), `_headers repeats ${name} within ${block.pattern}`);
    seen.add(name);
    if (block.pattern !== "/*") {
      assert(!universalHeaders.has(name), `_headers repeats inherited ${name} in ${block.pattern}`);
    }
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
console.log(`Crow-Flix-Website verification passed: ${files.length} deployable files, ${totalBytes} bytes.`);
