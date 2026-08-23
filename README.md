<img width="685" height="407" alt="image" src="https://github.com/user-attachments/assets/217cd074-300f-4893-987f-3f23704b3ee3" />

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

**Spring reveal animation.** Hovering the edge slides the sidebar in with a
light spring that overshoots slightly and settles. Closing is quicker and
doesn't bounce. Respects the system "reduce motion" setting.

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
| Liquid glass search field and active tab | Gradient fill, gradient edge and depth on both |

**Animation**

| Setting | What it does |
|---|---|
| Sidebar reveal | Springs in, blurs and fades on the way out |
| Folder open and close | Icon, chevron and contents move as one, scaled to folder size |
| Tab hover | Background and the close/reset buttons fade in together |
| Blur the page while switching spaces | Old space blurs out, the new one arrives out of focus |

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
