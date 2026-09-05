// Page canvas colour for the pinned sidebar.
//
// Section 10 of chrome.css paints three things with --safari-pin-canvas: the
// gap around the floating panel, the content browser's own placeholder, and the
// container behind it. Together they make the window one surface in the page's
// colour - around the panel, and in the page area while a page is on its way -
// which is what compact mode has behind its panel: the page itself.
//
// Two things have to be right, and neither can be known from this process:
//
//   what   The surface at the page's edge on the sidebar's side. Resolved from
//          layout in the content process (page-canvas-child.sys.mjs), which
//          changes only when the page restyles itself, not when its content
//          scrolls or an image lands.
//
//   when   The frame the new document reaches the screen. The content process
//          reports from MozAfterPaint, after the paint has been composited, so
//          the gap changes in the same frame as the page.
//
// This side only applies what it is told: the selected browser's reports as
// they come, and a per-browser cache on a tab switch, synchronously in the
// handler. It never clears the variable while running - handing it back to
// the CSS fallback is itself a visible jump - so between a navigation and the
// new page's first paint the whole window simply keeps the previous colour.
//
// One more thing the content process cannot see: whether its frames are being
// shown at all. Across a process switch - every cross-site navigation, with
// Fission - the compositor has nothing for the browser yet and the <browser>
// paints its own placeholder while the new process is already painting into
// layers that are not on screen. The parent does know: browser.hasLayers, and
// MozLayerTreeReady when it flips. A colour for a browser without layers waits
// for that event. It is not applied on a short timeout: that is exactly the
// case where the gap turns the new page's colour while the page area still
// shows the placeholder, and the reason the wait is long and re-checks the
// layers before giving up.
//
// Pixels are read in one case - a surface that style alone cannot name: a
// gradient or an image, a translucent layer, or nothing opaque at all. Then
// three 1x1 drawSnapshot pixels down the edge decide, once, after the page
// has painted, when the rasterisation and the screen agree.

const PREF = "mod.safari.pinned-panel";
// Hidden. Logs every report and every write with a timestamp - to the console
// and, appended, to safari-canvas.log in the profile - so "how many times did
// it change during that load" is a number rather than an impression.
const DEBUG_PREF = "mod.safari.pinned-panel.debug";
const LOG_FILE = "safari-canvas.log";
const VAR = "--safari-pin-canvas";
const ACTOR = "SafariZenCanvas";

// A colour for a browser whose layers are not on screen waits for
// MozLayerTreeReady. After LAYERS_RECHECK_MS the layers are looked at again in
// case the event was missed; after LAYERS_FORCE_MS the colour goes on
// regardless, so a browser that never reports layers cannot wedge the gap.
const LAYERS_RECHECK_MS = 2500;
const LAYERS_FORCE_MS = 6000;

// Fractions of the viewport height for the pixel fallback, one pixel in from
// the edge. Three rather than one because the top of a page is usually a
// header; the value that recurs down the edge is the surface.
const SAMPLES = [0.25, 0.55, 0.85];
const MIN_ALPHA = 250;
const SAMPLE_RETRY_MS = 120;

// Zen's translucent browsers - the empty tab - show the workspace gradient
// through a white wash (zen-browser-container.css:20-22). Matching them means
// the same wash, not `transparent`, which comes out visibly darker.
const WASH_LIGHT = "rgba(255, 255, 255, 0.6)";
const WASH_DARK = "rgba(255, 255, 255, 0.1)";

// Two pixel reads of the same gradient a moment apart differ by a few units -
// antialiasing, a scroll, a hover. Within this much of what is already
// showing, the read is the same answer, not a correction.
const PIXEL_TOLERANCE = 12;

const TAG = "[Safari-like Zen / canvas]";

// Sibling modules, resolved off this file's own URL: the mod folder is whatever
// id Sine fixed at first install, not necessarily the one in theme.json.
const HERE = import.meta.url.split("?")[0].replace(/[^/]+$/, "");

const root = document.documentElement;

// The resolved colour of each <browser>, so a switch back is instant. Keyed on
// the element rather than the tab: it survives a process switch, and it is
// what the actor hands back.
let cache = new WeakMap();
// The most recent report per browser, so a slower pixel read cannot land over
// a newer answer.
let pending = new WeakMap();
// Colours for browsers whose layers are not on screen yet: { colour, why,
// since, timer }, applied on MozLayerTreeReady or by the timers above.
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

// The content-side scheme, the same signal the CSS fallbacks key off. Chrome
// documents expose the media feature; if a build does not, light is the safer
// guess since it is the more visible wash.
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

// Whether the compositor is showing this browser's content. A browser in the
// parent process has no layer tree of its own to wait for.
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

// ---- layers ---------------------------------------------------------------

