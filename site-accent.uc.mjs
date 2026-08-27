// Site accent colour for the sidebar.
//
// The sidebar takes the colour of the site you are on, in compact mode and
// pinned mode alike, and cross-fades when you move between pages.
//
// ---------------------------------------------------------------------------
// Where the colour comes from
// ---------------------------------------------------------------------------
//
// A cascade, in this order:
//
//   1. the favicon's dominant colour - free and synchronous to trigger
//      (gBrowser.getIcon), and the only per-site signal Firefox already tracks;
//   2. <meta name="theme-color"> - the site's own declaration, and the most
//      accurate answer when it exists. Firefox does not parse it, so it arrives
//      from site-accent-child.sys.mjs;
//   3. the page's canvas colour, from the same actor.
//
// Zen's getMostDominantColor is a false friend and is not used: it reads the
// dots of the user's own workspace gradient (ZenGradientGenerator.mjs:1489), not
// anything about the page.
//
// ---------------------------------------------------------------------------
// What is done with it
// ---------------------------------------------------------------------------
//
// The accent keeps the site's hue and chroma, and only its lightness is clamped
// into the band the current scheme already occupies. Taken literally, "the
// site's colour" paints a #ff0000 sidebar on YouTube with white tab labels on
// saturated red. Clamping instead means no chrome text colour has to be touched,
// so nothing here fights ZenGradientGenerator's own zen-should-be-dark-mode /
// --toolbox-textcolor writes.
//
// Clamped, not blended toward a target. Mixing 75% of a target lightness into
// the source is what made every site land on roughly the same washed-out shade:
// the hue survived and everything that made it recognisable did not.
//
// The accent is translucent, but it is not laid over the workspace theme.
//
// Those are two separate things, and conflating them cost a round trip. A
// translucent accent stacked on the theme shows the theme through it, which is
// what made a blue site come out muddy purple-blue. An opaque accent fixes the
// colour and kills the panel's backdrop-filter, which is most of what makes the
// sidebar look like glass.
//
// So while an accent is showing, :root carries [safari-accent] and section 11
// drops the theme layer entirely. What is behind the accent is then the blur
// itself, which is what should be behind it - the colour stays true and the
// glass survives.
//
// Behind that, a scrim. A translucent accent over a raw blur is at the mercy of
// the page: the same blue reads 7.7:1 against white labels over a dark site and
// 2.9:1 over a white one, so the sidebar is legible on some sites and not on
// others. The scrim settles the backdrop to something known before the accent
// lands on it, which is the same job Zen's own brightness(0.25) does inside its
// acrylic filter - the one section 4 of this file strips out for being a
// dark-mode hardcode.
//
// Two values are published, --safari-accent-top and --safari-accent-bottom: a
// shallow vertical gradient in the site's own hue rather than one flat fill,
// which is the difference between "coloured" and "finished". Both fade to
// transparent when there is no accent, so "no accent here" is the same animation
// running backwards.
//
// Timing is deliberately not fought over. This feature wants a half-second
// cross-fade, so an accent that lands a few frames early or late is absorbed by
// the transition rather than seen as a jump.

const PREF = "mod.safari.site-accent";
const VAR_TOP = "--safari-accent-top";
const VAR_BOTTOM = "--safari-accent-bottom";
const VAR_SCRIM = "--safari-accent-scrim";
const ATTR = "safari-accent";
const ACTOR = "SafariZenAccent";

// Enough for the colour to read as itself, little enough that the blur behind it
// still does. Nothing shows through it but the scrim and the backdrop-filter.
const ACCENT_ALPHA = 0.68;

// How far the scrim settles the backdrop toward the scheme's own extreme. Higher
// is more legible and less glassy; this is the point where the worst case a site
// can produce still clears the contrast floor.
const SCRIM_ALPHA = 0.62;

// Half the spread between the two ends of the gradient, in lightness.
const SHEEN = 0.035;

// Must match --safari-accent-time in chrome.css: the theme layer is only
// restored once the accent has finished fading out, or the sidebar would snap.
const FADE_MS = 500;

// One look back when nothing answered, for an icon still on its way to Places.
const RETRY_MS = 900;

// Favicon scoring.
const ICON_SIZE = 32;
const MIN_ALPHA = 128;
const ICON_MIN_SATURATION = 0.15; // below this the icon is monochrome - GitHub
const MAX_LIGHTNESS = 0.93; // icon paper
const MIN_LIGHTNESS = 0.07; // icon ink
const HUE_BINS = 24;

