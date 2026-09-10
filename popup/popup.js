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
  header: document.querySelector("header"),
  headingTitle: document.querySelector("#heading-title"),
  status: document.querySelector("#status"),
  windowPanel: document.querySelector("#window-workspaces"),
  windowTrial: document.querySelector("#window-trial"),
  enableWindows: document.querySelector("#enable-window-workspaces"),
  windowSearch: document.querySelector("#window-search"),
  windowList: document.querySelector("#window-list"),
  archivedSection: document.querySelector("#put-away-workspaces"),
  archivedList: document.querySelector("#put-away-list"),
  archivedSummary: document.querySelector("#put-away-summary"),
  putAway: document.querySelector("#put-away-current"),
  windowDestination: document.querySelector("#window-destination"),
  newWindowForm: document.querySelector("#new-window-workspace"),
  windowName: document.querySelector("#window-name"),
  setup: document.querySelector("#setup"),
  setupCopy: document.querySelector("#setup-copy"),
  adopt: document.querySelector("#adopt"),
  focusManaged: document.querySelector("#focus-managed"),
  workspace: document.querySelector("#workspace"),
  activeContext: document.querySelector("#active-context"),
  tabContext: document.querySelector("#tab-context"),
  tabLocation: document.querySelector("#tab-location"),
  readLater: document.querySelector("#read-later"),
  settings: document.querySelector("#settings"),
  workspaceSelect: document.querySelector("#workspace-select"),
  workspaceName: document.querySelector("#workspace-name"),
  workspaceContext: document.querySelector("#workspace-context"),
  saveWorkspace: document.querySelector("#save-workspace"),
  openWorkspace: document.querySelector("#open-workspace"),
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
  const windowMode = snapshot.mode === "windows";
  ui.header.classList.toggle("workspace-heading", windowMode);
  ui.headingTitle.textContent = "Rauiri";
  ui.windowPanel.hidden = !windowMode;
  ui.windowTrial.hidden = windowMode;
  if (windowMode) {
    ui.setup.hidden = true;
    ui.workspace.hidden = true;
    const current = snapshot.workspaces.find((item) => item.id === snapshot.currentWorkspaceId);
    ui.headingTitle.textContent = current?.title || "Unassigned window";
    ui.putAway.hidden = !current || current.builtin;
    ui.putAway.textContent = current ? `Put away ${current.title}` : "Put away this workspace";
    document.documentElement.style.setProperty("--context", colors[current?.color] || colors.grey);
    ui.status.hidden = Boolean(current);
    ui.status.textContent = "This window is not assigned to a workspace";
    ui.message.textContent = snapshot.browserWarning || "";
    renderWindowList();
    const placeholder = new Option("Move this tab…", "", true, true);
    placeholder.disabled = true;
    ui.windowDestination.replaceChildren(placeholder, ...snapshot.workspaces.filter((item) => item.id !== current?.id).map((item) => new Option(`${item.title}${item.windowId === null && !item.builtin ? " (put away — resumes)" : ""}`, item.id)));
    updateActionAvailability();
    return;
  }
  ui.setup.hidden = snapshot.managed;
  ui.workspace.hidden = !snapshot.managed;
  ui.message.textContent = snapshot.browserWarning || "";
  ui.status.hidden = snapshot.managed;

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
  setContextOptions(ui.activeContext, snapshot.contexts, snapshot.activeContextId);
  const record = snapshot.currentRecord;
  const onShelf = ["readLater", "inactive"].includes(record?.attention);
  const placeholder = new Option("Move this tab…", "", true, true);
  placeholder.disabled = true;
  ui.tabContext.replaceChildren(placeholder, ...snapshot.contexts.map((context) => {
    const option = new Option(context.title, context.id);
    option.disabled = !onShelf && context.id === record?.contextId;
    return option;
  }));

  ui.tabLocation.textContent = record?.pinned ? "Pinned everywhere · unpin to move to a bucket"
    : onShelf ? `${record.attention === "inactive" ? "Inactive" : "Read Later"} · from ${contextTitle(record.originContextId)}`
    : record && record.contextId !== snapshot.activeContextId ? `This tab is in ${contextTitle(record.contextId)}` : "";
  ui.tabLocation.hidden = !ui.tabLocation.textContent;
  ui.readLater.textContent = onShelf ? "Restore this tab"
    : record?.pinned ? "Unpin & send to Read Later" : "Send to Read Later";
  const selected = ui.workspaceSelect.value;
  ui.workspaceSelect.replaceChildren(new Option("New tab set…", ""), ...snapshot.workspaces.map((workspace) => (
    new Option(`${contextTitle(workspace.contextId)} · ${workspace.title}`, workspace.id)
  )));
  if (snapshot.workspaces.some((workspace) => workspace.id === selected)) ui.workspaceSelect.value = selected;
  ui.openWorkspace.disabled = !ui.workspaceSelect.value;
  setContextOptions(ui.workspaceContext, snapshot.contexts, ui.workspaceContext.value || snapshot.activeContextId);
  updateActionAvailability();
}

