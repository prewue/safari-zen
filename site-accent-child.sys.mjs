// Content side of the site accent: <meta name="theme-color">, which Firefox
// does not parse, and the canvas colour from computed style. Every report
// carries the document phase - meta, dcl, load - and the load one is always
// sent, since the parent waits for it before trusting the canvas. DEV.md §9.

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

  // Several may be gated on media queries; the last matching wins, as in CSS.
  #themeColour() {
    const doc = this.document;
    const win = doc?.defaultView;
    if (!doc || !win) return null;

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

  // CSS propagates the canvas background from <html>, else from <body>.
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

  // about:blank is the initial document of every navigation; never answer from it.
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

    // a phase never goes backwards
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
