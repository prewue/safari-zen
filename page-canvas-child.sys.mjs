// Content side of the page canvas colour.
//
// The parent process has two things it cannot see for itself, and this actor
// answers both:
//
//   when   The frame in which a new document reaches the screen. Every parent-
//          side signal is a network milestone, and drawSnapshot rasterises the
//          document long before the compositor shows it. The content process
//          does know: MozAfterPaint on the window root fires once a paint has
//          been composited. That is the in-tree pattern for "the page is now
//          visible" - LoginManagerChild.sys.mjs:1707-1773 gates its first form
//          fill on exactly this, and DOMFullscreenChild.sys.mjs:124-156 uses it
//          to report a finished transition. dom.send_after_paint_to_content is
//          irrelevant here: it withholds the event from web-page JS, not from
//          privileged listeners in the content process.
//
//   what   The colour actually showing at the left edge, resolved from layout
//          rather than from pixels. At three points down the edge,
//          elementsFromPoint gives the stack of boxes under that point, and the
//          first one with an opaque background is what the eye sees there. The
//          modal value of the three wins, as it did with pixels. This is
//          deliberately not the CSS canvas colour: a great many apps leave
//          <body> white and paint their dark root <div> over it, and the
//          canvas is then a colour nobody sees. Reading layout rather than
//          pixels is what keeps it steady - a box's background changes only
//          when the page restyles it, not when an image loads or a video plays
//          inside it - and cheap enough to do on every paint of a load.
//
// The paint listener is armed, not permanent: from the document's creation
// until shortly after load, and again for a couple of seconds whenever
// something that could move the colour happens - a theme toggle flipping a
// class on <html>, a late stylesheet, the page coming back from bfcache or
// from the background, or the parent asking. Between those windows nothing
// runs at all. A report is sent only when the answer changes.
//
// Not every MozAfterPaint is a paint of the page. Gecko fires it for a tick
// that had invalidations but sent no transaction, and - while painting is
// still suppressed for a new document - for a transaction that draws nothing,
// which leaves the <browser> element's own background on screen. Two tests
// sort those out: the event's transactionId has to be past the one current
// when the listener was armed (DOMFullscreenChild.sys.mjs:147-150), and the
// event has to have painted rectangles of its own (event.clientRects, the same
// discriminator AboutReaderChild.sys.mjs:210 uses). That second test fires on
// the document's *first paint* - the frame its background reaches the screen -
// which is the moment to match. First contentful paint was tried instead and
// was wrong: on a heavy dark app it lands seconds late, long after the dark
// background is already showing, so the gap held the old colour the whole load.
//
// The initial document of every navigation is about:blank, and it fires load
// and pageshow like any other document. It is skipped outright, or it would
// answer over the real page.

const TRANSPARENT = "rgba(0, 0, 0, 0)";

// Routes child-side events to the parent's log when on. Off in normal use;
// the flood of per-paint lines is only wanted when chasing a timing bug.
const DEBUG = false;

// Fractions of the viewport height, one CSS pixel in from the left edge. The
// top of a page is usually a header; the value that recurs down the edge is
// the surface the panel would be floating on.
const SAMPLES = [0.25, 0.55, 0.85];
const SAMPLE_X = 1;

// How long paints keep being checked after load, for stylesheets and scripts
// that finish colouring the page just after it.
const LOAD_TAIL_MS = 2000;

// How long a nudge - a mutation, a visibility change, a parent request - keeps
// the paint listener on.
const NUDGE_MS = 2000;

export class SafariZenCanvasChild extends JSWindowActorChild {
  #active = false;
  #sent = "";
  #paintTarget = null;
  // windowUtils.lastTransactionId when the listener went on; paints at or
  // below it were not composited after that moment.
  #baseline = 0;
  #painted = false;
  #loaded = false;
  // Paints are checked until this Cu.now() timestamp; Infinity until load.
  #until = 0;
  #observer = null;
  #lateObserved = false;

  actorCreated() {
    const doc = this.document;
    if (!doc) return;
    // isInitialDocument is the precise test; the URI check is the fallback for
    // a build without it, at the cost of never answering for a typed
    // about:blank, which has nothing to show anyway.
    if (doc.isInitialDocument ?? doc.documentURI === "about:blank") return;
    this.#active = true;

    try {
      doc.addEventListener("visibilitychange", this);
    } catch (e) {}

    // Anything on <html> can change the canvas - class, style, data-theme.
    // <body> and <head> are watched from DOMContentLoaded on, once they exist.
    try {
      this.#observer = new this.contentWindow.MutationObserver(() =>
        this.#arm(NUDGE_MS)
      );
      this.#observer.observe(doc.documentElement, { attributes: true });
    } catch (e) {}

