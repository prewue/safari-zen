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
//   1. the favicon's dominant colour - the only per-site signal Firefox already
//      tracks, and the one that reads as "the brand";
//   2. <meta name="theme-color"> - the site's own declaration. Firefox does not
//      parse it, so it arrives from site-accent-child.sys.mjs;
//   3. the page's canvas colour, from the same actor;
//   4. the favicon's monochrome reading, so a site with no colour anywhere still
//      gets a sidebar of its own rather than the workspace gradient.
//
// Zen's getMostDominantColor is a false friend and is not used: it reads the
// dots of the user's own workspace gradient (ZenGradientGenerator.mjs:1489), not
// anything about the page.
//
// ---------------------------------------------------------------------------
// One decision per navigation
// ---------------------------------------------------------------------------
//
// The tiers do not arrive in cascade order. theme-color is parsed with <head>
// and reported at once; the favicon is requested when <head> is parsed and
// lands a fetch later; the canvas is only trustworthy once the stylesheets are
// in. Applying each tier as it arrives painted the sidebar two or three times
// per navigation - grey, then the theme-color, then the favicon - which is the
// "jitter" this file exists to prevent.
//
// So nothing is applied until the answer is settled. Every tab carries the
// state of its current document (`tabs`, below): which icon it has set and what
// it decoded to, what the page reported, whether the load has finished. Each
// signal re-runs decide(), which says either "not yet" or gives an answer and
// whether it is final - a chromatic favicon is final the moment it decodes,
// theme-color is final once the favicon question is settled, and so on. Only a
// final answer is applied, remembered for the origin and used as the hold.
//
// While the answer is pending the sidebar keeps its previous colour. A page on
// an origin seen before takes that origin's colour at the navigation itself,
// so moving around one site never changes anything, and a new site cross-fades
// once, when its own colour is known - typically a few hundred milliseconds
// after the navigation, absorbed by the transition.
//
// Two things Zen does with the icon make the signals here what they are:
//
//   - tabbrowser nulls browser.mIconURL when a new document commits, but leaves
//     the tab's `image` attribute alone until the load ends "to avoid
//     flickering" (tabbrowser.js:10115-10123). gBrowser.getIcon() is therefore
//     empty for the whole load, and the attribute is the previous page's icon.
//     Neither is a signal for the new document.
//   - setIcon() calls onLinkIconAvailable on every tabs-progress listener each
//     time an icon is set, whether or not the attribute changed (tabbrowser.js
//     :1548). That is the signal - and it fires even when the new icon is the
//     same as the old one, which TabAttrModified does not.
//
// A tab that has no icon at all gets there via the end of the load: STATE_STOP
// on the top-level network request is when tabbrowser itself gives up on the
// icon and clears the attribute. A hard deadline backs both up for a page that
// streams forever.
//
// ---------------------------------------------------------------------------
// What is done with the colour
// ---------------------------------------------------------------------------
//
// The accent keeps the site's hue and chroma, and only its lightness is clamped
// into the band the current scheme already occupies. Taken literally, "the
// site's colour" paints a #ff0000 sidebar on YouTube with white tab labels on
// saturated red. Clamping instead means no chrome text colour has to be touched,
// so nothing here fights ZenGradientGenerator's own zen-should-be-dark-mode /
// --toolbox-textcolor writes.
//
// The raw source colour is what is remembered, per tab and per origin, and the
// normalised accent is derived from it at apply time. That is what lets a
// scheme change - system dark mode, or a workspace whose theme flips Zen's own
// dark-mode decision - re-normalise every colour without re-reading anything.
//
// The accent is translucent, but it is not laid over the workspace theme: while
// an accent is showing, :root carries [safari-accent] and section 11 of
// chrome.css drops the theme layer, so what is behind the accent is the panel's
// own blur. A scrim settles that blur to something known first, so the same
// blue is legible over a white page and a dark one alike.
//
// Two values are published, --safari-accent-top and --safari-accent-bottom: a
// shallow vertical gradient in the site's own hue. Both fade to transparent
// when there is no accent, so "no accent here" is the same animation running
// backwards.

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

// How long a navigation may stay undecided before the best available answer is
// applied anyway. Past this the page is streaming, or its icon is not coming,
// and a late correction is better than a sidebar stuck on the previous site.
const SETTLE_MAX_MS = 4000;

// The end of the load is where tabbrowser gives up on an icon, but the icon's
// own request can outlive the document's, and a tab that was busy when the
// icon started loading says so with `pendingicon`. A page with neither gets
// this long after the load for a straggler before the lower tiers decide.
const ICON_GRACE_MS = 400;

