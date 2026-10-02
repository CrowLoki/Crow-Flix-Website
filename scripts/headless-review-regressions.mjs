import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Run against an existing local Vite build/preview. No provider or relay requests
// leave this isolated browser; the React app and personal-source parser are real.
const targetUrl = new URL(process.argv[2] || "http://127.0.0.1:4189/");
if (!["127.0.0.1", "localhost", "[::1]"].includes(targetUrl.hostname)) {
  throw new Error("Review regressions require a local preview URL.");
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temporaryRoot = path.resolve(tmpdir());
const profileDirectory = mkdtempSync(path.join(temporaryRoot, "crowflix-review-regressions-"));
const candidates = process.platform === "win32" ? [
  path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
] : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

const channel = (id, name, country, host) => ({
  key: `${id}@main`, id, name, country, isMain: true,
  categories: ["movies"], languages: ["English"], broadcastArea: [`c/${country}`],
  sources: [{ url: `https://${host}/live.mp4`, transport: "direct", provenance: "IPTV-org" }],
});
const fixtureCatalog = {
  channels: [
    channel("RegressionCinema.au", "Regression Cinema", "AU", "catalog-cinema.test"),
    channel("RegressionComedy.us", "Regression Comedy", "US", "catalog-comedy.test"),
  ],
  categories: [{ id: "movies", name: "Movies", count: 2 }],
  countries: ["AU", "US"].map((code) => ({ code, name: code, flag: "", languages: ["English"], count: 1 })),
  languages: [{ id: "English", name: "English", count: 2 }],
  regions: [], subdivisions: [], cities: [], timezones: [], owners: [], networks: [], feeds: [], providers: [],
  updatedAt: "2026-10-01T00:00:00.000Z", source: "IPTV-org API · regression fixture",
};
const playlist = (kind) => `#EXTM3U\n#EXTINF:-1 tvg-id="Regression${kind}.au" tvg-country="AU" tvg-language="English" group-title="Movies",Regression ${kind}\nhttps://personal-${kind.toLowerCase()}.test/live.mp4\n#EXTINF:-1 tvg-id="RegressionCinema.au" tvg-country="AU" tvg-language="English" group-title="Movies",Regression Cinema\nhttps://personal-${kind.toLowerCase()}.test/cinema.mp4\n`;
const personalUrl = "https://personal-playlist.test/regression.m3u";

function createCdpClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let id = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else {
      for (const listener of listeners.get(message.method) || []) listener(message.params);
    }
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("CDP connection closed"));
    }
    pending.clear();
  });
  return {
    socket,
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) || []), listener]);
    },
    async send(method, params = {}) {
      await opened;
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`CDP timeout: ${method}`));
        }, 10_000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}