// Apply now if the browser is on screen, otherwise when it gets there.
function present(browser, colour, why) {
  if (showing(browser)) {
    forget(browser);
    apply(colour, why);
    return;
  }
  const entry = waiting.get(browser);
  if (entry) {
    // A newer colour for the same wait: keep the clock, replace the answer.
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

// ---- pixel fallback -------------------------------------------------------

function readPixel(bitmap) {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, 1, 1).data;
}

async function samplePixel(browser, x, y) {
  // drawSnapshot resolves to false rather than throwing when the content is
  // gone, mid-navigation or crashed.
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

// Most frequent value, first one wins a tie. With three samples this is "two
// agree" in practice, and falls back to the topmost sample when all differ.
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

async function sample(browser) {
  let width = 0;
  let height = 0;
  try {
    // The bounds are chrome pixels; drawSnapshot's rect is content CSS pixels,
    // which differ by the page zoom. Without the division the lowest sample
    // falls off the viewport on a zoomed page and reads as unpainted.
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

// ---- reports --------------------------------------------------------------

// What the child said, turned into something paintable.
async function resolve(browser, colour) {
  if (colour) return colour;
  // Only a genuinely empty tab gets the wash. The <browser> `transparent`
  // attribute is no good for this: Zen sets it when a tab is created empty and
  // never clears it on navigation (tabbrowser.js:2960), so a page opened from
  // a new tab still carries it and would be washed grey. The tab's own
  // `zen-empty-tab` is kept current by #changeToEmptyTab, and is the same
  // state the CSS fallback keys off.
  const tab = window.gBrowser.getTabForBrowser?.(browser);
  if (tab?.hasAttribute("zen-empty-tab")) {
    return contentIsDark() ? WASH_DARK : WASH_LIGHT;
  }
  // The surface is a gradient, an image, or translucent - style could not name
  // it. Read what is actually on screen. drawSnapshot answers false
  // mid-process-switch, so one more look a moment later is cheap.
  return (
    (await sample(browser)) ??
    (await new Promise(r => window.setTimeout(r, SAMPLE_RETRY_MS)).then(() =>
      sample(browser)
    ))
  );
}

async function settle(browser, data, why) {
  if (!browser || !data) return;
  // A read from a document that has not had its first paint, or is not on
  // screen, is not the page yet. The paint push will bring the real one once
  // it is; do not paint a placeholder in the meantime. (Paint pushes are past
  // the gate by construction.)
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
  // Superseded by a newer report, or by stop().
  if (mine !== run || pending.get(browser) !== token) return;
  if (!colour) return;

  // A pixel read that lands within a whisker of the colour already known for
  // this browser is noise, not news; keep what is on screen.
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

// Ask the page what it shows right now. Applied only if the browser is still
// the selected one when the answer comes back.
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

// The only synchronous path there is: the tab is already painted and, if it
// has reported before, its colour is already known. Paint it in the same tick
// as the switch, then ask the page to confirm - the page is on screen, so a
// different answer now is a correction, not a lead.
function onTabSelect() {
  const browser = selectedBrowser();
  if (!browser) return;
  // The empty tab has no document to ask - the actor never activates on an
  // initial about:blank - and its answer is known anyway: the wash. Written
  // into the variable rather than left to the CSS branch, so that the moment
  // this tab starts navigating and the empty-tab branch drops away, the gap
  // and the placeholder are still the wash, and the next change is the new
  // page's own first paint.
  const tab = window.gBrowser.selectedTab;
  if (tab?.hasAttribute("zen-empty-tab")) {
    apply(contentIsDark() ? WASH_DARK : WASH_LIGHT, "tab-select/empty");
    return;
  }
  const cached = cache.get(browser);
  if (cached) present(browser, cached, "tab-select");
  query(browser, cached ? "tab-select/confirm" : "tab-select/query");
}

const progressListener = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIWebProgressListener",
    "nsISupportsWeakReference",
  ]),
  // A new document reports itself when it paints; nothing is done here for
  // that - acting on it would be acting on a network milestone, which leads
  // the page. A same-document change - an SPA route - creates no document and
  // so no first paint, but may well restyle, so the page is asked to watch its
  // next few paints.
  onLocationChange(browser, webProgress, request, location, flags) {
    if (!webProgress?.isTopLevel) return;
    if (!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) return;
    if (browser !== selectedBrowser()) return;
    nudge(browser);
  },
};

const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const onSchemeChange = () => {
  // Every cached colour was read under the old scheme. The page restyles and
  // repaints on its own; it only has to be told to look again.
  cache = new WeakMap();
  nudge(selectedBrowser(), true);
};

// The sampled edge follows the sidebar. Zen flips the attribute when the pref
// changes; the child reads the pref itself, and only has to be asked again.
let sideObserver = null;
const onSideChange = () => {
  cache = new WeakMap();
  nudge(selectedBrowser(), true);
};

// ---- lifecycle ------------------------------------------------------------

function registerActor() {
  // Once per process, and this script runs once per window, so re-registering
  // throws for every window after the first and for every mod reload.
  try {
    ChromeUtils.unregisterWindowActor(ACTOR);
  } catch (e) {}

  try {
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: { esModuleURI: HERE + "page-canvas-parent.sys.mjs" },
      child: {
        esModuleURI: HERE + "page-canvas-child.sys.mjs",
        events: {
          // Creates the actor with the document, before its first paint; the
          // child wires up its own paint listener from there.
          DOMWindowCreated: {},
          DOMContentLoaded: {},
          load: { capture: true },
          pageshow: {},
        },
      },
      allFrames: false,
      messageManagerGroups: ["browsers"],
      // Without this the actor is never created in an untrusted web content
      // process - which is every ordinary site - and it fails silently.
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
  // Hand the gap back to the static light/dark pair in chrome.css.
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