// Normalisation. Saturation is only pushed up when there is chroma to push: a
// genuinely neutral source stays neutral rather than having a hue invented,
// which is what keeps a monochrome site's sidebar monochrome.
const NEUTRAL_BELOW = 0.08;
const SAT_MIN = 0.28;
const SAT_MAX = 0.80;

// The lightness the sidebar is allowed to occupy. A source inside the band is
// left alone entirely.
const L_DARK = [0.16, 0.34];
const L_LIGHT = [0.78, 0.93];

const MIN_CONTRAST = 4.5;

// Icons that are Zen's own, not the site's.
const SKIP_SCHEMES = ["chrome:", "about:", "resource:"];

const ORIGIN_LIMIT = 64;

const TAG = "[Safari-like Zen / accent]";

// Sibling modules, resolved off this file's own URL: the mod folder is whatever
// id Sine fixed at first install, not necessarily the one in theme.json.
const HERE = import.meta.url.split("?")[0].replace(/[^/]+$/, "");

const root = document.documentElement;

// What the actor last said about each tab.
const pageData = new WeakMap();
// Decoded favicons, keyed by icon URL - the expensive part, and stable.
const iconColours = new Map();
// Final accents, keyed by origin, so a revisit is instant.
const byOrigin = new Map();

let last = "";
let listening = false;
let run = 0;
let fadeTimer = null;
let retryTimer = null;

function enabled() {
  try {
    return Services.prefs.getBoolPref(PREF, false);
  } catch (e) {
    return false;
  }
}

// ---- colour maths ---------------------------------------------------------
// The conversions are local because Zen's differ in convention (its hslToRgb
// takes hue as a fraction, its rgbToHsl returns degrees) and a silent mismatch
// here would be a wrong colour rather than an error. Zen's own helpers are used
// for the things that encode *policy* rather than arithmetic - see base() below.

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

// `over` at `alpha`, on top of `under`.
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

// ---- favicon --------------------------------------------------------------

const NO_ICON = { chromatic: null, neutral: null };

// Two ways to get the bytes, because one is not enough.
//
// fetch() handles data: and http(s): icons straight from cache, but Zen hands
// out `moz-remote-image:` URLs for SVG favicons - a protocol for re-encoding an
// image safely - and fetch cannot read those at all. That is not an edge case:
// it is why GitHub kept the workspace gradient and why Claude fell through to
// its page background instead of taking the orange off its own mark.
//
// Places already holds the decoded bytes for any icon it has seen, so it is the
// fallback: local data, no protocol handler and no CORS involved.
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

// Last resort, and the one that handles what the other two cannot: let the
// browser render the icon itself. An <img> in a chrome document resolves every
// scheme Zen hands out - moz-remote-image:, page-icon:, data: - and rasterises
// an SVG that createImageBitmap would refuse for having no intrinsic size.
// Reading the pixels back needs a system-principal document, which is what this
// script runs in.
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
      // "pixelated" on purpose: smooth downscaling averages neighbouring pixels
      // and invents hues that are in no part of the icon.
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: ICON_SIZE,
        resizeHeight: ICON_SIZE,
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

  // Only remember a real answer: a failure here is usually "Places has not
  // stored it yet", and caching that would make it permanent for the session.
  if (colour.chromatic || colour.neutral) {
    iconColours.set(url, colour);
    if (iconColours.size > ORIGIN_LIMIT * 2) {
      iconColours.delete(iconColours.keys().next().value);
    }
  }
  return colour;
}

// Most frequent pixel is the wrong answer: it is the icon's paper or its ink on
// almost every favicon. Score chromatic pixels only, bucket them so near-identical
// shades reinforce each other, and weight by saturation so a small vivid mark
// beats a large dull field.
function dominantColour(data) {
  const buckets = new Map();
  // Every opaque pixel, chromatic or not, so a monochrome mark can still say
  // "this site is dark" or "this site is light" when no other tier answers.
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

  return {
    // The bucket's mean, not its centre: the centre is a quantisation artefact.
    chromatic: best ? mean(best) : null,
    neutral: all.n ? mean(all) : null,
  };
}

// ---- normalisation --------------------------------------------------------

