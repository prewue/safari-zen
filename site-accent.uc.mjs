// Site accent colour for the sidebar.
//
// Cascade: favicon, <meta name="theme-color">, page canvas, monochrome favicon.
// One decision per navigation; the previous colour holds until it is made.
// Why it is shaped this way, the measurements and the traps: DEV.md §9.

const PREF = "mod.safari.site-accent";
const VAR_TOP = "--safari-accent-top";
const VAR_BOTTOM = "--safari-accent-bottom";
const VAR_SCRIM = "--safari-accent-scrim";
const ATTR = "safari-accent";
const ACTOR = "SafariZenAccent";

// Compositing. FADE_MS must match --safari-accent-time in chrome.css.
const ACCENT_ALPHA = 0.68;
const SCRIM_ALPHA = 0.62;
const SHEEN = 0.035;
const FADE_MS = 500;

// Deciding. Undecided past SETTLE_MAX_MS applies the best guess; after the
// top-level load stops, ICON_GRACE_MS is left for an icon still in flight.
const SETTLE_MAX_MS = 4000;
const ICON_GRACE_MS = 400;
const RETRY_MS = 900;

// Favicon scoring.
const ICON_SIZE = 32;
const MIN_ALPHA = 128;
const ICON_MIN_SATURATION = 0.15;
const ICON_MIN_MEAN_SATURATION = 0.22;
const MAX_LIGHTNESS = 0.93;
const MIN_LIGHTNESS = 0.07;
const HUE_BINS = 24;

// Normalisation: hue and chroma kept, lightness clamped into the scheme's band.
const NEUTRAL_BELOW = 0.08;
const SAT_MIN = 0.28;
const SAT_MAX = 0.80;
const L_DARK = [0.16, 0.34];
const L_LIGHT = [0.78, 0.93];
const MIN_CONTRAST = 4.5;
const SKIP_SCHEMES = ["chrome:", "about:", "resource:"];
const ORIGIN_LIMIT = 64;
const TAG = "[Safari-like Zen / accent]";
const HERE = import.meta.url.split("?")[0].replace(/[^/]+$/, "");
const root = document.documentElement;

// tab -> state of its current document (stateOf). iconColours: decoded icons
// by URL. byOrigin: final source colours, raw rgb so a scheme change
// re-normalises without re-reading.
const tabs = new WeakMap();
const iconColours = new Map();
const byOrigin = new Map();
let last = "";
let listening = false;
let fadeTimer = null;
let darkObserver = null;

// Hidden trace: console and safari-accent.log in the profile.
const DEBUG_PREF = "mod.safari.site-accent.debug";
const LOG_FILE = "safari-accent.log";
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

function enabled() {
  try {
    return Services.prefs.getBoolPref(PREF, false);
  } catch (e) {
    return false;
  }
}

// ---- colour maths. Local HSL conversions: Zen's differ in convention.
const picker = () => window.gZenThemePicker;

