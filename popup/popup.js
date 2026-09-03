const colors = {
  grey: "#8d8d88",
  blue: "#4c7fa8",
  red: "#b6514b",
  yellow: "#c39836",
  green: "#668c69",
  pink: "#b96885",
  purple: "#8067a0",
  cyan: "#3d8e94",
  orange: "#c47536",
};

const ui = {
  status: document.querySelector("#status"),
  setup: document.querySelector("#setup"),
  setupCopy: document.querySelector("#setup-copy"),
  adopt: document.querySelector("#adopt"),
  focusManaged: document.querySelector("#focus-managed"),
  workspace: document.querySelector("#workspace"),
  activeContext: document.querySelector("#active-context"),
  tabContext: document.querySelector("#tab-context"),
  tabTitle: document.querySelector("#tab-title"),
  tabHost: document.querySelector("#tab-host"),
  readLater: document.querySelector("#read-later"),
  readLaterCount: document.querySelector("#read-later-count"),
  settings: document.querySelector("#settings"),
  message: document.querySelector("#message"),
};

let currentWindow;
let activeTab;
let snapshot;

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Rauiri did not respond.");
  return response.result;
}

async function locate() {
  currentWindow = await chrome.windows.getCurrent();
  [activeTab] = await chrome.tabs.query({ active: true, windowId: currentWindow.id });
}

async function load() {
  await locate();
  snapshot = await send("snapshot", { windowId: currentWindow.id, tabId: activeTab?.id });
  render();
}

function render() {
  ui.setup.hidden = snapshot.managed;
  ui.workspace.hidden = !snapshot.managed;
  ui.message.textContent = "";

  if (!snapshot.managed) {
    document.documentElement.style.setProperty("--context", colors.grey);
    if (snapshot.hasManagedWindow) {
      ui.status.textContent = "Another window is managed";
      ui.setupCopy.textContent = "Rauiri is focused on a different browser window.";
      ui.adopt.hidden = true;
      ui.focusManaged.hidden = false;
    } else {
      ui.status.textContent = "No managed window";
      ui.setupCopy.textContent = "Adopt this window. Existing tabs start in Personal; existing pins become global.";
      ui.adopt.hidden = false;
      ui.focusManaged.hidden = true;
    }
    return;
  }

  const activeContext = snapshot.contexts.find((context) => context.id === snapshot.activeContextId);
  document.documentElement.style.setProperty("--context", colors[activeContext?.color] || colors.grey);
  ui.status.textContent = "This window is managed";

  setContextOptions(ui.activeContext, snapshot.contexts, snapshot.activeContextId);
  setContextOptions(
    ui.tabContext,
    snapshot.contexts,
    snapshot.currentRecord?.contextId || snapshot.activeContextId,
  );

  ui.tabTitle.textContent = snapshot.currentTab?.title || "No active tab";
  ui.tabHost.textContent = hostname(snapshot.currentTab?.url);
  ui.readLaterCount.textContent = String(snapshot.readLaterCount);

  const onShelf = snapshot.currentRecord?.attention === "readLater";
  ui.readLater.textContent = onShelf
    ? `Restore tab to ${contextTitle(snapshot.currentRecord?.originContextId)}`
    : "Send to Read Later";
  ui.tabContext.disabled = !snapshot.currentTab;
  ui.readLater.disabled = !snapshot.currentTab;
}

function setContextOptions(select, contexts, selected) {
  select.replaceChildren(...contexts.map((context) => {
    const option = document.createElement("option");
    option.value = context.id;
    option.textContent = context.title;
    option.selected = context.id === selected;
    return option;
  }));
}

function contextTitle(contextId) {
  return snapshot.contexts.find((context) => context.id === contextId)?.title || "context";
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "Browser page"; }
}

async function act(label, task) {
  ui.message.textContent = label;
  document.querySelectorAll("button, select").forEach((element) => { element.disabled = true; });
  try {
    await task();
    document.querySelectorAll("button, select").forEach((element) => { element.disabled = false; });
    await load();
  } catch (error) {
    ui.message.textContent = error.message;
    document.querySelectorAll("button, select").forEach((element) => { element.disabled = false; });
  }
}

ui.adopt.addEventListener("click", () => act("Adopting…", async () => {
  snapshot = await send("adoptWindow", { windowId: currentWindow.id, tabId: activeTab?.id });
}));

ui.focusManaged.addEventListener("click", async () => {
  if (snapshot.managedWindowId !== null) {
    await chrome.windows.update(snapshot.managedWindowId, { focused: true });
    window.close();
  }
});

ui.activeContext.addEventListener("change", () => act("Switching…", () => send("switchContext", {
  contextId: ui.activeContext.value,
})));

ui.tabContext.addEventListener("change", () => act("Moving…", () => send("moveTabToContext", {
  tabId: snapshot.currentTab.id,
  contextId: ui.tabContext.value,
})));

ui.readLater.addEventListener("click", () => act("Moving…", async () => {
  if (snapshot.currentRecord?.attention === "readLater") {
    await send("restoreReadLaterTab", { tabId: snapshot.currentTab.id });
  } else {
    await send("moveTabToReadLater", { tabId: snapshot.currentTab.id });
  }
}));

ui.settings.addEventListener("click", async () => {
  await send("openOptions");
  window.close();
});

load().catch((error) => {
  ui.status.textContent = "Unable to start";
  ui.message.textContent = error.message;
});
