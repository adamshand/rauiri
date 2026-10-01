import { WORKSPACE_COLORS, cleanHostnameInput, routeForUrl } from "../src/domain.js";
import { reconcileWorkspaceDrafts } from "../src/workspace-drafts.js";
import { WORKSPACE_SWATCHES, send, element, disableControls } from "../src/ui.js";
const ui = Object.fromEntries([
  "workspaces", "workspace-template", "save-workspaces", "delete-workspace-dialog", "delete-workspace-form",
  "delete-workspace-title", "delete-workspace-copy", "delete-workspace-tabs", "delete-workspace-rules",
  "delete-workspace-destination", "delete-destination-label", "cancel-workspace-delete", "export-workspace-deletion",
  "minimize-workspaces", "keyboard-shortcuts", "route-form", "route-host", "route-workspace", "move-existing",
  "activate-route", "routes", "import-backup", "export-backup", "configuration-only", "export-previous-backup",
  "export-reconnect-backup", "export-attach-backup", "backup-file", "status", "connection",
].map((id) => [id, document.getElementById(id)]));
let snapshot;
let drafts = [];
let deletingId = null;
let busy = false;
let toastTimer;
let reconnectTimer;

function notify(text, { pending = false, error = false } = {}) {
  clearTimeout(toastTimer);
  ui.status.textContent = text;
  ui.status.dataset.tone = error ? "error" : "";
  ui.status.toggleAttribute("data-visible", Boolean(text));
  if (text && !pending) toastTimer = setTimeout(() => ui.status.removeAttribute("data-visible"), error ? 8000 : 3500);
}
function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
async function refreshSnapshot() {
  const next = await send("snapshot");
  drafts = reconcileWorkspaceDrafts(drafts, snapshot?.workspaces || [], next.workspaces);
  snapshot = next;
  if (deletingId && !snapshot.workspaces.some((workspace) => workspace.id === deletingId)) {
    deletingId = null;
    ui["delete-workspace-dialog"].close();
  }
  if (!busy) render();
  clearTimeout(reconnectTimer);
  if (snapshot.connecting) reconnectTimer = setTimeout(() => {
    if (busy) return;
    void refreshSnapshot().catch((error) => notify(error.message, { error: true }));
  }, 200);
}
function render() {
  renderWorkspaces();
  renderWorkspaceSelect();
  renderRoutes();
  ui["minimize-workspaces"].checked = snapshot.minimizeOthers;
  ui["save-workspaces"].disabled = ui["minimize-workspaces"].disabled = ui["import-backup"].disabled = !snapshot.browserReady;
  ui["route-form"].querySelectorAll("button, input, select").forEach((node) => { node.disabled = !snapshot.browserReady; });
  ui.connection.textContent = snapshot.browserWarning || (snapshot.connecting ? "Reconnecting windows…" : snapshot.hasManagedWindow ? "Workspaces connected" : "No assigned windows");
  ui.connection.dataset.state = snapshot.browserWarning ? "warn" : snapshot.hasManagedWindow ? "ok" : "";
  updateDeleteChoices();
}
function shortcutSelect(workspace) {
  if (workspace.builtin || workspace.windowId === null) return element("span", "shortcut-fixed", workspace.builtin ? "0" : "");
  const select = document.createElement("select");
  select.className = "shortcut-select";
  select.setAttribute("aria-label", `Shortcut number for ${workspace.title}`);
  select.disabled = !snapshot.browserReady;
  select.replaceChildren(new Option("—", ""), ...snapshot.shortcutSlots.map((id, index) => {
    const occupant = id && id !== workspace.id ? snapshot.workspaces.find((item) => item.id === id)?.title : null;
    return new Option(occupant ? `${index + 1} · swap with ${occupant}` : String(index + 1), String(index + 1));
  }));
  select.value = workspace.shortcut === null ? "" : String(workspace.shortcut);
  select.addEventListener("change", () => {
    const slot = select.value ? Number(select.value) : workspace.shortcut;
    void perform("Saving shortcut…", () => send("assignWorkspaceShortcut", { slot, workspaceId: select.value ? workspace.id : null }), "Shortcut saved");
  });
  return select;
}
function renderWorkspaces() {
  const open = ui.workspaces.querySelector("details")?.open === true;
  const rows = new Map(drafts.map((draft) => {
    const workspace = snapshot.workspaces.find((item) => item.id === draft.id);
    const row = ui["workspace-template"].content.firstElementChild.cloneNode(true);
    row.querySelector(".workspace-key").replaceWith(shortcutSelect(workspace));
    const title = row.querySelector(".workspace-title");
    title.value = draft.title;
    title.disabled = workspace.builtin;
    title.addEventListener("input", () => { draft.title = title.value; renderWorkspaceSelect(); });
    const color = row.querySelector(".workspace-color");
    color.replaceChildren(...WORKSPACE_COLORS.map((value) => new Option(`${value[0].toUpperCase()}${value.slice(1)}`, value, false, value === draft.color)));
    row.style.setProperty("--swatch", WORKSPACE_SWATCHES[draft.color]);
    color.addEventListener("change", () => { draft.color = color.value; row.style.setProperty("--swatch", WORKSPACE_SWATCHES[draft.color]); });
    const actions = row.querySelector(".workspace-actions");
    actions.append(element("span", "workspace-meta", `${workspace.tabCount} tab${workspace.tabCount === 1 ? "" : "s"}`));
    const putAway = element("button", "quiet small", "Put away");
    putAway.type = "button";
    putAway.hidden = workspace.builtin || workspace.windowId === null;
    putAway.disabled = !snapshot.browserReady;
    putAway.addEventListener("click", () => {
      if (!window.confirm(`Put away “${workspace.title}”? Its window will close and its routes will pause. Web URLs, order and pins are saved, but unsaved forms, internal pages and history cannot be restored. Save unfinished work first.`)) return;
      void perform("Putting workspace away…", () => send("putAwayWorkspace", { workspaceId: workspace.id }), "Workspace put away; routes paused");
    });
    actions.append(putAway);
    const remove = row.querySelector(".remove");
    remove.disabled = workspace.builtin || !snapshot.browserReady;
    remove.setAttribute("aria-label", `Delete or merge ${workspace.title}`);
    remove.addEventListener("click", () => void perform("Checking workspace…", async () => {
      await refreshSnapshot();
      openDeleteDialog(workspace.id);
    }, "Choose what to keep"));
    return [draft.id, row];
  }));
  const rank = (workspace) => workspace.builtin ? 10 : workspace.shortcut ?? 11;
  const active = snapshot.workspaces.filter((workspace) => workspace.builtin || workspace.windowId !== null).sort((a, b) => rank(a) - rank(b));
  const archived = snapshot.workspaces.filter((workspace) => !workspace.builtin && workspace.windowId === null);
  const header = element("div", "workspace-header");
  header.append(element("span", "", "Key"), element("span", "", "Colour"), element("span", "", "Name"));
  const details = element("details", "put-away-workspaces");
  details.open = open;
  details.hidden = !archived.length;
  details.append(element("summary", "", `Put-away workspaces (${archived.length})`), ...archived.map((workspace) => rows.get(workspace.id)));
  ui.workspaces.replaceChildren(header, ...active.map((workspace) => rows.get(workspace.id)), details);
}
function renderWorkspaceSelect() {
  const selected = ui["route-workspace"].value;
  ui["route-workspace"].replaceChildren(...drafts.map((workspace) => new Option(workspace.title, workspace.id)));
  if (drafts.some((workspace) => workspace.id === selected)) ui["route-workspace"].value = selected;
}
function renderRoutes() {
  if (!snapshot.routes.length) {
    ui.routes.replaceChildren(element("p", "empty", "No strict routes. Most sites can stay in their current workspace."));
    return;
  }
  ui.routes.replaceChildren(...snapshot.routes.map((route) => {
    const row = element("div", "route-row");
    const destination = document.createElement("select");
    destination.setAttribute("aria-label", `Destination for ${route.hostname}`);
    destination.replaceChildren(...snapshot.workspaces.map((workspace) => new Option(workspace.title, workspace.id)));
    destination.value = route.contextId;
    destination.disabled = !snapshot.browserReady;
    destination.addEventListener("change", () => void perform("Updating route…", () => send("updateRouteDestination", { routeId: route.id, contextId: destination.value }), "Route updated; existing tabs were not moved"));
    const destinationCell = element("div", "route-destination");
    const status = element("span", "", route.active ? route.activate ? "Follows all navigation" : "Follows the address bar" : "Paused · workspace put away");
    status.toggleAttribute("data-inactive", !route.active);
    destinationCell.append(destination, status);
    const remove = element("button", "remove", "×");
    remove.type = "button";
    remove.disabled = !snapshot.browserReady;
    remove.setAttribute("aria-label", `Remove route for ${route.hostname}`);
    remove.addEventListener("click", () => void perform("Removing route…", () => send("removeRoute", { routeId: route.id })));
    row.append(element("code", "", route.hostname), destinationCell, remove);
    return row;
  }));
}
function openDeleteDialog(id) {
  const workspace = snapshot.workspaces.find((item) => item.id === id);
  if (!workspace) throw new Error("This workspace no longer exists.");
  deletingId = id;
  const live = workspace.windowId !== null;
  const rules = snapshot.routes.filter((route) => route.contextId === id).length;
  ui["delete-workspace-title"].textContent = `Delete “${workspace.title}”?`;
  ui["delete-workspace-copy"].textContent = live
    ? "Its live tabs and rules must move to another workspace without reloading. A put-away destination will be resumed."
    : `${workspace.tabCount} remembered tabs and ${rules} rules. Choose what to move or discard. Moving tabs to an active workspace opens them; a put-away destination stays put away.`;
  ui["delete-workspace-tabs"].value = live || workspace.tabCount ? "move" : "delete";
  ui["delete-workspace-rules"].value = live || rules ? "move" : "delete";
  ui["delete-workspace-destination"].replaceChildren(new Option("Choose a workspace…", ""), ...snapshot.workspaces.filter((item) => item.id !== id).map((item) => new Option(item.title, item.id)));
  updateDeleteChoices();
  ui["delete-workspace-dialog"].showModal();
}
function updateDeleteChoices() {
  const workspace = snapshot?.workspaces.find((item) => item.id === deletingId);
  if (!workspace) return;
  const live = workspace.windowId !== null;
  ui["delete-workspace-tabs"].disabled = ui["delete-workspace-rules"].disabled = live || busy;
  const needsDestination = live || ui["delete-workspace-tabs"].value === "move" || ui["delete-workspace-rules"].value === "move";
  ui["delete-destination-label"].hidden = !needsDestination;
  ui["delete-workspace-destination"].required = needsDestination;
}
async function perform(label, task, successLabel = "Saved") {
  if (busy) return;
  busy = true;
  notify(label, { pending: true });
  const restoreControls = disableControls();
  try {
    const result = await task();
    await refreshSnapshot();
    notify(typeof successLabel === "function" ? successLabel(result) : successLabel);
  } catch (error) {
    notify(error.message, { error: true });
    try { await refreshSnapshot(); } catch { /* Keep the last usable view. */ }
  } finally {
    busy = false;
    restoreControls();
    try { if (snapshot) render(); } catch (error) { notify(error.message, { error: true }); }
  }
}

