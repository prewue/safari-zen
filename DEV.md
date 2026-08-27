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

## 3. Content separation

`zen.theme.content-element-separation` (integer, Zen default **8**, capped at 12)
is set to `0` by `window-radius.uc.mjs`, gated on `mod.safari.flush-content`.

It has to be a pref, not a CSS override. `zenThemeModifier.js` does two things
with it:

```js
separation = Math.max(kMinElementSeparation, separation);   // kMin = 0.1px
document.documentElement.style.setProperty("--zen-element-separation", separation + "px");
if (separation == kMinElementSeparation) {
  document.documentElement.setAttribute("zen-no-padding", true);
} else {
  document.documentElement.removeAttribute("zen-no-padding");
}
```

So overriding `--zen-element-separation` in CSS would miss `zen-no-padding`,
which `zen-browser-container.css`, `zen-compact-mode.css`, `zen-glance.css`,
`zen-single-components.css` and `zen-split-view.css` all key off — including the
compact-mode corner-radius compensation. The variable is also clamped to 0.1px,
never actually 0.

It cannot go in `preferences.json` either. Sine converts pref value types via
`convertValueType`, which honours `"value": "num"`, but only in the *change*
handlers. The initial default write does not run it:

```js
if (save) ucAPI.prefs.set(pref.property, value);   // raw string
```

`ucAPI.prefs.set` picks its setter from `typeof value`, so that would call
`setStringPref` on an integer pref: it throws, gets swallowed by ucAPI's
try/catch, and the default silently never applies. Setting it from our own
script with `setIntPref` sidesteps the whole thing.

Turning the toggle off only clears the pref when the current value is `0`, so a
separation the user chose themselves is not clobbered.

The pref is observed live by `zenThemeModifier`, so no restart is needed.

---

## 4. Sidebar reveal animation

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
Closing is **0.30s** on `cubic-bezier(0.45, 0, 0.7, 0.55)`, no overshoot.

The original 0.19s `cubic-bezier(0.32, 0.72, 0, 1)` felt mismatched against the
open, and the duration was only half the reason — that curve is an *ease-out*,
so it covered 78% of the travel in the first quarter of the transition. The
panel effectively teleported and then crawled. The replacement is an ease-in:

| point of transition | 25% | 50% | 75% |
|---|---|---|---|
| old `cubic-bezier(0.32, 0.72, 0, 1)` | 0.779 | 0.955 | 0.992 |
| new `cubic-bezier(0.45, 0, 0.7, 0.55)` | 0.062 | 0.265 | 0.606 |

It leaves gently, builds speed, and is still accelerating when it clips past the
window edge. Because the travel is back-loaded, the perceived speed runs ahead
of the wall-clock duration — 0.30s here reads faster than 0.30s on a symmetric
curve would.

Zen synchronises companion elements with the toolbox by hand rather than through
a variable — `zen-compact-mode.css:196` carries `transition: visibility 0.15s`
on `#titlebar` with the comment *"Same as the toolbox"*. Retiming the close
without moving those desynchronises them: the panel keeps sliding while its
contents blank out at 0.15s, which looks like the sidebar vanishing mid-slide
with stray elements left behind. Both `#titlebar` and
`--zen-hidden-toolbar-transition-duration` now derive from
`--safari-close-time`, so changing the close duration moves everything at once.

A time-reversed critically damped spring was tried first, to keep the same
physical family as the open curve, and rejected: reversing a step response
inherits its long asymptotic tail as a *dead zone at the start* — only 0.7% of
the travel in the first quarter — which reads as input lag on exit.

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

## 5. Space swipe progress

Zen never publishes how far a space swipe has travelled. `_handleSwipeUpdate`
computes the offset and passes it straight to
`_organizeWorkspaceStripLocations(workspace, justMove, offsetPixels)` as the
third argument, so wrapping that method is the only place the number is
readable. `folder-motion.uc.mjs` normalises it against the same strip width
`ZenSpacesSwipe` measures — `#navigator-toolbox` plus `#zen-sidebar-splitter` —
and writes it to `--safari-space-progress`.

Driving the blur off the attributes alone does not work, in either direction:

- `swipe-gesture` goes up the moment the fingers land and stays up for the
  whole drag, so it says nothing about distance and only produces a flash.
- `animating-background` covers the tail, and is cleared only after an awaited
  `Promise.race` (`ZenSpaceManager.mjs:2145`), so anything throwing before that
  leaves it set and the blur stuck.

Two resets are therefore mandatory. `active` moves to the new space *while*
`swipe-gesture` is still up (`ZenSpace.mjs:308`), so an observer on that
attribute zeroes the progress the instant a space stops being the one you are
leaving — otherwise the space already in view keeps the last progress value and
stays blurred. A watchdog zeroes it too, for a gesture that never fires its end
callback.

`--safari-space-track` is the blur's own transition duration: `0s` while a
finger is driving it, so the blur is locked to the movement, and a real
duration on commit so the reset eases rather than snaps.

---

## 6. Dead end: native `NSGlassEffectView`

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

## 7. Platform scope

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

## 8. Pinned sidebar panel

`mod.safari.pinned-panel`, chrome.css section 10 (plus 3b for the inner padding),
and `page-canvas.uc.mjs` with its actor pair for the colour of the gap.

### The panel is already built, it is just hidden

