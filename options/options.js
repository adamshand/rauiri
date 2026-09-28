import { TAB_GROUP_COLORS, cleanHostnameInput, routeForUrl } from "../src/domain.js";

const COLOR_OPTIONS = TAB_GROUP_COLORS.map((color) => [color, `${color[0].toUpperCase()}${color.slice(1)}`]);
const SWATCHES = {
  grey: "#8d8d88", blue: "#4c7fa8", red: "#b6514b", yellow: "#c39836", green: "#668c69",
  pink: "#b96885", purple: "#8067a0", cyan: "#3d8e94", orange: "#c47536",
};

const ui = {
  contexts: document.querySelector("#contexts"),
  deleteDialog: document.querySelector("#delete-workspace-dialog"),
  deleteForm: document.querySelector("#delete-workspace-form"),
  deleteTitle: document.querySelector("#delete-workspace-title"),
  deleteCopy: document.querySelector("#delete-workspace-copy"),
  deleteTabs: document.querySelector("#delete-workspace-tabs"),
  deleteRules: document.querySelector("#delete-workspace-rules"),
  deleteDestination: document.querySelector("#delete-workspace-destination"),
  deleteDestinationLabel: document.querySelector("#delete-destination-label"),
  cancelDelete: document.querySelector("#cancel-workspace-delete"),
  exportDeletion: document.querySelector("#export-workspace-deletion"),
  windowPreferences: document.querySelector("#window-preferences"),
  minimizeWorkspaces: document.querySelector("#minimize-workspaces"),
  exportGroupBackup: document.querySelector("#export-group-backup"),
  keyboardShortcuts: document.querySelector("#keyboard-shortcuts"),
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
  connection: document.querySelector("#connection"),
};

let snapshot;
let contexts = [];
let draggedContextId = null;
let deletingWorkspace = null;
let recoveryRecords = [];
const selectedRecoveryIds = new Set();
let toastTimer;

function notify(text, { pending = false, tone = "" } = {}) {
  clearTimeout(toastTimer);
  ui.status.textContent = text;
  ui.status.dataset.tone = tone;
  ui.status.toggleAttribute("data-visible", Boolean(text));
  if (text && !pending) toastTimer = setTimeout(() => ui.status.removeAttribute("data-visible"), tone === "error" ? 8000 : 3500);
}

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
  ui.workspaces.closest("section").hidden = windowMode;
  ui.minimizeWorkspaces.checked = snapshot.minimizeOthers === true;
  ui.activateRouteLabel.hidden = !windowMode;
  ui.archiveHours.closest("section").hidden = windowMode;
  ui.recoveryList.closest("section").hidden = windowMode;
  ui.addContext.hidden = windowMode;
  ui.saveContexts.textContent = windowMode ? "Save workspaces" : "Save contexts";
  ui.workspaces.closest("section").querySelector(".section-copy p").textContent = windowMode
    ? "Active workspaces have a window and enabled routes. Put-away workspaces retain their tabs, but have no window and inactive routes."
    : "Save selected tabs from the popup for a client or task. Opening adds missing pages without closing tabs.";
  ui.routeForm.closest("section").querySelector(".section-copy p").textContent = windowMode
    ? "Sites that always belong to one workspace. Typing an address takes you there; other navigation is filed quietly in the background. Each hostname includes its subdomains, the most specific match wins, and pinned tabs are never routed."
    : "Sites that always belong to one context. Each hostname includes its subdomains, the most specific match wins, and routed sites stay out of automatic shelving.";
  ui.contexts.closest("section").querySelector("h2").textContent = windowMode ? "Workspaces" : "Contexts";
  ui.contexts.closest("section").querySelector(".section-copy p").textContent = windowMode
    ? "Drag a handle onto a number to swap, or into Other active workspaces to free its number (or focus a handle and press Up/Down). Numbers save immediately; save name and colour edits below."
    : "Names, colours, and order map directly to Helium’s native groups.";
  renderContexts();
  renderContextSelect();
  renderRoutes();
  renderWorkspaces();
  renderRecovery();
  // Window mode has no lifecycle settings; hidden number inputs still reject undefined.
  ui.archiveHours.value = windowMode ? "" : snapshot.settings.archiveAfterHours;
  ui.discardHours.value = windowMode ? "" : snapshot.settings.discardReadLaterAfterHours;
  ui.connection.textContent = snapshot.browserWarning || (snapshot.hasManagedWindow ? (windowMode ? "Workspaces connected" : "Managed window connected") : "No managed window");
  ui.connection.dataset.state = snapshot.browserWarning ? "warn" : snapshot.hasManagedWindow ? "ok" : "";
}

