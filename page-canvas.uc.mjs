// Page canvas colour for the pinned sidebar: --safari-pin-canvas, painted by
// chrome.css section 10 on the gap around the panel, the content placeholder
// and the container behind it. The child actor says what and when; this side
// applies, gated on the browser's layers being on screen, and never clears
// the variable while running. DEV.md §8.

const PREF = "mod.safari.pinned-panel";

// Hidden trace: console and safari-canvas.log in the profile.
const DEBUG_PREF = "mod.safari.pinned-panel.debug";
const LOG_FILE = "safari-canvas.log";
const VAR = "--safari-pin-canvas";
const ACTOR = "SafariZenCanvas";

// A colour for a browser without layers waits for MozLayerTreeReady; the
// layers are re-checked at LAYERS_RECHECK_MS and the colour forced on at
// LAYERS_FORCE_MS. Not a short timeout: that is the gap leading the page.
const LAYERS_RECHECK_MS = 2500;
const LAYERS_FORCE_MS = 6000;

// Pixel fallback, for a surface style cannot name.
const SAMPLES = [0.25, 0.55, 0.85];
const MIN_ALPHA = 250;
const SAMPLE_RETRY_MS = 120;

// The wash Zen paints its transparent browsers with (zen-browser-container.css).
const WASH_LIGHT = "rgba(255, 255, 255, 0.6)";
const WASH_DARK = "rgba(255, 255, 255, 0.1)";

// A pixel re-read within this of the cached colour is noise, not news.
const PIXEL_TOLERANCE = 12;
const TAG = "[Safari-like Zen / canvas]";
const HERE = import.meta.url.split("?")[0].replace(/[^/]+$/, "");
const root = document.documentElement;

// cache: resolved colour per <browser>, keyed on the element so it survives a
// process switch. pending: newest report per browser. waiting: colours held
// for MozLayerTreeReady.
let cache = new WeakMap();
let pending = new WeakMap();
let waiting = new WeakMap();
let last = "";
let listening = false;
let run = 0;

function enabled() {
  try {
    return Services.prefs.getBoolPref(PREF, false);
  } catch (e) {
    return false;
  }
}

let logPath = null;

function debug(...args) {
  try {
    if (!Services.prefs.getBoolPref(DEBUG_PREF, false)) return;
  } catch (e) {
    return;
  }
  const stamp = `${Math.round(window.performance.now())}ms`;
  console.log(TAG, stamp, ...args);
  try {
    logPath ??= PathUtils.join(PathUtils.profileDir, LOG_FILE);
    const line = `${new Date().toISOString()} ${stamp} ${args
      .map(a => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")}\n`;
    IOUtils.writeUTF8(logPath, line, { mode: "appendOrCreate" }).catch(() => {});
  } catch (e) {}
}

function apply(colour, why) {
  if (!colour || colour === last) return;
  last = colour;
  root.style.setProperty(VAR, colour);
  debug("apply", colour, "<-", why);
}

// The content-side scheme, the same signal the CSS fallbacks key off.
function contentIsDark() {
  try {
    return window.matchMedia("(-moz-content-prefers-color-scheme: dark)").matches;
  } catch (e) {
    return false;
  }
}

function rightSide() {
  return root.getAttribute("zen-right-side") === "true";
}

// Whether the compositor shows this browser; a browser in the parent process
// has no layer tree to wait for.
function showing(browser) {
  try {
    return !browser.isRemoteBrowser || !!browser.hasLayers;
  } catch (e) {
    return true;
  }
}

function selectedBrowser() {
  return window.gBrowser?.selectedBrowser;
}

// ---- layers. Apply now if on screen, otherwise when the layers arrive.
function present(browser, colour, why) {
  if (showing(browser)) {
    forget(browser);
    apply(colour, why);
    return;
  }
  const entry = waiting.get(browser);
  if (entry) {
    entry.colour = colour;
    entry.why = why;
    debug("deferred until layers (updated)", colour, why);
    return;
  }
  const since = window.performance.now();
  waiting.set(browser, { colour, why, since, timer: null });
  debug("deferred until layers", colour, why);
  schedule(browser, LAYERS_RECHECK_MS);
}

function schedule(browser, ms) {
  const entry = waiting.get(browser);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => recheck(browser), ms);
}

function recheck(browser) {
  const entry = waiting.get(browser);
  if (!entry) return;
  entry.timer = null;
  const waited = window.performance.now() - entry.since;
  if (showing(browser)) {
    release(browser, "layers-recheck");
  } else if (waited >= LAYERS_FORCE_MS) {
    release(browser, "layers-forced");
  } else {
    schedule(browser, Math.max(100, LAYERS_FORCE_MS - waited));
  }
}

