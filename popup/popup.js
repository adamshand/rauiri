import { WORKSPACE_SWATCHES, send, element, disableControls } from "../src/ui.js";
const ui = Object.fromEntries([
  "heading-title", "status", "window-search", "window-list", "put-away-workspaces", "put-away-list", "put-away-summary",
  "new-workspace-toggle", "window-destination", "new-window-workspace", "window-name", "settings", "message",
].map((id) => [id, document.getElementById(id)]));
let currentWindow;
let activeTab;
let snapshot;
let busy = false;
let reconnectTimer;

async function load() {
  currentWindow = await chrome.windows.getCurrent();
  [activeTab] = await chrome.tabs.query({ active: true, windowId: currentWindow.id });
  snapshot = await send("snapshot", { windowId: currentWindow.id });
  if (!busy) render();
  clearTimeout(reconnectTimer);
  if (snapshot.connecting) reconnectTimer = setTimeout(() => {
    if (!busy) void load().catch((error) => { ui.message.textContent = error.message; });
  }, 200);
}
function render() {
  const current = snapshot.workspaces.find((workspace) => workspace.id === snapshot.currentWorkspaceId);
  ui["heading-title"].textContent = current?.title || (snapshot.connecting ? "Reconnecting…" : "Unassigned window");
  document.documentElement.style.setProperty("--workspace", WORKSPACE_SWATCHES[current?.color] || WORKSPACE_SWATCHES.grey);
  ui.status.hidden = Boolean(current) && snapshot.browserReady;
  ui.status.textContent = snapshot.connecting ? "Reconnecting workspace windows…" : "This window is not assigned to a workspace";
  ui.message.textContent = snapshot.browserWarning || "";
  renderWindowList();
  const placeholder = new Option("Choose a workspace…", "", true, true);
  placeholder.disabled = true;
  ui["window-destination"].replaceChildren(placeholder, ...snapshot.workspaces.filter((workspace) => workspace.id !== current?.id)
    .map((workspace) => new Option(`${workspace.title}${workspace.windowId === null && !workspace.builtin ? " (put away)" : ""}`, workspace.id)));
  ui["window-destination"].disabled = busy || !snapshot.browserReady || !snapshot.managed || !activeTab;
  ui["new-workspace-toggle"].disabled = busy || !snapshot.browserReady;
}
function renderWindowList() {
  const search = ui["window-search"].value.trim().toLocaleLowerCase();
  const recent = snapshot.recentWorkspaceIds;
  const rank = (id) => recent.includes(id) ? recent.indexOf(id) : recent.length;
  const workspaces = snapshot.workspaces.filter((workspace) => workspace.title.toLocaleLowerCase().includes(search)).sort((a, b) => rank(a.id) - rank(b.id));
  function rowFor(workspace) {
    const row = element("div", "window-workspace-row");
    const current = workspace.id === snapshot.currentWorkspaceId;
    const state = workspace.restoring ? "restoring" : current ? "current" : workspace.windowId !== null ? "active" : workspace.builtin ? "closed" : "put-away";
    row.dataset.state = state;
    row.style.setProperty("--swatch", WORKSPACE_SWATCHES[workspace.color]);
    const button = element("button", "window-workspace");
    button.type = "button";
    button.disabled = busy || !snapshot.browserReady || (current && !workspace.restoring);
    button.dataset.current = String(current && !workspace.restoring);
    const status = { restoring: "Finish restoring", current: "Current", active: "Active", closed: "Closed · reopen", "put-away": "Put away · resume" }[state];
    button.append(element("i", "swatch"), element("span", "workspace-name", workspace.title),
      element("span", "workspace-meta", `${status} · ${workspace.tabCount} tab${workspace.tabCount === 1 ? "" : "s"}`));
    if (workspace.shortcut !== null) {
      const key = element("kbd", "", String(workspace.shortcut));
      key.title = `Alt+${workspace.shortcut}`;
      button.append(key);
    }
    button.addEventListener("click", () => void act("Switching workspace…", async () => {
      await send("focusWindowWorkspace", { workspaceId: workspace.id });
      window.close();
    }));
    const pin = element("button", "workspace-pin");
    pin.type = "button";
    pin.hidden = workspace.windowId === null;
    pin.disabled = busy || !snapshot.browserReady;
    pin.setAttribute("aria-label", `Keep ${workspace.title} alongside other workspaces`);
    pin.setAttribute("aria-pressed", String(workspace.pinned));
    pin.title = workspace.pinned ? `Unpin ${workspace.title}` : `Pin and switch to ${workspace.title}`;
    pin.innerHTML = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7Z"/><path d="M12 16v5"/></svg>';
    pin.addEventListener("click", () => void act(workspace.pinned ? "Unpinning workspace…" : "Pinning workspace…", async () => {
      await send("setPinnedWorkspace", { workspaceId: workspace.pinned ? null : workspace.id });
      if (!workspace.pinned) window.close();
    }, "Workspace unpinned"));
    row.append(button, pin);
    if (snapshot.browserReady && !snapshot.managed && workspace.windowId === null) {
      const attach = element("button", "attach-window", "Use this window");
      attach.type = "button";
      attach.disabled = busy;
      attach.addEventListener("click", () => {
        if (!window.confirm(`Associate this window with “${workspace.title}”? Its current tabs become the live workspace. The previous state is retained under Settings → Restore points → Last attach.`)) return;
        void act("Attaching window…", () => send("attachWorkspaceWindow", { workspaceId: workspace.id, windowId: currentWindow.id }));
      });
      row.append(attach);
    }
    return row;
  }
  const active = workspaces.filter((workspace) => workspace.builtin || workspace.windowId !== null);
  const archived = workspaces.filter((workspace) => !workspace.builtin && workspace.windowId === null);
  ui["window-list"].replaceChildren(...(search ? workspaces : active).map(rowFor));
  ui["put-away-list"].replaceChildren(...(search ? [] : archived).map(rowFor));
  ui["put-away-workspaces"].hidden = Boolean(search) || !archived.length;
  ui["put-away-summary"].textContent = `Put-away workspaces (${archived.length})`;
  if (!workspaces.length) {
    ui["window-list"].append(element("p", "list-empty", "No matching workspaces."));
  }
}
async function act(label, task, success = "") {
  if (busy) return;
  busy = true;
  ui.message.textContent = label;
  const restoreControls = disableControls("button:not(#settings), input, select");
  let message;
  try { await task(); await load(); message = success; }
  catch (error) { message = error.message; }
  finally {
    busy = false;
    restoreControls();
    if (snapshot) render();
    if (message) ui.message.textContent = message;
  }
}
function setNewWorkspaceOpen(open) {
  ui["new-window-workspace"].hidden = !open;
  ui["new-workspace-toggle"].setAttribute("aria-expanded", String(open));
  ui["new-workspace-toggle"].classList.toggle("active", open);
  (open ? ui["window-name"] : ui["window-search"]).focus();
}
ui["new-workspace-toggle"].addEventListener("click", () => setNewWorkspaceOpen(ui["new-window-workspace"].hidden));
ui["window-name"].addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || ui["window-name"].value) return;
  event.preventDefault();
  setNewWorkspaceOpen(false);
});
ui["window-search"].addEventListener("input", renderWindowList);
ui["window-search"].addEventListener("keydown", (event) => {
  if (event.isComposing || !["Enter", "ArrowDown"].includes(event.key)) return;
  const first = ui["window-list"].querySelector(".window-workspace:not(:disabled)");
  if (!first) return;
  event.preventDefault();
  if (event.key === "Enter") first.click();
  else first.focus();
});
ui["window-destination"].addEventListener("change", () => {
  const workspaceId = ui["window-destination"].value;
  if (workspaceId && activeTab) void act("Filing tab in the background…", () => send("moveWindowTab", { tabId: activeTab.id, workspaceId }), "Tab filed; you stayed in this workspace");
});
ui["new-window-workspace"].addEventListener("submit", (event) => {
  event.preventDefault();
  void act("Creating workspace…", async () => {
    await send("createWindowWorkspace", { title: ui["window-name"].value });
    ui["window-name"].value = "";
    window.close();
  });
});
ui.settings.addEventListener("click", async () => {
  try { await chrome.runtime.openOptionsPage(); window.close(); }
  catch (error) { ui.message.textContent = error.message; }
});
void load().then(() => ui["window-search"].focus()).catch((error) => {
  ui.status.textContent = "Unable to start";
  ui.message.textContent = error.message;
});