function beginWorkspaceDrag(event, id) {
  draggedContextId = id;
  event.dataTransfer.setData("text/plain", id);
  event.dataTransfer.effectAllowed = "move";
}

function shortcutDropTarget(element, accepts, drop) {
  element.addEventListener("dragover", (event) => {
    if (!accepts(draggedContextId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    element.classList.add("drop-target");
  });
  element.addEventListener("dragleave", () => element.classList.remove("drop-target"));
  element.addEventListener("drop", (event) => {
    const id = draggedContextId;
    if (!accepts(id)) return;
    event.preventDefault();
    clearDrag();
    drop(id);
  });
}

async function assignShortcut(slot, workspaceId) {
  const focusedId = document.activeElement?.closest(".context-row")?.dataset.id;
  await perform("Saving shortcut…", async () => {
    await send("assignWorkspaceShortcut", { slot, workspaceId });
    await refreshSnapshot();
  }, "Workspace numbers saved");
  if (focusedId) [...ui.contexts.querySelectorAll(".context-row")].find((row) => row.dataset.id === focusedId)?.querySelector(".drag-handle").focus();
}

function renderWorkspaceList(rows) {
  const byId = new Map(rows.map((row) => [row.dataset.id, row]));
  const active = snapshot.workspaces.filter((workspace) => !workspace.builtin && workspace.windowId !== null);
  const numbered = snapshot.shortcutSlots.map((id, index) => {
    const row = byId.get(id) || makeElement("div", "empty-workspace");
    if (!id) row.append(makeElement("span", "workspace-slot", String(index + 1)), makeElement("span", "empty", "Empty — drop a workspace here"));
    row.dataset.slot = String(index + 1);
    shortcutDropTarget(row, (id) => active.some((workspace) => workspace.id === id),
      (id) => assignShortcut(index + 1, id));
    return row;
  });
  const builtin = snapshot.workspaces.find((workspace) => workspace.builtin);
  const other = makeElement("div", "other-workspaces");
  other.append(makeElement("h3", "", "Other active workspaces"),
    ...active.filter((workspace) => workspace.shortcut === null).map((workspace) => byId.get(workspace.id)));
  other.append(makeElement("p", "empty", "Drop a numbered workspace here to leave its number empty."));
  shortcutDropTarget(other, (id) => id && snapshot.shortcutSlots.includes(id),
    (id) => assignShortcut(snapshot.shortcutSlots.indexOf(id) + 1, null));
  const archived = snapshot.workspaces.filter((workspace) => !workspace.builtin && workspace.windowId === null);
  const details = makeElement("details", "put-away-workspaces");
  details.open = ui.contexts.querySelector("details")?.open === true;
  details.append(makeElement("summary", "", `Put-away workspaces (${archived.length})`),
    ...archived.map((workspace) => byId.get(workspace.id)));
  details.hidden = !archived.length;
  ui.contexts.replaceChildren(...numbered, byId.get(builtin.id), other, details);
}

function renderContexts() {
  const rows = contexts.map((context, index) => {
    const row = ui.contextTemplate.content.firstElementChild.cloneNode(true);
    const workspace = snapshot.workspaces.find((item) => item.id === context.id);
    row.dataset.id = context.id;
    if (snapshot.mode === "windows") {
      row.classList.add("workspace-context");
      const shortcut = workspace?.shortcut;
      const slot = makeElement("span", "workspace-slot", String(shortcut ?? "—"));
      slot.setAttribute("aria-label", shortcut == null ? "No numbered shortcut" : `Shortcut slot ${shortcut}`);
      row.prepend(slot);
    }
    const title = row.querySelector(".context-title");
    const color = row.querySelector(".context-color");
    const handle = row.querySelector(".drag-handle");
    const windowMode = snapshot.mode === "windows";
    handle.style.visibility = windowMode && (workspace.builtin || workspace.windowId === null) ? "hidden" : "";
    handle.setAttribute("aria-label", `Move ${context.title}. Use Up or Down arrow keys.`);
    handle.addEventListener("keydown", (event) => {
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      if (windowMode) {
        const slot = workspace.shortcut;
        const next = slot === null ? (event.key === "ArrowUp" ? 9 : 1) : slot + (event.key === "ArrowUp" ? -1 : 1);
        if (next >= 1 && next <= 9) assignShortcut(next, context.id);
      } else moveContext(index, Math.max(0, Math.min(contexts.length - 1, index + (event.key === "ArrowUp" ? -1 : 1))));
    });
    handle.addEventListener("dragstart", (event) => {
      beginWorkspaceDrag(event, context.id);
      event.dataTransfer.setDragImage(row, 20, 20);
    });
    handle.addEventListener("dragend", clearDrag);
    row.addEventListener("dragover", (event) => {
      if (windowMode || !draggedContextId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      row.dataset.drop = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2 ? "after" : "before";
    });
    row.addEventListener("dragleave", () => { delete row.dataset.drop; });
    row.addEventListener("drop", (event) => {
      if (windowMode || !draggedContextId) return;
      event.preventDefault();
      const from = contexts.findIndex((item) => item.id === draggedContextId);
      let to = index + (event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2 ? 1 : 0);
      if (from < to) to--;
      clearDrag();
      if (from >= 0) moveContext(from, to);
    });

    const builtin = workspace?.builtin === true;
    title.value = context.title;
    title.disabled = builtin;
    title.addEventListener("input", () => {
      context.title = title.value;
      renderContextSelect();
    });
    color.replaceChildren(...COLOR_OPTIONS.map(([value, label]) => new Option(label, value, false, value === context.color)));
    row.style.setProperty("--swatch", SWATCHES[context.color] || SWATCHES.grey);
    color.addEventListener("change", () => {
      context.color = color.value;
      row.style.setProperty("--swatch", SWATCHES[context.color] || SWATCHES.grey);
    });

    const remove = row.querySelector(".remove");
    remove.disabled = builtin || contexts.length === 1;
    remove.title = builtin ? "Read Later is built in and cannot be deleted" : `Delete or merge ${context.title}`;
    remove.setAttribute("aria-label", `Delete or merge ${context.title}`);
    remove.addEventListener("click", () => {
      if (snapshot.mode === "windows") {
        perform("Checking workspace…", async () => {
          await refreshSnapshot();
          openDeleteDialog(context.id);
        }, "Choose what to keep");
      } else {
        contexts.splice(index, 1);
        renderContexts();
        renderContextSelect();
      }
    });
    if (snapshot.mode === "windows") row.append(workspaceActions(workspace));
    return row;
  });
  if (snapshot.mode === "windows") renderWorkspaceList(rows);
  else ui.contexts.replaceChildren(...rows);
}

function clearDrag() {
  draggedContextId = null;
  for (const row of ui.contexts.children) delete row.dataset.drop;
  document.querySelectorAll(".drop-target").forEach((element) => element.classList.remove("drop-target"));
}

function moveContext(from, to) {
  const [context] = contexts.splice(from, 1);
  contexts.splice(to, 0, context);
  renderContexts();
  renderContextSelect();
  [...ui.contexts.children].find((row) => row.dataset.id === context.id)?.querySelector(".drag-handle").focus();
  notify("Order changed. Save when ready.");
}

function openDeleteDialog(id) {
  deletingWorkspace = snapshot.workspaces.find((workspace) => workspace.id === id);
  if (!deletingWorkspace) throw new Error("This workspace no longer exists. Refresh Settings.");
  const live = deletingWorkspace.windowId !== null;
  const ruleCount = snapshot.routes.filter((route) => route.contextId === id).length;
  ui.deleteTitle.textContent = `Delete “${deletingWorkspace.title}”?`;
  ui.deleteCopy.textContent = live
    ? "This workspace is active. Its live tabs and rules must move to another workspace; tabs will not be reloaded. A put-away destination will be resumed."
    : `${deletingWorkspace.tabCount} remembered tabs and ${ruleCount} rules. Choose what to move or discard. Moving tabs to an active workspace opens them; a put-away destination stays put away.`;
  ui.deleteTabs.value = live || deletingWorkspace.tabCount ? "move" : "delete";
  ui.deleteRules.value = live || ruleCount ? "move" : "delete";
  ui.deleteDestination.replaceChildren(new Option("Choose a workspace…", ""), ...snapshot.workspaces.filter((w) => w.id !== id).map((w) => new Option(w.title, w.id)));
  updateDeleteChoices();
  ui.deleteDialog.showModal();
}

function updateDeleteChoices() {
  if (!deletingWorkspace) return;
  const live = deletingWorkspace.windowId !== null;
  ui.deleteTabs.disabled = live;
  ui.deleteRules.disabled = live;
  const needsDestination = live || ui.deleteTabs.value === "move" || ui.deleteRules.value === "move";
  ui.deleteDestinationLabel.hidden = !needsDestination;
  ui.deleteDestination.required = needsDestination;
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
    const context = makeElement("div", "route-destination");
    const destination = document.createElement("select");
    destination.setAttribute("aria-label", `Destination for ${route.hostname}`);
    destination.replaceChildren(...snapshot.contexts.map((item) => new Option(item.title, item.id)));
    destination.value = route.contextId;
    destination.addEventListener("change", () => perform("Updating route…", async () => {
      try {
        await send("updateRouteDestination", { routeId: route.id, contextId: destination.value });
        await refreshSnapshot();
      } catch (error) {
        destination.value = route.contextId;
        throw error;
      }
    }, "Route updated; existing tabs were not moved"));
    context.append(destination);
    if (snapshot.mode === "windows") {
      const status = makeElement("span", "", route.active
        ? route.activate ? "Follows all navigation" : "Follows the address bar"
        : "Paused · workspace put away");
      status.toggleAttribute("data-inactive", !route.active);
      context.append(status);
    }
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.title = `Remove ${route.hostname}`;
    remove.setAttribute("aria-label", `Remove route for ${route.hostname}`);
    remove.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    remove.addEventListener("click", () => perform("Removing route…", async () => {
      await send("removeRoute", { routeId: route.id });
      await refreshSnapshot();
    }));
    row.append(host, context, remove);
    return row;
  }));
}

