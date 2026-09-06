<img width="1123" height="810" alt="banner" src="https://github.com/user-attachments/assets/48cb8d77-b43c-4da4-a81b-272b81dd38ab" />

# Safari-like Zen

A [Sine](https://github.com/CosmoCreeper/Sine) mod that makes Zen Browser feel
like Safari on macOS: native window corners, a floating translucent sidebar
that takes the colour of the site you are on, and motion with a bit of spring.

## Install

In Zen, open **Settings → Mods**, add a mod from GitHub and paste:

```
prewue/safari-zen
```

Then turn on Sine's JS switch (below), fully quit Zen (**⌘Q**) and reopen it.

Needs Zen with Sine. The native window corners need macOS 26; everything else
works wherever Zen runs.

### Enable JS in Sine

Sine only runs a mod's scripts if the mod comes from its store or you have
allowed JS from other sources. This mod is installed from GitHub, so:

1. Open Zen **Settings → Sine** (the mods page).
2. Under **General**, turn on **Enable installing JS from unofficial sources**.
3. Fully quit Zen (**⌘Q**) and reopen it.

Without it the CSS parts still work — the sidebar shape, blur, glass field,
tab hover and reveal animation — but these do not:

| Needs JS | What you get without it |
|---|---|
| Native window corners, flush content edges | Zen's default corners and 8px content gap |
| Sidebar follows the site | Nothing; the sidebar keeps your workspace colour |
| Pinned sidebar's page-coloured gap | The panel still floats, over a flat light/dark gap |
| Folder motion, space swipe blur | Zen's own folder timing, no blur |

## What it does

- **Native window corners.** macOS's own window shape, like every native app.
- **Floating translucent sidebar.** Zen's translucency with a softer blur, a
  7px float from the window edge, and corners that follow the window's own
  curve concentrically.
- **Pinned sidebar with the compact panel.** With compact mode off, the
  sidebar keeps compact's floating panel but stays put, the page sits beside
  it, and the gap around the panel takes the page's own background colour.
- **Sidebar follows the site.** The sidebar takes the site's colour — from its
  favicon, its `theme-color` or its page background — once per navigation,
  cross-fading between sites. Replaces your workspace colour on the sidebar.
- **Liquid glass search field.**
- **Motion.** A spring reveal for the sidebar, folders that open as one, a tab
  hover fade, and a blur on the space you swipe away from. All of it respects
  the system "reduce motion" setting.

## Settings

Everything is an on/off switch in **Settings → Mods → Safari-like Zen**. Two of
them — the native window corners and the native translucent sidebar — need a
full restart (**⌘Q**) after changing.

To change the window corner radius, edit `RADIUS` in `window-radius.uc.mjs`
(26 is the macOS default; 20, 15 and 10 also look right); the sidebar's corners
follow it. The sidebar's float is the first rule in `chrome.css`.

## Uninstall

Remove the mod in **Settings → Mods**. On macOS, restore the default window
corners once:

```sh
defaults delete app.zen-browser.zen NSConvolutionOverride1
```

## Note

On macOS this mod runs `/usr/bin/defaults` from privileged browser code to set
the window corner radius. Install it only if you're happy with that.

Internals, measurements and research notes: [DEV.md](DEV.md).