function forget(browser) {
  const entry = waiting.get(browser);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  waiting.delete(browser);
}

function release(browser, why) {
  const entry = waiting.get(browser);
  if (!entry) return;
  forget(browser);
  if (browser === selectedBrowser()) apply(entry.colour, `${entry.why}/${why}`);
}

function onLayersReady(event) {
  release(event.originalTarget, "layers-ready");
}

// ---- pixel fallback
function readPixel(bitmap) {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, 1, 1).data;
}

// drawSnapshot resolves to false, not throws, when the content is gone.
async function samplePixel(browser, x, y) {
  const bitmap = await browser.drawSnapshot(x, y, 1, 1, 1, "transparent");
  if (!bitmap) return null;
  try {
    const d = readPixel(bitmap);
    if (d[3] < MIN_ALPHA) return null;
    return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
  } finally {
    bitmap.close?.();
  }
}

function channels(colour) {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(colour);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

function near(a, b) {
  const x = channels(a);
  const y = channels(b);
  if (!x || !y) return a === b;
  return x.every((v, i) => Math.abs(v - y[i]) <= PIXEL_TOLERANCE);
}

function mode(values) {
  let best = null;
  let bestCount = 0;
  for (const v of values) {
    const count = values.filter(o => o === v).length;
    if (count > bestCount) {
      best = v;
      bestCount = count;
    }
  }
  return best;
}

// The bounds are chrome pixels; drawSnapshot's rect is content CSS pixels.
async function sample(browser) {
  let width = 0;
  let height = 0;
  try {
    const bounds = window.windowUtils.getBoundsWithoutFlushing(browser);
    const zoom = browser.fullZoom || 1;
    width = bounds.width / zoom;
    height = bounds.height / zoom;
  } catch (e) {}
  if (!height) return null;

  const x = rightSide() ? Math.max(0, Math.floor(width) - 2) : 1;
  const results = await Promise.all(
    SAMPLES.map(fraction =>
      samplePixel(browser, x, Math.round(height * fraction)).catch(() => null)
    )
  );
  return mode(results.filter(Boolean));
}

// ---- reports. What the child said, made paintable.
async function resolve(browser, colour) {
  if (colour) return colour;

  const tab = window.gBrowser.getTabForBrowser?.(browser);
  if (tab?.hasAttribute("zen-empty-tab")) {
    // the empty tab, by the tab's own attribute: the browser's `transparent` is
    // set on a tab created empty and never cleared
    return contentIsDark() ? WASH_DARK : WASH_LIGHT;
  }

  return (

    // style could not name it: pixels, once, with one retry across a process switch
    (await sample(browser)) ??
    (await new Promise(r => window.setTimeout(r, SAMPLE_RETRY_MS)).then(() =>
      sample(browser)
    ))
  );
}

async function settle(browser, data, why) {
  if (!browser || !data) return;

  // a query on a document that has not painted or is hidden
  if (data.ready === false) {
    debug("skip not-ready", why, data.reason);
    return;
  }
  const token = {};
  pending.set(browser, token);
  const mine = run;
  let colour = null;
  try {
    colour = await resolve(browser, data.colour);
  } catch (e) {
    debug("resolve failed", e?.message ?? e);
  }

  // superseded by a newer report, or by stop()
  if (mine !== run || pending.get(browser) !== token) return;
  if (!colour) return;

  // pixel noise is not a correction
  if (!data.colour) {
    const known = cache.get(browser);
    if (known && near(known, colour)) colour = known;
  }

  cache.set(browser, colour);
  const selected = browser === selectedBrowser();
  debug(
    "report",
    why,
    data.reason,
    colour,
    selected ? "selected" : "background",
    showing(browser) ? "layers" : "no-layers"
  );
  if (selected) present(browser, colour, `${why}/${data.reason}`);
}

function onColour(event) {
  const { browser, colour, reason } = event.detail ?? {};
  settle(browser, { colour, reason }, "paint").catch(() => {});
}

function onChildDebug(event) {
  const { browser, args } = event.detail ?? {};
  const sel = browser === selectedBrowser() ? "*" : " ";
  debug("child" + sel, ...(args ?? []));
}

function actorFor(browser) {
  try {
    return browser?.browsingContext?.currentWindowGlobal?.getActor(ACTOR) ?? null;
  } catch (e) {
    return null;
  }
}

// Ask the page; applied only if the browser is still selected when it answers.
function query(browser, why) {
  const actor = actorFor(browser);
  if (!actor) return;
  actor
    .sendQuery("Canvas:Get")
    .then(data => {
      if (browser !== selectedBrowser()) return;
      return settle(browser, data, why);
    })
    .catch(e => debug("query failed", why, e?.message ?? e));
}

function nudge(browser, force = false) {
  try {
    actorFor(browser)?.sendAsyncMessage("Canvas:Refresh", { force });
  } catch (e) {}
}

// The one synchronous path: the cache, then a confirming query. The empty
// tab's actor never activates (initial about:blank), so its wash is written
// directly - then leaving it is one change, the new page's first paint.
function onTabSelect() {
  const browser = selectedBrowser();
  if (!browser) return;

  const tab = window.gBrowser.selectedTab;
  if (tab?.hasAttribute("zen-empty-tab")) {
    apply(contentIsDark() ? WASH_DARK : WASH_LIGHT, "tab-select/empty");
    return;
  }
  const cached = cache.get(browser);
  if (cached) present(browser, cached, "tab-select");
  query(browser, cached ? "tab-select/confirm" : "tab-select/query");
}

// A document swap reports itself when it paints. A same-document route may
// restyle without a new document: ask the page to watch its next paints.
const progressListener = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIWebProgressListener",
    "nsISupportsWeakReference",
  ]),

  onLocationChange(browser, webProgress, request, location, flags) {
    if (!webProgress?.isTopLevel) return;
    if (!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) return;
    if (browser !== selectedBrowser()) return;
    nudge(browser);
  },
};

