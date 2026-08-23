// Folder motion and space swipe progress.
//
// Zen animates folder contents from JS (ZenFolders.mjs) with a hardcoded
// 0.12s / "easeInOut", while the folder icon animates from CSS over 0.3s and
// the space chevron over 0.1s. Three different timings for one gesture. The
// content duration is also fixed regardless of how much content there is, so
// a two-tab folder and a fifteen-tab folder move at very different speeds.
//
// The pinned tabs section is deliberately left alone: animating it from here
// fought Zen's own collapse and came out jerky in both directions.
//
// This wraps gZenUIManager.motion.animate, retimes those calls, and publishes
// the chosen duration and easing as CSS variables so the icon and chevrons can
// ride the exact same timing.

const PREF = {
  enabled: "mod.safari.folder-motion",
  spaceBlur: "mod.safari.space-switch-blur",
};

// Zen's folder signature: every folder call goes out with exactly these.
const ZEN_FOLDER_DURATION = 0.12;
const ZEN_FOLDER_EASE = "easeInOut";

// Light spring on the way in (2.2% overshoot, peaking at 70%), no overshoot on
// the way out. Both are fast off the mark: a folder toggle is a click, so it
// has to answer immediately in either direction. The asymmetry lives in the
// duration and the overshoot, not in a slow start.
const EASE_OPEN = [0.34, 1.26, 0.64, 1];
const EASE_OPEN_TALL = [0.22, 0.85, 0.3, 1];
const EASE_CLOSE = [0.25, 0.9, 0.35, 1];

// The overshoot is a percentage of the distance travelled, so on a tall folder
// 2.2% turns into a large, springy bounce. Past this height the open curve
// drops the overshoot and just decelerates.
const NO_BOUNCE_ABOVE = 180;

const MIN_DURATION = 0.18;
const MAX_DURATION = 0.42;
const PER_PX = 0.0004;
const CLOSE_RATIO = 0.75;

const TAG = "[Safari-like Zen / motion]";

function getBool(p, d) {
  try {
    return Services.prefs.getBoolPref(p, d);
  } catch (e) {
    return d;
  }
}

function start() {
  window.setTimeout(main, 800);
}

if (document.readyState === "complete") {
  start();
} else {
  window.addEventListener("load", start, { once: true });
}

function main() {
  const root = document.documentElement;
  trackSwipeProgress(root);

  if (!getBool(PREF.enabled, true)) {
    return;
  }

  const um = window.gZenUIManager;
  if (!um?.motion?.animate) {
    console.warn(TAG, "gZenUIManager.motion unavailable, skipping");
    return;
  }

  // Folder heights change while the batch runs, so measure once per gesture
  // and reuse it for every item in that batch. Without this the items in one
  // folder would each get their own duration and visibly drift apart.
  const heightCache = new WeakMap();
  function folderDuration(el) {
    let folder = null;
    try {
      folder = el?.closest?.("zen-folder");
    } catch (e) {}

    const now = Date.now();
    if (folder) {
      const hit = heightCache.get(folder);
      if (hit && now - hit.t < 150) return { d: hit.d, h: hit.h };
    }

    let h = 0;
    try {
      const container = folder?.groupContainer ?? folder;
      if (container) {
        h = window.windowUtils.getBoundsWithoutFlushing(container).height || 0;
        if (!h) h = container.scrollHeight || 0;
      }
    } catch (e) {}

    const d = Math.min(MAX_DURATION, Math.max(MIN_DURATION, MIN_DURATION + h * PER_PX));
    const out = { d, h };
    if (folder) heightCache.set(folder, { ...out, t: now });
    return out;
  }

  function openEase(height) {
    return height > NO_BOUNCE_ABOVE ? EASE_OPEN_TALL : EASE_OPEN;
  }

  function isShrinking(target) {
    const h = target?.height;
    if (h === 0 || h === "0") return true;
    if (Array.isArray(h)) return h[h.length - 1] === 0 || h[h.length - 1] === "0";
    return false;
  }

  function publish(duration, ease) {
    // The folder icon and the space chevron transition off these, so all three
    // parts of the gesture share one timing.
    root.style.setProperty("--safari-folder-time", duration + "s");
    root.style.setProperty("--safari-folder-ease", `cubic-bezier(${ease.join(",")})`);
  }

  const original = um.motion.animate.bind(um.motion);

  um.motion.animate = function (el, target, opts, ...rest) {
    try {
      const isZenFolderCall =
        opts &&
        opts.duration === ZEN_FOLDER_DURATION &&
        opts.ease === ZEN_FOLDER_EASE;

      if (!isZenFolderCall) {
        return original(el, target, opts, ...rest);
      }

      const shrinking = isShrinking(target);
      const { d: base, h } = folderDuration(el);
      const duration = shrinking ? base * CLOSE_RATIO : base;
      const ease = shrinking ? EASE_CLOSE : openEase(h);

      publish(duration, ease);

      const next = { ...opts, duration, ease };

      // Stagger the fade against the height so the two do not mush together:
      // opening, the container leads and the content fades in behind it;
      // closing, the content is gone before the container finishes.
      if (target && Object.hasOwn(target, "opacity")) {
        next.opacity = shrinking
          ? { duration: duration * 0.5, ease: "linear" }
          : { duration: duration * 0.65, delay: duration * 0.35, ease: "linear" };
      }

      return original(el, target, next, ...rest);
    } catch (e) {
      console.error(TAG, "retiming failed, falling back:", e);
      return original(el, target, opts, ...rest);
    }
  };

  window.addEventListener(
    "unload",
    () => {
      try {
        um.motion.animate = original;
      } catch (e) {}
    },
    { once: true }
  );
}

