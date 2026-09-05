// Parent side of the site accent colour.
//
// Deliberately thin: it turns the child's message into a DOM event on the chrome
// window and stops there, so every decision - which tier wins, how the colour is
// normalised, when it is applied - stays in site-accent.uc.mjs where the rest of
// the mod can see it.

export class SafariZenAccentParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== "Accent:Colour") return;

    const bc = this.browsingContext;
    // topChromeWindow stays valid through a process switch, when
    // top.embedderElement is intermittently null - the same lesson the canvas
    // actor learned the hard way.
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
