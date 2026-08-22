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
than a docked strip.

**Spring reveal animation.** Hovering the edge slides the sidebar in with a
light spring that overshoots slightly and settles. Closing is quicker and
doesn't bounce. Respects the system "reduce motion" setting.

## Settings

Open **Settings → Mods → Safari-like Zen**.

| Setting | Default | What it does |
|---|---|---|
| Native translucent sidebar | On | Makes the sidebar see-through |
| Blur Sidebar Background (Acryllic Filter) | On | Blurs what's behind the sidebar |
| Sidebar blur radius | `24px` | How soft the blur is |
| Sidebar blur saturation | `150%` | How vivid colours stay through the blur |
| Theme gradient on top of the blur | `1` | How much of your theme colour shows, `0`–`1` |
| Custom window corner radius | On | Rounds the window corners (macOS only) |
| Premium sidebar reveal animation | On | The spring slide-in |

Two of these — **Native translucent sidebar** and **Custom window corner
radius** — are only applied at startup. After changing either one, fully quit
Zen (**⌘Q**) and reopen it.

**Custom window corner radius** is macOS only and does nothing on other
platforms.

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
