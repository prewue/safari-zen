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
//          visible" - LoginManagerChild.sys.mjs gates its first form fill on
//          exactly this, and DOMFullscreenChild.sys.mjs uses it to report a
//          finished transition.
//
//   what   The surface the sidebar panel floats beside: the colour showing at
//          the page's edge on the sidebar's side, resolved from layout rather
//          than from pixels. At three points down that edge, elementsFromPoint
//          gives the stack of boxes under the point, and the topmost one with an
//          opaque background *that spans the viewport's height* is the surface.
//
// The height test is what keeps the answer still on a live page. Without it
// the first opaque box under a point is whatever the page put there - a list
// row scrolling past, a hover highlight, a toast - and the colour followed
// every one of them: measured on one page, nine changes in seven seconds
// between the canvas and a row colour. A box that spans the viewport is a
// surface (the canvas, an app root, a sidebar, a drawer), and a surface only
// changes colour when the page restyles it. <html> and <body> count as
// surfaces whatever their box says, because CSS propagates their background
// to the canvas.
//
// A translucent or image layer over the surface is not stepped over: what
// shows there is a blend only pixels know, so the point is reported as
// unresolvable and the parent reads pixels once, after the paint. That is the
// only time pixels are read at all.
//
// The paint listener is armed, not permanent: from the document's creation
// until shortly after load, and again for a couple of seconds whenever
// something that could move the colour happens - a theme toggle flipping a
// class on <html>, a late stylesheet, the page coming back from bfcache or
// from the background, or the parent asking. Between those windows nothing
// runs at all. After the first paint, a paint whose rectangles do not touch the
// sampled edge cannot have changed the surface and is not read; the rest are
// coalesced to a few reads a second. A report is sent only when the answer
// changes.
//
// Not every MozAfterPaint is a paint of the page. Gecko fires it for a tick
// that had invalidations but sent no transaction, and - while painting is
// still suppressed for a new document - for a transaction that draws nothing,
// which leaves the <browser> element's own background on screen. Two tests
// sort those out: the event's transactionId has to be past the one current
// when the listener was armed, and the event has to have painted rectangles
// of its own (event.clientRects, the same discriminator AboutReaderChild uses).
// That second test fires on the document's *first paint* - the frame its
// background reaches the screen - which is the moment to match.
//
// The initial document of every navigation is about:blank, and it fires load
// and pageshow like any other document. It is skipped outright, or it would
// answer over the real page.

const TRANSPARENT = "rgba(0, 0, 0, 0)";

// Routes child-side events to the parent's log when on. Off in normal use;
// the flood of per-paint lines is only wanted when chasing a timing bug.
const DEBUG = false;

// Which edge the sidebar is on. Zen's pref is mirrored into content processes
// like any other, so the child can read it for itself.
const RIGHT_SIDE_PREF = "zen.tabs.vertical.right-side";

// Fractions of the viewport height, one CSS pixel in from the edge. The top of
// a page is usually a header; the value that recurs down the edge is the
// surface the panel would be floating on.
const SAMPLES = [0.25, 0.55, 0.85];

// How much of the viewport height a box has to span to count as a surface.
const SURFACE_MIN = 0.9;

// A paint that touches none of this strip at the edge cannot have changed what
// shows there.
const EDGE_PX = 8;

// How long paints keep being checked after load, for stylesheets and scripts
// that finish colouring the page just after it.
const LOAD_TAIL_MS = 2000;

// How long a nudge - a mutation, a visibility change, a parent request - keeps
// the paint listener on.
const NUDGE_MS = 2000;

// After the first paint, reads are coalesced to one per this interval.
const READ_GAP_MS = 40;

