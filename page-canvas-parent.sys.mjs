// Parent side of the page canvas colour.
//
// Deliberately thin: it turns the child's message into a DOM event on the chrome
// window and stops there, so every decision - what a transparent answer means,
// when to look at pixels instead, when the colour is applied - stays in
// page-canvas.uc.mjs where the rest of the mod can see it.

export class SafariZenCanvasParent extends JSWindowActorParent {
  receiveMessage(message) {
    const bc = this.browsingContext;
    // topChromeWindow is populated even in moments when the browser element
    // reference is briefly not - during a process switch, say - so it is the
    // reliable way to reach the chrome window from here.
    const win = bc?.topChromeWindow;
    const browser = bc?.top?.embedderElement;
    if (!win || !browser) return;

    if (message.name === "Canvas:Debug") {
      try {
        win.dispatchEvent(
          new win.CustomEvent("SafariZenCanvas:Debug", {
            detail: { browser, args: message.data.args },
          })
        );
      } catch (e) {}
      return;
    }

    if (message.name !== "Canvas:Colour") return;
    try {
      win.dispatchEvent(
        new win.CustomEvent("SafariZenCanvas:Colour", {
          detail: {
            browser,
            colour: message.data.colour,
            reason: message.data.reason,
          },
        })
      );
    } catch (e) {}
  }
}