function renderWindowList() {
  const search = ui.windowSearch.value.trim().toLocaleLowerCase();
  const recent = snapshot.recentWorkspaceIds || [];
  const rank = (id) => recent.includes(id) ? recent.indexOf(id) : recent.length;
  const workspaces = snapshot.workspaces.filter((item) => item.title.toLocaleLowerCase().includes(search))
    .sort((a, b) => rank(a.id) - rank(b.id));
  const renderRow = (workspace) => {
    const row = document.createElement("div");
    row.className = "window-workspace-row";
    const button = document.createElement("button");
    button.className = "window-workspace";
    button.type = "button";
    const title = document.createElement("strong");
    title.textContent = `${workspace.shortcut !== null ? `${workspace.shortcut} · ` : ""}${workspace.title}`;
    const meta = document.createElement("span");
    const current = workspace.id === snapshot.currentWorkspaceId;
    meta.textContent = `${workspace.restoring ? "Finish restoring" : current ? "Current" : workspace.windowId !== null ? "Active · switch" : workspace.builtin ? "Reopen built-in workspace" : "Put away · resume"} · ${workspace.tabCount} remembered tab${workspace.tabCount === 1 ? "" : "s"}`;
    button.append(title, meta);
    button.disabled = current && !workspace.restoring;
    button.dataset.current = String(button.disabled);
    button.addEventListener("click", () => act("Switching workspace…", async () => {
      await send("focusWindowWorkspace", { workspaceId: workspace.id });
      window.close();
    }));
    const pin = document.createElement("button");
    pin.className = "workspace-pin";
    pin.type = "button";
    pin.hidden = workspace.windowId === null;
    pin.setAttribute("aria-label", `Keep ${workspace.title} alongside other workspaces`);
    pin.setAttribute("aria-pressed", String(workspace.pinned));
    pin.title = workspace.pinned ? `Unpin ${workspace.title}` : `Pin and switch to ${workspace.title}`;
    pin.innerHTML = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7Z"/><path d="M12 16v5"/></svg>';
    pin.addEventListener("click", () => act(workspace.pinned ? "Unpinning workspace…" : "Pinning workspace…", async () => {
      await send("setPinnedWorkspace", { workspaceId: workspace.pinned ? null : workspace.id });
      if (!workspace.pinned) window.close();
    }, "Workspace unpinned"));
    row.append(button, pin);
    if (!snapshot.managed && workspace.windowId === null) {
      const attach = document.createElement("button");
      attach.className = "attach-window";
      attach.textContent = "Use this window";
      attach.addEventListener("click", () => {
        if (!window.confirm(`Associate this window with “${workspace.title}”? Its current tabs will become the live workspace. The previous saved tab list is retained in your backup.`)) return;
        act("Attaching window…", () => send("attachWorkspaceWindow", { workspaceId: workspace.id, windowId: currentWindow.id }));
      });
      row.append(attach);
    }
    return row;
  };
  const active = workspaces.filter((workspace) => workspace.builtin || workspace.windowId !== null);
  const archived = workspaces.filter((workspace) => !workspace.builtin && workspace.windowId === null);
  ui.windowList.replaceChildren(...(search ? workspaces : active).map(renderRow));
  ui.archivedList.replaceChildren(...(search ? [] : archived).map(renderRow));
  ui.archivedSection.hidden = Boolean(search) || !archived.length;
  ui.archivedSummary.textContent = `Put-away workspaces (${archived.length})`;
  if (!workspaces.length) {
    const empty = document.createElement("p");
    empty.className = "help";
    empty.textContent = "No matching workspaces.";
    ui.windowList.append(empty);
  }
}