// Installed before any application code, including lazy modules, evaluates.
function installFixtures({ catalog, urlPlaylist, url, storage, catalogMode }) {
  const state = window.__review = {
    catalogMode, catalogRequests: 0, playlistRequests: 0, storageAttempts: 0,
    errors: [], blockedFetches: [], releaseCatalog: null,
  };
  window.addEventListener("error", (event) => state.errors.push(event.error?.name + ": " + event.message));
  window.addEventListener("unhandledrejection", (event) => state.errors.push(String(event.reason)));
  window.localStorage.clear();
  if (storage === "getter") {
    Object.defineProperty(window, "localStorage", { configurable: true, get() {
      state.storageAttempts += 1;
      throw new DOMException("Regression: storage access denied", "SecurityError");
    } });
  } else if (storage === "getItem" || storage === "setItem") {
    Storage.prototype[storage] = function () {
      state.storageAttempts += 1;
      throw new DOMException(`Regression: ${storage} unavailable`, storage === "setItem" ? "QuotaExceededError" : "SecurityError");
    };
  }
  // Prevent snapshot fallbacks masking an uncached failure and avoid per-case
  // guide/cache persistence. This affects only the newly created test context.
  Object.defineProperty(window, "caches", { configurable: true, value: undefined });
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const requested = new URL(typeof input === "string" ? input : input.url || String(input), location.href);
    if (requested.origin === location.origin && /^\/catalog\/[A-Za-z_]+\.json\.gz$/.test(requested.pathname)) {
      state.catalogRequests += 1;
      const mode = state.catalogMode;
      if (mode === "pending") await new Promise((resolve) => { state.releaseCatalog = resolve; });
      if (mode === "failure") return new Response("fixture catalogue unavailable", { status: 503 });
      return new Response(JSON.stringify({ version: 1, region: requested.pathname.split("/").pop().split(".")[0], catalog }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (requested.pathname === "/fetch" && requested.searchParams.get("url") === url) {
      state.playlistRequests += 1;
      return new Response(urlPlaylist, { headers: { "Content-Type": "text/plain" } });
    }
    if (requested.origin !== location.origin) {
      state.blockedFetches.push(requested.href);
      throw new TypeError("External request blocked by isolated regression harness");
    }
    return originalFetch(input, init);
  };
}

let browser;
let browserClient;
const results = [];

async function withPage(options, run) {
  const { browserContextId } = await browserClient.send("Target.createBrowserContext");
  let page;
  try {
    const { targetId } = await browserClient.send("Target.createTarget", { url: "about:blank", browserContextId });
    const endpoint = new URL(browserClient.endpoint);
    const targets = await fetch(`http://${endpoint.hostname}:${endpoint.port}/json/list`).then((response) => response.json());
    const target = targets.find((item) => item.id === targetId);
    assert.ok(target, "The isolated test page must exist");
    page = createCdpClient(target.webSocketDebuggerUrl);
    const networkErrors = [];
    const blockedNetwork = [];
    page.on("Fetch.requestPaused", ({ requestId, request }) => {
      const allowed = new URL(request.url).origin === targetUrl.origin;
      if (!allowed) blockedNetwork.push(request.url);
      void page.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed
        ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch((error) => {
          // Closing the player can cancel an intercepted media request before
          // the abort reply arrives. Chrome then discards that interception ID.
          if (!error.message.includes("Invalid InterceptionId")) networkErrors.push(error.message);
        });
    });
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Network.setCacheDisabled", { cacheDisabled: true });
    await page.send("Network.setBypassServiceWorker", { bypass: true });
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "http*", requestStage: "Request" }] });
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installFixtures.toString()})(${JSON.stringify({
      catalog: fixtureCatalog, urlPlaylist: playlist("URL"), url: personalUrl, storage: "normal", catalogMode: "success", ...options,
    })})` });
    const evaluate = async (expression) => {
      const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (expression, description, timeout = 6_000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      const evidence = await evaluate(`({ text: document.body.innerText.slice(0, 700), errors: window.__review?.errors, requests: window.__review?.catalogRequests })`);
      throw new Error(`${description}; ${JSON.stringify(evidence)}`);
    };
    const click = async (selector) => {
      await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)}); element.click(); })()`);
    };
    const button = async (selector, text) => {
      await evaluate(`(() => { const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.textContent.trim() === ${JSON.stringify(text)}); if (!element) throw new Error('Missing button: ' + ${JSON.stringify(text)}); element.click(); })()`);
    };
    const input = async (selector, value) => {
      await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    };
    const app = { evaluate, waitFor, click, button, input };
    await page.send("Page.navigate", { url: targetUrl.href });
    await waitFor("document.readyState === 'complete' && Boolean(window.__review)", "App document should load");
    await run(app);
    assert.deepEqual(await evaluate("window.__review.errors"), [], "Interactions must not emit uncaught application exceptions");
    assert.deepEqual(networkErrors, [], "Network interception must remain active");
    return { ...await evaluate("({ catalogueRequests: window.__review.catalogRequests, playlistRequests: window.__review.playlistRequests, storageAttempts: window.__review.storageAttempts })"), blockedNetworkRequests: blockedNetwork.length };
  } finally {
    page?.socket.close();
    await browserClient.send("Target.disposeBrowserContext", { browserContextId });
  }
}