const scheme = window.matchMedia("(prefers-color-scheme: dark)");

// Cached colours were read under the old scheme; the page repaints on its own.
const onSchemeChange = () => {
  cache = new WeakMap();
  nudge(selectedBrowser(), true);
};

// The sampled edge follows the sidebar; the child reads the pref itself.
let sideObserver = null;
const onSideChange = () => {
  cache = new WeakMap();
  nudge(selectedBrowser(), true);
};

// ---- lifecycle
function registerActor() {
  try {
    // once per process: re-registering throws (second window, mod reload)
    ChromeUtils.unregisterWindowActor(ACTOR);
  } catch (e) {}

  try {
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: { esModuleURI: HERE + "page-canvas-parent.sys.mjs" },
      child: {
        esModuleURI: HERE + "page-canvas-child.sys.mjs",
        events: {
          // before the first paint; the child arms its own paint listener
          DOMWindowCreated: {},
          DOMContentLoaded: {},
          load: { capture: true },
          pageshow: {},
        },
      },
      allFrames: false,
      messageManagerGroups: ["browsers"],

      // without this the actor never exists on an ordinary site
      safeForUntrustedWebProcess: true,
    });
    return true;
  } catch (e) {
    console.error(TAG, "actor registration failed:", e);
    return false;
  }
}

function start() {
  if (listening) return;
  if (!registerActor()) return;
  listening = true;
  window.addEventListener("SafariZenCanvas:Colour", onColour);
  window.addEventListener("SafariZenCanvas:Debug", onChildDebug);
  window.addEventListener("MozLayerTreeReady", onLayersReady);
  window.gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
  window.gBrowser.addTabsProgressListener(progressListener);
  scheme.addEventListener("change", onSchemeChange);
  sideObserver = new window.MutationObserver(onSideChange);
  sideObserver.observe(root, {
    attributes: true,
    attributeFilter: ["zen-right-side"],
  });
  onTabSelect();
}

function stop() {
  if (!listening) return;
  listening = false;
  run++;
  try {
    window.removeEventListener("SafariZenCanvas:Colour", onColour);
    window.removeEventListener("SafariZenCanvas:Debug", onChildDebug);
    window.removeEventListener("MozLayerTreeReady", onLayersReady);
    window.gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
    window.gBrowser.removeTabsProgressListener(progressListener);
    scheme.removeEventListener("change", onSchemeChange);
    sideObserver?.disconnect();
  } catch (e) {}
  sideObserver = null;
  for (const browser of window.gBrowser.browsers) forget(browser);

  root.style.removeProperty(VAR);
  cache = new WeakMap();
  pending = new WeakMap();
  waiting = new WeakMap();
  last = "";
}

function sync() {
  if (enabled()) {
    start();
  } else {
    stop();
  }
}

function init() {
  if (!window.gBrowser?.tabContainer) {
    console.warn(TAG, "gBrowser unavailable, page canvas colour not tracked");
    return;
  }

  sync();
  Services.prefs.addObserver(PREF, sync);

  window.addEventListener(
    "unload",
    () => {
      try {
        Services.prefs.removeObserver(PREF, sync);
        stop();
      } catch (e) {}
    },
    { once: true }
  );
}

if (document.readyState === "complete") {
  window.setTimeout(init, 800);
} else {
  window.addEventListener("load", () => window.setTimeout(init, 800), {
    once: true,
  });
}