function workspaceActions(workspace) {
      const row = makeElement("div", "workspace-actions");
      const label = makeElement("span", "workspace-meta", `${workspace.builtin ? "Built in" : workspace.windowId === null ? "Put away" : "Active"} · ${workspace.tabCount} tab${workspace.tabCount === 1 ? "" : "s"}`);
      const open = makeElement("button", "quiet small", workspace.restoring ? "Finish restoring" : workspace.windowId === null ? "Resume" : "Switch");
      open.addEventListener("click", () => perform("Opening workspace…", async () => {
        await send("focusWindowWorkspace", { workspaceId: workspace.id });
        await refreshSnapshot();
      }));
      const keepLabel = makeElement("label", "checkbox");
      keepLabel.hidden = workspace.windowId === null;
      const keep = document.createElement("input");
      keep.type = "checkbox";
      keep.checked = workspace.pinned;
      keep.setAttribute("aria-label", `Pin ${workspace.title} alongside other workspaces`);
      keep.addEventListener("change", () => perform("Saving window preference…", async () => {
        await send("setPinnedWorkspace", { workspaceId: keep.checked ? workspace.id : null });
        await refreshSnapshot();
      }));
      keepLabel.append(keep, makeElement("span", "", "Pinned"));
      const putAway = makeElement("button", "quiet small", "Put away");
      putAway.hidden = workspace.builtin || workspace.windowId === null;
      putAway.addEventListener("click", () => {
        if (!window.confirm(`Put away “${workspace.title}”? Its window will close and its routes will pause. Web URLs, order and pins are saved, but unsaved forms, browser-internal pages and navigation history cannot be restored. Save any unfinished work first.`)) return;
        perform("Putting workspace away…", async () => {
          await send("putAwayWorkspace", { workspaceId: workspace.id });
          await refreshSnapshot();
        }, "Workspace put away; routes paused");
      });
      row.append(label, keepLabel, open, putAway);
      for (const button of row.querySelectorAll("button")) button.type = "button";
      if (!workspace.builtin && workspace.shortcut !== null) {
        const clear = makeElement("button", "quiet small", "Remove number");
        clear.type = "button";
        clear.addEventListener("click", () => assignShortcut(workspace.shortcut, null));
        row.append(clear);
      }
      return row;
}

