// Content side of the page canvas colour.
//
// what  the surface at the page's edge on the sidebar's side: under each of
//       three points down that edge, the topmost opaque box that spans the
//       viewport height (<html> and <body> always count). An image or
//       translucent layer on the way makes the point unresolvable; the parent
//       reads pixels for those.
// when  MozAfterPaint on the window root, after compositing. The first paint
//       with rects past the arming baseline is the frame the page appears.
//
// The listener is armed for a load and for a while after anything that could
// restyle; a paint whose rects miss the edge is not read. DEV.md §8.

const TRANSPARENT = "rgba(0, 0, 0, 0)";
const DEBUG = false;

// Which edge; Zen's pref is mirrored into content processes.
const RIGHT_SIDE_PREF = "zen.tabs.vertical.right-side";
const SAMPLES = [0.25, 0.55, 0.85];

// A box has to span this much of the viewport height to be a surface.
const SURFACE_MIN = 0.9;

// A paint has to touch this strip at the edge to have changed the surface.
const EDGE_PX = 8;

// Paint windows after load and after a nudge; read coalescing after the first paint.
const LOAD_TAIL_MS = 2000;
const NUDGE_MS = 2000;
const READ_GAP_MS = 40;

export class SafariZenCanvasChild extends JSWindowActorChild {
  #active = false;
  #sent = "";
  #paintTarget = null;
  #baseline = 0;
  #painted = false;
  #loaded = false;
  #until = 0;
  #observer = null;
  #lateObserved = false;
  #readTimer = null;
  #lastRead = 0;

  actorCreated() {
    const doc = this.document;
    if (!doc) return;

    // the initial document of every navigation; it would answer over the real page
    if (doc.isInitialDocument ?? doc.documentURI === "about:blank") return;
    this.#active = true;

    try {
      doc.addEventListener("visibilitychange", this);
    } catch (e) {}

    try {
      // anything on <html> can change the canvas; <body> and <head> are watched
      // once they exist
      this.#observer = new this.contentWindow.MutationObserver(() =>
        this.#arm(NUDGE_MS)
      );
      this.#observer.observe(doc.documentElement, { attributes: true });
    } catch (e) {}

    // Created late - the parent asking, or an event on a document that was here
    // before the actor was registered, which is every restored tab. Its first
    // paint is behind it and a finished page paints no more: report now.
    if (doc.readyState !== "loading") {
      this.#observeLate();
      this.#painted = true;
      if (doc.readyState === "complete") {
        this.#loaded = true;
        this.#until = ChromeUtils.now() + LOAD_TAIL_MS;
      } else {
        this.#until = Infinity;
      }
      this.#arm(0);
      if (!doc.hidden) this.#report();
    } else {
      this.#until = Infinity;
      this.#arm(0);
    }
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

      // No paint seen since arming means the first one was before it: report now.
      // A hidden document never paints; report so the parent can cache it.
      case "load": {
        if (event.target !== this.document) return;
        this.#observeLate();
        this.#loaded = true;
        this.#until = ChromeUtils.now() + LOAD_TAIL_MS;

        const unseen = !this.#painted;
        this.#painted = true;
        if (unseen || this.document.hidden) this.#report();
        this.#arm(0);
        break;
      }

      // bfcache: no new document, the next paint is the one that shows it
      case "pageshow":

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

        if (message.data?.force) this.#sent = "";
        this.#arm(NUDGE_MS);
        return null;
    }
    return null;
  }

  // theme toggles flip attributes on <body>; apps mount their root after load
  #observeLate() {
    if (this.#lateObserved || !this.#observer) return;
    const doc = this.document;
    if (!doc?.body) return;
    this.#lateObserved = true;
    try {
      this.#observer.observe(doc.body, { attributes: true, childList: true });
      if (doc.head) this.#observer.observe(doc.head, { childList: true });
    } catch (e) {}
  }

  // Idempotent. The baseline is lastTransactionId at arm time; paints at or
  // below it were not composited since.
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
    const id = event.transactionId;
    if (typeof id === "number" && id <= this.#baseline) return;
    const rects = event.clientRects;
    if (!this.#painted) {
      // a composited transaction that drew nothing, while paint is suppressed
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

  // One read per READ_GAP_MS, always with a trailing one.
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

  // { colour, reason, ready }: colour null means pixels are needed (reason says
  // why); ready means painted and visible, so a query cannot paint a placeholder.
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

    // two of three agreeing; one surface beside two soft points is not an answer
    if (colour && agree >= 2) return { colour, reason: "style", ready };
    const soft = points.find(p => p.soft)?.soft;
    return { colour: null, reason: soft ?? "transparent", ready };
  }

  // The topmost viewport-spanning opaque box under a point. `soft` names an
  // image or translucent layer met on the way, which makes the point
  // unresolvable from layout.
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

        // content, a control, a highlight, a banner: not a surface
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

    // <body>'s background propagates to the canvas even outside its box
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

  // Sent only when the answer changes.
  #report() {
    let data = null;
    try {
      data = this.#read();
    } catch (e) {
      return;
    }
    if (!data) return;

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

// Alpha of a computed colour; anything unparseable counts as opaque.
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
