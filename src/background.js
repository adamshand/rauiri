import { createWindowWorkspaces } from "./window-workspaces.js";

// One controller owns all mutations. Register listeners synchronously so MV3 can
// wake the worker; UI reads remain independent of browser startup and its queue.
export function startBackground(api) {
  const controller = createWindowWorkspaces(api);
  const trustedPages = ["popup/popup.html", "options/options.html"].map((path) => api.runtime.getURL(path));
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== api.runtime.id || !trustedPages.includes(sender.url?.split(/[?#]/)[0])) {
      sendResponse({ ok: false, error: "Rauiri commands must come from its popup or Settings." });
      return false;
    }
    if (!message || typeof message.type !== "string") {
      sendResponse({ ok: false, error: "Invalid Rauiri command." });
      return false;
    }
    controller.handle(message).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
    );
    return true;
  });
  return controller;
}

if (globalThis.chrome) startBackground(chrome);