// One more attempt at an icon that was set but would not decode - usually
// Places has not stored it yet.
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

// The state of each tab's current document - see stateOf().
const tabs = new WeakMap();
// Decoded favicons, keyed by icon URL - the expensive part, and stable.
const iconColours = new Map();
// Final source colours, keyed by origin, so a revisit is instant. Raw rgb, not
// the normalised accent, so a scheme change does not invalidate them.
const byOrigin = new Map();

let last = "";
let listening = false;
let fadeTimer = null;
let darkObserver = null;

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
// for the things that encode *policy* rather than arithmetic - see contrastRatio.

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

// ---- applying -------------------------------------------------------------

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

// A source colour, or null for "no accent", to the sidebar.
function show(source) {
  apply(source ? normalise(source) : null);
}

// ---- per-tab state --------------------------------------------------------

function originOf(browser) {
  try {
    return browser?.currentURI?.prePath || null;
  } catch (e) {
    return null;
  }
}

// Zen's empty tab has nothing to take a colour from, and is the one case
// decided at the selection itself. A bare about:blank in any other tab is a
// document on its way to being replaced - a new tab opened on a link, a
// browser re-created for a process switch - and is held, not decided.
function blank(tab) {
  return tab.hasAttribute("zen-empty-tab");
}

function stateOf(tab) {
  let s = tabs.get(tab);
  if (!s) {
    s = {
      // Bumped when a new document commits; answers for an older one are dropped.
      epoch: 0,
      origin: null,
      // The icon the page has set, and what it decoded to. `undefined` while
      // decoding, NO_ICON when it would not decode or is Zen's own.
      iconURL: null,
      icon: undefined,
      // The actor's last report: { themeColour, canvasColour, phase }.
      page: null,
      // Top-level network stop seen - tabbrowser's own moment of giving up on
      // an icon that never came - and when.
      loaded: false,
      loadedAt: 0,
      // The decision: the rgb the accent derives from, null for "no accent",
      // undefined while there is none yet. `final` says whether a later signal
      // may still improve it.
      source: undefined,
      final: false,
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

// Only a final answer is remembered. A miss usually means the icon has not
// reached Places yet or the actor has not reported, and caching that made it
// permanent for the origin - which is why one Claude domain took its colour and
// the other never did.
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

// Whether an icon can still arrive for this document. Decoded, and it cannot;
// otherwise the load has to be over, no icon may be in flight, and a short
// grace has to have passed for one that started just before the end.
function iconSettled(tab, s, now) {
  if (s.icon !== undefined) return true;
  if (!s.loaded) return false;
  if (tab.hasAttribute("pendingicon")) return false;
  return now - s.loadedAt >= ICON_GRACE_MS;
}

// The cascade, run against what is known so far. Returns null for "nothing to
// say yet", otherwise { source, final }.
function decide(tab, s) {
  const now = window.performance.now();
  const overdue = now - s.started > SETTLE_MAX_MS;

  // Tier 1, the favicon. A chromatic one is the answer the moment it decodes;
  // everything below waits until the icon question is settled.
  if (s.icon?.chromatic) return { source: s.icon.chromatic, final: true };
  if (!overdue && !iconSettled(tab, s, now)) return null;

  // Tier 2, the site's own declaration.
  const meta = usable(parseColour(s.page?.themeColour));
  if (meta) return { source: meta, final: true };

  // Tier 3, the canvas. Trustworthy once the page has loaded and its
  // stylesheets are in; before that it is a guess for the deadline only.
  const settled = s.loaded || s.page?.phase === "load" || overdue;
  const canvas = usable(parseColour(s.page?.canvasColour));
  if (canvas) return { source: canvas, final: settled };

  // Tier 4, the monochrome reading of the icon.
  if (s.icon?.neutral) return { source: s.icon.neutral, final: true };

  // Every tier declined. Final once the page has said its last word, so the
  // theme comes back only for a page that really has no colour of its own.
  if (settled && (s.page || s.loaded || overdue)) {
    return { source: null, final: true };
  }
  return null;
}

// Re-run the cascade for a tab and act on what changed.
function evaluate(tab) {
  const s = tabs.get(tab);
  if (!s) return;
  const r = decide(tab, s);
  if (!r) return;
  // A provisional answer never replaces a final one, and a final one that is
  // the same answer again is a no-op.
  if (!r.final && s.final) return;
  if (s.final && sameSource(r.source, s.source)) return;
  s.source = r.source;
  s.final = r.final;
  if (r.final) {
    remember(s.origin, r.source);
    window.clearTimeout(s.timer);
    s.timer = null;
  }
  if (selected(tab)) show(r.source);
}

// A new document has committed in this tab. Everything known is about the old
// one; start over, and paint what can be known now: nothing for a blank page,
// the origin's remembered colour for a site seen before, and otherwise the
// previous colour holds until decide() has an answer.
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
  s.started = window.performance.now();
  window.clearTimeout(s.timer);
  s.timer = null;

  if (blank(tab)) {
    s.source = null;
    s.final = true;
    if (selected(tab)) show(null);
    return;
  }

  if (selected(tab) && byOrigin.has(s.origin)) show(byOrigin.get(s.origin));

  const epoch = s.epoch;
  s.timer = window.setTimeout(() => {
    if (s.epoch !== epoch) return;
    s.timer = null;
    evaluate(tab);
  }, SETTLE_MAX_MS + 20);
}

// A tab that was open before this ran - or before the listener attached - has
// no epoch of its own. Read what tabbrowser already knows about it.
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
  s.loaded = !tab.hasAttribute("busy");
  s.loadedAt = s.started;
  const icon = window.gBrowser.getIcon(tab) || tab.getAttribute("image");
  if (icon) takeIcon(tab, browser, icon);
  query(tab, browser);
  // A page with no icon at all is only decided once the grace has passed, and
  // nothing else may come along to ask.
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
        // Set, but would not decode: one look back for an icon still on its
        // way to Places.
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

// Ask the page what it has, for a document whose reports were sent before
// this window was listening.
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

// The selected tab changed: paint what is known about it, and go looking for
// anything that is not.
function present() {
  const tab = window.gBrowser.selectedTab;
  const browser = window.gBrowser.selectedBrowser;
  if (!tab || !browser) return;
  const s = seed(tab, browser);
  if (s.source !== undefined) {
    show(s.source);
  } else if (byOrigin.has(s.origin)) {
    show(byOrigin.get(s.origin));
  }
  // Otherwise the previous colour holds; the signals for this tab are already
  // in flight, or seed() has just requested them.
  evaluate(tab);
}

// ---- events ---------------------------------------------------------------

function onTabSelect() {
  present();
}

function onAccent(event) {
  const { browser, themeColour, canvasColour, phase } = event.detail ?? {};
  if (!browser) return;
  const tab = window.gBrowser.getTabForBrowser?.(browser);
  if (!tab) return;
  const s = seed(tab, browser);
  s.page = { themeColour, canvasColour, phase };
  evaluate(tab);
}

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
    // Every navigation passes through an about:blank - the initial document of
    // a new browser, and again when a process switch re-creates the browser -
    // and none of them is a page. Only Zen's own empty tab is one to show.
    if (location?.spec === "about:blank" && !tab.hasAttribute("zen-empty-tab")) {
      return;
    }
    begin(tab, browser);
  },
  // The end of the top-level load: if no icon has arrived by now, none will,
  // and tabbrowser clears the attribute on the same signal.
  onStateChange(browser, webProgress, request, flags) {
    const L = Ci.nsIWebProgressListener;
    if (!(flags & L.STATE_STOP) || !(flags & L.STATE_IS_NETWORK)) return;
    if (!webProgress?.isTopLevel) return;
    const tab = window.gBrowser.getTabForBrowser?.(browser);
    if (!tab) return;
    const s = seed(tab, browser);
    if (s.loaded) return;
    s.loaded = true;
    s.loadedAt = window.performance.now();
    evaluate(tab);
    // The grace for a straggling icon, then the lower tiers may decide.
    const epoch = s.epoch;
    window.setTimeout(() => {
      if (s.epoch !== epoch) return;
      evaluate(tab);
    }, ICON_GRACE_MS + 20);
  },
  // Fires on every setIcon, whether or not the tab's attribute changed - the
  // one signal that says "the new document has an icon, and it is this".
  onLinkIconAvailable(browser, iconURL) {
    if (!iconURL) return;
    const tab = window.gBrowser.getTabForBrowser?.(browser);
    if (!tab) return;
    seed(tab, browser);
    takeIcon(tab, browser, iconURL);
  },
};

// The band the accent is normalised into follows Zen's own dark-mode decision,
// which a workspace theme can flip without the system scheme moving. Sources
// are kept raw, so this is a re-normalisation, not a re-read.
function onSchemeChange() {
  last = "";
  const tab = window.gBrowser?.selectedTab;
  const s = tab && tabs.get(tab);
  if (s && s.source !== undefined) {
    show(s.source);
  } else if (s && byOrigin.has(s.origin)) {
    show(byOrigin.get(s.origin));
  }
}

const scheme = window.matchMedia("(prefers-color-scheme: dark)");

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