// ---- Space swipe progress ------------------------------------------------
// Zen never publishes how far a space swipe has travelled: _handleSwipeUpdate
// computes the offset and hands it straight to _organizeWorkspaceStripLocations
// as its third argument. Wrapping that method is the one place the number is
// available, so the blur can follow the finger instead of flashing on and off
// at the edges of the gesture.
const SETTLE = "0.32s";

function trackSwipeProgress(root) {
  if (!getBool(PREF.spaceBlur, true)) return;

  const ws = window.gZenWorkspaces;
  if (typeof ws?._organizeWorkspaceStripLocations !== "function") {
    console.warn(TAG, "gZenWorkspaces unavailable, swipe progress not tracked");
    return;
  }

  // `track` is the transition applied to the blur. Zero while a finger is
  // driving it, so the blur is locked to the movement; non-zero once the
  // change commits, so the settle is eased rather than snapped.
  const setProgress = (p, track = "0s") => {
    try {
      root.style.setProperty("--safari-space-progress", String(p));
      root.style.setProperty("--safari-space-track", track);
    } catch (e) {}
  };

  // Same measurement ZenSpacesSwipe uses for its own normalisation.
  const stripWidth = () => {
    try {
      const w =
        (document.getElementById("navigator-toolbox")
          ? window.windowUtils.getBoundsWithoutFlushing(
              document.getElementById("navigator-toolbox")
            ).width
          : 0) +
        (document.getElementById("zen-sidebar-splitter")
          ? window.windowUtils.getBoundsWithoutFlushing(
              document.getElementById("zen-sidebar-splitter")
            ).width
          : 0);
      return w > 0 ? w : 0;
    } catch (e) {
      return 0;
    }
  };

  const original = ws._organizeWorkspaceStripLocations.bind(ws);
  ws._organizeWorkspaceStripLocations = function (workspace, justMove, offsetPixels, ...rest) {
    try {
      if (
        typeof offsetPixels === "number" &&
        root.hasAttribute("swipe-gesture")
      ) {
        const w = stripWidth();
        setProgress(w ? Math.min(1, Math.abs(offsetPixels) / w).toFixed(3) : 0);
      }
    } catch (e) {
      console.error(TAG, "swipe progress failed:", e);
    }
    return original(workspace, justMove, offsetPixels, ...rest);
  };

  // The gesture attribute can outlive the gesture, so never leave the blur
  // depending on it alone: zero the progress when it clears, and on a watchdog
  // in case it never does.
  let watchdog = null;
  const observer = new window.MutationObserver(() => {
    if (root.hasAttribute("swipe-gesture")) {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => setProgress(0, SETTLE), 4000);
    } else {
      window.clearTimeout(watchdog);
      setProgress(0, SETTLE);
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ["swipe-gesture"] });

  // The commit does not wait for the gesture to be released: `active` moves to
  // the new space while `swipe-gesture` is still up, so the space now in view
  // would match the outgoing rule and sit there holding the last progress
  // value. Zeroing on the attribute move clears it the instant it stops being
  // the one you are leaving.
  const activeObserver = new window.MutationObserver(records => {
    for (const rec of records) {
      if (rec.target.localName === "zen-workspace") {
        setProgress(0, SETTLE);
        return;
      }
    }
  });
  const strip = document.getElementById("tabbrowser-tabs");
  if (strip) {
    activeObserver.observe(strip, {
      attributes: true,
      subtree: true,
      attributeFilter: ["active"],
    });
  }

  window.addEventListener(
    "unload",
    () => {
      try {
        window.clearTimeout(watchdog);
        observer.disconnect();
        activeObserver.disconnect();
        ws._organizeWorkspaceStripLocations = original;
      } catch (e) {}
    },
    { once: true }
  );
}
