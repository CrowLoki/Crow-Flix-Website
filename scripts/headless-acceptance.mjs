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
    audienceFirst: document.body.innerText.includes('Australian entertainment') && document.body.innerText.includes('American TV & Movies'),
    entertainmentFirst: (() => {
      const home = document.querySelector('.home-content')?.innerText || '';
      return home.includes('Movies to watch')
        && home.includes('TV shows & entertainment')
        && !home.includes('Live news')
        && !home.includes('Live sports');
    })(),
    enlargedClawCursor: getComputedStyle(document.documentElement).cursor.includes('/cursors/40/normal.png'),
    helper: Boolean(document.querySelector('.crow-guide-avatar')),
    brandAccessible: document.querySelector('.brand')?.getAttribute('aria-label') === 'CrowFlix home',
    desktopDownload: document.body.innerText.includes('Download Crow-Flix for Windows'),
    headerFits: (() => {
      const actions = document.querySelector('.header-actions')?.getBoundingClientRect();
      const account = document.querySelector('.account-button')?.getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth
        && Boolean(actions && actions.left >= 0 && actions.right <= innerWidth)
        && Boolean(account && account.left >= 0 && account.right <= innerWidth);
    })(),
    status: document.querySelector('.status-bar')?.innerText || ''
  })`);
  home.responsiveHeader = [];
  for (const width of [320, 420, 421, 720, 721, 960, 1000, 1001, 1280, 1281, 1500, 1501]) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    home.responsiveHeader.push(await evaluate(`(() => {
      const brand = document.querySelector('.brand')?.getBoundingClientRect();
      const brandLabel = document.querySelector('.brand span');
      const label = brandLabel && getComputedStyle(brandLabel).display !== 'none'
        ? brandLabel.getBoundingClientRect()
        : null;
      const nav = document.querySelector('.topbar nav')?.getBoundingClientRect();
      const search = document.querySelector('.search')?.getBoundingClientRect();
      const source = document.querySelector('.source-button')?.getBoundingClientRect();
      const account = document.querySelector('.account-button')?.getBoundingClientRect();
      const overlaps = (left, right) => Boolean(left && right
        && left.left < right.right && left.right > right.left
        && left.top < right.bottom && left.bottom > right.top);
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        fits: document.documentElement.scrollWidth <= innerWidth
          && Boolean(brand && brand.left >= 0)
          && Boolean(search && search.left >= 0 && search.right <= innerWidth)
          && Boolean(source && source.left >= 0 && source.right <= innerWidth)
          && Boolean(account && account.left >= 0 && account.right <= innerWidth)
          && !overlaps(label, search)
          && !overlaps(nav, search),
      };
    })()`));
  }
  await page.send("Emulation.clearDeviceMetricsOverride");
  await waitFor("innerWidth >= 1400");
  await evaluate("document.querySelector('.account-button')?.focus(); document.querySelector('.account-button')?.click()");
  await waitFor("Boolean(document.querySelector('.account-dialog'))");
  await waitFor("history.state?.accountOpen === true");
  const accountSettings = await evaluate(`({
    anonymous: document.querySelector('.account-dialog')?.innerText.includes('Browsing anonymously') || false,
    optional: document.querySelector('.account-dialog')?.innerText.includes('fully usable without signing in') || false,
    honestFoundation: document.querySelector('.account-dialog')?.innerText.includes('Account sync is not available yet') || false,
    noDeadSignIn: ![...document.querySelectorAll('.account-dialog button')].some((button) => /^Sign in$/i.test(button.textContent.trim())),
    reminder: Boolean(document.querySelector('.account-reminder-setting input')),
    initialFocus: document.activeElement?.classList.contains('dialog-close') || false
  })`);
  await evaluate("history.back()");
  await waitFor("history.state?.accountOpen === false && !document.querySelector('.account-dialog')");
  accountSettings.historyBackClosed = await evaluate("!document.querySelector('.account-dialog')");
  await evaluate("history.forward()");
  await waitFor("history.state?.accountOpen === true && Boolean(document.querySelector('.account-dialog'))");
  accountSettings.historyForwardRestored = await evaluate("Boolean(document.querySelector('.account-dialog'))");
  await evaluate("document.querySelector('.account-reminder-setting input')?.click()");
  await waitFor(`JSON.parse(localStorage.getItem('crowflix:account-prompt:v1') || '{}').suppressed === true`);
  accountSettings.preferencePersisted = await evaluate(`JSON.parse(localStorage.getItem('crowflix:account-prompt:v1') || '{}').suppressed === true`);
  await evaluate("document.querySelector('.account-dialog .dialog-close')?.click()");
  await waitFor("!document.querySelector('.account-dialog')");
  const reloaded = page.event("Page.loadEventFired");
  await page.send("Page.reload", { ignoreCache: true });
  await reloaded;
  await waitFor("!document.querySelector('.loading-overlay') && document.querySelectorAll('.channel-card').length > 0");
  await evaluate("document.querySelector('.account-button')?.focus(); document.querySelector('.account-button')?.click()");
  await waitFor("Boolean(document.querySelector('.account-dialog'))");
  accountSettings.reloadPersisted = await evaluate("document.querySelector('.account-reminder-setting input')?.checked === true");
  await evaluate("document.querySelector('.account-reminder-setting input')?.click()");
  await waitFor("localStorage.getItem('crowflix:account-prompt:v1') === null");
  accountSettings.preferenceReset = await evaluate("localStorage.getItem('crowflix:account-prompt:v1') === null");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  await waitFor("!document.querySelector('.account-dialog')");
  accountSettings.escapeDismissed = await evaluate("!document.querySelector('.account-dialog')");
  accountSettings.focusReturned = await evaluate("document.activeElement?.classList.contains('account-button') || false");
  await evaluate("document.querySelector('.crow-guide-avatar')?.click()");
  await waitFor("Boolean(document.querySelector('.crow-guide-bubble'))");
  const helper = await evaluate(`({
    localOnly: document.querySelector('.crow-guide-bubble')?.innerText.includes('stay on this device') || false,
    noExternalAi: document.querySelector('.crow-guide-bubble')?.innerText.includes('No external AI') || false,
    search: Boolean(document.querySelector('.crow-guide-search input')),
    quickActions: document.querySelectorAll('.crow-guide-quick button').length,
    candidates: document.querySelectorAll('.crow-guide-result').length,
    somethingElse: [...document.querySelectorAll('.crow-guide-actions button')].some((button) => button.textContent.includes('Something else'))
  })`);
  await evaluate("document.querySelector('.crow-guide-search input')?.focus()");
  await page.send("Input.insertText", { text: "movies" });
  await evaluate("document.querySelector('.crow-guide-search')?.requestSubmit()");
  await waitFor("document.querySelector('.crow-guide-answer')?.textContent.includes('matching')");
  helper.usefulSearch = await evaluate(`(() => {
    const results = [...document.querySelectorAll('.crow-guide-result')];
    return results.length > 0
      && results.every((item) => item.querySelector('.crow-guide-result-copy small')?.textContent.length > 10)
      && results.every((item) => !['temporarily-offline', 'unsupported'].includes(item.dataset.availability));
  })()`);
  await evaluate(`[...document.querySelectorAll('.crow-guide-quick button')].find((button) => button.textContent.includes('On now'))?.click()`);
  await waitFor("[...document.querySelectorAll('.crow-guide-actions button')].some((button) => button.textContent.includes('Load live guide'))");
  helper.honestGuideFallback = await evaluate("document.querySelector('.crow-guide-answer')?.textContent.includes('do not have current programme listings') || false");
  await evaluate("document.querySelector('.crow-guide-bubble button[aria-label]')?.click()");
  await waitFor("!document.querySelector('.crow-guide-bubble')");
  await evaluate(`[...document.querySelectorAll('.topbar nav button')].find((button) => button.textContent.includes('Live TV'))?.click()`);
  await waitFor("document.querySelectorAll('.browse-results .channel-card').length === 48");
  await evaluate("document.querySelector('.browse-sidebar > button')?.click()");
  await waitFor("Boolean(document.querySelector('.explore-popout'))");
  const explore = await evaluate(`({
    title: document.querySelector('.explore-popout header')?.innerText || '',
    options: document.querySelectorAll('.explore-popout-options > button').length,
    overlay: getComputedStyle(document.querySelector('.explore-popout')).position === 'absolute'
  })`);
  await evaluate("document.querySelector('.explore-popout button[aria-label]')?.click()");
  await waitFor("!document.querySelector('.explore-popout')");
  await evaluate("document.querySelector('.account-sidebar-button')?.click()");
  await waitFor("Boolean(document.querySelector('.account-dialog'))");
  accountSettings.exploreEntry = await evaluate(`document.querySelector('.account-reminder-setting input')?.checked === false`);
  await evaluate("document.querySelector('.account-dialog .dialog-close')?.click()");
  await waitFor("!document.querySelector('.account-dialog')");
  const live = await evaluate(`({
    cards: document.querySelectorAll('.browse-results .channel-card').length,
    providers: document.body.innerText.includes('Source providers'),
    owners: document.body.innerText.includes('Owners'),
    fullCopy: document.body.innerText.includes('complete matching catalogue stays visible'),
    preferredOrder: document.body.innerText.includes('Australia / US / English first'),
    honestTotals: (() => {
      const metrics = document.querySelector('.catalog-number');
      const text = (metrics?.innerText || '').toLowerCase();
      const channels = Number(metrics?.dataset.channelCount || 0);
      const sources = Number(metrics?.dataset.sourceCount || 0);
      return text.includes('stream sources')
        && text.includes('catalogued channel/feed entries')
        && channels > 12_000
        && sources > channels;
    })()
  })`);
  const backgroundStreamRequests = await evaluate(`performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((url) => /(?:\\.m3u8|\\.mpd)(?:[?#]|$)|\\/playback(?:[/?]|$)/i.test(url))
    .filter((url) => !/\\/raw-tv\\.m3u8(?:[?#]|$)/i.test(decodeURIComponent(url)))`);
  await evaluate("document.querySelector('.browse-results .channel-card')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))");
  await waitFor("Boolean(document.querySelector('.channel-preview'))", 5_000);
  const hoverPreview = await evaluate(`({
    muted: document.querySelector('.channel-preview video')?.muted === true,
    label: document.querySelector('.channel-preview span')?.textContent || ''
  })`);
  await evaluate("document.querySelector('.browse-results .channel-card')?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }))");
  await waitFor("!document.querySelector('.channel-preview')");
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
  await evaluate("document.querySelector('.source-dialog .dialog-close')?.click()");
  await waitFor("!document.querySelector('.source-dialog')");
  await evaluate(`[...document.querySelectorAll('.topbar nav button')].find((button) => button.textContent.includes('Guide'))?.click()`);
  await waitFor("Boolean(document.querySelector('.guide-page'))");
  const guideAudience = await evaluate(`(() => {
    const options = [...document.querySelectorAll('.guide-controls select option')].map((option) => option.textContent || '');
    return {
      englishFirst: document.querySelector('.guide-controls label span')?.textContent.includes('English first') || false,
      australiaFirst: options[0]?.includes('Australia') || false,
      unitedStatesSecond: options[1]?.includes('United States') || false
    };
  })()`);
  await evaluate(`[...document.querySelectorAll('.topbar nav button')].find((button) => button.textContent.includes('CrowFlix Free'))?.click()`);
  await waitFor("document.querySelector('.web-library h1')?.textContent.includes('CrowFlix Free Collection')");
  const freeCollection = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.web-card')].find((item) => item.textContent.includes('FilmRise'));
    return {
      heading: document.querySelector('.web-library h1')?.textContent || '',
      officialCategory: [...document.querySelectorAll('.web-category-strip button')].some((button) => button.textContent.includes('CrowFlix Free Collection')),
      preferredCategory: [...document.querySelectorAll('.web-category-strip button')].some((button) => button.textContent.includes('Australia & United States')),
      officialCard: Boolean(card),
      brandedCuration: card?.innerText.toLocaleLowerCase().includes('crowflix free collection') || false,
      originalPublisherNotice: card?.innerText.includes('original official publisher page') || false,
      englishFirst: document.querySelector('.web-library')?.innerText.includes('English first') || false
    };
  })()`);
  await evaluate(`[...document.querySelectorAll('.topbar nav button')].find((button) => button.textContent.includes('Live TV'))?.click()`);
  await waitFor("document.querySelectorAll('.browse-results .channel-card').length === 48");
  await evaluate("document.querySelector('.browse-results .card-main')?.click()");
  await waitFor("Boolean(document.querySelector('.player'))");
  const player = await evaluate(`({
    customControls: Boolean(document.querySelector('.player-controls')),
    nativeControlsRemoved: !document.querySelector('.player video')?.hasAttribute('controls'),
    settingsButton: Boolean(document.querySelector('.player button[aria-label="Playback settings"]')),
    guideButton: Boolean(document.querySelector('.player-brand[aria-controls="player-mini-guide"]')),
    subtitleButton: Boolean(document.querySelector('.player button[aria-label="Subtitles"]')),
    fullscreenButton: Boolean(document.querySelector('.player button[aria-label*="Fullscreen" i]'))
  })`);
  await evaluate("document.querySelector('.player button[aria-label=\"Playback settings\"]')?.click()");
  await waitFor("Boolean(document.querySelector('.player-settings-main'))");
  await evaluate(`[...document.querySelectorAll('.player-settings-main button')].find((button) => button.textContent.includes('Subtitles'))?.click()`);
  await waitFor("document.querySelector('.player-settings-submenu')?.innerText.includes('Subtitles')");
  const subtitleMenu = await evaluate(`({
    off: [...document.querySelectorAll('.player-settings-submenu button')].some((button) => button.textContent.includes('Off')),
    honestUnavailable: document.querySelector('.player-settings-submenu')?.innerText.includes('not supplying a subtitle track') || document.querySelectorAll('.player-settings-submenu button').length > 2
  })`);
  await evaluate("document.querySelector('.player button[aria-label=\"Playback settings\"]')?.click(); document.querySelector('.player-brand')?.click()");
  await waitFor("Boolean(document.querySelector('.player-mini-guide'))");
  const miniGuide = await evaluate(`({
    search: Boolean(document.querySelector('.mini-guide-search input')),
    channels: document.querySelectorAll('.mini-guide-list > button').length,
    previous: [...document.querySelectorAll('.mini-guide-zap button')].some((button) => button.textContent.includes('Previous channel')),
    next: [...document.querySelectorAll('.mini-guide-zap button')].some((button) => button.textContent.includes('Next channel'))
  })`);
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  await waitFor("Boolean(document.querySelector('.player')) && !document.querySelector('.player-mini-guide')");
  await evaluate("document.querySelector('.player video')?.click()");
  const playerStayedOpen = await evaluate("Boolean(document.querySelector('.player'))");
  await evaluate("history.back()");
  await waitFor("!document.querySelector('.player') && document.querySelectorAll('.browse-results .channel-card').length === 48");
  const browserHistory = await evaluate(`({
    returnedToLive: !document.querySelector('.player') && document.querySelectorAll('.browse-results .channel-card').length === 48
  })`);
  await evaluate("history.forward()");
  await waitFor("Boolean(document.querySelector('.player'))");
  browserHistory.forwardRestoredPlayer = await evaluate("Boolean(document.querySelector('.player'))");

  const assertions = {
    homeLoaded: home.cards > 0 && home.addSource && home.liveNav && home.audienceFirst && home.entertainmentFirst && home.enlargedClawCursor && home.helper && home.brandAccessible && !home.desktopDownload && home.headerFits && home.responsiveHeader.every((item) => item.fits),
    crowGuide: helper.localOnly && helper.noExternalAi && helper.search && helper.quickActions === 3 && helper.candidates > 0 && helper.somethingElse && helper.usefulSearch && helper.honestGuideFallback,
    accountFoundation: accountSettings.anonymous && accountSettings.optional && accountSettings.honestFoundation && accountSettings.noDeadSignIn && accountSettings.reminder && accountSettings.initialFocus && accountSettings.historyBackClosed && accountSettings.historyForwardRestored && accountSettings.preferencePersisted && accountSettings.reloadPersisted && accountSettings.preferenceReset && accountSettings.escapeDismissed && accountSettings.focusReturned && accountSettings.exploreEntry,
    explorePopout: explore.title.includes('Explore') && explore.options > 1 && explore.overlay,
    fullLivePage: live.cards === 48 && live.providers && live.owners && live.fullCopy && live.preferredOrder && live.honestTotals,
    noBackgroundStreamProbing: backgroundStreamRequests.length === 0,
    hoverPreview: hoverPreview.muted && hoverPreview.label.length > 0,
    detailsDialog: details.channelId && details.sources && details.providers,
    personalSourcesDialog: sourceDialog.playlist && sourceDialog.guide,
    guideAudience: guideAudience.englishFirst && guideAudience.australiaFirst && guideAudience.unitedStatesSecond,
    crowFlixFreeCollection: freeCollection.heading === 'CrowFlix Free Collection' && freeCollection.officialCategory && freeCollection.preferredCategory && freeCollection.officialCard && freeCollection.brandedCuration && freeCollection.originalPublisherNotice && freeCollection.englishFirst,
    playerControls: player.customControls && player.nativeControlsRemoved && player.settingsButton && player.guideButton && player.subtitleButton && player.fullscreenButton,
    subtitleMenu: subtitleMenu.off && subtitleMenu.honestUnavailable,
    miniGuide: miniGuide.search && miniGuide.channels > 0 && miniGuide.previous && miniGuide.next,
    escapeClosesOverlayOnly: playerStayedOpen,
    browserBackForward: browserHistory.returnedToLive && browserHistory.forwardRestoredPlayer,
  };
  if (Object.values(assertions).some((value) => !value)) {
    throw new Error(`Headless acceptance assertion failed: ${JSON.stringify({ assertions, home, accountSettings, helper, explore, live, backgroundStreamRequests, hoverPreview, details, sourceDialog, guideAudience, freeCollection, player, subtitleMenu, miniGuide, browserHistory })}`);
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
