import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import {
  FIXTURE_HOSTS, MAX_FIXTURE_BYTES, PROVIDER_HEADERS, fixtureResponse, fixtureUrl, generateMediaFixtures,
} from "./playback-fixtures.mjs";

// Real built React app + browser decoders + source relay handler. Only the
// catalogue/provider network boundaries are fixtures; no media APIs are mocked.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), `${name} needs a value`);
  return process.argv[index + 1];
};
const dist = path.resolve(option("--dist", path.join(root, "dist")));
assert.ok(existsSync(path.join(dist, "index.html")), "Build the application before running playback acceptance (--dist selects its output)");
const candidates = [
  option("--browser", process.env.CROWFLIX_BROWSER || process.env.CHROME_PATH),
  ...(process.platform === "win32" ? [
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]),
].filter(Boolean);
const browserPath = candidates.find(existsSync);
assert.ok(browserPath, "A Chrome/Chromium/Edge executable is required (--browser or CROWFLIX_BROWSER)");
const temporaryParent = path.resolve(process.env.CROWFLIX_ACCEPTANCE_TEMP_ROOT || tmpdir());
// Under the CI wrapper, remain in its owned POSIX process group so its final
// timeout cleanup also reaches Chromium descendants. Standalone runs own one.
const detachedBrowser = process.platform !== "win32" && !process.env.CROWFLIX_ACCEPTANCE_TEMP_ROOT;
const directory = mkdtempSync(path.join(temporaryParent, "crowflix-playback-"));
const mediaDirectory = path.join(directory, "media");
const profileDirectory = path.join(directory, "profile");
const controller = new AbortController();
const stop = () => controller.abort(new Error("Playback acceptance interrupted"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const deadline = setTimeout(() => controller.abort(new Error("Playback acceptance exceeded its 180-second bound")), 180_000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nativeFetch = globalThis.fetch;
const results = [];
const upstreamRequests = [];
const serverErrors = [];
let browser;
let browserClient;
let vite;
let server;
let fixtureInventory;
let activeCase;

function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let id = 0;
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP socket connection timed out")), 3_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(`CDP socket connection failed: ${event.message || "WebSocket handshake rejected"}`));
    }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else request.resolve(message.result);
    } else for (const listener of listeners.get(message.method) || []) listener(message.params);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("CDP closed")); }
    pending.clear();
  });
  return {
    socket, ready: opened,
    on(method, listener) { listeners.set(method, [...(listeners.get(method) || []), listener]); },
    async send(method, params = {}) {
      await opened;
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
        pending.set(requestId, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}

async function connectCdp(url) {
  // Chrome can advertise a new isolated target just before its WebSocket is
  // ready. Retry attachment only; playback assertions are never retried.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const client = cdp(url);
    try { await client.ready; return client; }
    catch (error) {
      client.socket.close();
      if (attempt === 2) throw error;
      await delay(150 * (attempt + 1));
    }
  }
}

function catalog(test) {
  return {
    channels: [{
      key: "Acceptance.au@main", id: "Acceptance.au", name: test.name, country: "AU", isMain: true,
      categories: ["movies"], languages: ["English"], broadcastArea: ["c/AU"], sources: [test.source],
    }],
    categories: [{ id: "movies", name: "Movies", count: 1 }],
    countries: [{ code: "AU", name: "Australia", flag: "", languages: ["English"], count: 1 }],
    languages: [{ id: "English", name: "English", count: 1 }],
    regions: [], subdivisions: [], cities: [], timezones: [], owners: [], networks: [], feeds: [], providers: [],
    updatedAt: "2026-10-01T00:00:00.000Z", source: "Owned synthetic playback acceptance fixture",
  };
}

async function boundedBytes(response, maximum = MAX_FIXTURE_BYTES) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("Acceptance response exceeded its fixture bound"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

async function startServer(worker) {
  server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/_fixture/")) {
        const original = url.searchParams.get("url");
        const headers = new Headers();
        if (request.headers.range) headers.set("Range", request.headers.range);
        let result;
        if (url.pathname === "/_fixture/relay") {
          const relay = new URL(original);
          fixtureUrl(relay.searchParams.get("url"));
          assert.equal(relay.pathname, "/stream");
          result = await worker.fetch(new Request(relay, { headers }));
        } else result = await fixtureResponse(mediaDirectory, original, { headers });
        const bytes = await boundedBytes(result);
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(bytes);
        return;
      }
      if (/^\/catalog\/[A-Za-z_]+\.json\.gz$/.test(url.pathname)) {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ version: 1, region: url.pathname.split("/").pop().split(".")[0], catalog: catalog(activeCase) }));
        return;
      }
      const filename = path.resolve(dist, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1));
      assert.ok(filename.startsWith(dist + path.sep), "Static requests must stay within the selected build");
      const content = await readFile(filename);
      assert.ok(content.byteLength <= 10 * 1024 * 1024, "Static acceptance assets must be bounded");
      response.writeHead(200, { "Content-Type": MIME[path.extname(filename)] || "application/octet-stream", "Cache-Control": "no-store" });
      response.end(content);
    } catch (error) {
      if (error.code !== "ENOENT") serverErrors.push(error.message);
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end("Local acceptance fixture unavailable");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

const measurements = `(() => {
  const video = document.querySelector('.player video');
  if (!video) return null;
  const quality = video.getVideoPlaybackQuality?.();
  return { time: video.currentTime, decodedFrames: video.webkitDecodedFrameCount ?? (quality ? quality.totalVideoFrames - quality.droppedVideoFrames : 0),
    readyState: video.readyState, paused: video.paused, width: video.videoWidth, height: video.videoHeight,
    error: video.error?.message || null, source: video.currentSrc,
    route: document.querySelector('.player-source-state')?.innerText || '' };
})()`;

async function runCase(test, origin, endpoint) {
  controller.signal.throwIfAborted();
  activeCase = test;
  const upstreamStart = upstreamRequests.length;
  const { browserContextId } = await browserClient.send("Target.createBrowserContext");
  let page;
  const network = [];
  const blocked = [];
  const failures = [];
  const jobs = new Set();
  let lastMeasurement;
  try {
    const { targetId } = await browserClient.send("Target.createTarget", { url: "about:blank", browserContextId });
    const tabs = await nativeFetch(`${endpoint}/json/list`, { signal: controller.signal }).then((response) => response.json());
    const target = tabs.find((tab) => tab.id === targetId);
    assert.ok(target, "The browser must expose the isolated playback target");
    page = await connectCdp(target.webSocketDebuggerUrl);
    page.on("Runtime.exceptionThrown", (event) => failures.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
    page.on("Fetch.requestPaused", ({ requestId, request }) => {
      const job = (async () => {
        const url = new URL(request.url);
        if (url.origin === origin) return page.send("Fetch.continueRequest", { requestId });
        const relayTarget = url.pathname === "/stream" ? url.searchParams.get("url") : null;
        const relayed = relayTarget && FIXTURE_HOSTS.has(new URL(relayTarget).hostname);
        if (!relayed && !FIXTURE_HOSTS.has(url.hostname)) {
          blocked.push(url.origin + url.pathname);
          return page.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
        }
        const kind = relayed ? "relay" : "direct";
        const local = `${origin}/_fixture/${kind}?url=${encodeURIComponent(url.href)}`;
        const headers = new Headers();
        const range = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "range")?.[1];
        if (range) headers.set("Range", range);
        const result = await nativeFetch(local, { headers, redirect: "manual", signal: controller.signal });
        const bytes = await boundedBytes(result);
        network.push({ route: kind, url: relayed ? relayTarget : url.href, status: result.status, range: range || null, bytes: bytes.length });
        await page.send("Fetch.fulfillRequest", {
          requestId, responseCode: result.status,
          responseHeaders: [...result.headers].filter(([name]) => !["connection", "transfer-encoding", "keep-alive"].includes(name))
            .map(([name, value]) => ({ name, value })),
          body: bytes.toString("base64"),
        });
      })().catch((error) => {
        if (!/Invalid InterceptionId|Invalid interceptionId|CDP closed|Session closed|Target closed/.test(error.message)) failures.push(error.message);
      });
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
    });
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Network.setCacheDisabled", { cacheDisabled: true });
    await page.send("Network.setBypassServiceWorker", { bypass: true });
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "http*", requestStage: "Request" }] });
    const evaluate = async (expression) => {
      controller.signal.throwIfAborted();
      const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (predicate, description, timeout = 35_000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const value = await evaluate(predicate);
        if (value) return value;
        await delay(100);
      }
      lastMeasurement = await evaluate(measurements);
      throw new Error(`${description}; ${JSON.stringify(lastMeasurement)}; network=${JSON.stringify(network)}`);
    };
    await page.send("Page.navigate", { url: origin });
    await wait("!document.querySelector('.loading-overlay') && Boolean(document.querySelector('.channel-card .card-main'))", "Built app should render the fixture catalogue", 15_000);
    await evaluate("document.querySelector('.channel-card .card-main').click()");
    await wait(`(() => { const value = ${measurements}; return value && !value.paused && value.time >= 0.5 && value.decodedFrames >= 5; })()`, "Browser must decode the selected production playback route");
    const first = await evaluate(measurements);
    await wait(`(() => { const value = ${measurements}; return value && value.time >= ${first.time + 0.8} && value.decodedFrames >= ${first.decodedFrames + 5}; })()`, "Decoded frames and media time must both advance", 8_000);
    const advanced = await evaluate(measurements);
    assert.equal(advanced.width, 160);
    assert.equal(advanced.height, 90);
    assert.equal(advanced.error, null);
    let seek;
    if (test.range) {
      await evaluate("document.querySelector('.player video').currentTime = 7");
      await wait(`(() => { const value = ${measurements}; return value && value.time >= 7.5 && value.decodedFrames > ${advanced.decodedFrames}; })()`, "Progressive seeking must resume decoded playback", 8_000);
      seek = await evaluate(measurements);
      assert.ok(network.some((entry) => entry.status === 206 && entry.range), "Progressive playback must exercise a real browser byte-range request");
    }
    if (test.relay) assert.ok(network.some((entry) => entry.route === "relay" && entry.status === 200), "Playback must use the relay");
    else assert.ok(!network.some((entry) => entry.route === "relay"), "Direct case must succeed without relay fallback");
    if (test.redirect) {
      const calls = upstreamRequests.slice(upstreamStart);
      assert.ok(calls.some((entry) => entry.url.startsWith("https://redirect.playback.test/")), "Relay must fetch the original manifest");
      assert.ok(calls.some((entry) => /^https:\/\/cdn\.playback\.test\/(hls|dash)\/seg-/.test(entry.url)), "Relative segments must resolve on the final CDN path");
      assert.ok(!calls.some((entry) => /^https:\/\/redirect\.playback\.test\/.*(?:seg-|init-)/.test(entry.url)), "Relative segments must not use the original manifest host");
    }
    if (test.fallback) {
      const failed = network.findIndex((entry) => entry.route === "direct" && entry.status === 403);
      const recovered = network.findIndex((entry) => entry.route === "relay" && entry.status === 200);
      assert.ok(failed >= 0 && recovered > failed, "The production controller must fail direct playback before recovering through relay");
    }
    assert.deepEqual(failures, [], "No uncaught application or interception failures are allowed");
    return { name: test.name, ok: true, first, advanced, ...(seek ? { seek } : {}), network, blockedExternalRequests: blocked.length };
  } catch (error) {
    return { name: test.name, ok: false, error: error.message || String(error), stack: error.stack, failures, network, blockedExternalRequests: blocked.length };
  } finally {
    await browserClient.send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
    page?.socket.close();
    await Promise.allSettled(jobs);
  }
}

