# DEV notes

Internals, measurements and dead ends behind this mod. Written so a future
session (human or AI) can pick it up without redoing the research.

Everything below was measured on **macOS 26.5 (Tahoe)** with **Zen 1.21.15b**
(`XUL` built against SDK 26.5, arm64).

---

## 1. Window corner radius — `NSConvolutionOverride1`

`window-radius.uc.mjs` shells out to `/usr/bin/defaults` to set
`app.zen-browser.zen NSConvolutionOverride1 -float <r>`.

**The corner is already Apple's `.continuous` squircle.** Captured real windows
with their alpha channel, extracted the boundary with sub-pixel interpolation,
and fitted it against both CoreGraphics families:

| Window | continuous fit | circular fit | verdict |
|---|---|---|---|
| `O1=10` | rms 0.048, max 0.11 | rms 0.068, max 0.21 | continuous |
| `O1=18` | rms 0.057, max 0.18 | rms 0.119, max 0.44 | continuous |
| `O1=26` | rms 0.074, max 0.32 | rms 0.214, max 1.13 | continuous |
| `O1=45` | rms 0.146, max 1.02 | rms 0.480, max 3.73 | continuous |
| stock app A, no override | rms 0.074, max 0.32 | rms 0.214, max 1.13 | continuous |
| stock app B, no override | rms 0.074, max 0.32 | rms 0.214, max 1.13 | continuous |

rms is in points; 0.074pt is 0.15px at 2x, i.e. a pixel-exact match. So
`NSConvolutionOverride1` **only scales an already-continuous curve** — it does
not switch the shape.

`CGPathCreateWithContinuousRoundedRect(rect, 26, 26, NULL)` emits three cubic
Béziers per corner with an extent of `39.74529 = 1.528665 × 26`, exactly
`kCACornerCurveContinuous`.

**26 is the system default.** Two unmodified apps built against the macOS 26 SDK,
with no `NSConvolutionOverride1` set at all, measure identically to a window
forced to 26 — that is the control that rules out the override being the source
of the shape. Zen is built against SDK
26.5, so it inherits the same default — setting 26 is effectively a no-op that
just pins it. A test binary built against SDK 15.2 got 12 instead, so the
default is gated on build SDK, not on bundling.

Other findings:

- `NSConvolutionOverride2` exists in AppKit but has **no observable effect** on
  window corners (tested 0, 1, 26, 60 — radius and curve unchanged).
- `NSWindow._setCornerRadius:` at runtime produces geometry identical to the
  `defaults` route (extent 30.750, diagonal 7.585 at r=26), so a live,
  restart-free implementation via js-ctypes is possible if ever wanted.
- Apple's continuous corner best-fits CSS `superellipse(1.744)` (exponent
  3.3505), max deviation 0.19px at r=26. Useful if inner chrome corners ever
  need to match: pair it with `border-radius: 1.528665 × R`, since a CSS
  superellipse spans exactly its radius while Apple's curve spans 1.53×.
  Zen's engine does ship `corner-shape` behind `layout.css.corner-shape.enabled`.

---

## 2. Translucent sidebar — Zen's acrylic path

The transparency is **Zen's own**, not a CSS reimplementation.

`zen.theme.acrylic-elements` (default `false` in `firefox.js:1702`) drives two
things:

1. `ZenGradientGenerator.mjs:1235` returns the sidebar base colour at **0.6
   alpha instead of 1.0**, so the user's theme is recomputed translucent rather
   than discarded:
   ```js
   const opacity = this.#allowTransparencyOnSidebar ? 0.6 : 1;
   return this.isDarkMode ? [23, 23, 26, opacity] : [240, 240, 244, opacity];
   ```
   `#getSingleRGBColor` also shows that on macOS `canBeTransparent` is true, so
   the *main* background keeps its alpha while the *toolbar* is forced opaque
   until this flag is on.

2. `zen-compact-mode.css:16` swaps `#zen-toolbar-background` to a transparent
   background with
   `backdrop-filter: blur(42px) saturate(110%) brightness(0.25) contrast(100%)`.

### Two gotchas this mod works around

