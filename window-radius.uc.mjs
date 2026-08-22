// Window Corner Radius — macOS / Zen Browser
// Change this value and reload the mod/restart Zen.
// Typical values: 10, 15, 20, 26.
const RADIUS = "26";

const PREF_ENABLED = "mod.safari.window-radius";

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