Compact mode's floating panel is one element: `#zen-toolbar-background`, the first
child of `#titlebar` (`browser.xhtml:6518`, `class="zen-toolbar-background
zen-browser-generic-background"`). Everything that makes it look like a panel is
declared at the **top level** of `zen-compact-mode.css:8-34` — outside any
`[zen-compact-mode]` selector:

```css
.zen-toolbar-background {
  display: none;
  box-shadow: var(--zen-big-shadow);
  background: light-dark(#e9e9e9, #131313);
  @media -moz-pref('zen.theme.acrylic-elements') {
    background: transparent;
    backdrop-filter: blur(42px) saturate(110%) brightness(0.25) contrast(100%) !important;
  }
  &::before, &::after {
    outline: 1px solid rgba(255, 255, 255, .15);
    background-attachment: fixed !important;
    background-size: 100vw 100vh !important;
  }
  &, &::before, &::after {
    border-radius: calc(var(--zen-native-inner-radius) - var(--zen-compact-mode-no-padding-radius-fix, 0px));
  }
}
```

The only thing keeping it off screen outside compact is `display: none` on line 9.
Compact turns it on with a single declaration, `zen-compact-mode.css:203-205`.

The colours are live too. `ZenGradientGenerator.mjs:1730-1733` writes
`--zen-main-browser-background-toolbar` to that element **unconditionally**, not
inside a compact-mode branch, and `zen-browser-ui.css:67-84` is what paints it onto
`::after` / `::before`. So in the pinned layout the layer is fully painted and
current — it is simply not displayed. That is why this is a display toggle rather
than a reimplementation, and why the workspace crossfade and the section 8 swipe
blur keep working untouched.

`#navigator-toolbox` itself paints nothing in either mode:
`background: var(--zen-navigator-toolbox-background, transparent) !important`
(`zen-browser-ui.css:12-16`), and `--zen-navigator-toolbox-background` is never
assigned anywhere in the tree. Both modes rely entirely on the panel element.

### The panel has to be re-parented by CSS, not by DOM

`ZenUIManager.mjs:1374-1380` moves two elements depending on the mode:

```js
if (isCompactMode) {
  titlebar.moveBefore(navBar, titlebar.firstChild);
  titlebar.moveBefore(topButtons, titlebar.firstChild);
} else {
  titlebar.parentNode.moveBefore(topButtons, titlebar);
  titlebar.parentNode.moveBefore(navBar, titlebar);
}
```

So in compact `#nav-bar` and `#zen-sidebar-top-buttons` live **inside** `#titlebar`,
and the panel — a child of `#titlebar` — covers the whole sidebar. Pinned, they are
moved **out**, becoming siblings placed before it. Turning the panel on and leaving
it there would cover the tab strip only, with the window buttons and the urlbar
sitting outside it.

Moving the element in the DOM would mean a script, and one that has to undo itself
on `ZenCompactMode:Toggled`. It is not necessary. The panel is
`position: absolute; inset: 0`, so it sizes to the padding box of its nearest
**positioned ancestor** — which does not have to be its parent. Compact positions
`#titlebar` (`zen-compact-mode.css:194`); section 10 leaves `#titlebar` static and
positions `#navigator-toolbox` instead, and the panel spreads over the entire
sidebar without anything being moved.

### Stacking

`z-index: -1` on the panel (`zen-compact-mode.css:13`) only means "behind the
sidebar's own content" if the sidebar is a stacking context. Compact gets one for
free from `position: fixed; z-index: 10`. Pinned, `#navigator-toolbox` is
`position: inherit` (`zen-browser-ui.css:18-21`) off a static parent, so a `-1`
child would escape upward and land behind `#zen-browser-background` — which is
`position: absolute; z-index: 0` (`zen-browser-ui.css:40-45`) and covers the whole
window — i.e. the panel would be painted and invisible.

`position: relative; z-index: 1` on the toolbox fixes both halves at once: it makes
the stacking context that traps the `-1`, and it puts the sidebar on the same layer
as `#zen-appcontent-wrapper` (`zen-browser-ui.css:165-166`), above the gradient.

### Origin trap: Sine sheets are USER_SHEET

`stylesheets.sys.mjs` registers the aggregate mod stylesheet with

```js
window.windowUtils.loadSheet(this.#chromeURI, window.windowUtils.USER_SHEET);
```

so everything in `chrome.css` is **user origin**, and the cascade puts author
normal *above* user normal:

```
UA normal < user normal < author normal < author important < user important
```

A plain declaration here therefore loses to any Zen rule that touches the same
property, no matter how specific ours is. Two of this section's three key
declarations are exactly that case and silently did nothing until they were
marked `!important`:

| ours | Zen's, which was winning |
|---|---|
| `display: flex` on the panel | `.zen-toolbar-background { display: none }` (`zen-compact-mode.css:9`) |
| `position: relative` on the toolbox | `#nav-bar, #navigator-toolbox { position: inherit }` (`zen-browser-ui.css:18-21`) |

The symptom is a pinned sidebar that looks completely untouched — no panel and
no float — while the stylesheet is demonstrably loaded and the pref is set. It
is also why nearly every rule in this mod carries `!important`, and why the
glass-control rules in section 6 do not need it: those declare properties on an
`::after` the mod itself creates, so no author rule competes.

### Geometry, and what has to be behind the panel

Compact insets the panel by **float/2 on all four sides**, but reaches that number
three different ways (`zen-compact-mode.css:124-158`):

| side | how compact gets there | result |
|---|---|---|
| left | `left: -float/2` against `padding: 0 float` | float/2 |
| right | same padding, `--actual-zen-sidebar-width` wide | float/2 |
| top | `top: float/2` | float/2 |
| bottom | `height: 100% - float` | float/2 |