- **`brightness(0.25)` is a dark-mode hardcode.** In light mode it crushes the
  sidebar to near-black. `mod.safari.acrylic-tune` rebuilds the filter as
  `blur() saturate()` only.
- **The theme tint cannot be overridden naively.** `#zen-toolbar-background`
  paints the incoming theme on `::after` at `opacity: var(--zen-background-opacity)`
  and the outgoing one on `::before` at `calc(1 - var(--zen-background-opacity))`.
  That pair is Zen's workspace crossfade. Scale both by the same factor or the
  crossfade breaks:
  ```css
  &::after  { opacity: calc(var(--zen-background-opacity) * var(--tint)); }
  &::before { opacity: calc((1 - var(--zen-background-opacity)) * var(--tint)); }
  ```

### Read-once trap

`#allowTransparencyOnSidebar` is a **field initialiser** on
`ZenGradientGenerator` (`ZenGradientGenerator.mjs:83`), so the pref is read once
at construction. Toggling it at runtime updates the CSS but not the recomputed
theme colours, which strands the sidebar opaque with no way to toggle back.
Always require a full ⌘Q restart.

The layer itself is `display: none` outside compact mode — it only becomes
`display: flex` inside the compact-mode blocks (`zen-compact-mode.css:203,370`).

---

## 3. Sidebar reveal animation

Zen's own rules, in `zen-compact-mode.css`:

```css
/* base / closing */
#navigator-toolbox:not([animate='true']) {
  transition: left 0.15s ease, right 0.15s ease, visibility 0.15s ease;
}

/* opening */
#navigator-toolbox:is([zen-has-hover], [zen-user-show], [zen-has-empty-tab],
                      [flash-popup], [has-popup-menu], [movingtab],
                      [zen-compact-mode-active]):not([animate='true']) {
  --zen-compact-mode-func: linear(0 0%, … 1.003423 100%);
  --zen-compact-mode-time: 0.25s;
  transition: left  var(--zen-compact-mode-time) var(--zen-compact-mode-func),
              right var(--zen-compact-mode-time) var(--zen-compact-mode-func);
}
```

Zen's stock curve overshoots only **0.34%** — under a pixel, so it reads flat.

This mod replaces both with an asymmetric pair. The open curve is the step
response of a damped harmonic oscillator, damping ratio **0.76**, response
**0.32s**, sampled into `linear()` at 50 points over **0.46s**:

- overshoot **2.54%** (≈8px on a 317px slide), peaking at 54% of the transition
- settles to within **0.33px** of target, so the forced `1.0000 100%` stop
  causes no visible snap
- closing is 0.19s `cubic-bezier(0.32, 0.72, 0, 1)`, no overshoot

Nearby options if the overshoot needs retuning: damping 0.78 → 6.3px,
0.74 → 10px, 0.72 → 12.2px.

**Cascade note.** The base and opening selectors differ only by `:is(...)`, so
both overrides carry `!important` and the opening rule wins during hover purely
on specificity (`:is()` contributes its most specific argument). `visibility` is
deliberately excluded from the opening transition, otherwise the panel flickers
at the start of the slide.

### Related prefs

| Pref | Default | Effect |
|---|---|---|
| `zen.view.compact.animate-sidebar` | true | Master switch, read by `ZenCompactMode.mjs` |
| `zen.view.compact.show-sidebar-and-toolbar-on-hover` | true | Hover reveal at all |
| `zen.view.compact.sidebar-keep-hover.duration` | 150 | Delay before hiding after pointer leaves |
| `zen.view.compact.toolbar-hide-after-hover.duration` | 1000 | Toolbar variant of the above |
| `zen.view.compact.outside-window-edge-offset.horizontal` | 200 | Width of the edge trigger zone |

---

## 4. Dead end: native `NSGlassEffectView`

Fully explored and **abandoned**. Do not retry from a mod.

What works:

- `NSGlassEffectView` exists on Tahoe, is a plain `NSView` subclass, and is
  entirely driveable from js-ctypes via `objc_msgSend` (`setStyle:`,
  `setCornerRadius:`, `setTintColor:`, `setContentView:`, private `_setPath:`).
- It renders from a binary built against an older SDK, and performs **true
  cross-process backdrop sampling** — verified by blurring another app's window.
