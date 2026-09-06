// Native macOS window corner radius (NSConvolutionOverride1 via /usr/bin/defaults)
// and Zen's content separation. DEV.md §1 and §3.

// The macOS 26 default. 20, 15 and 10 also look right; needs a restart.
const RADIUS = "26";
const PREF_ENABLED = "mod.safari.window-radius";
const PREF_FLUSH = "mod.safari.flush-content";
const PREF_SEPARATION = "zen.theme.content-element-separation";

// A pref, not a CSS override: Zen keys zen-no-padding off it and clamps the
// variable itself. Only our own 0 is undone when the toggle goes off.
try {
  const flush = Services.prefs.getBoolPref(PREF_FLUSH, true);
  const current = Services.prefs.getIntPref(PREF_SEPARATION, 8);

  if (flush && current !== 0) {
    Services.prefs.setIntPref(PREF_SEPARATION, 0);
    console.log("[Safari-like Zen] content separation set to 0");
  } else if (!flush && current === 0 && Services.prefs.prefHasUserValue(PREF_SEPARATION)) {
    Services.prefs.clearUserPref(PREF_SEPARATION);
    console.log("[Safari-like Zen] content separation reset to the Zen default");
  }
} catch (e) {
  console.error("[Safari-like Zen] content separation failed:", e);
}

if (Services.appinfo.OS === "Darwin") {
  try {
    let enabled = true;
    try {
      enabled = Services.prefs.getBoolPref(PREF_ENABLED, true);
    } catch (e) {}

    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath("/usr/bin/defaults");

    const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    process.init(file);

    // off deletes the override so macOS falls back to its own radius
    const args = enabled
      ? ["write", "app.zen-browser.zen", "NSConvolutionOverride1", "-float", RADIUS]
      : ["delete", "app.zen-browser.zen", "NSConvolutionOverride1"];

    process.run(false, args, args.length);
    console.log(
      `[Safari-like Zen] window radius ${enabled ? "set to " + RADIUS : "reset to the macOS default"}`
    );

    // chrome.css section 2 rounds the sidebar panel concentrically with this
    const root = document.documentElement;
    if (enabled) {
      root.style.setProperty("--safari-window-radius", RADIUS + "px");
      root.setAttribute("safari-window-radius", RADIUS);
    } else {
      root.style.removeProperty("--safari-window-radius");
      root.removeAttribute("safari-window-radius");
    }
  } catch (e) {
    console.error("[Safari-like Zen] window radius failed:", e);
  }
}
