// Parent side: relays the child's messages as DOM events on the chrome window.
// topChromeWindow stays valid through a process switch; top.embedderElement
// does not always.

export class SafariZenCanvasParent extends JSWindowActorParent {
  receiveMessage(message) {
    const bc = this.browsingContext;
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
