// Parent side: relays the child's report as a DOM event on the chrome window.
// topChromeWindow stays valid through a process switch; top.embedderElement
// does not always.

export class SafariZenAccentParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== "Accent:Colour") return;

    const bc = this.browsingContext;
    const win = bc?.topChromeWindow;
    const browser = bc?.top?.embedderElement;
    if (!win || !browser) return;

    try {
      win.dispatchEvent(
        new win.CustomEvent("SafariZenAccent:Colour", {
          detail: {
            browser,
            themeColour: message.data.themeColour,
            canvasColour: message.data.canvasColour,
            phase: message.data.phase,
          },
        })
      );
    } catch (e) {}
  }
}