- It can be created inside Zen and placed correctly: `glass idx 0,
  childView idx 1`, frame matching the sidebar to the pixel.
- Only `style` 0 (regular, dimming scrim) and 1 (clear) exist; 2 clamps to 0.

Why it still cannot be seen:

```
isOpaque — window: true | ZenWindowMaterialView: false
         | ChildView: false | PixelHostingView: false
```

Forcing `setOpaque:NO` on the window and stripping the chrome root background
changed nothing. Sampling a live window's alpha channel:

```
sidebar rect   alpha avg=255.0 min=255 max=255 fully-opaque=100.0%
content area   alpha avg=255.0 min=255 max=255 fully-opaque=100.0%
window edge    alpha avg=249.9 min=  0 max=255 fully-opaque= 97.7%
```

**Gecko composites alpha=255 across the entire surface.** `PixelHostingView`
reporting `isOpaque: false` is only a flag; the pixels it actually writes are
opaque. Surface transparency is decided by the widget's transparency mode in
`nsCocoaWindow` at window creation — unreachable from privileged chrome JS.
The only non-opaque pixels are the window's rounded-corner mask.

Side finding worth reporting upstream: `zen.widget.macos.window-vibrancy`
defaults to true and `ZenWindowMaterialView` (with `setMaterial:`) is present,
but since the window is opaque, **Zen's own behind-window material is inert too**.

### Zen's native view tree

```
ToolbarWindow
  ZenWindowMaterialView [0,0 1728x1084]     <- contentView, Zen's material view
    ChildView [0,0 1728x1084]               <- Gecko's rendering surface
      ViewRegionContainerView               <- draggable regions
        NonDraggableView …
      ViewRegionContainerView               <- vibrancy regions: always EMPTY
      PixelHostingView [0,0 1728x1084]      <- every rendered pixel
```

- `vibrancyViewsContainer` **does not exist** on this window
  (`respondsToSelector:` returns false) — Zen replaces it with
  `ZenWindowMaterialView`.
- `-moz-default-appearance: -moz-sidebar` registers **no** vibrancy region in
  Zen: the second `ViewRegionContainerView` stays empty. The
  `widget.macos.sidebar-blend-mode.behind-window` pref exists but nothing
  populates the region.

---

## 5. Platform scope

Only the window corner radius is macOS-specific — it shells out to
`/usr/bin/defaults` and self-guards on `Services.appinfo.OS === "Darwin"`. The
sidebar shape, the acrylic tuning and the reveal animation are plain CSS and
work wherever Zen runs, so the mod carries no `os` field in `theme.json` and the
corner-radius setting is labelled macOS-only instead.

Sine's platform gating, for reference:

- `theme.json` → `os: ["macos"]` filters the mod out of the marketplace listing
  (`marketplace.sys.mjs:195`).
- `preferences.json` → `disabledOn: ["windows", "linux"]` hides an individual
  setting (`preferences.sys.mjs:136`).

Both compare against `ucAPI.utils.os`, which is `AppConstants.platform.slice(0, 3)`
— i.e. `mac`, `win`, `lin` — matched as a substring.

---

## 6. Method notes

Useful techniques if any of this needs re-verifying:

- **Corner geometry**: `screencapture -o -l<windowid>` captures a window with
  its alpha channel. Trace the first row-wise alpha crossing at 127.5 with
  linear interpolation, then least-squares fit against rasterised
  `CGPathCreateWithRoundedRect` / `CGPathCreateWithContinuousRoundedRect`
  candidates sampled through the *same* pipeline — comparing against analytic
  curves introduces a threshold bias that grows with radius.
- **AppKit internals**: `objc_copyClassList` + `class_copyMethodList` on a
  dlopened AppKit dumps the private API surface.
- **Which framework owns a symbol**: `dyld_info -exports <framework>` works
  directly on dyld-shared-cache frameworks.
- **Which selectors a build has**: parse the fat Mach-O, pick the arm64 slice,
  and search `__TEXT,__objc_methname` / `__objc_classname`. This is how
  `vibrancyViewsContainer` was confirmed to be a real selector.