Pinned, `#navigator-toolbox` is an ordinary flex child of `<hbox flex="1" id="browser">`
(`browser.xhtml:6081`; every XUL element is `display: flex`, `xul.css:18-21`), so the
same inset is one even value on the box itself — and it is also what pushes the page
aside, the toolbox being in flow rather than fixed.

The obvious way to write that is a margin, and it is wrong. **Margins are not
painted.** With a margin the gap around the panel shows whatever is underneath the
sidebar column, which is `#zen-browser-background` — the workspace gradient — and the
panel ends up framed in a colour compact never has behind it.

The gap is dropped on the page-facing side — the panel runs straight up to the page
there, with only its inner spacing left — so `inset-inline-end` goes to 0 and the
padding on that side carries the inner value alone. Both flip for a right-hand sidebar.

Otherwise the gap is padding, the toolbox paints it, and the panel is inset back out
of it:

```css
--safari-pin-gap: calc(var(--zen-compact-float) / 2);
padding: calc(var(--safari-pin-gap) + <inner spacing>);
#zen-toolbar-background { inset: var(--safari-pin-gap) !important; }
```

`inset: 0` resolves against the **padding box**, which is why it has to be overridden
at all — left alone the panel would cover the gap it is supposed to float inside.

That leaves the question of what colour the toolbox paints. Compact's panel does not
float over the gradient: with flush content the page card spans the whole window and
the compact toolbox is `position: fixed; z-index: 10`, above `#zen-appcontent-wrapper`,
so **the page is what is behind the panel** — both in the gap around it and under its
`backdrop-filter`.

A fixed light/dark pair is not close enough. It matches a default page and nothing
else: GitHub in dark mode is `#0d1117`, against a hardcoded `#202020` that is plainly a
different colour, and the gap goes back to reading as a frame. So the colour is
sampled live — see below — and the static pair survives only as the fallback:

```css
background: var(--safari-pin-canvas, rgb(255, 255, 255)) !important;
@media (-moz-content-prefers-color-scheme: dark) {
  background: var(--safari-pin-canvas, rgb(32, 32, 32)) !important;
}
```

Those fallbacks are the values Zen paints content with
(`zen-browser-container.css:16-18`). The media query is deliberate: `light-dark()` on a
chrome element resolves against the *chrome* colour scheme, so a light page under dark
chrome would come out dark. `-moz-content-prefers-color-scheme` is the content-side
one, the same signal `env(-moz-content-preferred-color-scheme)` carries.

`--tabpanel-background-color` (`content-area.css:11-13`, `#f9f9fb` / `#2b2a33`) also
tracks the content scheme and would serve as a fallback, but it is Firefox's newtab
canvas colour, not the one Zen actually paints `browser[type="content"]` with.

### Asking the page: `page-canvas.uc.mjs` and its actor pair

The gap has to be the colour of the page canvas, and it has to become that colour in
the frame the page appears — not before, not after. Those are two separate questions,
and neither can be answered from the parent process.

**What.** The colour showing at the left edge, resolved from layout in the content
process (`page-canvas-child.sys.mjs`). At three points one CSS pixel in from the edge
— 25 % / 55 % / 85 % of the viewport height, the same points the pixel sampler used —
`elementsFromPoint` gives the stack of boxes under the point, top to bottom, and the
first fully opaque background in that stack is what the eye sees there. Translucent and
image layers are stepped over, not stopped on: what shows through them is a blend only
pixels know, so the walk continues to the solid thing behind. `<html>` and `<body>` are
in the stack, so the CSS canvas is reached when nothing else paints there. Two of three
agreeing is the answer.

This is deliberately *not* the CSS canvas colour, which was the first actor design and
is wrong more often than it sounds: a great many apps leave `<body>` white and paint a
dark root `<div>` over it (`agent.pollyreach.ai/auth` was the one that showed it), and
the canvas is then a colour nobody sees. Reading the stack finds the div; reading the
canvas finds the white.

The answer is one of: an opaque colour, which the parent paints as is; or "layout alone
cannot name it" — a gradient, an image, a translucent stack, or nothing opaque at all —
and then the parent reads pixels, once, after the paint, which resolves the blend
correctly because the page is on screen by then. Each read also carries a `ready` flag —
first contentful paint has happened and the document is on screen — so a query cannot
paint a placeholder from a page that has not rendered yet.

Pixels were the first design of all, and they are why the gap jumped: a pixel one column
in from the left edge belongs to whatever the page put there — a sidebar, a banner, a
video, a lazily loaded image — and changes whenever that does. A box's background changes
only when the page restyles it. Layout is also cheap enough to read on every paint of a
load, which rasterising is not.

**When.** `MozAfterPaint`, listened for on the content window's `windowRoot` from a
`JSWindowActorChild`. It fires once a paint has been *composited*, so the first one for
a new document is the frame in which that document replaced the previous one on screen.
This is the in-tree pattern for "the page is now visible" — Firefox has no single event
for it and composes it the same way:

| in-tree user | what it gates on it |
|---|---|
| `LoginManagerChild.sys.mjs:1707-1773` | the first form fill: `DOMContentLoaded` → `windowRoot` `MozAfterPaint` → `visibilityState === "visible"`; the `TODO: Bug 1983533` beside it says there is no chrome-only event for this |
| `DOMFullscreenChild.sys.mjs:124-156` | reporting a finished fullscreen transition, with `event.transactionId > windowUtils.lastTransactionId` |
| `AboutReaderChild.sys.mjs:186-210` | the readability check, with `event.clientRects.length` as "did *my* document paint" |