    // Until load, every paint is looked at. The first one is the frame in
    // which this document replaced the previous one on screen.
    //
    // The actor can also be created late - the parent asking about a page
    // that was open before the mod started - and then load has already
    // happened and will not come again; the tail starts now.
    if (doc.readyState === "complete") {
      this.#observeLate();
      this.#loaded = true;
      this.#painted = true;
      this.#until = Cu.now() + LOAD_TAIL_MS;
    } else {
      if (doc.readyState === "interactive") this.#observeLate();
      this.#until = Infinity;
    }
    this.#arm(0);
    this.#dbg("created", this.document.documentURI.slice(0, 60), "ready=" + doc.readyState);
  }

  didDestroy() {
    this.#active = false;
    this.#disarm();
    try {
      this.#observer?.disconnect();
    } catch (e) {}
    this.#observer = null;
    try {
      this.document?.removeEventListener("visibilitychange", this);
    } catch (e) {}
  }

  #dbg(...args) {
    if (!DEBUG) return;
    try {
      this.sendAsyncMessage("Canvas:Debug", { args });
    } catch (e) {}
  }

  handleEvent(event) {
    if (!this.#active) return;
    switch (event.type) {
      case "MozAfterPaint":
        this.#onPaint(event);
        break;
      case "DOMContentLoaded":
        if (event.target !== this.document) return;
        this.#observeLate();
        break;
      case "load":
        if (event.target !== this.document) return;
        this.#observeLate();
        this.#loaded = true;
        this.#until = Cu.now() + LOAD_TAIL_MS;
        // By load a visible page has painted; if no qualifying paint event was
        // ever seen, do not let that wedge reports off - trust load.
        this.#painted = true;
        // A document loading in the background never paints, so nothing
        // above would ever report it. Its colour is not on screen either, so
        // sending it now costs nothing visible and lets the parent cache it
        // for the switch.
        if (this.document.hidden) this.#report();
        this.#arm(0);
        break;
      case "pageshow":
        // bfcache restores do not create a new document, so no first paint
        // is pending; the next paint is the one that shows it.
        if (event.target !== this.document) return;
        this.#arm(NUDGE_MS);
        break;
      case "visibilitychange":
        if (!this.document.hidden) this.#arm(NUDGE_MS);
        break;
    }
  }

  receiveMessage(message) {
    if (!this.#active) return null;
    switch (message.name) {
      case "Canvas:Get":
        return this.#read();
      case "Canvas:Refresh":
        // A forced refresh means the parent threw its cache away - the colour
        // scheme flipped - and wants an answer even if it is the same one.
        if (message.data?.force) this.#sent = "";
        this.#arm(NUDGE_MS);
        return null;
    }
    return null;
  }

  #observeLate() {
    if (this.#lateObserved || !this.#observer) return;
    const doc = this.document;
    if (!doc?.body) return;
    this.#lateObserved = true;
    try {
      // Attributes for theme toggles; children for an app mounting its root
      // element after load.
      this.#observer.observe(doc.body, { attributes: true, childList: true });
      if (doc.head) this.#observer.observe(doc.head, { childList: true });
    } catch (e) {}
  }

  // Keep looking at paints for at least `ms` more. Idempotent; a listener
  // already on stays on.
  #arm(ms) {
    if (!this.#active) return;
    if (this.#loaded) this.#until = Math.max(this.#until, Cu.now() + ms);
    if (this.#paintTarget) return;
    const win = this.contentWindow;
    const target = win?.windowRoot;
    if (!target) return;
    try {
      this.#baseline = win.windowUtils?.lastTransactionId ?? 0;
    } catch (e) {
      this.#baseline = 0;
    }
    try {
      target.addEventListener("MozAfterPaint", this);
      this.#paintTarget = target;
    } catch (e) {}
  }

  #disarm() {
    const target = this.#paintTarget;
    this.#paintTarget = null;
    if (!target) return;
    try {
      target.removeEventListener("MozAfterPaint", this);
    } catch (e) {}
  }

  #onPaint(event) {
    // Not composited since the listener went on: nothing new is on screen.
    const id = event.transactionId;
    if (typeof id === "number" && id <= this.#baseline) return;
    // A composited transaction that drew nothing of this document - the empty
    // frame Gecko sends while paint is still suppressed - has no painted rects.
    // Skip it; the first one that does paint is the page's background arriving.
    const rects = event.clientRects;
    if (rects && rects.length === 0 && !this.#painted) return;
    this.#painted = true;
    this.#report();
    if (this.#loaded && Cu.now() > this.#until) this.#disarm();
  }

  // What shows at the left edge, resolved to one of two answers:
  //   { colour: "rgb(...)" }  an opaque colour the parent can paint as is
  //   { colour: null }        layout alone cannot name it - a gradient or an
  //                           image, a translucent box, or nothing opaque at
  //                           all (the page paints Zen's default) - and the
  //                           parent has to look at pixels instead
  // `reason` is for the debug log only.
  #read() {
    const doc = this.document;
    const win = doc?.defaultView;
    if (!win || !doc.documentElement) return null;
    const height = win.innerHeight;
    if (!height) return null;

    const colours = [];
    let reason = "transparent";
    for (const fraction of SAMPLES) {
      const at = this.#at(win, doc, SAMPLE_X, Math.round(height * fraction));
      if (at.colour) {
        colours.push(at.colour);
      } else if (at.reason !== "transparent") {
        reason = at.reason;
      }
    }

    // Two of three agreeing is the answer. One lone colour beside two
    // gradients is not: the gradient is the surface, and pixels know it.
    const colour = mode(colours);
    const agree = colours.filter(c => c === colour).length;
    // A read from a document that has not painted, or is off screen, is not the
    // page yet - the parent uses this to refuse painting a placeholder from a
    // query. Paint pushes only fire past the gate, so they are ready already.
    const ready = this.#painted && !doc.hidden;
    if (colour && (agree >= 2 || reason === "transparent")) {
      return { colour, reason: "style", ready };
    }
    return { colour: null, reason, ready };
  }

  // The first opaque background in the stack of boxes under a point, top
  // down. A transparent box shows whatever is behind it, so it is skipped;
  // <html> and <body> are in the stack too, which is how the CSS canvas is
  // reached when nothing else paints there.
  #at(win, doc, x, y) {
    let stack;
    try {
      stack = doc.elementsFromPoint(x, y);
    } catch (e) {
      return { colour: null, reason: "transparent" };
    }
    // Walk the stack top to bottom for the first fully opaque background. A
    // translucent or image layer over it does not settle the colour - what
    // shows is a blend of it and whatever is behind, which only pixels know -
    // so note that and keep looking for something solid underneath.
    let soft = null;
    for (const el of stack) {
      const style = win.getComputedStyle(el);
      if (!style) continue;
      if (style.backgroundImage !== "none") {
        soft ??= "image";
        continue;
      }
      const alpha = alphaOf(style.backgroundColor);
      if (alpha === 0) continue;
      if (alpha < 1 || parseFloat(style.opacity) < 1) {
        soft ??= "translucent";
        continue;
      }
      return { colour: style.backgroundColor, reason: "style" };
    }
    return { colour: null, reason: soft ?? "transparent" };
  }

  #report() {
    let data = null;
    try {
      data = this.#read();
    } catch (e) {
      return;
    }
    if (!data) return;
    // Repeats are the common case - paints outnumber colour changes by
    // orders of magnitude - and each one would be a message and a repaint
    // for nothing.
    const key = `${data.colour}|${data.reason}`;
    if (key === this.#sent) return;
    this.#sent = key;
    this.#dbg("report", data.colour, data.reason);
    try {
      this.sendAsyncMessage("Canvas:Colour", data);
    } catch (e) {}
  }
}

// Alpha of a computed colour, 0..1. Computed values are serialised as
// rgb()/rgba(), or in a modern syntax with a "/ alpha" component; anything
// unparseable is treated as opaque, which at worst paints a colour the page
// also paints.
function alphaOf(value) {
  if (!value || value === "transparent" || value === TRANSPARENT) return 0;
  let m = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+%?)\s*)?\)$/.exec(
    value
  );
  if (m) return m[1] === undefined ? 1 : fraction(m[1]);
  m = /\/\s*([\d.]+%?)\s*\)$/.exec(value);
  if (m) return fraction(m[1]);
  return 1;
}

// Most frequent value, first one wins a tie.
function mode(values) {
  let best = null;
  let bestCount = 0;
  for (const v of values) {
    const count = values.filter(o => o === v).length;
    if (count > bestCount) {
      best = v;
      bestCount = count;
    }
  }
  return best;
}

function fraction(text) {
  const n = parseFloat(text);
  if (Number.isNaN(n)) return 1;
  return text.endsWith("%") ? n / 100 : n;
}
