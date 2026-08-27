// Content side of the site accent colour.
//
// Answers the two tiers the parent process cannot see for itself:
//
//   theme-color  Firefox does not parse <meta name="theme-color"> at all - the
//                grep across both omni archives is empty, and ContentMetaChild
//                only collects description and preview-image tags. The Web App
//                Manifest theme_color is a different spec, fetched on demand and
//                only for Taskbar Tabs. So there is nothing to read from chrome,
//                and this is why the feature needs an actor at all.
//
//   canvas       Read from computed style rather than sampled from pixels. CSS
//                propagates the canvas background from <html>, or from <body>
//                when <html> declares none, so those two in that order are the
//                whole rule.
//
// about:blank is skipped outright: the initial document of every navigation is
// about:blank and fires load like any other, so reporting from it would answer
// over the real page.

const TRANSPARENT = "rgba(0, 0, 0, 0)";

export class SafariZenAccentChild extends JSWindowActorChild {
  #sent = "";

  handleEvent(event) {
    switch (event.type) {
      case "DOMContentLoaded":
      case "pageshow":
      case "load":
        this.#report();
        break;
      case "DOMMetaAdded":
      case "DOMMetaChanged":
        // Sites that swap theme-color with the colour scheme, or on route
        // changes, do it through these.
        if (event.target?.name === "theme-color") this.#report();
        break;
    }
  }

  receiveMessage(message) {
    if (message.name === "Accent:Get") return this.#read();
    return undefined;
  }

  #themeColour() {
    const doc = this.document;
    const win = doc?.defaultView;
    if (!doc || !win) return null;

    // A page may ship several, each gated on a media query - typically one for
    // light and one for dark. The last matching one wins, as in CSS.
    let found = null;
    for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
      const content = meta.getAttribute("content")?.trim();
      if (!content) continue;
      const media = meta.getAttribute("media");
      if (media) {
        try {
          if (!win.matchMedia(media).matches) continue;
        } catch (e) {
          continue;
        }
      }
      found = content;
    }
    return found;
  }

  #canvasColour() {
    const doc = this.document;
    const win = doc?.defaultView;
    const root = doc?.documentElement;
    if (!win || !root) return null;

    const opaque = value =>
      value && value !== "transparent" && value !== TRANSPARENT ? value : null;

    return (
      opaque(win.getComputedStyle(root).backgroundColor) ??
      (doc.body ? opaque(win.getComputedStyle(doc.body).backgroundColor) : null)
    );
  }

  #read() {
    const doc = this.document;
    if (!doc || doc.documentURI === "about:blank") {
      return { themeColour: null, canvasColour: null };
    }
    try {
      return {
        themeColour: this.#themeColour(),
        canvasColour: this.#canvasColour(),
      };
    } catch (e) {
      return { themeColour: null, canvasColour: null };
    }
  }

  #report() {
    const data = this.#read();
    // load fires after DOMContentLoaded on every page; a repeat of the same
    // answer would cost a message and a repaint for nothing.
    const key = `${data.themeColour}|${data.canvasColour}`;
    if (key === this.#sent) return;
    this.#sent = key;
    try {
      this.sendAsyncMessage("Accent:Colour", data);
    } catch (e) {}
  }
}
