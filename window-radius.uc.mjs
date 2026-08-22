// Window Corner Radius — macOS / Zen Browser
// Change this value and reload the mod/restart Zen.
// Typical values: 10, 15, 20, 26.
const RADIUS = "26";

const PREF_ENABLED = "mod.safari.window-radius";
const PREF_FLUSH = "mod.safari.flush-content";
const PREF_SEPARATION = "zen.theme.content-element-separation";

// Content separation. This has to be set as a pref rather than overridden in
// CSS: at 0 Zen also puts `zen-no-padding` on :root, which several of its
// stylesheets key off, and it clamps the variable to 0.1px regardless.
// Sine's preferences.json cannot do it reliably either — its dropdown and
// string handlers write the *initial* default without running
// convertValueType, which would put a string into an integer pref.
try {
  const flush = Services.prefs.getBoolPref(PREF_FLUSH, true);
  const current = Services.prefs.getIntPref(PREF_SEPARATION, 8);

  if (flush && current !== 0) {
    Services.prefs.setIntPref(PREF_SEPARATION, 0);
    console.log("[Safari-like Zen] content separation set to 0");
  } else if (!flush && current === 0 && Services.prefs.prefHasUserValue(PREF_SEPARATION)) {
    // Only undo our own value, so a separation the user picked themselves
    // is left alone.
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

    // Turning the toggle off deletes the override so macOS falls back to its
    // own radius, instead of leaving the last custom value behind.
    const args = enabled
      ? ["write", "app.zen-browser.zen", "NSConvolutionOverride1", "-float", RADIUS]
      : ["delete", "app.zen-browser.zen", "NSConvolutionOverride1"];

    process.run(false, args, args.length);
    console.log(
      `[Safari-like Zen] window radius ${enabled ? "set to " + RADIUS : "reset to the macOS default"}`
    );
  } catch (e) {
    console.error("[Safari-like Zen] window radius failed:", e);
  }
}
