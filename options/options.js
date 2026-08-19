import { cleanHostnameInput, routeForUrl } from "../src/domain.js";

const GROUP_COLORS = [
  ["grey", "Grey"],
  ["blue", "Blue"],
  ["red", "Red"],
  ["yellow", "Yellow"],
  ["green", "Green"],
  ["pink", "Pink"],
  ["purple", "Purple"],
  ["cyan", "Cyan"],
  ["orange", "Orange"],
];

const ui = {
  contexts: document.querySelector("#contexts"),
  contextTemplate: document.querySelector("#context-template"),
  addContext: document.querySelector("#add-context"),
  saveContexts: document.querySelector("#save-contexts"),
  routeForm: document.querySelector("#route-form"),
  routeHost: document.querySelector("#route-host"),
  routeContext: document.querySelector("#route-context"),
  moveExisting: document.querySelector("#move-existing"),
  routes: document.querySelector("#routes"),
  archiveHours: document.querySelector("#archive-hours"),
  discardHours: document.querySelector("#discard-hours"),
  saveLifecycle: document.querySelector("#save-lifecycle"),
  runSweep: document.querySelector("#run-sweep"),
  status: document.querySelector("#status"),
};

let snapshot;
let contexts = [];

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Rauiri did not respond.");
  return response.result;
}

async function load() {
  const currentWindow = await chrome.windows.getCurrent();
  snapshot = await send("snapshot", { windowId: currentWindow.id });
  contexts = snapshot.contexts.map((context) => ({ ...context }));
  render();
}

function render() {
  renderContexts();
  renderContextSelect();
  renderRoutes();
  ui.archiveHours.value = snapshot.settings.archiveAfterHours;
  ui.discardHours.value = snapshot.settings.discardReadLaterAfterHours;
  ui.status.textContent = snapshot.hasManagedWindow ? "Managed window connected" : "No managed window";
}

function renderContexts() {
  ui.contexts.replaceChildren(...contexts.map((context, index) => {
    const row = ui.contextTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.id = context.id;
    const title = row.querySelector(".context-title");
    const color = row.querySelector(".context-color");
    const up = row.querySelector(".move-up");
    const down = row.querySelector(".move-down");

    title.value = context.title;
    title.addEventListener("input", () => {
      context.title = title.value;
      renderContextSelect();
    });
    color.replaceChildren(...GROUP_COLORS.map(([value, label]) => new Option(label, value, false, value === context.color)));
    color.addEventListener("change", () => { context.color = color.value; });

    up.disabled = index === 0;
    down.disabled = index === contexts.length - 1;
    up.addEventListener("click", () => moveContext(index, index - 1));
    down.addEventListener("click", () => moveContext(index, index + 1));
    row.querySelector(".remove").addEventListener("click", () => {
      contexts.splice(index, 1);
      renderContexts();
      renderContextSelect();
    });
    return row;
  }));
}

function moveContext(from, to) {
  const [context] = contexts.splice(from, 1);
  contexts.splice(to, 0, context);
  renderContexts();
  renderContextSelect();
}

function renderContextSelect() {
  const selectedContextId = ui.routeContext.value;
  ui.routeContext.replaceChildren(...contexts.map((context) => new Option(context.title, context.id)));
  if (contexts.some((context) => context.id === selectedContextId)) {
    ui.routeContext.value = selectedContextId;
  }
}

function renderRoutes() {
  if (!snapshot.routes.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No strict routes. Most sites should inherit their browsing context.";
    ui.routes.replaceChildren(empty);
    return;
  }

  ui.routes.replaceChildren(...snapshot.routes.map((route) => {
    const row = document.createElement("div");
    row.className = "route-row";
    const host = document.createElement("code");
    host.textContent = route.hostname;
    const context = document.createElement("span");
    context.textContent = snapshot.contexts.find((candidate) => candidate.id === route.contextId)?.title || "Unknown context";
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.title = `Remove ${route.hostname}`;
    remove.setAttribute("aria-label", `Remove route for ${route.hostname}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => perform("Removing route…", async () => {
      await send("removeRoute", { routeId: route.id });
      await refreshSnapshot();
    }));
    row.append(host, context, remove);
    return row;
  }));
}

async function refreshSnapshot() {
  const currentWindow = await chrome.windows.getCurrent();
  snapshot = await send("snapshot", { windowId: currentWindow.id });
  renderRoutes();
}

async function perform(label, task) {
  ui.status.textContent = label;
  document.querySelectorAll("button, input, select").forEach((element) => { element.disabled = true; });
  try {
    await task();
    ui.status.textContent = "Saved";
  } catch (error) {
    ui.status.textContent = error.message;
  } finally {
    document.querySelectorAll("button, input, select").forEach((element) => { element.disabled = false; });
    renderContexts();
  }
}

ui.addContext.addEventListener("click", () => {
  contexts.push({
    id: `context-${crypto.randomUUID()}`,
    title: "New context",
    color: "blue",
    order: contexts.length,
  });
  renderContexts();
  renderContextSelect();
  ui.contexts.lastElementChild?.querySelector("input")?.select();
});

ui.saveContexts.addEventListener("click", () => perform("Saving contexts…", async () => {
  await send("saveContexts", { contexts });
  await refreshSnapshot();
  contexts = snapshot.contexts.map((context) => ({ ...context }));
  renderContextSelect();
}));

ui.routeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  let moveExisting = ui.moveExisting.checked;
  if (moveExisting && snapshot.managedWindowId !== null) {
    const pattern = cleanHostnameInput(ui.routeHost.value);
    const tabs = await chrome.tabs.query({ windowId: snapshot.managedWindowId });
    const matching = tabs.filter((tab) => routeForUrl([{ hostname: pattern }], tab.url)).length;
    if (matching > 0) {
      moveExisting = window.confirm(`Move ${matching} existing matching tab${matching === 1 ? "" : "s"} into this context?`);
    }
  }

  perform("Adding route…", async () => {
    await send("addRoute", {
      hostname: ui.routeHost.value,
      contextId: ui.routeContext.value,
      moveExisting,
    });
    ui.routeHost.value = "";
    await refreshSnapshot();
  });
});

ui.saveLifecycle.addEventListener("click", () => perform("Saving lifecycle…", async () => {
  await send("saveSettings", {
    settings: {
      archiveAfterHours: Number(ui.archiveHours.value),
      discardReadLaterAfterHours: Number(ui.discardHours.value),
    },
  });
  await refreshSnapshot();
}));

ui.runSweep.addEventListener("click", () => perform("Running sweep…", () => send("runSweep")));

load().catch((error) => { ui.status.textContent = error.message; });