function updateActionAvailability() {
  if (snapshot?.mode === "windows") {
    ui.windowDestination.disabled = !snapshot.managed || !activeTab;
    for (const button of ui.windowList.querySelectorAll("[data-current]")) button.disabled = button.dataset.current === "true";
    return;
  }
  ui.openWorkspace.disabled = !ui.workspaceSelect.value;
  ui.tabContext.disabled = !snapshot?.currentTab || snapshot?.currentRecord?.pinned === true;
  ui.readLater.disabled = !snapshot?.currentTab;
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

async function act(label, task, successLabel = "") {
  ui.message.textContent = label;
  document.querySelectorAll("button:not(#settings), input, select").forEach((element) => { element.disabled = true; });
  try {
    const result = await task();
    await load();
    if (successLabel) ui.message.textContent = typeof successLabel === "function" ? successLabel(result) : successLabel;
  } catch (error) {
    ui.message.textContent = error.message;
  } finally {
    document.querySelectorAll("button, input, select").forEach((element) => { element.disabled = false; });
    updateActionAvailability();
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

ui.tabContext.addEventListener("change", () => {
  const destination = ui.tabContext.value;
  if (!destination) return;
  act("Moving…", () => send("moveTabToContext", {
    tabId: snapshot.currentTab.id,
    contextId: destination,
  }), `Moved to ${contextTitle(destination)}`);
});

ui.readLater.addEventListener("click", () => act("Moving…", async () => {
  if (["readLater", "inactive"].includes(snapshot.currentRecord?.attention)) {
    await send("restoreReadLaterTab", { tabId: snapshot.currentTab.id });
  } else {
    await send("moveTabToReadLater", { tabId: snapshot.currentTab.id });
  }
}));

ui.workspaceSelect.addEventListener("change", () => {
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === ui.workspaceSelect.value);
  ui.workspaceName.value = workspace?.title || "";
  ui.workspaceContext.value = workspace?.contextId || snapshot.activeContextId;
  ui.openWorkspace.disabled = !workspace;
});

ui.saveWorkspace.addEventListener("click", () => {
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === ui.workspaceSelect.value);
  if (workspace && !window.confirm(`Replace “${workspace.title}” with the currently selected tabs?`)) return;
  act("Saving workspace…", () => send("saveWorkspace", { workspace: {
    id: workspace?.id,
    title: ui.workspaceName.value,
    contextId: ui.workspaceContext.value,
  } }), (result) => `Saved ${result.saved} selected pages`);
});

ui.openWorkspace.addEventListener("click", () => act("Opening workspace…", () => send("openWorkspace", {
  workspaceId: ui.workspaceSelect.value,
}), (result) => `Opened ${result.opened} missing pages`));

ui.enableWindows.addEventListener("click", () => {
  if (!window.confirm("Move this window’s grouped tabs into separate workspace windows? Tabs stay open and an original-state backup is kept. Automatic shelving and group accordion behavior will be disabled in window mode.")) return;
  act("Creating workspace windows…", () => send("enableWindowWorkspaces", { windowId: currentWindow.id }));
});
ui.putAway.addEventListener("click", () => {
  const current = snapshot.workspaces.find((workspace) => workspace.id === snapshot.currentWorkspaceId);
  if (!current || current.builtin || !window.confirm(`Put away “${current.title}”? Its window will close and its routes will pause. Web URLs, order and pins are saved, but unsaved forms, browser-internal pages and navigation history cannot be restored. Save unfinished work first.`)) return;
  act("Putting workspace away…", async () => {
    await send("putAwayWorkspace", { workspaceId: current.id });
    window.close();
  });
});
ui.windowSearch.addEventListener("input", renderWindowList);
ui.windowSearch.addEventListener("keydown", (event) => {
  if (event.isComposing || !["Enter", "ArrowDown"].includes(event.key)) return;
  const first = ui.windowList.querySelector(".window-workspace:not(:disabled)");
  if (!first) return;
  event.preventDefault();
  if (event.key === "Enter") first.click();
  else first.focus();
});
ui.windowDestination.addEventListener("change", () => {
  if (!ui.windowDestination.value || !activeTab) return;
  act("Filing tab in the background…", () => send("moveWindowTab", { tabId: activeTab.id, workspaceId: ui.windowDestination.value }), "Tab filed; you stayed in this workspace");
});
ui.newWindowForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act("Creating workspace…", async () => {
    await send("createWindowWorkspace", { title: ui.windowName.value });
    ui.windowName.value = "";
    window.close();
  });
});

ui.settings.addEventListener("click", async () => {
  try {
    await chrome.runtime.openOptionsPage();
    window.close();
  } catch (error) {
    ui.message.textContent = error.message;
  }
});

load().then(() => {
  if (snapshot.mode === "windows") ui.windowSearch.focus();
}).catch((error) => {
  ui.status.textContent = "Unable to start";
  ui.message.textContent = error.message;
});
