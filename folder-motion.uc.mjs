// Folder motion and space swipe progress. Wraps gZenUIManager.motion.animate
// to retime Zen's folder calls by content height and publishes the timing as
// CSS variables; wraps _organizeWorkspaceStripLocations to publish swipe
// progress. DEV.md §5.

const PREF = {
  enabled: "mod.safari.folder-motion",
  spaceBlur: "mod.safari.space-switch-blur",
};

// Zen's folder signature: every folder call goes out with exactly these.
const ZEN_FOLDER_DURATION = 0.12;
const ZEN_FOLDER_EASE = "easeInOut";

// Light spring on the way in, none on the way out; past NO_BOUNCE_ABOVE px the
// open curve only decelerates.
const EASE_OPEN = [0.34, 1.26, 0.64, 1];
const EASE_OPEN_TALL = [0.22, 0.85, 0.3, 1];
const EASE_CLOSE = [0.25, 0.9, 0.35, 1];
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

  // measured once per gesture so every item in a batch gets the same duration
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

  // the folder icon and the space chevron transition off these
  function publish(duration, ease) {
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

      // opening, the container leads and the content fades in behind; closing,
      // the content is gone before the container finishes
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

// ---- space swipe progress. --safari-space-progress follows the finger;
// --safari-space-track is 0s while it does and SETTLE once the change commits.
const SETTLE = "0.32s";

function trackSwipeProgress(root) {
  if (!getBool(PREF.spaceBlur, true)) return;

  const ws = window.gZenWorkspaces;
  if (typeof ws?._organizeWorkspaceStripLocations !== "function") {
    console.warn(TAG, "gZenWorkspaces unavailable, swipe progress not tracked");
    return;
  }

  const setProgress = (p, track = "0s") => {
    try {
      root.style.setProperty("--safari-space-progress", String(p));
      root.style.setProperty("--safari-space-track", track);
    } catch (e) {}
  };

  // the same measurement ZenSpacesSwipe normalises against
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

  // swipe-gesture can outlive the gesture: zero on clear, and on a watchdog
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

  // `active` moves to the new space while swipe-gesture is still up; zero the
  // instant a space stops being the one you are leaving
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
