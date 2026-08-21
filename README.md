# Window Corner Radius — Sine mod

This is a local Sine mod for Zen Browser on macOS.

It runs:
`/usr/bin/defaults write app.zen-browser.zen NSConvolutionOverride1 -float 10`

Change `RADIUS` in `window-radius.uc.mjs` to adjust the value.

Suggested values:
- 26 — Tahoe default-like
- 20 — slightly less rounded
- 15 — noticeably less rounded
- 10 — strongly reduced
- 0.1 — nearly square

After changing the value, fully quit Zen (⌘Q) and reopen it.

To reset to the macOS default, disable/remove the mod and run:
`defaults delete app.zen-browser.zen NSConvolutionOverride1`

Note: this mod executes `/usr/bin/defaults` from privileged browser JS. Install only if you trust the code.