function parseColour(value) {
  if (!value) return null;
  try {
    const c = InspectorUtils.colorToRGBA(value);
    if (c) return [c.r, c.g, c.b, c.a ?? 1];
  } catch (e) {}
  const m = String(value)
    .trim()
    .match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  const hex = String(value).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full =
      h.length === 3
        ? h
            .split("")
            .map(x => x + x)
            .join("")
        : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  return null;
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = t => {
    t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

function luminance([r, g, b]) {
  const a = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function contrastRatio(a, b) {
  const p = picker();
  if (typeof p?.contrastRatio === "function") {
    try {
      return p.contrastRatio(a, b);
    } catch (e) {}
  }
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function compose(under, over, alpha) {
  return [
    Math.round(over[0] * alpha + under[0] * (1 - alpha)),
    Math.round(over[1] * alpha + under[1] * (1 - alpha)),
    Math.round(over[2] * alpha + under[2] * (1 - alpha)),
  ];
}

function isDarkChrome() {
  const attr = root.getAttribute("zen-should-be-dark-mode");
  if (attr === "true") return true;
  if (attr === "false") return false;
  const p = picker();
  if (typeof p?.isDarkMode === "boolean") return p.isDarkMode;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (e) {
    return true;
  }
}

function textColour() {
  try {
    const value = window
      .getComputedStyle(root)
      .getPropertyValue("--toolbox-textcolor");
    const parsed = parseColour(value);
    if (parsed) return parsed.slice(0, 3);
  } catch (e) {}
  return isDarkChrome() ? [255, 255, 255] : [0, 0, 0];
}

// ---- favicon
const NO_ICON = { chromatic: null, neutral: null };

// fetch() reads data: and http(s): icons; Places holds the bytes of any icon
// it has seen, including the moz-remote-image: SVGs fetch cannot read.
async function iconBlob(url, browser) {
  try {
    const response = await fetch(url);
    if (response.ok) return await response.blob();
  } catch (e) {}

  try {
    const pageURI = browser?.currentURI;
    if (pageURI) {
      const favicon = await PlacesUtils.favicons.getFaviconForPage(pageURI);
      if (favicon?.rawData?.length) {
        return new Blob([new Uint8Array(favicon.rawData)], {
          type: favicon.mimeType || "image/png",
        });
      }
    }
  } catch (e) {}

  return null;
}

// Last resort: let the browser render it. Resolves every scheme Zen hands out
// and rasterises an SVG without intrinsic size.
async function iconPixelsViaImage(url) {
  const img = new window.Image();
  img.src = url;
  await img.decode();

  const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE);
  return ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data;
}

async function iconPixels(url, browser) {
  const blob = await iconBlob(url, browser);
  if (blob) {
    try {
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: ICON_SIZE,
        resizeHeight: ICON_SIZE,

        // smooth downscaling invents hues
        resizeQuality: "pixelated",
      });
      try {
        const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, ICON_SIZE, ICON_SIZE);
        return ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data;
      } finally {
        bitmap.close?.();
      }
    } catch (e) {}
  }

  try {
    return await iconPixelsViaImage(url);
  } catch (e) {}

  return null;
}

async function accentFromIcon(url, browser) {
  if (!url) return NO_ICON;
  if (SKIP_SCHEMES.some(scheme => url.startsWith(scheme))) return NO_ICON;
  if (iconColours.has(url)) return iconColours.get(url);

  let colour = NO_ICON;
  try {
    const pixels = await iconPixels(url, browser);
    if (pixels) colour = dominantColour(pixels);
  } catch (e) {
    colour = NO_ICON;
  }

  // Only a real answer is cached; a miss is usually "not in Places yet".
  if (colour.chromatic || colour.neutral) {
    iconColours.set(url, colour);
    if (iconColours.size > ORIGIN_LIMIT * 2) {
      iconColours.delete(iconColours.keys().next().value);
    }
  }
  return colour;
}