function normalise(rgb) {
  const dark = isDarkChrome();
  const text = textColour();

  let [h, s, l] = rgbToHsl(...rgb);

  // Neutral in, neutral out. Clamping a grey up to SAT_MIN would invent a hue
  // that is in no part of the source, and a monochrome site would come out
  // tinted.
  if (s >= NEUTRAL_BELOW) s = Math.min(SAT_MAX, Math.max(SAT_MIN, s));

  const [lo, hi] = dark ? L_DARK : L_LIGHT;
  l = Math.min(hi, Math.max(lo, l));

  // Push away from the text until it is legible. Measured on the actual
  // composite in its worst case: the accent over the scrim over the least
  // helpful page the site could put behind it - a white page under dark chrome,
  // a black one under light chrome.
  const worst = compose(
    dark ? [255, 255, 255] : [0, 0, 0],
    dark ? [0, 0, 0] : [255, 255, 255],
    SCRIM_ALPHA
  );
  // The end nearest the text is the one that has to clear the floor, not the
  // midpoint - the sheen puts one end above it either way.
  const nearText = dark ? SHEEN : -SHEEN;
  for (let i = 0; i < 20; i++) {
    const end = hslToRgb(h, s, Math.min(0.98, Math.max(0.03, l + nearText)));
    if (contrastRatio(compose(worst, end, ACCENT_ALPHA), text) >= MIN_CONTRAST) {
      break;
    }
    l = dark ? Math.max(0.05, l - 0.02) : Math.min(0.97, l + 0.02);
  }

  // Light falls from above, so the top end is the lighter one in both schemes.
  const end = offset => {
    const [r, g, b] = hslToRgb(h, s, Math.min(0.98, Math.max(0.03, l + offset)));
    return `rgba(${r}, ${g}, ${b}, ${ACCENT_ALPHA})`;
  };

  return { top: end(SHEEN), bottom: end(-SHEEN) };
}

// ---- the cascade ----------------------------------------------------------

function usable(parsed) {
  return parsed && parsed[3] >= 0.5 ? parsed.slice(0, 3) : null;
}

async function computeAccent(tab, browser) {
  const icon = await accentFromIcon(window.gBrowser.getIcon(tab), browser);
  if (icon.chromatic) return normalise(icon.chromatic);

  const page = pageData.get(tab);

  const fromMeta = usable(parseColour(page?.themeColour));
  if (fromMeta) return normalise(fromMeta);

  const fromCanvas = usable(parseColour(page?.canvasColour));
  if (fromCanvas) return normalise(fromCanvas);

  // Last: the monochrome reading of the icon. A site with no colour anywhere
  // should still get a sidebar of its own rather than falling back to the
  // workspace gradient, which reads as the feature having simply not fired.
  if (icon.neutral) return normalise(icon.neutral);

  // Every tier declined. Say which, so this is reportable rather than guessed at.
  console.warn(
    TAG,
    "no accent for",
    browser?.currentURI?.spec,
    "| icon:",
    window.gBrowser.getIcon(tab) || "(none)",
    "| icon read:",
    icon.chromatic || icon.neutral ? "yes" : "no",
    "| theme-color:",
    page?.themeColour ?? "(none)",
    "| canvas:",
    page?.canvasColour ?? "(none)"
  );
  return null;
}

function originOf(browser) {
  try {
    return browser?.currentURI?.prePath || null;
  } catch (e) {
    return null;
  }
}

// Only a real answer is remembered. A miss usually means the icon has not
// reached Places yet or the actor has not reported, and caching that made it
// permanent for the origin - which is why one Claude domain took its colour and
// the other never did.
function remember(origin, accent) {
  if (!origin || !accent) return;
  byOrigin.delete(origin);
  byOrigin.set(origin, accent);
  if (byOrigin.size > ORIGIN_LIMIT) {
    byOrigin.delete(byOrigin.keys().next().value);
  }
}