async function waitForExit(child, milliseconds) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const done = (exited) => { clearTimeout(timer); child.removeListener("exit", exitedListener); resolve(exited); };
    const exitedListener = () => done(true);
    const timer = setTimeout(() => done(false), milliseconds);
    child.once("exit", exitedListener);
  });
}

try {
  fixtureInventory = await generateMediaFixtures(mediaDirectory, {
    ffmpeg: option("--ffmpeg", process.env.FFMPEG_PATH || "ffmpeg"), signal: controller.signal,
  });
  // Vite transforms only the existing Worker source in memory. No build or
  // writes to dist/public/catalog occur in this runner.
  vite = await createViteServer({ root, configFile: false, appType: "custom", server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
  const { default: worker } = await vite.ssrLoadModule("/relay/src/index.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    fixtureUrl(url); // Never permit the relay test process to fetch a public provider.
    assert.equal(init.redirect, "manual", "The production Worker must validate redirects itself");
    const response = await fixtureResponse(mediaDirectory, url, init, { throughRelay: true });
    upstreamRequests.push({ url, status: response.status });
    return response;
  };
  const origin = await startServer(worker);
  browser = spawn(browserPath, [
    "--headless=new", "--disable-gpu", "--disable-extensions", "--disable-component-update",
    "--disable-background-networking", "--disable-breakpad", "--disable-crash-reporter",
    "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0", `--user-data-dir=${profileDirectory}`, "--window-size=1280,900",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: detachedBrowser });
  const webSocket = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Browser startup exceeded 15 seconds")), 15_000);
    browser.stderr.setEncoding("utf8");
    browser.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8_000);
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    browser.once("error", (error) => { clearTimeout(timer); reject(error); });
    browser.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Browser exited (${code})`)); });
  });
  browserClient = await connectCdp(webSocket);
  const endpoint = new URL(webSocket).origin.replace("ws:", "http:");
  const cases = [
    { name: "Progressive range and seek", source: { url: "https://direct.playback.test/progressive.mp4", transport: "direct" }, range: true },
    { name: "Direct HLS", source: { url: "https://direct.playback.test/hls/manifest.m3u8", transport: "hls" } },
    { name: "Direct DASH", source: { url: "https://direct.playback.test/dash/manifest.mpd", transport: "dash" } },
    { name: "Redirected relay HLS", source: { url: "https://redirect.playback.test/hls.m3u8", transport: "hls", userAgent: PROVIDER_HEADERS["User-Agent"] }, relay: true, redirect: true },
    { name: "Redirected relay DASH", source: { url: "https://redirect.playback.test/dash.mpd", transport: "dash", userAgent: PROVIDER_HEADERS["User-Agent"] }, relay: true, redirect: true },
    { name: "Provider-header relay DASH", source: { url: "https://headers.playback.test/dash/manifest.mpd", transport: "dash", userAgent: PROVIDER_HEADERS["User-Agent"], referrer: PROVIDER_HEADERS.Referer }, relay: true },
    { name: "Direct failure recovers through relay", source: { url: "https://fallback.playback.test/hls/manifest.m3u8", transport: "hls" }, relay: true, fallback: true },
  ];
  for (const test of cases) {
    const result = await runCase(test, origin, endpoint);
    results.push(result);
    console.log(`${result.ok ? "PASS" : "FAIL"} ${test.name}${result.ok ? `: media ${result.first.time.toFixed(2)} -> ${result.advanced.time.toFixed(2)} seconds, decoded ${result.first.decodedFrames} -> ${result.advanced.decodedFrames} frames` : `: ${result.error}`}`);
  }
  assert.deepEqual(serverErrors, [], "Local fixture server must not conceal errors");
  assert.ok(results.every((result) => result.ok), "One or more decoded playback acceptance cases failed");
} catch (error) {
  process.exitCode = 1;
  console.error(error.stack || error.message);
} finally {
  clearTimeout(deadline);
  if (browserClient && browser?.exitCode === null) await browserClient.send("Browser.close").catch(() => undefined);
  browserClient?.socket.close();
  if (!await waitForExit(browser, 5_000)) {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      await waitForExit(killer, 5_000);
    } else if (detachedBrowser) {
      try { process.kill(-browser.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    } else browser.kill("SIGKILL");
    await waitForExit(browser, 5_000);
  }
  // Chromium descendants can briefly retain the inherited stderr pipe after
  // the main process exits, keeping Node alive despite completed cleanup.
  browser?.stderr?.destroy();
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = nativeFetch;
  await vite?.close();
  assert.equal(path.dirname(path.resolve(directory)), temporaryParent, "Only this run's verified temporary directory may be removed");
  assert.ok(path.basename(directory).startsWith("crowflix-playback-"));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(directory, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 39) throw error; await delay(250); }
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
console.log(JSON.stringify({ ok: process.exitCode !== 1 && results.length === 7, dist, fixtures: fixtureInventory, results }, null, 2));