`dom.send_after_paint_to_content` does not get in the way. It withholds the event from
web-page JS; privileged listeners in the content process are not what it gates, and
none of the three above consult it.

Not every `MozAfterPaint` is a paint of the page, though, and two tests sort out the
ones that are not. Gecko fires it for a tick that had invalidations but sent no
transaction, and — while painting is still suppressed for a new document — for a
transaction that composites nothing, leaving the `<browser>` element's own grey
background on screen. First: the event carries `transactionId`, and the child records
`windowUtils.lastTransactionId` when it arms the listener and ignores anything at or
below it (`DOMFullscreenChild.sys.mjs:147-150`). Second: the event has to have painted
rectangles of its own — `event.clientRects.length`, the discriminator
`AboutReaderChild.sys.mjs:210` uses — so an empty composite is skipped and the first one
that actually paints is taken. That first painted frame is the document's *first paint*,
the moment its background reaches the screen, which is exactly what to match.

First *contentful* paint was tried for the second test and was wrong. It waits for the
first frame with real content, which on a heavy dark app lands seconds after the dark
background is already showing — so the gap sat on the previous page's colour for the
whole load. Measured: swapping it for `clientRects` cut the gap-behind-page lag on a
light→dark navigation from ~250ms to one or two compositor frames. `load` forces the
flag on as a backstop for a document that somehow never delivered a painted event.

The listener is armed, not permanent. It is on from the document's creation
(`DOMWindowCreated`, before any paint) until two seconds after `load`, and again for two
seconds whenever something that could move the colour happens: an attribute change on
`<html>` or `<body>` (theme toggles flip a class there), a child added to `<head>` (a late
stylesheet), `pageshow` (bfcache), the document becoming visible, or the parent asking.
Outside those windows nothing runs. Each paint costs one `getComputedStyle`; a report
is sent only when the answer changes, so a load is one message.

**The parent applies, it does not decide.** `page-canvas.uc.mjs` writes the variable
when the *selected* browser reports, and on `TabSelect` from a per-browser `WeakMap`,
synchronously in the handler. A same-document location change — an SPA route — creates
no document and so no first paint, but may restyle; the parent nudges the page to watch
its next few paints (`Canvas:Refresh`). A `prefers-color-scheme` flip drops the cache and
nudges with `force`, so the page answers even if the colour is the same.

**Routing the report needs the reliable window handle.** The parent turns a report into
a `CustomEvent` on the chrome window, reached as `browsingContext.topChromeWindow`. That
matters: `top.embedderElement`, the obvious way to the `<browser>`, is intermittently
null exactly during a process switch — the very moment reports are flowing — and a parent
that keyed off it silently dropped every push and fell back to a network milestone. This
cost a long debugging round; `topChromeWindow` stays valid through the switch, and the
push arrives.

**The wash is for an empty tab, not a `transparent` browser.** When style names no
colour and the tab is genuinely Zen's empty tab, the gap shows the same wash the CSS
fallback does. The signal for "empty" is the tab's `zen-empty-tab` attribute, kept
current by `#changeToEmptyTab`. The `<browser>` element's `transparent="true"` looks
tempting and is wrong: Zen sets it when a tab is *created* empty and never clears it on
navigation (`tabbrowser.js:2960`), so a page opened from a new tab still carries it —
keying the wash off it washed real pages grey, which is exactly the bug that showed on
YouTube opened from a fresh tab.

**Layers, not just paint.** Across a process switch the compositor briefly has nothing
for the browser and the `<browser>` shows its own grey placeholder while the new process
paints into layers nobody is showing yet. The parent can tell — `browser.hasLayers`, and
`MozLayerTreeReady` when it flips (`AsyncTabSwitcher.sys.mjs:783`) — so a colour for a
browser without layers is held and applied on that event, with a short timeout as a
backstop. The same holds on a switch to a tab whose background layers were dropped:
applying the cached colour in the `TabSelect` handler would lead the switch by the wait,
so it defers too.

**No network milestone drives the colour.** An earlier version re-queried the page at the
end of the load (`STATE_STOP | STATE_IS_NETWORK`) as a safety net. It was removed: on a
page that streams — YouTube, Gmail — that milestone fires long before the content paints,
and applying its answer put the new colour in the gap a second or more before the page
appeared. The paint push is the only thing that changes the colour on a load now;
`TabSelect` reads the per-browser cache and confirms it with a `ready`-gated query.

Nothing is ever cleared while running. Handing the variable back to the CSS fallback is
itself a visible jump — to grey, under a dark content scheme.

**Traps, all of which bit once:**

- The initial document of every navigation is `about:blank`, and it fires `load` and
  `pageshow` like any other. `document.isInitialDocument` is the precise test; the
  child skips those documents outright.
- A document loading in a background tab never paints, so a paint-driven report would
  never come. The child sends its colour on `load` when `document.hidden`; that colour is
  not on screen, so sending it costs nothing visible, and it is what makes the eventual
  switch synchronous.
- `browser.tabs.remote.warmup.enabled` is on by default: a tab the pointer hovers over
  is warmed and *does* paint in the background. Reports from it land in the cache and
  are applied only if the browser is the selected one.
- The actor can be created late — the parent asking about a page that was open before
  the mod started. `load` has already happened and will not come again, so the child
  checks `readyState` and starts the post-load tail immediately rather than listening
  forever.
