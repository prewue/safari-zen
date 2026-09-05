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
// Every report says which phase of the document it comes from - "meta" for a
// theme-color parsed or changed, "dcl" for DOMContentLoaded, "load" for load.
// The parent decides from the phase how far to trust the canvas: at "dcl" the
// stylesheets may still be on their way, at "load" they are in. A report is
// sent whenever the answer or the phase changes, so "load" always arrives even
// when it repeats the colours - the parent is waiting for that word.
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
        if (event.target === this.document) this.#report("dcl");
        break;
      case "load":
      case "pageshow":
        if (event.target === this.document) this.#report("load");
        break;
      case "DOMMetaAdded":
      case "DOMMetaChanged":
        // Sites that swap theme-color with the colour scheme, or on route
        // changes, do it through these.
        if (event.target?.name === "theme-color") this.#report("meta");
        break;
    }
  }

  receiveMessage(message) {
    if (message.name === "Accent:Get") return this.#read(this.#phase());
    return undefined;
  }

  #phase() {
    const state = this.document?.readyState;
    if (state === "complete") return "load";
    if (state === "interactive") return "dcl";
    return "meta";
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

  #read(phase) {
    const doc = this.document;
    if (!doc || doc.documentURI === "about:blank") {
      return { themeColour: null, canvasColour: null, phase };
    }
    try {
      return {
        themeColour: this.#themeColour(),
        canvasColour: this.#canvasColour(),
        phase,
      };
    } catch (e) {
      return { themeColour: null, canvasColour: null, phase };
    }
  }

  #report(phase) {
    const data = this.#read(phase);
    // A phase never goes backwards: a theme-color change after load is still a
    // "load"-phase answer, so the parent keeps trusting the canvas.
    if (phase === "meta" && this.document?.readyState !== "loading") {
      data.phase = this.#phase();
    }
    const key = `${data.themeColour}|${data.canvasColour}|${data.phase}`;
    if (key === this.#sent) return;
    this.#sent = key;
    try {
      this.sendAsyncMessage("Accent:Colour", data);
    } catch (e) {}
  }
}