function renderWorkspaces() {
  if (snapshot.mode === "windows") return;
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
  notify(label, { pending: true });
  document.querySelectorAll("button, input, select").forEach((element) => { element.disabled = true; });
  try {
    const result = await task();
    notify(typeof successLabel === "function" ? successLabel(result) : successLabel);
  } catch (error) {
    notify(error.message, { tone: "error" });
  } finally {
    document.querySelectorAll("button, input, select").forEach((element) => { element.disabled = false; });
    renderContexts();
    updateRecoveryActions();
    updateDeleteChoices();
  }
}

ui.deleteTabs.addEventListener("change", updateDeleteChoices);
ui.deleteRules.addEventListener("change", updateDeleteChoices);
ui.cancelDelete.addEventListener("click", () => ui.deleteDialog.close());
ui.deleteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const id = deletingWorkspace.id;
  const live = deletingWorkspace.windowId !== null;
  const payload = { workspaceId: id, destinationId: ui.deleteDestination.value,
    tabs: live ? "move" : ui.deleteTabs.value, rules: live ? "move" : ui.deleteRules.value };
  perform("Deleting / merging workspace…", async () => {
    await send("deleteWindowWorkspace", payload);
    ui.deleteDialog.close();
    contexts = contexts.filter((context) => context.id !== id);
    await refreshSnapshot();
    renderContextSelect();
  }, "Workspace removed. Last deletion backup is available.");
});
ui.exportDeletion.addEventListener("click", () => perform("Exporting deletion backup…", async () => {
  downloadJson(await send("exportWorkspaceDeletionBackup"), "rauiri-before-workspace-deletion.json");
}));

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
    const routes = [...snapshot.routes.filter((route) => cleanHostnameInput(route.hostname) !== pattern), { id: "preview-route", hostname: pattern, contextId: ui.routeContext.value }]
      .filter((route) => snapshot.mode !== "windows" || snapshot.workspaces.some((workspace) => workspace.id === route.contextId && workspace.windowId !== null));
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

ui.keyboardShortcuts.addEventListener("click", () => perform("Opening shortcut settings…", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" })));
ui.minimizeWorkspaces.addEventListener("change", () => perform("Saving preference…", () => send("setWorkspacePreferences", { minimizeOthers: ui.minimizeWorkspaces.checked })));
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
    notify(error instanceof SyntaxError ? "That file is not valid JSON." : error.message, { tone: "error" });
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
    notify("Copied selected URLs");
  } catch {
    notify("Could not access the clipboard. Try Export JSON instead.", { tone: "error" });
  }
});

ui.exportRecovery.addEventListener("click", () => {
  const exported = selectedRecoveryRecords().map(({ id, ...record }) => record);
  downloadJson(exported, `rauiri-recovery-${new Date().toISOString().slice(0, 10)}.json`);
  notify(`Exported ${exported.length} saved page${exported.length === 1 ? "" : "s"}`);
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

load().catch((error) => {
  ui.connection.textContent = "Unable to load";
  ui.connection.dataset.state = "warn";
  notify(error.message, { tone: "error" });
});