- `drawSnapshot`'s rect is in content CSS pixels; `getBoundsWithoutFlushing` is chrome
  pixels. Divide by `browser.fullZoom` or the lowest sample falls off a zoomed page's
  viewport and reads as unpainted.
- `safeForUntrustedWebProcess: true` is mandatory or the actor is never created on an
  ordinary site and fails silently. The actor modules are reachable at
  `chrome://sine/content/<id>/…` via the profile's `chrome.manifest`
  (`content sine ../sine-mods/`); derive the URLs from `import.meta.url`, since the
  folder is whatever id Sine fixed at first install. They must *not* be listed in
  `theme.json`'s `scripts`, or Sine imports them once as background modules.
- The actor modules are cached by the module loader for the life of the process.
  Sine's "Refresh mod styles" re-runs `page-canvas.uc.mjs` but not the `.sys.mjs`
  files; an edit to either actor needs a restart.

`mod.safari.pinned-panel.debug` (hidden, boolean) logs every report and every write
with a timestamp in the Browser Toolbox console. A navigation should be one `apply`
line; scrolling, video, and a live page should be none.

### The whole window, not just the gap

Painting only the gap left one seam: on a load the gap took the new colour a beat before
the page did, so for that beat a page-coloured strip sat beside Zen's grey content
placeholder. Rather than chase that beat down to zero, the page area is painted the same
colour, so there is no strip to notice — the window changes as one surface.

The lever is not transparency. Making the content `<browser>` transparent so the window
shows through would work but is a broad, risky change — the gradient would bleed on any
page without an opaque background, and video, PDF and translucent documents would all be
affected; Zen restricts transparent content browsers to the empty tab for exactly these
reasons. Nothing here is made transparent; two opaque surfaces are repainted with
`--safari-pin-canvas`.

Which surface actually shows during a load is not obvious, and guessing it wrong wasted a
round. The instinct is the `<browser>`'s own placeholder — Zen paints
`browser[type="content"]:not([transparent="true"])` a flat `light-dark(#fff, #202020)`
(`zen-browser-container.css:16-18`) — so that is repainted too. But a diagnostic fill
(browser magenta, the container behind it lime) showed the truth: on a cross-process
navigation the new document has no layers yet, the `<browser>` paints nothing, and what
shows through is **`#tabbrowser-tabpanels`**, the container Zen leaves transparent
(`zen-browser-ui.css:7-9`) — it came up lime, never magenta. That transparent container
was the black/grey frame the page area showed. So it is painted `--safari-pin-canvas` as
well, and between the two the content area carries the page colour whether the browser is
painting a placeholder or nothing at all. Both are opaque, so nothing composites through
and video, PDF and images are untouched; the page's own paint covers them exactly, since
that variable is what it was sampled from, so gap and page move as one.

The tabpanels fill is held off the empty tab (`&:not([zen-has-empty-tab="true"])`), where
the workspace gradient is meant to show, and the browser's `[transparent="true"]` branch —
the empty tab again — is left to Zen's wash. Both use the toolbox's fallback pair and
content-scheme media query, so with the script off the surfaces are Zen's own values and
nothing changes.

### Measuring it, at last

Every earlier round was steered by prose descriptions of a sub-second event, and each
fix traded one artefact for another because nobody could see the frame. This one was
measured. A WebDriver BiDi session drives Zen over `--remote-debugging-port` (navigate a
tab, switch tabs), and a Quartz `CGWindowListCreateImage` loop samples the gap pixel and
a page column off the driven window at ~25 fps, while the mod appends every decision to
`safari-canvas.log` with a `performance.now()` stamp. Aligning the two on the navigation
instant turns "it leads" into a number: on a white→YouTube navigation the gap now trails
the page by ~0.2 s rather than leading it, and a return to a backgrounded YouTube tab
applies `rgb(15,15,15)` on `layers-ready`, never the wash. `mod.safari.pinned-panel.debug`
turns the log on; the child's own per-paint trace is behind a `DEBUG` constant in
`page-canvas-child.sys.mjs`, off by default because it is a flood.

### Dead end: chasing the load-time jump from the parent

Before the actor, the colour came from three 1×1 `drawSnapshot` pixels down the left
edge, sampled on `TabSelect`, `onLocationChange` and `STATE_STOP`. It was stable
*enough* on a quiet page and had a flash during every load; eight attempts to remove
the flash from the parent side made things worse and were reverted. Do not retry them
— this is what happened, and why none of it could have worked.

**The random jumping had a mundane cause.** `onStateChange` was gated on bare
`STATE_STOP`, which fires for every finished request — images, XHR, beacons, ad
frames, media segments — not just the document. Each one re-sampled the left edge
180ms later, and on a live page the left edge is never the same twice. The
`LOCATION_CHANGE_SAME_DOCUMENT` filter was missing as well, so every SPA route change
cleared the cache and sampled again. Filtering those (`STATE_IS_NETWORK`,
`isTopLevel`, the same-document flag) is the minimal fix if the actor ever has to go;
it removes the jumping and keeps the load-time flash.

**The flash could not be fixed from the parent at all.** `drawSnapshot` rasterises the
*document*, not what the compositor has on screen; Gecko holds the previous frame until
the new document is worth showing, so the colour is readable long before any of it is
visible — about a second on a slow site. Every parent-side substitute for "the page is
now visible" is a network milestone, and the network is not the renderer:

