import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const targetUrl = process.argv[2] || "https://crowflix.tv/";
const temporaryRoot = path.resolve(tmpdir());
const profileDirectory = mkdtempSync(path.join(temporaryRoot, "crowflix-headless-"));
if (path.dirname(profileDirectory) !== temporaryRoot) {
  throw new Error("The isolated browser profile escaped the temporary directory.");
}

const candidates = process.platform === "win32"
  ? [
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  ]
  : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const browserPath = candidates.find(existsSync);
if (!browserPath) throw new Error("No supported Chrome or Edge binary was found.");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const waiters = new Map();
  let requestId = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    const listeners = waiters.get(message.method) || [];
    waiters.delete(message.method);
    for (const resolve of listeners) resolve(message.params);
  });
  return {
    socket,
    async send(method, params = {}) {
      await opened;
      requestId += 1;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
    async event(method, timeout = 30_000) {
      await opened;
      return Promise.race([
        new Promise((resolve) => {
          const listeners = waiters.get(method) || [];
          listeners.push(resolve);
          waiters.set(method, listeners);
        }),
        delay(timeout).then(() => { throw new Error(`Timed out waiting for ${method}.`); }),
      ]);
    },
  };
}

async function removeIsolatedProfile() {
  if (path.dirname(profileDirectory) !== temporaryRoot) {
    throw new Error("Refusing to remove an unverified browser profile path.");
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(profileDirectory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(250);
    }
  }
}

let browser;
let page;
let stderr = "";
try {
  browser = spawn(browserPath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-component-update",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "--window-size=1440,1000",
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const browserWebSocketUrl = await Promise.race([
    new Promise((resolve, reject) => {
      browser.stderr.setEncoding("utf8");
      browser.stderr.on("data", (chunk) => {
        stderr += chunk;
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) resolve(match[1]);
      });
      browser.once("exit", (code) => reject(new Error(`Browser exited before DevTools was ready (${code}).`)));
    }),
    delay(15_000).then(() => { throw new Error("Timed out starting the headless browser."); }),
  ]);
  const endpoint = new URL(browserWebSocketUrl);
  const target = await fetch(
    `http://${endpoint.hostname}:${endpoint.port}/json/new?${encodeURIComponent(targetUrl)}`,
    { method: "PUT" },
  ).then((response) => {
    if (!response.ok) throw new Error(`DevTools target creation returned ${response.status}.`);
    return response.json();
  });
  page = createCdpClient(target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const evaluate = async (expression) => {
    const result = await page.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed.");
    return result.result.value;
  };
  const waitFor = async (expression, timeout = 45_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return;
      await delay(500);
    }
    throw new Error(`Timed out waiting for live UI condition: ${expression}`);
  };

  await waitFor("!document.querySelector('.loading-overlay') && document.querySelectorAll('.channel-card').length > 0");
  const home = await evaluate(`({
    title: document.title,
    cards: document.querySelectorAll('.channel-card').length,
    addSource: Boolean(document.querySelector('.source-button')),
    liveNav: [...document.querySelectorAll('.topbar nav button')].some((button) => button.textContent.includes('Live TV')),
    desktopDownload: document.body.innerText.includes('Download Crow-Flix for Windows'),
    status: document.querySelector('.status-bar')?.innerText || ''
  })`);
  await evaluate(`[...document.querySelectorAll('.topbar nav button')].find((button) => button.textContent.includes('Live TV'))?.click()`);
  await waitFor("document.querySelectorAll('.browse-results .channel-card').length === 48");
  const live = await evaluate(`({
    cards: document.querySelectorAll('.browse-results .channel-card').length,
    providers: document.body.innerText.includes('Source providers'),
    owners: document.body.innerText.includes('Owners'),
    fullCopy: document.body.innerText.includes('complete matching catalogue stays visible')
  })`);
  await evaluate("document.querySelector('.browse-results .details-button')?.click()");
  await waitFor("Boolean(document.querySelector('.channel-details'))");
  const details = await evaluate(`({
    channelId: [...document.querySelectorAll('.channel-details .detail-item > span')].some((item) => item.textContent.trim() === 'Channel ID'),
    sources: [...document.querySelectorAll('.channel-details h3')].some((item) => item.textContent.trim() === 'Playback sources'),
    providers: [...document.querySelectorAll('.channel-details .detail-item > span')].some((item) => item.textContent.trim() === 'Source providers')
  })`);
  await evaluate("document.querySelector('.channel-details .dialog-close')?.click()");
  await waitFor("!document.querySelector('.channel-details')");
  await evaluate("document.querySelector('.source-button')?.click()");
  await waitFor("Boolean(document.querySelector('.source-dialog'))");
  const sourceDialog = await evaluate(`({
    playlist: document.querySelector('.source-dialog')?.innerText.includes('Personal M3U playlist URL'),
    guide: document.querySelector('.source-dialog')?.innerText.includes('Personal XMLTV guide URL')
  })`);

  const assertions = {
    homeLoaded: home.cards > 0 && home.addSource && home.liveNav && !home.desktopDownload,
    fullLivePage: live.cards === 48 && live.providers && live.owners && live.fullCopy,
    detailsDialog: details.channelId && details.sources && details.providers,
    personalSourcesDialog: sourceDialog.playlist && sourceDialog.guide,
  };
  if (Object.values(assertions).some((value) => !value)) {
    throw new Error(`Headless acceptance assertion failed: ${JSON.stringify({ assertions, home, live, details, sourceDialog })}`);
  }
  console.log(JSON.stringify({
    ok: true,
    browser: path.basename(browserPath),
    targetUrl,
    assertions,
    catalogueStatus: home.status,
  }, null, 2));
  await page.send("Browser.close").catch(() => undefined);
} finally {
  page?.socket.close();
  if (browser && browser.exitCode === null) browser.kill();
  await Promise.race([
    new Promise((resolve) => browser?.once("exit", resolve)),
    delay(5_000),
  ]);
  await removeIsolatedProfile();
}
