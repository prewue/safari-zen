<img width="1123" height="810" alt="banner" src="https://github.com/user-attachments/assets/48cb8d77-b43c-4da4-a81b-272b81dd38ab" />

# Safari-like Zen

A [Sine](https://github.com/CosmoCreeper/Sine) mod that makes Zen Browser feel
like Safari on macOS native window corners, a translucent sidebar, and a
reveal animation with a bit of spring to it.

## Requirements

- Zen Browser with the Sine mod manager
- macOS 26 (Tahoe) or newer, only for the native window corners. The sidebar
  styling, blur and animation work on any platform Zen runs on.

## Install

In Zen, open **Settings**, add a mod from GitHub and paste:

```
prewue/safari-zen
```

Then fully quit Zen (**⌘Q**) and reopen it.

## Features

**Native window corners.** Rounds the browser window using macOS's own window
shape, so Zen matches Safari and every other native app instead of drawing its
own approximation. macOS only.

**Translucent sidebar.** Turns on Zen's built-in translucency and blurs whatever
sits behind the sidebar. Your workspace theme is kept — a gradient stays a
gradient, just softer — and switching workspaces still cross-fades normally.

**Safari-like sidebar shape.** The sidebar floats 22px from the window edge with
a 20px corner radius and tighter internal padding, so it reads as a panel rather
than a docked strip. The page itself sits flush against the window, with no gap
around it.

**Pinned sidebar with the compact panel.** Turn Zen's compact mode *off* and the
sidebar keeps compact's look — the floating rounded panel with the blur and the
shadow — while staying put. The page sits beside it rather than underneath, and
the splitter still resizes it, neither of which compact allows. The gap around
the panel is painted with the current page's own background colour — reported
by the page in the frame it appears — and so is the area behind the page while
it loads, so the whole window reads as one surface and the colour never lands
in the gap before the page arrives. The panel reads as floating on the page the
way it does in compact instead of being framed by the workspace gradient.
Compact mode itself is untouched: switch it back on and the hover reveal works
exactly as before.

**Sidebar follows the site.** The sidebar takes the colour of the site you are
on and cross-fades to the next one as you move between pages — in compact mode
and pinned mode alike. The colour comes from the favicon where it has one, from
the site's own `theme-color` where it declares one, and from the page background
otherwise; a page with no colour of its own fades back to your workspace theme.
Brand colours are normalised into the same lightness your theme already uses, so
a red site does not turn the sidebar into a warning label. This one replaces
your Zen theme colour on the sidebar while it is on.

**Considered motion.** Hovering the edge slides the sidebar in with a light
spring that overshoots slightly and settles; closing is quicker and doesn't
bounce. Folders open with their icon and chevron on the same timing, scaled to
how much content is moving. Tab hover fades in. Swiping between spaces blurs
the one you are leaving, in step with your finger. All of it respects the
system "reduce motion" setting.

## Settings

Everything is a plain on/off switch, grouped in **Settings → Mods → Safari-like
Zen**. There are no values to tune — the point is one coherent Safari-like look,
not a customiser.

**Window**

| Setting | What it does |
|---|---|
| Native window corner radius | Rounds the window using macOS's own shape (macOS only) |
| Flush content edges | Removes the gap between the page and the window |

**Sidebar layout**

| Setting | What it does |
|---|---|
| Outer padding | Floats the sidebar off the window edge |
| Inner padding | Tighter spacing inside the sidebar |
| Sidebar corner radius | Rounds the sidebar panel |

**Sidebar background**

| Setting | What it does |
|---|---|
| Native translucent sidebar | Zen's own translucency |
| Blur Sidebar Background | Blurs what sits behind the sidebar |

**Controls**

| Setting | What it does |
|---|---|
| Liquid glass search field | Gradient fill, gradient edge and inner depth |

**Pinned sidebar (experimental)**

| Setting | What it does |
|---|---|
| Pinned sidebar as compact | Gives the always-visible sidebar compact mode's floating panel. Only applies while compact mode is off |

**Site colour (experimental)**

| Setting | What it does |
|---|---|
| Sidebar follows the site | Takes the current site's accent colour, cross-fading between pages. Works in both compact and pinned mode. Overrides your Zen theme colour on the sidebar |

**Animation**

| Setting | What it does |
|---|---|
| Sidebar reveal | Springs in, slides out |
| Folder open and close | Icon, chevron and contents move as one, scaled to folder size |
| Tab hover | Background and the close/reset buttons fade in together |
| Blur the space you are leaving while swiping | Follows the gesture; the space arriving stays sharp |

Two of these — **Native window corner radius** and **Native translucent
sidebar** — are only read at startup. After changing either, fully quit Zen
(**⌘Q**) and reopen it.

To change how round the window corners are, edit `RADIUS` in
`window-radius.uc.mjs`. Useful values are `26`, `20`, `15` and `10`.

## Uninstall

Remove the mod in **Settings → Mods**. On macOS, run this once in Terminal to
restore the default window corners:

```sh
defaults delete app.zen-browser.zen NSConvolutionOverride1
```

## Note

On macOS this mod runs `/usr/bin/defaults` from privileged browser code in order
to set the window corner radius. Install it only if you're happy with that.

---

Implementation details, measurements and research notes live in [DEV.md](DEV.md).
