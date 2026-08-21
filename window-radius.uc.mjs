// Window Corner Radius — macOS / Zen Browser
// Change this value and reload the mod/restart Zen.
// Typical values: 10, 15, 20, 26.
const RADIUS = "26";

if (Services.appinfo.OS === "Darwin") {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath("/usr/bin/defaults");

    const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    process.init(file);

    const args = [
      "write",
      "app.zen-browser.zen",
      "NSConvolutionOverride1",
      "-float",
      RADIUS,
    ];

    process.run(false, args, args.length);
    console.log(`[Window Corner Radius] Set macOS window radius to ${RADIUS}`);
  } catch (e) {
    console.error("[Window Corner Radius] Failed:", e);
  }
}