export class SafariZenCanvasChild extends JSWindowActorChild {
  #active = false;
  #sent = "";
  #paintTarget = null;
  // windowUtils.lastTransactionId when the listener went on; paints at or
  // below it were not composited after that moment.
  #baseline = 0;
  #painted = false;
  #loaded = false;
  // Paints are checked until this ChromeUtils.now() timestamp; Infinity until load.
  #until = 0;
  #observer = null;
  #lateObserved = false;
  #readTimer = null;
  #lastRead = 0;

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
      this.#until = ChromeUtils.now() + LOAD_TAIL_MS;
    } else {
      if (doc.readyState === "interactive") this.#observeLate();
      this.#until = Infinity;
    }
    this.#arm(0);
    this.#dbg("created", doc.documentURI.slice(0, 60), "ready=" + doc.readyState);
  }

  didDestroy() {
    this.#active = false;
    this.#disarm();
    this.#cancelRead();
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
        this.#until = ChromeUtils.now() + LOAD_TAIL_MS;
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
    if (this.#loaded) this.#until = Math.max(this.#until, ChromeUtils.now() + ms);
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
    const rects = event.clientRects;
    if (!this.#painted) {
      // A composited transaction that drew nothing of this document - the
      // empty frame Gecko sends while paint is still suppressed - has no
      // painted rects. Skip it; the first one that does paint is the page's
      // background arriving, and that one is read at once.
      if (rects && rects.length === 0) return;
      this.#painted = true;
      this.#cancelRead();
      this.#report();
    } else if (!rects || this.#touchesEdge(rects)) {
      this.#scheduleRead();
    }
    if (this.#loaded && ChromeUtils.now() > this.#until) this.#disarm();
  }

  #touchesEdge(rects) {
    const win = this.contentWindow;
    const right = rightSide();
    const width = win?.innerWidth ?? 0;
    for (const r of rects) {
      if (right ? r.right > width - EDGE_PX : r.left < EDGE_PX) return true;
    }
    return false;
  }

  // One read per READ_GAP_MS at most, always with a trailing one so the last
  // paint of a burst is what gets reported.
  #scheduleRead() {
    if (this.#readTimer) return;
    const wait = Math.max(0, READ_GAP_MS - (ChromeUtils.now() - this.#lastRead));
    this.#readTimer = this.contentWindow.setTimeout(() => {
      this.#readTimer = null;
      if (this.#active) this.#report();
    }, wait);
  }

  #cancelRead() {
    if (!this.#readTimer) return;
    try {
      this.contentWindow.clearTimeout(this.#readTimer);
    } catch (e) {}
    this.#readTimer = null;
  }

  // What shows at the edge, resolved to one of two answers:
  //   { colour: "rgb(...)" }  an opaque surface the parent can paint as is
  //   { colour: null }        layout alone cannot name it - a gradient or an
  //                           image, a translucent layer, or nothing opaque at
  //                           all (the page paints Zen's default) - and the
  //                           parent has to look at pixels instead
  // `reason` is for the debug log; `ready` says whether this document has
  // painted and is on screen, so a query cannot paint a placeholder.
  #read() {
    this.#lastRead = ChromeUtils.now();
    const doc = this.document;
    const win = doc?.defaultView;
    if (!win || !doc.documentElement) return null;
    const height = win.innerHeight;
    if (!height) return null;
    const x = rightSide() ? Math.max(0, win.innerWidth - 2) : 1;

    const points = SAMPLES.map(f => this.#at(win, doc, x, Math.round(height * f)));
    const solid = points.filter(p => p.colour && !p.soft).map(p => p.colour);
    const colour = mode(solid);
    const agree = solid.filter(c => c === colour).length;
    const ready = this.#painted && !doc.hidden;

    // Two of three agreeing is the answer. One lone surface beside two soft
    // points is not: the soft thing is what shows, and pixels know it.
    if (colour && agree >= 2) return { colour, reason: "style", ready };
    const soft = points.find(p => p.soft)?.soft;
    return { colour: null, reason: soft ?? "transparent", ready };
  }

  // The surface under a point: the topmost box in the stack that spans the
  // viewport and paints an opaque background. `soft` names an image or
  // translucent layer met on the way down - over the surface, or where no
  // surface was found - which makes the point unresolvable from layout.
  #at(win, doc, x, y) {
    let stack;
    try {
      stack = doc.elementsFromPoint(x, y);
    } catch (e) {
      return { colour: null, soft: null };
    }
    const minHeight = win.innerHeight * SURFACE_MIN;
    const html = doc.documentElement;
    const body = doc.body;
    let soft = null;
    for (const el of stack) {
      if (el !== html && el !== body) {
        let rect;
        try {
          rect = el.getBoundingClientRect();
        } catch (e) {
          continue;
        }
        // Not a surface: content, a control, a highlight, a banner.
        if (rect.height < minHeight) continue;
      }
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
      return { colour: style.backgroundColor, soft };
    }
    // Nothing opaque under the point. <body>'s background still propagates to
    // the canvas when <html> declares none, even where <body>'s own box does
    // not reach - a short page.
    if (body && !stack.includes(body)) {
      const style = win.getComputedStyle(body);
      if (style?.backgroundImage !== "none") {
        soft ??= "image";
      } else {
        const alpha = alphaOf(style.backgroundColor);
        if (alpha === 1 && parseFloat(style.opacity) >= 1) {
          return { colour: style.backgroundColor, soft };
        }
        if (alpha > 0) soft ??= "translucent";
      }
    }
    return { colour: null, soft };
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

function rightSide() {
  try {
    return Services.prefs.getBoolPref(RIGHT_SIDE_PREF, false);
  } catch (e) {
    return false;
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
