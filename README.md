# Safari-like Zen Layout — Sine mod

A local Sine mod for Zen Browser on macOS. It makes Zen's chrome read closer to
Safari: native macOS window corners plus sidebar rounding and padding tweaks.

## What it changes

**Window corner radius** (`window-radius.uc.mjs`) — runs:

`/usr/bin/defaults write app.zen-browser.zen NSConvolutionOverride1 -float 26`

Change `RADIUS` in `window-radius.uc.mjs` to adjust it. After changing the
value, fully quit Zen (⌘Q) and reopen it.

Suggested values:
- 26 — the macOS Tahoe system default (see below)
- 20 — slightly less rounded
- 15 — noticeably less rounded
- 10 — strongly reduced
- 0.1 — nearly square

**Chrome CSS** (`chrome.css`):
- `--zen-compact-float: 22px` on `#navigator-toolbox` — outer padding of the
  sidebar from the window edge.
- `--zen-border-radius: 20px` — sidebar corner radius.
- `padding: 2px 8px 8px 8px` on the compact-mode `#titlebar`, replacing Zen's
  uniform `var(--zen-toolbox-padding)`, using the same selector Zen ships.

## Reset

To reset the window radius to the macOS default, disable/remove the mod and run:

`defaults delete app.zen-browser.zen NSConvolutionOverride1`

Note: this mod executes `/usr/bin/defaults` from privileged browser JS. Install
only if you trust the code.

## What the corner radius key actually does

Measured on macOS 26.5 (Tahoe) by screenshotting real windows with alpha and
fitting the corner curve:

- The corner AppKit draws is **already Apple's `.continuous` squircle**, not a
  circular arc. Fitting the captured curve against
  `CGPathCreateWithContinuousRoundedRect` vs `CGPathCreateWithRoundedRect`:
  continuous wins at every radius (at r=26: rms 0.07pt vs 0.21pt, max error
  0.32pt vs 1.13pt). `NSConvolutionOverride1` only scales that curve — it does
  not switch the shape.
- The corner spans `1.528665 × radius` along each edge — exactly
  `kCACornerCurveContinuous`, AppKit's continuous-corner expansion factor.
- **26 is the system default.** Craft and Telegram have no
  `NSConvolutionOverride1` set and measure identically to a window forced to 26.
  Zen is built against SDK 26.5, so it gets the same default. Setting 26 here is
  therefore a no-op that just pins the default explicitly; use a different value
  if you actually want to deviate.
- `NSConvolutionOverride2` exists in AppKit but has no observable effect on
  window corners (tested 0, 1, 26, 60 — radius and curve unchanged).