// Chromatic pixels bucketed by hue, scored by count and saturation, the
// winner's mean. `neutral` is the mean of every opaque pixel.
function dominantColour(data) {
  const buckets = new Map();
  const all = { n: 0, r: 0, g: 0, b: 0 };

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < MIN_ALPHA) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);

    all.n++;
    all.r += r;
    all.g += g;
    all.b += b;

    if (l > MAX_LIGHTNESS || l < MIN_LIGHTNESS) continue;
    if (s < ICON_MIN_SATURATION) continue;

    const key = `${Math.floor((h / 360) * HUE_BINS)}|${Math.floor(s * 4)}|${Math.floor(l * 4)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { n: 0, r: 0, g: 0, b: 0, s: 0 };
      buckets.set(key, bucket);
    }
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.s += s;
  }

  const mean = bucket => [
    Math.round(bucket.r / bucket.n),
    Math.round(bucket.g / bucket.n),
    Math.round(bucket.b / bucket.n),
  ];

  let best = null;
  let bestScore = 0;
  for (const bucket of buckets.values()) {
    const score = bucket.n * (0.5 + bucket.s / bucket.n);
    if (score > bestScore) {
      bestScore = score;
      best = bucket;
    }
  }

  // anti-aliased edge pixels of a monochrome mark are not a colour
  if (best && best.s / best.n < ICON_MIN_MEAN_SATURATION) best = null;

  return {
    chromatic: best ? mean(best) : null,
    neutral: all.n ? mean(all) : null,
  };
}

// ---- normalisation. Clamp into the band, then push away from the text
// colour until the worst-case composite (accent over scrim over the least
// helpful page) clears MIN_CONTRAST at the end nearest the text.
function normalise(rgb) {
  const dark = isDarkChrome();
  const text = textColour();
  let [h, s, l] = rgbToHsl(...rgb);

  // neutral in, neutral out
  if (s >= NEUTRAL_BELOW) s = Math.min(SAT_MAX, Math.max(SAT_MIN, s));

  const [lo, hi] = dark ? L_DARK : L_LIGHT;
  l = Math.min(hi, Math.max(lo, l));

  const worst = compose(
    dark ? [255, 255, 255] : [0, 0, 0],
    dark ? [0, 0, 0] : [255, 255, 255],
    SCRIM_ALPHA
  );

  const nearText = dark ? SHEEN : -SHEEN;
  for (let i = 0; i < 20; i++) {
    const end = hslToRgb(h, s, Math.min(0.98, Math.max(0.03, l + nearText)));
    if (contrastRatio(compose(worst, end, ACCENT_ALPHA), text) >= MIN_CONTRAST) {
      break;
    }
    l = dark ? Math.max(0.05, l - 0.02) : Math.min(0.97, l + 0.02);
  }

  const end = offset => {
    const [r, g, b] = hslToRgb(h, s, Math.min(0.98, Math.max(0.03, l + offset)));
    return `rgba(${r}, ${g}, ${b}, ${ACCENT_ALPHA})`;
  };

  return { top: end(SHEEN), bottom: end(-SHEEN) };
}

// ---- applying. null = no accent: both ends fade to transparent and the
// theme comes back. The scrim is written here, not via light-dark(), which
// would follow the chrome scheme rather than Zen's dark-mode decision.
function apply(accent) {
  const top = accent?.top ?? "transparent";
  const bottom = accent?.bottom ?? "transparent";
  const key = `${top}|${bottom}`;
  if (key === last) return;
  last = key;

  root.style.setProperty(VAR_TOP, top);
  root.style.setProperty(VAR_BOTTOM, bottom);

  root.style.setProperty(
    VAR_SCRIM,
    accent
      ? isDarkChrome()
        ? `rgba(0, 0, 0, ${SCRIM_ALPHA})`
        : `rgba(255, 255, 255, ${SCRIM_ALPHA})`
      :

        isDarkChrome()
        ? "rgba(0, 0, 0, 0)"
        : "rgba(255, 255, 255, 0)"
  );

  window.clearTimeout(fadeTimer);

  // Attribute on at once (theme layer gone before the accent lands), off only
  // after the fade.
  if (accent) {
    root.setAttribute(ATTR, "true");
  } else {
    fadeTimer = window.setTimeout(
      () => root.removeAttribute(ATTR),
      FADE_MS + 40
    );
  }
}

function show(source, why) {
  debug("show", why, source, "selected=" + (window.gBrowser?.selectedBrowser?.currentURI?.spec || "").slice(0, 50));
  apply(source ? normalise(source) : null);
}

// ---- per-tab state
function originOf(browser) {
  try {
    return browser?.currentURI?.prePath || null;
  } catch (e) {
    return null;
  }
}

// Only Zen's empty tab is decided on selection. A bare about:blank elsewhere
// is a document on its way to being replaced, and is held.
function blank(tab) {
  return tab.hasAttribute("zen-empty-tab");
}

function stateOf(tab) {
  let s = tabs.get(tab);
  if (!s) {
    // epoch    bumped when a document commits; answers for an older one are dropped
    // iconURL  the icon the page set; icon: its reading, undefined while decoding
    // page     the actor's last report { themeColour, canvasColour, phase }
    // loaded   top-level network stop seen, and when
    // source   the rgb the accent derives from; null = no accent; undefined = undecided
    // final    whether a later signal may still improve it; tier: which tier gave it
    s = {
      epoch: 0,
      origin: null,

      iconURL: null,
      icon: undefined,

      page: null,

      loaded: false,
      loadedAt: 0,

      source: undefined,
      final: false,
      tier: null,
      started: 0,
      timer: null,
    };
    tabs.set(tab, s);
  }
  return s;
}

function selected(tab) {
  return tab === window.gBrowser?.selectedTab;
}

// Only final answers; a remembered miss would be permanent for the session.
function remember(origin, source) {
  if (!origin || !source) return;
  byOrigin.delete(origin);
  byOrigin.set(origin, source);
  if (byOrigin.size > ORIGIN_LIMIT) {
    byOrigin.delete(byOrigin.keys().next().value);
  }
}

function usable(parsed) {
  return parsed && parsed[3] >= 0.5 ? parsed.slice(0, 3) : null;
}

function sameSource(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// Whether an icon can still arrive: not once decoded, and not before the load
// has stopped with no pendingicon and ICON_GRACE_MS gone by.
function iconSettled(tab, s, now) {
  if (s.icon !== undefined) return true;
  if (!s.loaded) return false;
  if (tab.hasAttribute("pendingicon")) return false;
  return now - s.loadedAt >= ICON_GRACE_MS;
}

// The cascade against what is known. null = not yet; else { source, final, tier }.
function decide(tab, s) {
  const now = window.performance.now();
  const overdue = now - s.started > SETTLE_MAX_MS;

  // 1. favicon; everything below waits until the icon question is settled
  if (s.icon?.chromatic) return { source: s.icon.chromatic, final: true, tier: "icon" };
  if (!overdue && !iconSettled(tab, s, now)) return null;

  // 2. theme-color
  const meta = usable(parseColour(s.page?.themeColour));
  if (meta) return { source: meta, final: true, tier: "theme-color" };

  // 3. canvas, final once the stylesheets are in
  const settled = s.loaded || s.page?.phase === "load" || overdue;
  const canvas = usable(parseColour(s.page?.canvasColour));
  if (canvas) return { source: canvas, final: settled, tier: "canvas" };

  // 4. monochrome favicon
  if (s.icon?.neutral) return { source: s.icon.neutral, final: true, tier: "icon-neutral" };

  // nothing, once the page has said its last word
  if (settled && (s.page || s.loaded || overdue)) {
    return { source: null, final: true, tier: "none" };
  }
  return null;
}

// Re-run the cascade and act on what changed.
function evaluate(tab) {
  const s = tabs.get(tab);
  if (!s) return;
  const r = decide(tab, s);
  if (!r) return;

  // Provisional never replaces final; a chromatic-icon final is never demoted
  // by a later non-icon answer (a site setting a second, neutral icon).
  if (!r.final && s.final) return;
  if (s.final && sameSource(r.source, s.source)) return;
  if (s.final && s.tier === "icon" && r.tier !== "icon") return;
  debug(
    "decide",
    s.origin,
    r.tier,
    r.final ? "final" : "provisional",
    r.source,
    "| icon=" + (s.iconURL ? (s.icon === undefined ? "decoding" : s.icon.chromatic ? "chromatic" : s.icon.neutral ? "neutral" : "none") : "unset"),
    "page=" + (s.page ? s.page.phase + ":" + s.page.themeColour + "/" + s.page.canvasColour : "none"),
    "loaded=" + s.loaded,
    "pending=" + tab.hasAttribute("pendingicon"),
    "+" + Math.round(window.performance.now() - s.started) + "ms"
  );
  s.source = r.source;
  s.final = r.final;
  s.tier = r.tier;
  if (r.final) {
    remember(s.origin, r.source);
    window.clearTimeout(s.timer);
    s.timer = null;
  }
  if (selected(tab)) show(r.source, "decide/" + r.tier);
}

// A new document committed: start over. A known origin is shown at once;
// otherwise the previous colour holds until decide() answers.
function begin(tab, browser) {
  const s = stateOf(tab);
  s.epoch++;
  s.origin = originOf(browser);
  s.iconURL = null;
  s.icon = undefined;
  s.page = null;
  s.loaded = false;
  s.loadedAt = 0;
  s.source = undefined;
  s.final = false;
  s.tier = null;
  s.started = window.performance.now();
  window.clearTimeout(s.timer);
  s.timer = null;

  if (blank(tab)) {
    s.source = null;
    s.final = true;
    if (selected(tab)) show(null, "begin/empty");
    return;
  }

  if (selected(tab) && byOrigin.has(s.origin)) show(byOrigin.get(s.origin), "begin/origin");

  const epoch = s.epoch;

  // the deadline for a page that never settles
  s.timer = window.setTimeout(() => {
    if (s.epoch !== epoch) return;
    s.timer = null;
    evaluate(tab);
  }, SETTLE_MAX_MS + 20);
}

// A tab seen before any navigation of its own - restored, or open before the
// listener attached: read what tabbrowser already knows.
function seed(tab, browser) {
  const s = stateOf(tab);
  if (s.started) return s;
  s.started = window.performance.now();
  s.origin = originOf(browser);
  if (blank(tab)) {
    s.source = null;
    s.final = true;
    return s;
  }

  let spec = "";
  try {
    spec = browser.currentURI.spec;
  } catch (e) {}

  // on its way somewhere; begin() takes over when the page commits
  if (spec === "about:blank") {
    debug("seed", "about:blank held");
    return s;
  }
  s.loaded = !tab.hasAttribute("busy");
  s.loadedAt = s.started;
  const icon = window.gBrowser.getIcon(tab) || tab.getAttribute("image");
  debug("seed", s.origin, "loaded=" + s.loaded, "icon=" + (icon ? icon.slice(0, 40) : "none"));
  if (icon) takeIcon(tab, browser, icon);
  query(tab, browser);

  const epoch = s.epoch;
  window.setTimeout(() => {
    if (s.epoch !== epoch) return;
    evaluate(tab);
  }, ICON_GRACE_MS + 20);
  return s;
}

function takeIcon(tab, browser, url) {
  const s = stateOf(tab);
  if (!url || url === s.iconURL) return;
  s.iconURL = url;
  s.icon = undefined;
  const epoch = s.epoch;
  const stale = () => s.epoch !== epoch || s.iconURL !== url;

  const decode = attempt => {
    accentFromIcon(url, browser)
      .catch(() => NO_ICON)
      .then(colour => {
        if (stale()) return;
        s.icon = colour;
        evaluate(tab);

        // would not decode: one look back for an icon not yet in Places
        if (attempt === 0 && !colour.chromatic && !colour.neutral) {
          window.setTimeout(() => {
            if (stale()) return;
            decode(1);
          }, RETRY_MS);
        }
      });
  };
  decode(0);
}

function actorFor(browser) {
  try {
    return browser?.browsingContext?.currentWindowGlobal?.getActor(ACTOR) ?? null;
  } catch (e) {
    return null;
  }
}

// Ask the page, for a document whose reports went out before this window listened.
function query(tab, browser) {
  const actor = actorFor(browser);
  if (!actor) return;
  const s = stateOf(tab);
  const epoch = s.epoch;
  actor
    .sendQuery("Accent:Get")
    .then(data => {
      if (!data || s.epoch !== epoch || s.page) return;
      s.page = data;
      evaluate(tab);
    })
    .catch(() => {});
}

// Selected tab changed: show what is known, go looking for what is not.
function present() {
  const tab = window.gBrowser.selectedTab;
  const browser = window.gBrowser.selectedBrowser;
  if (!tab || !browser) return;
  const s = seed(tab, browser);
  if (s.source !== undefined) {
    show(s.source, "select/decided");
  } else if (byOrigin.has(s.origin)) {
    show(byOrigin.get(s.origin), "select/origin");
  }

  evaluate(tab);
}

// ---- events
function onTabSelect() {
  present();
}

function onAccent(event) {
  const { browser, themeColour, canvasColour, phase } = event.detail ?? {};
  if (!browser) return;
  const tab = window.gBrowser.getTabForBrowser?.(browser);
  if (!tab) return;
  const s = seed(tab, browser);
  debug("page", s.origin, phase, themeColour, canvasColour);
  s.page = { themeColour, canvasColour, phase };
  evaluate(tab);
}

// onLocationChange: every navigation passes through an about:blank - a new
// browser's initial document, a process switch - and none is a page.
// onStateChange: the top-level network stop, where tabbrowser itself gives
// up on an icon. onLinkIconAvailable: fires on every setIcon, changed or not,
// unlike TabAttrModified, which is silent when the same icon is set again.
const progressListener = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIWebProgressListener",
    "nsISupportsWeakReference",
  ]),
  onLocationChange(browser, webProgress, request, location, flags) {
    if (!webProgress?.isTopLevel) return;
    if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) return;
    const tab = window.gBrowser.getTabForBrowser?.(browser);
    if (!tab) return;

    if (location?.spec === "about:blank" && !tab.hasAttribute("zen-empty-tab")) {
      return;
    }
    debug("navigate", location?.spec?.slice(0, 60));
    begin(tab, browser);
  },

  onStateChange(browser, webProgress, request, flags) {
    const L = Ci.nsIWebProgressListener;
    if (!(flags & L.STATE_STOP) || !(flags & L.STATE_IS_NETWORK)) return;
    if (!webProgress?.isTopLevel) return;
    const tab = window.gBrowser.getTabForBrowser?.(browser);
    if (!tab) return;
    const s = seed(tab, browser);
    if (s.loaded) return;
    debug("load-stop", s.origin);
    s.loaded = true;
    s.loadedAt = window.performance.now();
    evaluate(tab);

    const epoch = s.epoch;
    window.setTimeout(() => {
      if (s.epoch !== epoch) return;
      evaluate(tab);
    }, ICON_GRACE_MS + 20);
  },

  onLinkIconAvailable(browser, iconURL) {
    if (!iconURL) return;
    const tab = window.gBrowser.getTabForBrowser?.(browser);
    if (!tab) return;
    debug("icon", originOf(browser), iconURL.slice(0, 60));
    seed(tab, browser);
    takeIcon(tab, browser, iconURL);
  },
};

// Zen's own dark-mode decision can flip per workspace: re-normalise, no re-read.
function onSchemeChange() {
  last = "";
  const tab = window.gBrowser?.selectedTab;
  const s = tab && tabs.get(tab);
  if (s && s.source !== undefined) {
    show(s.source, "scheme/decided");
  } else if (s && byOrigin.has(s.origin)) {
    show(byOrigin.get(s.origin), "scheme/origin");
  }
}

const scheme = window.matchMedia("(prefers-color-scheme: dark)");

// ---- lifecycle
function registerActor() {
  try {
    // once per process: re-registering throws (second window, mod reload)
    ChromeUtils.unregisterWindowActor(ACTOR);
  } catch (e) {}

  try {
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: { esModuleURI: HERE + "site-accent-parent.sys.mjs" },
      child: {
        esModuleURI: HERE + "site-accent-child.sys.mjs",
        events: {
          DOMContentLoaded: {},
          pageshow: {},
          load: { capture: true },
          DOMMetaAdded: {},
          DOMMetaChanged: {},
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
  window.addEventListener("SafariZenAccent:Colour", onAccent);
  window.gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
  window.gBrowser.addTabsProgressListener(progressListener);
  scheme.addEventListener("change", onSchemeChange);
  darkObserver = new window.MutationObserver(onSchemeChange);
  darkObserver.observe(root, {
    attributes: true,
    attributeFilter: ["zen-should-be-dark-mode"],
  });
  present();
}

function stop() {
  if (!listening) return;
  listening = false;
  try {
    window.removeEventListener("SafariZenAccent:Colour", onAccent);
    window.gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
    window.gBrowser.removeTabsProgressListener(progressListener);
    scheme.removeEventListener("change", onSchemeChange);
    darkObserver?.disconnect();
  } catch (e) {}
  darkObserver = null;
  byOrigin.clear();
  for (const tab of window.gBrowser.tabs) {
    const s = tabs.get(tab);
    if (s) window.clearTimeout(s.timer);
    tabs.delete(tab);
  }
  window.clearTimeout(fadeTimer);
  root.removeAttribute(ATTR);
  root.style.removeProperty(VAR_TOP);
  root.style.removeProperty(VAR_BOTTOM);
  root.style.removeProperty(VAR_SCRIM);
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
    console.warn(TAG, "gBrowser unavailable, site accent not tracked");
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
