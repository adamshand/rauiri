import { TAB_GROUP_COLORS, cleanHostnameInput, routeForUrl } from "../src/domain.js";

const COLOR_OPTIONS = TAB_GROUP_COLORS.map((color) => [color, `${color[0].toUpperCase()}${color.slice(1)}`]);

const ui = {
  contexts: document.querySelector("#contexts"),
  windowPreferences: document.querySelector("#window-preferences"),
  minimizeWorkspaces: document.querySelector("#minimize-workspaces"),
  saveWindowPreferences: document.querySelector("#save-window-preferences"),
  exportGroupBackup: document.querySelector("#export-group-backup"),
  activateRoute: document.querySelector("#activate-route"),
  activateRouteLabel: document.querySelector("#activate-route-label"),
  contextTemplate: document.querySelector("#context-template"),
  addContext: document.querySelector("#add-context"),
  saveContexts: document.querySelector("#save-contexts"),
  routeForm: document.querySelector("#route-form"),
  routeHost: document.querySelector("#route-host"),
  routeContext: document.querySelector("#route-context"),
  moveExisting: document.querySelector("#move-existing"),
  routes: document.querySelector("#routes"),
  workspaces: document.querySelector("#workspaces"),
  archiveHours: document.querySelector("#archive-hours"),
  discardHours: document.querySelector("#discard-hours"),
  saveLifecycle: document.querySelector("#save-lifecycle"),
  runSweep: document.querySelector("#run-sweep"),
  importBackup: document.querySelector("#import-backup"),
  exportBackup: document.querySelector("#export-backup"),
  configurationOnly: document.querySelector("#configuration-only"),
  exportPreviousBackup: document.querySelector("#export-previous-backup"),
  backupFile: document.querySelector("#backup-file"),
  recoveryCount: document.querySelector("#recovery-count"),
  recoveryList: document.querySelector("#recovery-list"),
  selectAllRecovery: document.querySelector("#select-all-recovery"),
  copyRecovery: document.querySelector("#copy-recovery"),
  exportRecovery: document.querySelector("#export-recovery"),
  reopenRecovery: document.querySelector("#reopen-recovery"),
  status: document.querySelector("#status"),
};

let snapshot;
let contexts = [];
let recoveryRecords = [];
const selectedRecoveryIds = new Set();

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Rauiri did not respond.");
  return response.result;
}

function makeElement(tagName, className, textContent) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (textContent !== undefined) element.textContent = textContent;
  return element;
}

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function load() {
  snapshot = await send("configurationSnapshot");
  contexts = snapshot.contexts.map((context) => ({ ...context }));
  render();
  void refreshRecovery().catch((error) => { ui.recoveryCount.textContent = error.message; });
}

