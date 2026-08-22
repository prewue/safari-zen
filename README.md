# Safari-like Zen Layout — Sine mod

A local Sine mod for Zen Browser on macOS. It makes Zen's chrome read closer to
Safari: native macOS window corners, a natively translucent sidebar, plus
sidebar rounding and padding tweaks.

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

**Translucent sidebar** — turns on Zen's own `zen.theme.acrylic-elements` and
retunes it. See the next section.

**Chrome CSS** (`chrome.css`):
- `--zen-compact-float: 22px` on `#navigator-toolbox` — outer padding of the
  sidebar from the window edge.
- `--zen-border-radius: 20px` — sidebar corner radius.
- `padding: 2px 8px 8px 8px` on the compact-mode `#titlebar`, replacing Zen's
  uniform `var(--zen-toolbox-padding)`, using the same selector Zen ships.

## Translucent sidebar

The transparency itself is **Zen's native path**, not a CSS reimplementation.
`zen.theme.acrylic-elements` is Zen's own switch, and this mod just exposes it
in the settings and fixes its rough edges.

What Zen does when it is on:

- `ZenGradientGenerator.mjs` returns the sidebar's base colour at **0.6 alpha
  instead of opaque**, so your theme is recomputed translucent rather than
  discarded — a gradient stays a gradient.
- `zen-compact-mode.css` swaps `#zen-toolbar-background` to a transparent
  background with `backdrop-filter: blur(42px) saturate(110%) brightness(0.25)
  contrast(100%)`.

Two problems with the stock version, both handled here:

1. That `brightness(0.25)` is a **dark-mode hardcode** — in light mode it
   crushes the sidebar to near-black. `mod.safari.acrylic-tune` rebuilds the
   filter without it and makes blur and saturation configurable.
2. Naively overriding the tint breaks Zen's workspace crossfade. The tint is
   scaled through `--zen-background-opacity` so the incoming (`::after`) and
   outgoing (`::before`) theme layers keep summing correctly.

**`zen.theme.acrylic-elements` is read once at startup**, in a field
initialiser on `ZenGradientGenerator`. Toggling it at runtime updates the CSS
but not the recomputed theme colours, which leaves the sidebar opaque with no
way to toggle back. Always **fully quit Zen (⌘Q)** after changing it.

### Settings

| Pref | Default | What it does |
|---|---|---|
| `zen.theme.acrylic-elements` | on | Zen's native translucent sidebar (**restart required**) |
| `mod.safari.acrylic-tune` | on | Rebuild Zen's filter without the dark-only brightness |
| `mod.safari.acrylic-blur` | `42px` | Blur radius |
| `mod.safari.acrylic-saturation` | `140%` | Blur saturation |
| `mod.safari.acrylic-tint` | `1` | How much of the theme gradient stays on top |

### Why not real Liquid Glass

A native `NSGlassEffectView` can be created and placed correctly under Zen's
`ChildView` from chrome JS, but it can never be seen: Gecko composites its
surface with **alpha = 255 everywhere**, verified by sampling a live window's
alpha channel. Surface transparency is decided by the widget's transparency
mode in `nsCocoaWindow` at window creation, which a mod cannot reach. Zen's
acrylic path is the workable route.

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
