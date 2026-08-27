// Page canvas colour for the pinned sidebar.
//
// Section 10 of chrome.css paints #navigator-toolbox with the colour of the
// page canvas, so the gap around the floating panel reads as page rather than
// as the workspace gradient - which is what compact has behind its panel, the
// page card spanning the whole window underneath it.
//
// A fixed light/dark pair gets that wrong the moment a site brings its own
// background: GitHub's dark #0d1117 against a hardcoded #202020 is plainly a
// different colour. So the page is asked.
//
// Two things have to be right, and neither can be known from this process:
//
//   what   The colour showing at the left edge. Resolved from layout in the
//          content process (page-canvas-child.sys.mjs): the first opaque
//          background under each of three points down the edge, which changes
//          only when the page restyles itself. Pixels were tried first and
//          change whenever the page's content does - an image loading, a video
//          playing - which is what made the gap jump at random on a live page.
//
//   when   The frame the new document reaches the screen. drawSnapshot
//          rasterises the document the moment it exists, about a second before
//          the compositor shows it on a slow site, and every parent-side
//          milestone is a network one. The content process knows: it reports
//          from MozAfterPaint, after the paint has been composited, so the gap
//          changes in the same frame as the page. (In-tree precedent:
//          LoginManagerChild.sys.mjs:1707-1773, DOMFullscreenChild.sys.mjs:124-156.)
//
// This side only applies what it is told. It writes the variable when the
// selected browser reports a change, and on a tab switch from a per-browser
// cache, synchronously in the handler. It never clears the variable while
// running: handing it back to the CSS fallback is itself a visible jump.
//
// One more thing the content process cannot see: whether its frames are being
// shown at all. Across a process switch - and on a switch to a tab that had
// no layers - the compositor has nothing for the browser yet and the <browser>
// paints its own placeholder, dark grey under a dark scheme, while the new
// process is already painting into layers that are not on screen. The parent
// does know: browser.hasLayers, and MozLayerTreeReady when it flips. A colour
// for a browser without layers waits for that event (the async tab switcher's
// own definition of "the tab is now visible", AsyncTabSwitcher.sys.mjs:783).
//
// Two reconciliations back the reports up, both after the fact and so unable
// to lead the page: a tab switch asks the page again after applying the cache,
// and the end of a top-level load asks once more. A report that was lost, or
// deduplicated on the content side, is corrected there rather than on the
// next visit to the tab.
//
// Pixels are still read in one case - a canvas that style alone cannot name:
// transparent (the page paints Zen's default), translucent, a gradient or an
// image. Then three 1x1 drawSnapshot pixels down the left edge decide, exactly
// as before, but only once and only after the page has painted, when the
// rasterisation and the screen agree.

const PREF = "mod.safari.pinned-panel";
// Hidden. Logs every report and every write with a timestamp - to the console
// and, appended, to safari-canvas.log in the profile - so "how many times did
// it change during that load" is a number rather than an impression.
const DEBUG_PREF = "mod.safari.pinned-panel.debug";
const LOG_FILE = "safari-canvas.log";
// How long a colour waits for MozLayerTreeReady before going on regardless.
// The tab switcher itself stops waiting for layers after 400ms and shows what
// it has; past that the browser is on screen whatever hasLayers says.
const LAYERS_WAIT_MS = 600;
const VAR = "--safari-pin-canvas";
const ACTOR = "SafariZenCanvas";

// Fractions of the viewport height for the pixel fallback, one pixel in from
// the left edge. Three rather than one because the top-left pixel of a page is
// usually a header; the value that recurs down the edge is the canvas.
const SAMPLES = [0.25, 0.55, 0.85];
const MIN_ALPHA = 250;
const SAMPLE_RETRY_MS = 120;

// Zen's translucent browsers - the empty tab - show the workspace gradient
// through a white wash (zen-browser-container.css:20-22). Matching them means
// the same wash, not `transparent`, which comes out visibly darker.
const WASH_LIGHT = "rgba(255, 255, 255, 0.6)";
const WASH_DARK = "rgba(255, 255, 255, 0.1)";

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
// Colours for browsers whose layers are not on screen yet, applied on
// MozLayerTreeReady - or after LAYERS_WAIT_MS, whichever comes first.
let waiting = new WeakMap();
let waitTimer = null;

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

// Whether the compositor is showing this browser's content. A browser in the
// parent process has no layer tree of its own to wait for.
function showing(browser) {
  try {
    return !browser.isRemoteBrowser || !!browser.hasLayers;
  } catch (e) {
    return true;
  }
}