function render() {
  const windowMode = snapshot.mode === "windows";
  ui.windowPreferences.hidden = !windowMode;
  ui.minimizeWorkspaces.checked = snapshot.minimizeOthers === true;
  ui.activateRouteLabel.hidden = !windowMode;
  ui.archiveHours.closest("section").hidden = windowMode;
  ui.recoveryList.closest("section").hidden = windowMode;
  ui.addContext.hidden = windowMode;
  ui.saveContexts.textContent = windowMode ? "Save workspaces" : "Save contexts";
  ui.workspaces.closest("section").querySelector(".section-copy p").textContent = windowMode
    ? "Live workspaces remember their tabs automatically. Switch without reloading, or resume a closed workspace from its saved URLs."
    : "Save selected tabs from the popup for a client or task. Opening adds missing pages without closing tabs.";
  ui.routeForm.closest("section").querySelector(".section-copy p").textContent = windowMode
    ? "File matching URLs in a workspace without following. Optionally follow an active tab to its destination. Native pins and manual assignments are left alone."
    : "Use exact hostnames or *.example.com for subdomains. Routed sites stay out of automatic shelving.";
  ui.contexts.closest("section").querySelector("h2").textContent = windowMode ? "Workspace names & order" : "Contexts";
  ui.contexts.closest("section").querySelector(".section-copy p").textContent = windowMode
    ? "Rename workspaces here. Create and switch workspace windows from the popup."
    : "Names, colours, and order map directly to Helium’s native groups.";
  renderContexts();
  renderContextSelect();
  renderRoutes();
  renderWorkspaces();
  renderRecovery();
  ui.archiveHours.value = snapshot.settings.archiveAfterHours;
  ui.discardHours.value = snapshot.settings.discardReadLaterAfterHours;
  ui.status.textContent = snapshot.browserWarning || (snapshot.hasManagedWindow ? "Managed window connected" : "No managed window");
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
    color.replaceChildren(...COLOR_OPTIONS.map(([value, label]) => new Option(label, value, false, value === context.color)));
    color.addEventListener("change", () => { context.color = color.value; });

    up.disabled = index === 0;
    down.disabled = index === contexts.length - 1;
    up.addEventListener("click", () => moveContext(index, index - 1));
    down.addEventListener("click", () => moveContext(index, index + 1));
    row.querySelector(".remove").hidden = snapshot.mode === "windows";
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
    const empty = makeElement("p", "empty", "No strict routes. Most sites should inherit their browsing context.");
    ui.routes.replaceChildren(empty);
    return;
  }

  ui.routes.replaceChildren(...snapshot.routes.map((route) => {
    const row = makeElement("div", "route-row");
    const host = makeElement("code", "", route.hostname);
    const contextTitle = snapshot.contexts.find((candidate) => candidate.id === route.contextId)?.title || "Unknown context";
    const context = makeElement("span", "", `${contextTitle}${snapshot.mode === "windows" ? route.activate ? " · follow" : " · background" : ""}`);
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

function renderWorkspaces() {
  if (snapshot.mode === "windows") {
    ui.workspaces.replaceChildren(...snapshot.workspaces.map((workspace) => {
      const row = makeElement("div", "workspace-row");
      const label = makeElement("span", "", `${workspace.title} · ${workspace.windowId === null ? "Closed" : "Live"} · ${workspace.tabCount} saved pages`);
      const open = makeElement("button", "quiet", workspace.restoring ? "Finish restoring" : workspace.windowId === null ? "Resume" : "Switch");
      open.addEventListener("click", () => perform("Opening workspace…", () => send("focusWindowWorkspace", { workspaceId: workspace.id })));
      row.append(label, open);
      return row;
    }));
    return;
  }
  if (!snapshot.workspaces.length) {
    ui.workspaces.replaceChildren(makeElement("p", "empty", "No saved workspaces. Select tabs and save a workspace from the Rauiri popup."));
    return;
  }
  ui.workspaces.replaceChildren(...snapshot.workspaces.map((workspace) => {
    const row = makeElement("div", "workspace-row");
    const bucket = snapshot.contexts.find((context) => context.id === workspace.contextId)?.title || "Unknown bucket";
    const label = makeElement("span", "", `${workspace.title} · ${bucket} · ${workspace.pages.length} pages`);
    const open = makeElement("button", "quiet", "Open");
    open.addEventListener("click", () => perform("Opening workspace…", () => send("openWorkspace", { workspaceId: workspace.id }),
      (result) => `Opened ${result.opened} missing pages; existing tabs kept`));
    const remove = makeElement("button", "quiet", "Delete");
    remove.addEventListener("click", () => {
      if (!window.confirm(`Delete saved workspace “${workspace.title}”? Open tabs stay open.`)) return;
      perform("Deleting workspace…", async () => {
        await send("deleteWorkspace", { workspaceId: workspace.id });
        await refreshSnapshot();
        renderWorkspaces();
      });
    });
    row.append(label, open, remove);
    return row;
  }));
}

function selectedRecoveryRecords() {
  return recoveryRecords.filter((record) => selectedRecoveryIds.has(record.id));
}

function updateRecoveryActions() {
  const selectedCount = selectedRecoveryRecords().length;
  const allSelected = recoveryRecords.length > 0 && selectedCount === recoveryRecords.length;
  ui.selectAllRecovery.disabled = recoveryRecords.length === 0;
  ui.selectAllRecovery.textContent = allSelected ? "Clear selection" : "Select all";
  ui.copyRecovery.disabled = selectedCount === 0;
  ui.exportRecovery.disabled = selectedCount === 0;
  ui.reopenRecovery.disabled = selectedCount === 0;
  ui.reopenRecovery.textContent = selectedCount ? `Reopen selected (${selectedCount})` : "Reopen selected";
}

function renderRecovery() {
  const availableIds = new Set(recoveryRecords.map((record) => record.id));
  for (const id of selectedRecoveryIds) {
    if (!availableIds.has(id)) selectedRecoveryIds.delete(id);
  }

  ui.recoveryCount.textContent = recoveryRecords.length
    ? `${recoveryRecords.length} stored page${recoveryRecords.length === 1 ? "" : "s"} not currently open`
    : "No missing stored pages found";

  if (!recoveryRecords.length) {
    const empty = makeElement("p", "empty", "Rauiri’s saved records currently match the tabs in your browser.");
    ui.recoveryList.replaceChildren(empty);
    updateRecoveryActions();
    return;
  }

  ui.recoveryList.replaceChildren(...recoveryRecords.map((record) => {
    const row = makeElement("label", "recovery-row");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedRecoveryIds.has(record.id);
    checkbox.setAttribute("aria-label", `Select ${record.title || record.url}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedRecoveryIds.add(record.id);
      else selectedRecoveryIds.delete(record.id);
      updateRecoveryActions();
    });

    const page = makeElement("span", "recovery-page");
    const title = makeElement("span", "recovery-title", record.title || "Untitled page");
    title.title = title.textContent;
    const url = makeElement("span", "recovery-url", record.url);
    url.title = record.url;
    page.append(title, url);

    const meta = makeElement("span", "recovery-meta");
    const location = makeElement("strong", "", record.attention === "readLater" ? "Read Later" : record.attention === "inactive" ? "Inactive" : record.contextTitle);
    const seenAt = Number.isFinite(record.lastSeenAt)
      ? new Date(record.lastSeenAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
      : "Date unknown";
    const seen = makeElement("span", "", seenAt);
    meta.append(location, seen);

    row.append(checkbox, page, meta);
    return row;
  }));
  updateRecoveryActions();
}

async function refreshSnapshot() {
  snapshot = await send("configurationSnapshot");
  renderRoutes();
  renderWorkspaces();
}

async function refreshRecovery() {
  recoveryRecords = await send("recoverySnapshot");
  renderRecovery();
}

async function perform(label, task, successLabel = "Saved") {
  ui.status.textContent = label;
  document.querySelectorAll("button, input, select").forEach((element) => { element.disabled = true; });
  try {
    const result = await task();
    ui.status.textContent = typeof successLabel === "function" ? successLabel(result) : successLabel;
  } catch (error) {
    ui.status.textContent = error.message;
  } finally {
    document.querySelectorAll("button, input, select").forEach((element) => { element.disabled = false; });
    renderContexts();
    updateRecoveryActions();
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
  if (moveExisting) {
    const windowIds = snapshot.mode === "windows" ? snapshot.workspaces.map((item) => item.windowId).filter(Number.isInteger)
      : Number.isInteger(snapshot.managedWindowId) ? [snapshot.managedWindowId] : [];
    const pattern = cleanHostnameInput(ui.routeHost.value);
    const routes = [...snapshot.routes.filter((route) => cleanHostnameInput(route.hostname) !== pattern), { id: "preview-route", hostname: pattern }];
    const tabs = (await Promise.all(windowIds.map((windowId) => chrome.tabs.query({ windowId })))).flat();
    const matching = tabs.filter((tab) => !tab.pinned && routeForUrl(routes, tab.url)?.id === "preview-route").length;
    if (matching > 0) moveExisting = window.confirm(`Apply this route to up to ${matching} existing matching tabs? Manual assignments are kept.`);
  }

  perform("Adding route…", async () => {
    await send("addRoute", {
      hostname: ui.routeHost.value,
      contextId: ui.routeContext.value,
      moveExisting,
      activate: ui.activateRoute.checked,
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

ui.saveWindowPreferences.addEventListener("click", () => perform("Saving preferences…", () => send("setWorkspacePreferences", { minimizeOthers: ui.minimizeWorkspaces.checked })));
ui.exportGroupBackup.addEventListener("click", () => perform("Exporting original backup…", async () => {
  downloadJson(await send("exportLegacyBackup"), "rauiri-original-groups.json");
}, "Original group backup exported"));

ui.runSweep.addEventListener("click", () => perform("Running sweep…", () => send("runSweep")));

ui.exportBackup.addEventListener("click", () => perform("Preparing backup…", async () => {
  const backup = await send("exportBackup", { configurationOnly: ui.configurationOnly.checked });
  downloadJson(backup, `rauiri-backup-${new Date().toISOString().slice(0, 10)}.json`);
}, "Backup exported"));

ui.exportPreviousBackup.addEventListener("click", () => perform("Preparing previous backup…", async () => {
  downloadJson(await send("exportPreviousBackup"), "rauiri-before-import.json");
}, "Pre-import backup exported"));

ui.importBackup.addEventListener("click", () => {
  ui.backupFile.value = "";
  ui.backupFile.click();
});

ui.backupFile.addEventListener("change", async () => {
  const [file] = ui.backupFile.files;
  if (!file) return;

  try {
    const backup = JSON.parse(await file.text());
    const confirmed = window.confirm(
      backup.format === "rauiri-window-workspaces"
        ? "Import this workspace backup and enable window mode? All assigned workspace windows must be closed first. It will replace saved workspaces and routes, without opening or closing any tabs."
        : "Import this backup? It will replace Rauiri’s contexts, routes, lifecycle settings, and saved recovery records. Open tabs will remain open and may be reorganized.",
    );
    if (!confirmed) return;

    await perform("Importing backup…", async () => {
      const result = await send("importBackup", { backup });
      selectedRecoveryIds.clear();
      await load();
      return result;
    }, (result) => `Imported ${result.contexts} context${result.contexts === 1 ? "" : "s"}, ${result.routes} route${result.routes === 1 ? "" : "s"}, and ${result.records} saved tab record${result.records === 1 ? "" : "s"}`);
  } catch (error) {
    ui.status.textContent = error instanceof SyntaxError ? "That file is not valid JSON." : error.message;
  }
});

ui.selectAllRecovery.addEventListener("click", () => {
  const allSelected = recoveryRecords.every((record) => selectedRecoveryIds.has(record.id));
  selectedRecoveryIds.clear();
  if (!allSelected) recoveryRecords.forEach((record) => selectedRecoveryIds.add(record.id));
  renderRecovery();
});

ui.copyRecovery.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(selectedRecoveryRecords().map((record) => record.url).join("\n"));
    ui.status.textContent = "Copied selected URLs";
  } catch {
    ui.status.textContent = "Could not access the clipboard. Try Export JSON instead.";
  }
});

ui.exportRecovery.addEventListener("click", () => {
  const exported = selectedRecoveryRecords().map(({ id, ...record }) => record);
  downloadJson(exported, `rauiri-recovery-${new Date().toISOString().slice(0, 10)}.json`);
  ui.status.textContent = `Exported ${exported.length} saved page${exported.length === 1 ? "" : "s"}`;
});

ui.reopenRecovery.addEventListener("click", () => perform("Reopening saved tabs…", async () => {
  const currentWindow = await chrome.windows.getCurrent();
  const result = await send("reopenRecords", {
    recordIds: selectedRecoveryRecords().map((record) => record.id),
    windowId: currentWindow.id,
  });
  await refreshRecovery();
  return result;
}, (result) => `Reopened ${result.reopened} tab${result.reopened === 1 ? "" : "s"}`));

load().catch((error) => { ui.status.textContent = error.message; });
