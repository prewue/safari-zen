// Parent side of the site accent colour.
//
// Deliberately thin: it turns the child's message into a DOM event on the chrome
// window and stops there, so every decision - which tier wins, how the colour is
// normalised, when it is applied - stays in site-accent.uc.mjs where the rest of
// the mod can see it.

export class SafariZenAccentParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== "Accent:Colour") return;

    const browser = this.browsingContext?.top?.embedderElement;
    const win = browser?.ownerGlobal;
    if (!win) return;

    try {
      win.dispatchEvent(
        new win.CustomEvent("SafariZenAccent:Colour", {
          detail: {
            browser,
            themeColour: message.data.themeColour,
            canvasColour: message.data.canvasColour,
          },
        })
      );
    } catch (e) {}
  }
}