// `null` means no accent: both ends fade to transparent and the theme comes back.
function apply(accent) {
  const top = accent?.top ?? "transparent";
  const bottom = accent?.bottom ?? "transparent";
  const key = `${top}|${bottom}`;
  if (key === last) return;
  last = key;

  root.style.setProperty(VAR_TOP, top);
  root.style.setProperty(VAR_BOTTOM, bottom);
  // Written here rather than left to light-dark() in CSS, which would resolve
  // against the chrome colour scheme and not against Zen's own dark-mode
  // decision for the current theme.
  root.style.setProperty(
    VAR_SCRIM,
    accent
      ? isDarkChrome()
        ? `rgba(0, 0, 0, ${SCRIM_ALPHA})`
        : `rgba(255, 255, 255, ${SCRIM_ALPHA})`
      : // Fades out with the accent, so the theme is not revealed through a
        // scrim that is still darkening it.
        isDarkChrome()
        ? "rgba(0, 0, 0, 0)"
        : "rgba(255, 255, 255, 0)"
  );

  window.clearTimeout(fadeTimer);
  if (accent) {
    // On immediately: the theme layer has to be gone before the accent arrives
    // over it, or the two are briefly composited and the colour reads wrong.
    root.setAttribute(ATTR, "true");
  } else {
    // Off only once the accent has finished fading, so the theme reappears
    // under a colour that is already transparent rather than under a visible one.
    fadeTimer = window.setTimeout(
      () => root.removeAttribute(ATTR),
      FADE_MS + 40
    );
  }
}

async function refresh({ useCache = true, retry = true } = {}) {
  const mine = ++run;
  const tab = window.gBrowser?.selectedTab;
  const browser = window.gBrowser?.selectedBrowser;
  if (!tab || !browser) return;

  const origin = originOf(browser);
  if (useCache && origin && byOrigin.has(origin)) {
    apply(byOrigin.get(origin));
    return;
  }

  let accent = null;
  try {
    accent = await computeAccent(tab, browser);
  } catch (e) {
    console.error(TAG, "accent failed:", e);
    return;
  }

  // A newer tab or navigation took over while the favicon was decoding.
  if (mine !== run || tab !== window.gBrowser.selectedTab) return;

  remember(origin, accent);
  apply(accent);

  // Nothing yet. The icon may still be on its way to Places, and TabAttrModified
  // does not fire for an icon that was already set before this ran, so one
  // unprompted look back is the difference between "no colour for a moment" and
  // "no colour on this site, ever".
  if (!accent && retry) {
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      if (mine !== run) return;
      refresh({ useCache: false, retry: false }).catch(() => {});
    }, RETRY_MS);
  }
}

const schedule = () => {
  refresh().catch(e => console.error(TAG, "refresh failed:", e));
};

// ---- events ---------------------------------------------------------------

function onTabSelect() {
  schedule();
}

function onTabAttrModified(event) {
  if (!event.detail?.changed?.includes("image")) return;
  const tab = event.target;
  if (tab !== window.gBrowser.selectedTab) return;
  // The icon is the first tier, so a new one can change the answer.
  refresh({ useCache: false }).catch(() => {});
}

function onAccent(event) {
  const { browser, themeColour, canvasColour } = event.detail ?? {};
  if (!browser) return;
  const tab = window.gBrowser.getTabForBrowser?.(browser);
  if (!tab) return;
  pageData.set(tab, { themeColour, canvasColour });
  if (tab !== window.gBrowser.selectedTab) return;
  refresh({ useCache: false }).catch(() => {});
}

const progressListener = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIWebProgressListener",
    "nsISupportsWeakReference",
  ]),
  onLocationChange(browser, webProgress, request, location, flags) {
    if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) return;
    const tab = window.gBrowser.getTabForBrowser?.(browser);
    if (tab) pageData.delete(tab);
    if (browser === window.gBrowser.selectedBrowser) schedule();
  },
};

const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const onSchemeChange = () => {
  // Every remembered accent was normalised into the old scheme's band.
  byOrigin.clear();
  refresh({ useCache: false }).catch(() => {});
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
  window.addEventListener("SafariZenAccent:Colour", onAccent);
  window.gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
  window.gBrowser.tabContainer.addEventListener(
    "TabAttrModified",
    onTabAttrModified
  );
  window.gBrowser.addTabsProgressListener(progressListener);
  scheme.addEventListener("change", onSchemeChange);
  schedule();
}

function stop() {
  if (!listening) return;
  listening = false;
  run++;
  try {
    window.removeEventListener("SafariZenAccent:Colour", onAccent);
    window.gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
    window.gBrowser.tabContainer.removeEventListener(
      "TabAttrModified",
      onTabAttrModified
    );
    window.gBrowser.removeTabsProgressListener(progressListener);
    scheme.removeEventListener("change", onSchemeChange);
  } catch (e) {}
  byOrigin.clear();
  window.clearTimeout(fadeTimer);
  window.clearTimeout(retryTimer);
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