ui["save-workspaces"].addEventListener("click", () => void perform("Saving workspaces…", async () => {
  await send("saveWorkspaceDetails", { workspaces: drafts.map(({ id, title, color }) => ({ id, title, color })) });
  drafts = [];
}));
ui["route-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  void perform("Adding route…", async () => {
    let moveExisting = ui["move-existing"].checked;
    if (moveExisting) {
      const current = await send("snapshot");
      const hostname = cleanHostnameInput(ui["route-host"].value);
      const routes = [...current.routes.filter((route) => cleanHostnameInput(route.hostname) !== hostname),
        { id: "preview-route", hostname, contextId: ui["route-workspace"].value }]
        .filter((route) => current.workspaces.some((workspace) => workspace.id === route.contextId && workspace.windowId !== null));
      const windows = current.workspaces.map((workspace) => workspace.windowId).filter(Number.isInteger);
      const tabs = (await Promise.all(windows.map((windowId) => chrome.tabs.query({ windowId })))).flat();
      const count = tabs.filter((tab) => !tab.pinned && routeForUrl(routes, tab.url)?.id === "preview-route").length;
      if (count) moveExisting = window.confirm(`Apply this route to up to ${count} existing matching tabs? Manual assignments are kept.`);
    }
    await send("addRoute", { hostname: ui["route-host"].value, contextId: ui["route-workspace"].value, moveExisting, activate: ui["activate-route"].checked });
    ui["route-host"].value = "";
  });
});
ui["delete-workspace-tabs"].addEventListener("change", updateDeleteChoices);
ui["delete-workspace-rules"].addEventListener("change", updateDeleteChoices);
ui["cancel-workspace-delete"].addEventListener("click", () => ui["delete-workspace-dialog"].close());
ui["delete-workspace-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  const workspace = snapshot.workspaces.find((item) => item.id === deletingId);
  if (!workspace) return;
  const live = workspace.windowId !== null;
  const payload = { workspaceId: deletingId, destinationId: ui["delete-workspace-destination"].value,
    tabs: live ? "move" : ui["delete-workspace-tabs"].value, rules: live ? "move" : ui["delete-workspace-rules"].value };
  void perform("Deleting / merging workspace…", async () => {
    await send("deleteWindowWorkspace", payload);
    deletingId = null;
    ui["delete-workspace-dialog"].close();
  }, "Workspace removed. Last deletion backup is available.");
});
ui["minimize-workspaces"].addEventListener("change", () => void perform("Saving preference…", () => send("setWorkspacePreferences", { minimizeOthers: ui["minimize-workspaces"].checked })));
ui["keyboard-shortcuts"].addEventListener("click", () => void perform("Opening shortcut settings…", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" })));
for (const [id, type, filename] of [
  ["export-previous-backup", "exportPreviousBackup", "rauiri-before-import.json"],
  ["export-workspace-deletion", "exportWorkspaceDeletionBackup", "rauiri-before-workspace-deletion.json"],
  ["export-reconnect-backup", "exportReconnectBackup", "rauiri-before-reconnect.json"],
  ["export-attach-backup", "exportAttachBackup", "rauiri-before-attach.json"],
]) ui[id].addEventListener("click", () => void perform("Preparing restore point…", async () => downloadJson(await send(type), filename), "Restore point exported"));
ui["export-backup"].addEventListener("click", () => void perform("Preparing backup…", async () => {
  const backup = await send("exportBackup", { configurationOnly: ui["configuration-only"].checked });
  downloadJson(backup, `rauiri-backup-${new Date().toISOString().slice(0, 10)}.json`);
  return backup;
}, (backup) => backup.snapshot.fresh ? "Backup exported" : `Backup exported from saved state. ${backup.snapshot.reason}`));
ui["import-backup"].addEventListener("click", () => { ui["backup-file"].value = ""; ui["backup-file"].click(); });
ui["backup-file"].addEventListener("change", () => {
  const [file] = ui["backup-file"].files;
  if (!file) return;
  void perform("Reading backup…", async () => {
    const backup = JSON.parse(await file.text());
    if (!window.confirm("Import this workspace backup? Put away all workspaces except Read Later first. Saved workspaces and routes will be replaced. Live Read Later tabs are kept and missing imported reading pages will open.")) return null;
    const result = await send("importBackup", { backup });
    drafts = [];
    return result;
  }, (result) => result ? `Imported ${result.workspaces} workspaces, ${result.routes} routes and ${result.tabs} remembered tabs` : "Import cancelled");
});
void refreshSnapshot().catch((error) => {
  ui.connection.textContent = "Unable to load";
  ui.connection.dataset.state = "warn";
  notify(error.message, { error: true });
});