| gate | why it fails |
|---|---|
| `isLoadingDocument` clearing | that is the load event, subresources included; heavy pages are on screen seconds earlier |
| `STATE_STOP \| STATE_IS_DOCUMENT` | a page that streams its markup — YouTube — keeps that request open long past first paint |
| an origin cache applied on `onLocationChange` | changes the colour *at* the navigation, a second before the page |
| `transition` on the toolbox background | a slower jump, not a fix |

There is no parent-process signal for a content paint. `MozAfterPaint` in the chrome
window belongs to the chrome window; `MozLayerTreeReady` tracks whether a remote
browser has *any* layers and is a tab-switch signal, not a navigation one
(`tabbrowser.js:2785-2790` re-triggers it by hand on remoteness change);
`MozAfterRemotePaint` and `requestNotifyAfterRemotePaint` no longer exist in Gecko 154;
and `AsyncTabSwitcher.sys.mjs:1402-1406` says outright that "the parent process might not
even get MozAfterPaint delivered" for a remote child's first paint.

**The first actor attempt used the wrong signal.** It reported on `DOMContentLoaded` +
`requestAnimationFrame`. rAF callbacks run on every refresh-driver tick, including the
ticks during which painting is still suppressed and the old page is still on screen —
so it led the paint just as the parent did, and it never ran at all for a background
tab. Its other flickers had ordinary causes that are handled above: reporting from the
initial `about:blank`, and clearing the variable on a "no answer".

### The splitter has to stop taking space

`#zen-sidebar-splitter` is not decoration: it is a real flex sibling, created in JS
(`ZenCustomizableUI.sys.mjs:51-56`), re-anchored after the toolbox on every layout
pass (`ZenUIManager.mjs:1505-1508`), and sized `min/max-width:
var(--zen-toolbox-padding) !important` (`vertical-tabs.css:874-884`) — 6px on macOS.

Left in flow it adds a second gap after the padded one, and that gap lies outside the
toolbox, so nothing paints it: a 6px stripe of gradient between the panel and the
page. Pulling it back over the toolbox by its own width
(`margin-inline-start: calc(-1 * var(--zen-toolbox-padding))`, mirrored for a
right-hand sidebar) takes it out of the layout while leaving the grab area exactly
where the eye expects it. Resizing is unaffected — the splitter drives the toolbox's
persisted `style.width`, not its own box.

Compact never hits this because it hides the splitter outright
(`zen-compact-mode.css:65`) and gives up resizing along with it. Keeping it is the
payoff for not pinning compact open.

### Surviving the compact-mode toggle

`gZenCompactModeManager` flips `zen-compact-mode` in the `preference` setter and only
*then* calls `_updateEvent()` → `animateCompactMode()`, which sets
`zen-compact-animating` on `:root` and `animate="true"` on the toolbox and animates
the inline margin (`ZenCompactMode.mjs:173-201`, `475-628`). Scoped to a plain
`:root:not([zen-compact-mode="true"])`, this section therefore switches off a frame
*before* the slide starts: the panel and the gap disappear, then the bare sidebar
slides away. That is the jump.

The fix is to stay applied for the length of the handover:

```css
:root:is(:not([zen-compact-mode="true"]), [zen-compact-animating])
```

This is safe because every compact rule that would collide is itself behind
`:not([animate='true'])` — the `position: fixed`, the `#titlebar { visibility: hidden }`
and compact's own `.zen-toolbar-background { display: flex }` are all suppressed while
the animation runs, and `#zen-sidebar-splitter { display: none }` sits behind
`:not([zen-compact-animating])`. So during the overlap only this section applies, the
panel slides out with the sidebar, and compact takes over once the toolbox is already
off screen. Nothing in section 5 is touched.

Only the animated toggle is covered. Flipping `mod.safari.pinned-panel` itself is a
media-query change and snaps by definition.

### Why not just pin compact open

The obvious alternative is to leave compact mode on and force the panel to its
revealed position — `left: calc(var(--zen-compact-float) / -2) !important` plus
`#titlebar { visibility: visible }`. The render would be byte-identical, since it
would *be* the compact render. It was rejected for two reasons:

- The panel is `position: fixed`, so the page runs underneath it and space has to
  be reserved by hand. The width to reserve is `--actual-zen-sidebar-width`, which
  `ZenCompactMode.mjs:437` writes **inline on `#navigator-toolbox`** — it does not
  inherit into `#zen-tabbox-wrapper`, so a script would be needed just to mirror
  the number onto `:root`.
- `#zen-sidebar-splitter` is `display: none !important` in compact, so sidebar
  resizing disappears.

### Collapsed sidebar

The collapsed rail needs no width fixing. Compact has to bump
`--zen-toolbox-max-width` to 74px (`zen-compact-mode.css:108`) because its float is
padding on a box already capped at 60px; here the cap describes the same box and the
gap is padding inside it, so the panel simply lands where the tabs already fit.

The one thing carried over is that compact runs the collapsed rail with no inner
horizontal padding at all (`zen-compact-mode.css:190`, `var(--zen-toolbox-padding) 0`)
— a tab is already as wide as the rail — so `padding-inline` drops to the bare gap.

Nothing in this section writes to `#titlebar`, which matters more than it looks: the
collapsed layout fixes in `zen-tabs.css` are scoped to
`:root:not([zen-compact-mode='true'])`, so unlike in compact they are live, and one of
them reserves `padding-top: var(--zen-toolbar-height)` on `#titlebar` for the window
buttons. Leaving the element alone lets that clearance survive on its own.