// Apply now if the browser is on screen, otherwise when it gets there.
function present(browser, colour, why) {
  if (showing(browser)) {
    waiting.delete(browser);
    apply(colour, why);
    return;
  }
  waiting.set(browser, colour);
  debug("deferred until layers", colour, why);
  window.clearTimeout(waitTimer);
  waitTimer = window.setTimeout(() => release(browser, "layers-timeout"), LAYERS_WAIT_MS);
}

function release(browser, why) {
  const colour = waiting.get(browser);
  if (!colour) return;
  waiting.delete(browser);
  if (browser === window.gBrowser.selectedBrowser) apply(colour, why);
}

function onLayersReady(event) {
  release(event.originalTarget, "layers-ready");
}

function actorFor(browser) {
  try {
    return browser?.browsingContext?.currentWindowGlobal?.getActor(ACTOR) ?? null;
  } catch (e) {
    return null;
  }
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
  let height = 0;
  try {
    // The bounds are chrome pixels; drawSnapshot's rect is content CSS pixels,
    // which differ by the page zoom. Without the division the lowest sample
    // falls off the viewport on a zoomed page and reads as unpainted.
    height =
      window.windowUtils.getBoundsWithoutFlushing(browser).height /
      (browser.fullZoom || 1);
  } catch (e) {}
  if (!height) return null;

  const results = await Promise.all(
    SAMPLES.map(fraction =>
      samplePixel(browser, 1, Math.round(height * fraction)).catch(() => null)
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
  // never clears it on navigation (ZenSpaceManager / tabbrowser.js:2960), so a
  // page opened from a new tab still carries it and would be washed grey. The
  // tab's own `zen-empty-tab` is kept current by #changeToEmptyTab, and is the
  // same state the CSS fallback keys off.
  const tab = window.gBrowser.getTabForBrowser?.(browser);
  if (tab?.hasAttribute("zen-empty-tab")) {
    return contentIsDark() ? WASH_DARK : WASH_LIGHT;
  }
  // The canvas is a gradient, an image, or translucent - style could not name
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
  // A read from a document that has not had its first contentful paint, or is
  // not on screen, is not the page yet. The paint push will bring the real one
  // once it is; do not paint a placeholder in the meantime. (Paint pushes omit
  // the flag and so are always taken.)
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

  cache.set(browser, colour);
  const selected = browser === window.gBrowser.selectedBrowser;
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
  const sel = browser === window.gBrowser?.selectedBrowser ? "*" : " ";
  debug("child" + sel, ...(args ?? []));
}

// Ask the page what it shows right now. Applied only if the browser is still
// the selected one when the answer comes back.
function query(browser, why) {
  const actor = actorFor(browser);
  if (!actor) return;
  actor
    .sendQuery("Canvas:Get")
    .then(data => {
      if (browser !== window.gBrowser.selectedBrowser) return;
      return settle(browser, data, why);
    })
    .catch(e => debug("query failed", why, e?.message ?? e));
}

// The only synchronous path there is: the tab is already painted and, if it
// has reported before, its colour is already known. Paint it in the same tick
// as the switch, then ask the page to confirm - the page is on screen, so a
// different answer now is a correction, not a lead.
function onTabSelect() {
  const browser = window.gBrowser.selectedBrowser;
  const cached = cache.get(browser);
  if (cached) present(browser, cached, "tab-select");
  query(browser, cached ? "tab-select/confirm" : "tab-select/query");
}

function nudge(browser, force = false) {
  try {
    actorFor(browser)?.sendAsyncMessage("Canvas:Refresh", { force });
  } catch (e) {}
}

const progressListener = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIWebProgressListener",
    "nsISupportsWeakReference",
  ]),
  // A new document reports itself when it paints; nothing is done here for
  // that. A same-document change - an SPA route - creates no document and so
  // no first paint, but may well restyle, so the page is asked to watch its
  // next few paints.
  onLocationChange(browser, webProgress, request, location, flags) {
    if (!webProgress?.isTopLevel) return;
    if (!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) {
      // A document swap paints itself and pushes; nothing to do here. Acting on
      // it would be acting on a network milestone, which is what led the page.
      return;
    }
    // A same-document route change creates no document and so no first paint,
    // but may restyle; ask the page to watch its next few paints.
    if (browser !== window.gBrowser.selectedBrowser) return;
    nudge(browser);
  },
};

const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const onSchemeChange = () => {
  // Every cached colour was read under the old scheme. The page restyles and
  // repaints on its own; it only has to be told to look again.
  cache = new WeakMap();
  nudge(window.gBrowser.selectedBrowser, true);
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
  } catch (e) {}
  // Hand the gap back to the static light/dark pair in chrome.css.
  root.style.removeProperty(VAR);
  window.clearTimeout(waitTimer);
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