async function loaded(app) {
  await app.waitFor("!document.querySelector('.loading-overlay') && [...document.querySelectorAll('.channel-card .card-copy span')].some((item) => item.textContent === 'Regression Cinema')", "Real fixture catalogue must render");
}

async function browse(app) {
  await app.button(".topbar nav button", "Live TV");
  await app.waitFor("Boolean(document.querySelector('.browse-results'))", "Live catalogue should open");
}

async function expectCards(app, names) {
  assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.browse-results .channel-card .card-copy span')].map((item) => item.textContent).sort()"), [...names].sort(), "Visible catalogue must contain all and only expected channels");
}

async function refresh(app, mode = "success") {
  const previous = await app.evaluate("window.__review.catalogRequests");
  await app.evaluate(`window.__review.catalogMode = ${JSON.stringify(mode)}`);
  await app.button(".status-bar button", "Refresh catalogue");
  await app.waitFor(`window.__review.catalogRequests === ${previous + 1}`, "Refresh should fetch the catalogue once");
  if (mode !== "pending") await app.waitFor("!document.querySelector('.loading-overlay')", "Refresh should settle");
}

async function importFile(app, kind = "File") {
  if (!await app.evaluate("Boolean(document.querySelector('#personal-playlist-url'))")) await app.click(".source-button");
  await app.waitFor("Boolean(document.querySelector('#personal-playlist-url'))", "Personal source dialog should open");
  await app.evaluate(`(() => { const input = document.querySelector('input[type=file][accept=".m3u,.m3u8,text/plain"]'); const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(playlist(kind))}], ${JSON.stringify(`regression-${kind.toLowerCase()}.m3u`)}, { type: 'text/plain' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await app.waitFor(`!document.querySelector('#personal-playlist-url') && [...document.querySelectorAll('.browse-results .card-copy span')].some((item) => item.textContent === ${JSON.stringify(`Regression ${kind}`)})`, "Selected personal M3U file must add its actual channel");
}

async function routes(app, expectedHosts) {
  await app.click('.details-button[aria-label="Show Regression Cinema details"]');
  await app.waitFor("Boolean(document.querySelector('.channel-source-list'))", "Channel details should expose source metadata");
  assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.channel-source-list article small')].map((item) => item.textContent).sort()"), [...expectedHosts].sort(), "Same-channel personal routes must survive without duplication");
  await app.click(".channel-details .dialog-close");
  await app.waitFor("!document.querySelector('.channel-details')", "Details should close");
}

async function storageInteractions(app) {
  await loaded(app);
  await browse(app);
  await app.click('.heart-button[aria-label="Toggle Regression Cinema favourite"]');
  await app.button(".topbar nav button", "My List");
  await app.waitFor("document.querySelectorAll('.standalone-grid .channel-card').length === 1", "Favourites must remain usable when persistence fails");
  await app.click(".standalone-grid .card-main");
  await app.waitFor("Boolean(document.querySelector('.player'))", "Selecting a favourite should open the player");
  await app.evaluate("history.back()");
  await app.waitFor("!document.querySelector('.player')", "Browser back should close playback");
  await app.button(".topbar nav button", "Home");
  await app.waitFor("[...document.querySelectorAll('.rail-section')].some((item) => item.querySelector('h2')?.textContent === 'Continue watching' && item.innerText.includes('Regression Cinema'))", "Recent selections must remain in memory");
  await app.click(".account-button");
  await app.waitFor("Boolean(document.querySelector('.account-reminder-setting input'))", "Account preferences should open");
  await app.click(".account-reminder-setting input");
  assert.equal(await app.evaluate("document.querySelector('.account-reminder-setting input').checked || Boolean(document.querySelector('.toast')?.textContent.includes('could not save the account reminder setting'))"), true, "Account preference changes should either save or show a persistence error without crashing");
  await app.click(".account-dialog .dialog-close");
  await app.button(".topbar nav button", "CrowFlix Free");
  await app.waitFor("Boolean(document.querySelector('.web-library'))", "Web Library should open");
  await app.click(".web-category-strip button");
  await app.button(".web-hero-actions button", "Add website");
  await app.waitFor("Boolean(document.querySelector('.web-editor'))", "Web Library editor should open");
  await app.input('.web-editor input[placeholder="Example: My movie site"]', "Regression saved website");
  await app.input('.web-editor input[placeholder="https://example.com/watch"]', "https://saved-website.test/watch");
  await app.button(".web-editor .dialog-actions button", "Add to Web Library");
  await app.waitFor("[...document.querySelectorAll('.web-card h2')].some((item) => item.textContent === 'Regression saved website')", "Web Library additions must remain usable in the session");
  await app.click('button[aria-label="Edit Regression saved website"]');
  await app.waitFor("Boolean(document.querySelector('.web-editor'))", "Saved website should be editable");
  await app.input('.web-editor input[placeholder="Example: My movie site"]', "Regression edited website");
  await app.button(".web-editor .dialog-actions button", "Save changes");
  await app.waitFor("[...document.querySelectorAll('.web-card h2')].some((item) => item.textContent === 'Regression edited website')", "Web Library edits must survive a failed save");
  await app.button(".topbar nav button", "Live TV");
  await app.button(".topbar nav button", "CrowFlix Free");
  await app.waitFor("Boolean(document.querySelector('.web-library'))", "Web Library should reopen");
  await app.click(".web-category-strip button");
  assert.equal(await app.evaluate("[...document.querySelectorAll('.web-card h2')].some((item) => item.textContent === 'Regression edited website')"), true, "Edited website must survive navigation");
  assert.ok(await app.evaluate("window.__review.storageAttempts > 0"), "Injected storage failure must be exercised");
}

async function test(name, options, run) {
  try {
    const evidence = await withPage(options, run);
    results.push({ name, ok: true, evidence });
    console.log(`PASS ${name}: ${JSON.stringify(evidence)}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

try {
  const browserPath = candidates.find(existsSync);
  assert.ok(browserPath, "A Chrome or Edge binary is required");
  browser = spawn(browserPath, [
    "--headless=new", "--disable-gpu", "--disable-extensions", "--disable-component-update",
    "--disable-background-networking", "--disable-breakpad", "--disable-crash-reporter", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profileDirectory}`, "--window-size=1440,1000", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const webSocketUrl = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Browser start timed out")), 15_000);
    browser.stderr.setEncoding("utf8");
    browser.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    browser.once("error", (error) => { clearTimeout(timer); reject(error); });
    browser.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Browser exited (${code})`)); });
  });
  browserClient = createCdpClient(webSocketUrl);
  browserClient.endpoint = webSocketUrl;
  console.log(`Isolated review browser PID ${browser.pid}; preview ${targetUrl.href}`);
  for (const storage of ["getter", "getItem", "setItem"]) {
    await test(`storage ${storage} failure keeps real application usable`, { storage }, storageInteractions);
  }
  await test("uncached failure stays visible without preview cards and retry restores catalogue", { catalogMode: "failure" }, async (app) => {
    await app.waitFor("window.__review.catalogRequests === 1 && !document.querySelector('.loading-overlay')", "Failed catalogue fetch should settle");
    assert.equal(await app.evaluate("document.querySelectorAll('.channel-card').length"), 0, "Failed catalogue must never fabricate preview cards");
    await app.waitFor("Boolean(document.querySelector('.catalog-error-banner'))", "Catalogue failure needs a persistent error banner");
    await delay(5_300); // Exceed the current transient-toast duration.
    assert.equal(await app.evaluate("Boolean(document.querySelector('.catalog-error-banner button:not(:disabled)'))"), true, "Retry must remain after transient feedback expires");
    await app.evaluate("window.__review.catalogMode = 'success'");
    await app.button(".catalog-error-banner button", "Retry");
    await loaded(app);
    assert.equal(await app.evaluate("Boolean(document.querySelector('.catalog-error-banner'))"), false, "Successful retry should clear the catalogue error");
    assert.equal(await app.evaluate("window.__review.catalogRequests"), 2, "Retry must perform a new request");
    await browse(app);
    await expectCards(app, ["Regression Cinema", "Regression Comedy"]);
  });
  await test("later failed refresh preserves existing real catalogue", {}, async (app) => {
    await loaded(app);
    await browse(app);
    await refresh(app, "failure");
    await expectCards(app, ["Regression Cinema", "Regression Comedy"]);
    assert.equal(await app.evaluate("Boolean(document.querySelector('.catalog-error-banner'))"), true, "Failed refresh should report an error alongside preserved channels");
  });
  await test("personal file channels and additional routes survive repeated refresh", {}, async (app) => {
    await loaded(app);
    await importFile(app);
    await routes(app, ["catalog-cinema.test", "personal-file.test"]);
    await refresh(app);
    await expectCards(app, ["Regression Cinema", "Regression Comedy", "Regression File"]);
    await routes(app, ["catalog-cinema.test", "personal-file.test"]);
    await refresh(app);
    await routes(app, ["catalog-cinema.test", "personal-file.test"]);
  });
  await test("personal URL channels and additional routes survive refresh", {}, async (app) => {
    await loaded(app);
    await app.click(".source-button");
    await app.waitFor("Boolean(document.querySelector('#personal-playlist-url'))", "Personal URL editor should open");
    await app.input("#personal-playlist-url", personalUrl);
    await app.click("#personal-playlist-url + button");
    await app.waitFor("!document.querySelector('#personal-playlist-url') && Boolean(document.querySelector('.browse-results'))", "Personal URL import should finish");
    await expectCards(app, ["Regression Cinema", "Regression Comedy", "Regression URL"]);
    assert.equal(await app.evaluate("window.__review.playlistRequests"), 1, "URL import should use the bounded relay client with the mocked playlist");
    await refresh(app);
    await expectCards(app, ["Regression Cinema", "Regression Comedy", "Regression URL"]);
    await routes(app, ["catalog-cinema.test", "personal-url.test"]);
  });
  await test("personal import completed during pending refresh is retained", {}, async (app) => {
    await loaded(app);
    await app.click(".source-button");
    await refresh(app, "pending");
    await app.waitFor("typeof window.__review.releaseCatalog === 'function'", "Catalogue response should be pending");
    await importFile(app, "Pending");
    await expectCards(app, ["Regression Cinema", "Regression Comedy", "Regression Pending"]);
    await app.evaluate("window.__review.releaseCatalog(); window.__review.releaseCatalog = null");
    await app.waitFor("!document.querySelector('.loading-overlay') && document.querySelector('.toast')?.textContent.includes('channels ready')", "Pending refresh should complete after the import");
    await expectCards(app, ["Regression Cinema", "Regression Comedy", "Regression Pending"]);
    await routes(app, ["catalog-cinema.test", "personal-pending.test"]);
  });
} finally {
  if (browserClient && browser?.exitCode === null) {
    await Promise.race([browserClient.send("Browser.close").catch(() => undefined), delay(2_000)]);
  }
  browserClient?.socket.close();
  if (browser?.exitCode === null) {
    await Promise.race([new Promise((resolve) => browser.once("exit", resolve)), delay(15_000)]);
    if (browser.exitCode === null) {
      browser.kill();
      await Promise.race([new Promise((resolve) => browser.once("exit", resolve)), delay(5_000)]);
    }
  }
  assert.equal(path.dirname(path.resolve(profileDirectory)), temporaryRoot, "Only this test's isolated browser profile may be removed");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { rmSync(profileDirectory, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 79) throw error; await delay(250); }
  }
}
console.log(JSON.stringify({ ok: results.length === 8 && results.every((result) => result.ok), results }, null, 2));
if (results.length !== 8 || results.some((result) => !result.ok)) process.exitCode = 1;