### Section 5 rescoping

The reveal animation in section 5 used to match `#navigator-toolbox` globally even
though every rule in it is about compact's slide. Left alone it would put a
`transition: visibility 0.30s` on a toolbox that never moves. All five selectors
are now prefixed with `:root[zen-compact-mode="true"]`; the closing rule is still
less specific than the opening one, so the cascade inside compact is unchanged.

---

## 9. Site accent colour

`mod.safari.site-accent`, chrome.css section 11 plus `site-accent.uc.mjs` and an
actor pair. The sidebar takes the colour of the site you are on, in both modes.

### Where the colour comes from, and what does not help

A cascade: the favicon's dominant colour, then `<meta name="theme-color">`, then the
page's canvas colour.

Two things that look like they would help, and do not:

- **`ZenGradientGenerator.getMostDominantColor` is a false friend.** It takes
  `workspaceTheme.gradientColors` — the dots the user placed in Zen's own gradient
  picker — and returns the one marked `isPrimary`, else the middle one
  (`ZenGradientGenerator.mjs:1489-1496`, `:1857-1867`). It never touches an image, a
  favicon or a page.
- **Firefox does not parse `<meta name="theme-color">` at all.** `ContentMetaChild`
  collects only description and preview-image tags; the Web App Manifest `theme_color`
  is a different spec, fetched on demand and only for Taskbar Tabs. That tier is the
  entire reason this feature needs an actor.

What is reusable is the *policy*, not the arithmetic: `getToolbarModifiedBaseRaw`
(Zen's sidebar base plus its acrylic alpha), `blendColors` and `contrastRatio` off
`window.gZenThemePicker`. The HSL conversions are local on purpose — Zen's
`hslToRgb` takes hue as a fraction while its `rgbToHsl` returns degrees, and a silent
convention mismatch there would be a wrong colour rather than an error.

### The compositing knob

Do **not** overwrite `--zen-main-browser-background-toolbar`. Zen rewrites it inline
on every workspace change, drag frame and swipe frame (`ZenGradientGenerator.mjs:1730`,
`ZenSpaceManager.mjs:1852-1867`), its value is often a `linear-gradient` and so cannot
be transitioned, and replacing it kills the workspace crossfade.

The accent is stacked over it in the same shorthand instead:

```css
@property --safari-accent { syntax: "<color>"; inherits: true; initial-value: transparent; }

#zen-toolbar-background::after {
  background:
    linear-gradient(var(--safari-accent), var(--safari-accent)),
    var(--zen-main-browser-background-toolbar) !important;
  background-blend-mode: normal, screen !important;
}
```

Three things fall out of that shape:

- alpha 1 is a full replacement, alpha 0 is the untouched theme — so "this page has
  no accent" is the same animation running backwards, not a separate code path;
- Zen's crossfade still works, `::after` at `opacity: var(--zen-background-opacity)`
  and `::before` at `calc(1 - …)` untouched, both carrying the same accent;
- **`background-blend-mode: normal` on our layer.** The theme layers carry `screen`
  (`zen-browser-ui.css:66,79`), which only ever lightens; inheriting it washes the
  accent out. This is the difference between the colour being right and being
  approximately right.

`@property` works in this context — Zen uses it itself (`zen-boosts.css:598`) — and a
registered custom property is what makes the colour transitionable at all.

### Which element, in which mode

`#zen-toolbar-background` is `display: none` outside compact mode
(`zen-compact-mode.css:9`), lifted only inside `:root[zen-compact-mode='true']` — and
by section 10 of this file. So one element covers compact *and* pinned-with-panel, and
only stock pinned needs a second target: `#navigator-toolbox`, whose
`--zen-navigator-toolbox-background` hook Zen declares (`zen-browser-ui.css:12-16`) and
then never writes anywhere in the tree. That rule is excluded when section 10 is on,
where the toolbox background is already the page canvas behind the panel.

Tinting `#zen-browser-background` instead would be wrong: that element spans the whole
window, not the sidebar.

### Getting the colour right

The accent replaces hue and chroma but its **lightness is normalised into the band the
current scheme already occupies**. Taken literally, "the site's colour" paints a
`#ff0000` sidebar on YouTube with white labels on saturated red. Normalising means no
chrome text colour has to be touched, so nothing fights `ZenGradientGenerator`'s own
`zen-should-be-dark-mode` / `--toolbox-textcolor` writes.

Saturation is only pushed *up* when there is chroma to push (`s >= 0.08`). Clamping a
grey up to the floor would invent a hue that is in no part of the source — GitHub's
`#1f2328` would come out visibly blue.

**Translucency and "laid over the theme" are two different things.** Conflating them
cost two round trips.

First cut: the accent carried Zen's acrylic alpha (0.6 from
`getToolbarModifiedBaseRaw`) *and* sat on top of the workspace gradient, so 40% of the
gradient showed through and a blue site came out muddy purple-blue. Second cut: opaque,
which fixed the colour and killed the panel's `backdrop-filter` — most of what makes
the sidebar look like glass.

What was actually needed is translucent **and** not over the theme. While an accent is
showing, `:root` carries `[safari-accent]` and section 11 drops the theme layer
entirely, so what the accent reveals is the blur rather than the gradient.

**Then a scrim, because a raw blur is not a known quantity.** The same Telegram blue
reads 7.7:1 against white labels over a dark site and 2.9:1 over a white one — legible
on some sites and not on others, which is exactly the "not very readable" complaint.
A scrim at `SCRIM_ALPHA` settles the backdrop toward the scheme's own extreme before the
accent lands on it. It is the same job Zen's `brightness(0.25)` does inside its acrylic
filter — the one section 4 strips out for being a dark-mode hardcode.

The contrast loop then measures the **real composite in its worst case**: the accent
over the scrim over the least helpful page the site could put behind it, a white page
under dark chrome or a black one under light. And it measures the gradient end nearest
the text, not the midpoint — the sheen puts one end above the other either way, and
optimising the middle leaves that end short. With those two corrections every brand
colour tested clears 4.5:1 at both ends, worst case.

**The lightness is clamped, not blended.** Mixing 75% of a target lightness into the
source was the other half of "it barely tints". It landed every
site on roughly the same washed-out shade — the hue survived and everything that made
it recognisable did not. Clamping into a band leaves a source already inside it
completely alone:

| | dark chrome | light chrome |
|---|---|---|
| lightness band | 0.14 – 0.30 | 0.80 – 0.94 |
| saturation | clamped 0.28 – 0.80, and only when `s >= 0.08` | same |

The two ends are that band's value plus and minus `SHEEN`, lighter at the top — a
shallow vertical gradient in the site's own hue, which is the difference between
"coloured" and "finished".

### The transition has to live on `:root`

A registered custom property animates **on the element whose value changes**. A
descendant that merely inherits it receives the new value outright, however many
transitions are declared on the descendant.

The script writes `--safari-accent-top` / `-bottom` / `-scrim` to `:root`, so declaring
the transition on `#zen-toolbar-background::after` — where the colour is *used* — looked
right and did nothing at all: the colour jumped on every tab switch. The transition
belongs on `:root`, and everything below then inherits a value that is already moving.

`--safari-accent-scrim` is registered as a `<color>` for the same reason, and fades to
`rgba(…, 0)` rather than being dropped, so the theme is never revealed through a scrim
that is still darkening it.

### Favicon scoring

Most-frequent-pixel is the wrong answer — it returns the icon's paper or its ink on
almost every favicon. So: drop `alpha < 128`, drop `l > 0.93` and `l < 0.07`, drop
`s < 0.15` (this is what makes a monochrome mark decline and fall through to the next
tier rather than producing a grey "accent"), bucket the survivors by hue in 24 bins
against a coarse saturation/lightness grid, score `count × (0.5 + s)` so a small vivid
mark beats a large dull field, and return the winning bucket's **mean** rather than its
centre, which is a quantisation artefact.

The downscale to 32×32 uses `resizeQuality: "pixelated"` deliberately: smooth
downscaling averages neighbouring pixels and invents hues that are in no part of the
icon.

**Getting the bytes needs two paths, and only having one was a real bug.** `fetch()`
handles `data:` and `http(s):` icons straight from cache, but Zen hands out
`moz-remote-image:` URLs for SVG favicons — a protocol for re-encoding an image safely —
and `fetch` cannot read those at all. That is not an edge case: it is why GitHub kept
showing the workspace gradient, and why Claude fell through to its page background
instead of taking the orange off its own mark. Places already holds the decoded bytes
for any icon it has seen, so `PlacesUtils.favicons.getFaviconForPage(browser.currentURI)`
→ `.rawData` is the fallback: local data, no protocol handler, no CORS.

A third path exists behind those two, and it is the one that catches what they cannot:
render the icon with an `<img>` in the chrome document and read the canvas back. That
resolves every scheme Zen hands out — `moz-remote-image:`, `page-icon:`, `data:` — and
rasterises an SVG that `createImageBitmap` refuses for having no intrinsic size. Reading
the pixels needs a system-principal document, which is what a `.uc.mjs` runs in.

**No miss is ever cached, at either level.** This was the bug behind "claude.com works,
claude.ai does not". A miss usually means the icon has not reached Places yet, or the
actor has not reported — and `remember(origin, null)` made that permanent for the
origin, so whichever domain happened to be unlucky on its first visit stayed colourless
for the session while its twin worked fine. Nothing about the site differed; only the
timing of the first look did.

For the same reason a miss schedules one look back after `RETRY_MS`. `TabAttrModified`
does not fire for an icon that was already set before the listener attached, so without
it a tab opened from a restored session or a background load could sit colourless with
nothing coming to correct it.

When every tier declines, the reason is logged — which icon URL, whether it decoded,
what the actor said. A silent failure here is indistinguishable from the feature being
off, and that cost two rounds of guessing.

`chrome:`, `about:` and `resource:` icons are skipped — those are Zen's own defaults.

The scoring pass also returns a second, **neutral** reading: the mean of every opaque
pixel, chromatic or not. It is the last tier in the cascade, after the canvas. Without
it a site with no colour anywhere — a monochrome mark, no `theme-color`, and an actor
that has not reported yet — falls through to the workspace gradient, and a purple
sidebar on a flat grey site reads as the feature having simply failed. With it, a
monochrome site gets a monochrome sidebar, which is what it should have. Saturation is
only clamped upward when there is chroma to clamp (`s >= 0.08`), so a grey source stays
grey rather than having a hue invented for it.

### Why timing is not a problem here

The gutter feature in §8 has to land on a specific frame, which is why it needs the
content process to say when. This one *wants* a half-second cross-fade, so an accent
arriving a few frames early or late is absorbed by the transition rather than seen as
a jump. That is why this feature can afford a cascade with an async favicon decode in
it and the previous one cannot.

---

## 10. Method notes

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
