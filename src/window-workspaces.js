import { cleanHostnameInput, isRoutableUrl, isValidRouteHostname, routeForUrl, TAB_GROUP_COLORS, createBackup, stateFromBackup } from "./domain.js";

const KEY = "rauiriWindowWorkspaces";
const SESSION_KEY = "rauiriWorkspaceWindows";
const FORMAT = "rauiri-window-workspaces";

export function validateWindowState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.workspaces) || !value.workspaces.length
    || !Array.isArray(value.routes) || typeof value.minimizeOthers !== "boolean") throw new Error("Unsupported workspace backup.");
  const ids = new Set();
  for (const workspace of value.workspaces) {
    if (!workspace || typeof workspace.id !== "string" || !workspace.id || ids.has(workspace.id)
      || typeof workspace.title !== "string" || !workspace.title.trim() || !TAB_GROUP_COLORS.includes(workspace.color)
      || !Array.isArray(workspace.tabs)) throw new Error("Invalid workspace in backup.");
    ids.add(workspace.id);
    for (const tab of workspace.tabs) {
      if (!tab || !isRoutableUrl(tab.url) || typeof tab.url !== "string" || typeof tab.title !== "string"
        || typeof tab.pinned !== "boolean" || typeof tab.routeOverride !== "boolean") throw new Error("Invalid saved workspace tab.");
    }
  }
  const routeIds = new Set();
  for (const route of value.routes) {
    if (!route || typeof route.id !== "string" || routeIds.has(route.id) || !ids.has(route.contextId)
      || typeof route.hostname !== "string" || !isValidRouteHostname(route.hostname)
      || typeof route.activate !== "boolean") throw new Error("Invalid workspace route.");
    routeIds.add(route.id);
  }
  return structuredClone({ ...value, enabled: true });
}

// One owner for window/tab mutations. Reads never wait for this queue.
// Browser windows are the live state; local snapshots are recovery, not instructions
// to recreate every tab on each switch.
export function createWindowWorkspaces(api) {
  let data = null;
  let chain = Promise.resolve();
  let warning = null;
  let blockedEdit = null;
  const bindings = new Map(); // workspace id -> live window id (session only)
  const overrides = new Map(); // tab id -> manually assigned URL
  const moves = new Map(); // tab id -> expected destination window
  const seeds = new Map(); // blank tabs created by us for a restore
  let timer;

  const ready = (async () => {
    const stored = await api.storage.local.get(KEY);
    if (stored[KEY]?.enabled) data = validateWindowState(stored[KEY]);
  })();
  // Keep load failures visible without overwriting a malformed stored state.
  void ready.catch((error) => { warning = error.message; });

  const enabled = () => data?.enabled === true;
  const workspaceForWindow = (windowId) => data?.workspaces.find((workspace) => bindings.get(workspace.id) === windowId);
  const find = (id) => {
    const workspace = data?.workspaces.find((item) => item.id === id);
    if (!workspace) throw new Error("Choose a workspace.");
    return workspace;
  };
  function enqueue(task) {
    const result = chain.then(() => ready).then(task);
    chain = result.catch((error) => { warning = error?.message || String(error); });
    return result;
  }
  function event(task) { void enqueue(async () => { if (enabled()) await task(); }).catch(() => {}); }
  async function persist() {
    await api.storage.local.set({ [KEY]: data });
    await api.storage.session.set({ [SESSION_KEY]: Object.fromEntries(bindings) });
  }
  async function edit(task) {
    if (blockedEdit) throw new Error("A browser edit is still pending. You can still open Settings and export a backup.");
    for (let attempt = 0; ; attempt++) {
      let timeout;
      let expired = false;
      const request = Promise.resolve().then(task);
      blockedEdit = request;
      const settled = () => {
        blockedEdit = null;
        if (expired) event(captureAll);
      };
      void request.then(settled, settled);
      try {
        return await Promise.race([request, new Promise((_, reject) => {
          timeout = setTimeout(() => { expired = true; reject(new Error("Browser edit timed out; waiting for its outcome.")); }, 2000);
        })]);
      } catch (error) {
        if (expired || attempt >= 5 || !/cannot be edited right now/i.test(error.message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      } finally { clearTimeout(timeout); }
    }
  }
  async function normalWindow(id) {
    const window = await api.windows.get(id, { populate: true });
    if (window.type !== "normal" || window.incognito) throw new Error("Choose a normal, non-incognito window.");
    return window;
  }
  function savedTabs(tabs) {
    return tabs.filter((tab) => !tab.incognito && isRoutableUrl(tab.url || tab.pendingUrl)).map((tab) => ({
      url: tab.url || tab.pendingUrl, title: tab.title || tab.url || tab.pendingUrl,
      pinned: tab.pinned === true, routeOverride: overrides.get(tab.id) === (tab.url || tab.pendingUrl),
    }));
  }
  async function captureAll() {
    if (!enabled()) return;
    for (const workspace of data.workspaces) {
      const windowId = bindings.get(workspace.id);
      if (!Number.isInteger(windowId)) continue;
      try {
        const window = await normalWindow(windowId);
        if (!workspace.restorePending) workspace.tabs = savedTabs(window.tabs || []);
      } catch (error) {
        // Only a missing window is evidence that it closed; transient read errors
        // must not turn a live workspace into a second, newly restored window.
        if (/no window|not found|non-incognito/i.test(error.message)) bindings.delete(workspace.id);
        else warning = error.message;
      }
    }
    await persist();
  }
  function scheduleCapture() {
    if (!enabled()) return;
    clearTimeout(timer);
    timer = setTimeout(() => event(captureAll), 100);
  }
  async function start() {
    const session = await api.storage.session.get(SESSION_KEY);
    const windows = (await api.windows.getAll({ populate: true, windowTypes: ["normal"] })).filter((window) => !window.incognito);
    const available = new Map(windows.map((window) => [window.id, window]));
    for (const workspace of data.workspaces) {
      const id = session[SESSION_KEY]?.[workspace.id];
      if (available.has(id)) { bindings.set(workspace.id, id); available.delete(id); }
    }
    // IDs do not survive browser restarts. Reconnect only unique exact URL multisets,
    // never a loose "one matching page" guess. Ambiguous windows need explicit attachment.
    const signature = (tabs) => JSON.stringify(tabs.map((tab) => tab.url || tab.pendingUrl).filter(isRoutableUrl).sort());
    for (const workspace of data.workspaces) {
      if (bindings.has(workspace.id) || !workspace.tabs.length) continue;
      const sig = signature(workspace.tabs);
      if (data.workspaces.filter((item) => signature(item.tabs) === sig).length !== 1) continue;
      const matches = [...available.values()].filter((window) => signature(window.tabs || []) === sig);
      if (matches.length === 1) { bindings.set(workspace.id, matches[0].id); available.delete(matches[0].id); }
    }
    for (const workspace of data.workspaces) {
      const window = windows.find((item) => item.id === bindings.get(workspace.id));
      for (const tab of window?.tabs || []) {
        if (workspace.tabs.some((saved) => saved.url === tab.url && saved.routeOverride)) overrides.set(tab.id, tab.url);
      }
    }
    await captureAll();
  }
  async function ensureLive(workspace) {
    const id = bindings.get(workspace.id);
    if (Number.isInteger(id)) {
      try {
        await normalWindow(id);
        if (workspace.restorePending) await finishRestore(workspace, id);
        return id;
      } catch (error) {
        if (!/no window|not found/i.test(error.message)) throw error;
        bindings.delete(workspace.id);
      }
    }
    workspace.restorePending = true;
    await persist();
    const window = await edit(async () => {
      const created = await api.windows.create({ url: "about:blank", focused: false, type: "normal" });
      // Record even a late result, so retrying cannot create an orphan duplicate.
      bindings.set(workspace.id, created.id);
      if (created.tabs?.[0]) seeds.set(workspace.id, created.tabs[0].id);
      return created;
    });
    await persist();
    await finishRestore(workspace, window.id);
    return window.id;
  }
  async function finishRestore(workspace, windowId) {
    const open = await api.tabs.query({ windowId });
    const available = new Map();
    for (const tab of open) {
      const url = tab.pendingUrl || tab.url;
      available.set(url, (available.get(url) || 0) + 1);
    }
    for (const saved of workspace.tabs) {
      if (available.get(saved.url)) { available.set(saved.url, available.get(saved.url) - 1); continue; }
      const seedId = seeds.get(workspace.id);
      const seed = open.find((tab) => tab.id === seedId && tab.url === "about:blank");
      await edit(async () => {
        const tab = seed
          ? await api.tabs.update(seed.id, { url: saved.url, pinned: saved.pinned })
          : await api.tabs.create({ windowId, url: saved.url, pinned: saved.pinned, active: false });
        overrides.set(tab.id, saved.url);
        seeds.delete(workspace.id);
        return tab;
      });
    }
    delete workspace.restorePending;
    seeds.delete(workspace.id);
    await persist();
  }
  async function focus(id) {
    const workspace = find(id);
    const windowId = await ensureLive(workspace);
    const window = await normalWindow(windowId);
    await edit(() => api.windows.update(windowId, { ...(window.state === "minimized" ? { state: "normal" } : {}), focused: true }));
    if (data.minimizeOthers) {
      for (const [otherId, otherWindowId] of bindings) {
        if (otherId === id) continue;
        try { await edit(() => api.windows.update(otherWindowId, { state: "minimized" })); }
        catch (error) { warning = error.message; }
      }
    }
    await captureAll();
  }
  async function moveTab(tabId, destinationId, follow = false, manual = true) {
    const tab = await api.tabs.get(tabId);
    if (!workspaceForWindow(tab.windowId) || tab.incognito) throw new Error("This tab is not in a live workspace.");
    const destination = find(destinationId);
    if (bindings.get(destinationId) === tab.windowId) return;
    const sourceId = tab.windowId;
    const destinationWindowId = await ensureLive(destination);
    const sourceTabs = await api.tabs.query({ windowId: sourceId });
    if (tab.active || sourceTabs.length === 1) {
      const fallback = sourceTabs.filter((item) => item.id !== tabId)
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      if (fallback && tab.active) await edit(() => api.tabs.update(fallback.id, { active: true }));
      if (!fallback) await edit(() => api.tabs.create({ windowId: sourceId, active: true }));
    }
    moves.set(tabId, destinationWindowId);
    if (manual) overrides.set(tabId, tab.url || tab.pendingUrl);
    try {
      await edit(() => api.tabs.move(tabId, { windowId: destinationWindowId, index: -1 }));
      if (tab.pinned) await edit(() => api.tabs.update(tabId, { pinned: true }));
    } catch (error) {
      moves.delete(tabId);
      throw error;
    }
    await captureAll();
    if (follow) {
      await edit(() => api.tabs.update(tabId, { active: true }));
      await focus(destinationId);
    }
  }
  async function routeTab(tabId) {
    let tab;
    try { tab = await api.tabs.get(tabId); } catch { return; }
    if (!workspaceForWindow(tab.windowId) || tab.incognito || tab.pinned) return;
    const url = tab.pendingUrl || tab.url;
    if (overrides.get(tabId) === url) return;
    overrides.delete(tabId);
    const route = routeForUrl(data.routes, url);
    if (route) await moveTab(tabId, route.contextId, route.activate && tab.active, false);
  }
  async function enable(legacy, windowId, recordIds = {}) {
    if (enabled()) throw new Error("Window workspaces are already enabled.");
    const source = await normalWindow(windowId);
    const groups = await api.tabGroups.query({ windowId });
    const byGroup = new Map(groups.map((group) => [group.id, group.title]));
    const activeId = legacy.activeContextId || legacy.contexts[0].id;
    const definitions = [...legacy.contexts.map((context) => ({ ...context, tabs: [] })),
      { id: "read-later", title: "Read Later", color: "grey", tabs: [] },
      { id: "inactive", title: "Inactive", color: "grey", tabs: [] }];
    const plan = new Map(definitions.map((workspace) => [workspace.id, []]));
    for (const tab of source.tabs || []) {
      const workspace = !tab.pinned && definitions.find((item) => item.title === byGroup.get(tab.groupId));
      const record = legacy.records?.[recordIds[tab.id]];
      const recordedId = record?.attention === "readLater" ? "read-later" : record?.attention === "inactive" ? "inactive" : record?.contextId;
      const destination = tab.pinned ? activeId : workspace?.id || (plan.has(recordedId) ? recordedId : activeId);
      plan.get(destination).push(tab);
    }
    for (const workspace of definitions) workspace.tabs = savedTabs(plan.get(workspace.id));
    // Existing manually saved sets remain available, without opening more windows.
    for (const set of legacy.workspaces || []) definitions.push({
      id: `set-${set.id}`, title: set.title, color: legacy.contexts.find((item) => item.id === set.contextId)?.color || "grey",
      tabs: set.pages.map((page) => ({ ...page, pinned: false, routeOverride: true })),
    });
    const next = validateWindowState({ version: 1, enabled: true, minimizeOthers: true,
      workspaces: definitions, routes: legacy.routes.map((route) => ({ ...route, activate: false })) });
    await api.storage.local.set({ rauiriBeforeWindowMode: legacy, [KEY]: next });
    data = next; // Legacy orchestration stops before any tab moves begin.
    bindings.set(activeId, windowId);
    await persist();
    if (!plan.get(activeId).length) await edit(() => api.tabs.create({ windowId, active: true }));
    for (const workspace of data.workspaces) {
      const tabs = plan.get(workspace.id) || [];
      if (workspace.id === activeId || !tabs.length) continue;
      // Move live tabs, never reload them from saved URLs during migration.
      const window = await edit(async () => {
        const created = await api.windows.create({ tabId: tabs[0].id, focused: false, type: "normal" });
        bindings.set(workspace.id, created.id);
        return created;
      });
      for (const tab of tabs.slice(1)) await edit(() => api.tabs.move(tab.id, { windowId: window.id, index: -1 }));
      await persist();
    }
    for (const id of bindings.values()) {
      const tabs = await api.tabs.query({ windowId: id });
      const grouped = tabs.filter((tab) => tab.groupId !== api.tabGroups.TAB_GROUP_ID_NONE).map((tab) => tab.id);
      if (grouped.length) await edit(() => api.tabs.ungroup(grouped));
    }
    await captureAll();
    await focus(activeId);
  }
  function overview(windowId) {
    return {
      mode: "windows", managed: Boolean(workspaceForWindow(windowId)), currentWorkspaceId: workspaceForWindow(windowId)?.id || null,
      browserWarning: warning, minimizeOthers: data.minimizeOthers,
      workspaces: data.workspaces.map((workspace) => ({ id: workspace.id, title: workspace.title, color: workspace.color, windowId: bindings.get(workspace.id) ?? null, restoring: workspace.restorePending === true, tabCount: workspace.tabs.length })),
      contexts: data.workspaces.map(({ id, title, color }, order) => ({ id, title, color, order })),
      routes: data.routes, settings: {}, hasManagedWindow: bindings.size > 0, managedWindowId: null,
    };
  }
  async function handle(message) {
    await ready;
    if (["snapshot", "configurationSnapshot"].includes(message.type)) return overview(message.windowId);
    if (message.type === "exportBackup") {
      const legacy = await api.storage.local.get("rauiriState");
      return { format: FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(),
        state: message.configurationOnly ? { ...data, workspaces: data.workspaces.map(({ id, title, color }) => ({ id, title, color, tabs: [] })) } : data,
        ...(message.configurationOnly ? {} : { legacyState: legacy.rauiriState }) };
    }
    if (message.type === "exportLegacyBackup") {
      const stored = await api.storage.local.get("rauiriBeforeWindowMode");
      if (!stored.rauiriBeforeWindowMode) throw new Error("No original group backup is available.");
      return createBackup(stored.rauiriBeforeWindowMode);
    }
    if (message.type === "recoverySnapshot") return []; // Legacy records remain in full backups.
    if (message.type === "openOptions") return api.runtime.openOptionsPage();
    return enqueue(async () => {
      switch (message.type) {
        case "focusWindowWorkspace": await focus(message.workspaceId); break;
        case "moveWindowTab": await moveTab(message.tabId, message.workspaceId); break;
        case "createWindowWorkspace": {
          const title = String(message.title || "").trim();
          if (!title) throw new Error("Name your workspace.");
          const workspace = { id: crypto.randomUUID(), title, color: "blue", tabs: [] };
          data.workspaces.push(workspace);
          await persist();
          await focus(workspace.id);
          break;
        }
        case "attachWorkspaceWindow": {
          find(message.workspaceId);
          await normalWindow(message.windowId);
          if (workspaceForWindow(message.windowId) || bindings.has(message.workspaceId)) throw new Error("The window or workspace is already assigned.");
          await api.storage.local.set({ rauiriBeforeWorkspaceAttach: data });
          const workspace = find(message.workspaceId);
          workspace.savedBeforeAttach = structuredClone(workspace.tabs);
          delete workspace.restorePending;
          bindings.set(message.workspaceId, message.windowId);
          await captureAll();
          break;
        }
        case "setWorkspacePreferences": data.minimizeOthers = message.minimizeOthers === true; await persist(); break;
        case "saveContexts": {
          if (!Array.isArray(message.contexts) || message.contexts.length !== data.workspaces.length) throw new Error("Create workspaces in the popup. Removing workspaces is not supported in this live prototype.");
          const seen = new Set();
          const updated = message.contexts.map((context) => {
            const workspace = find(context.id);
            if (seen.has(context.id) || !String(context.title || "").trim() || !TAB_GROUP_COLORS.includes(context.color)) throw new Error("Invalid workspace details.");
            seen.add(context.id);
            return { ...workspace, title: context.title.trim(), color: context.color };
          });
          data.workspaces = updated; await persist(); break;
        }
        case "addRoute": {
          find(message.contextId);
          const hostname = cleanHostnameInput(message.hostname);
          if (!isValidRouteHostname(hostname)) throw new Error("Enter an exact hostname or *.example.com.");
          data.routes = [...data.routes.filter((route) => route.hostname !== hostname),
            { id: crypto.randomUUID(), hostname, contextId: message.contextId, activate: message.activate === true }];
          await persist();
          if (message.moveExisting) {
            for (const id of [...bindings.values()]) {
              for (const tab of await api.tabs.query({ windowId: id })) {
                if (routeForUrl(data.routes, tab.url)?.id === data.routes.at(-1).id) await routeTab(tab.id);
              }
            }
          }
          break;
        }
        case "removeRoute": data.routes = data.routes.filter((route) => route.id !== message.routeId); await persist(); break;
        case "importBackup": {
          if (message.backup?.format !== FORMAT || message.backup.formatVersion !== 1) throw new Error("Choose a window-workspace backup. Your original group backup is retained separately.");
          if (bindings.size) throw new Error("Import only when no workspace windows are live. Export a backup first.");
          const next = validateWindowState(message.backup.state);
          const legacy = message.backup.legacyState ? stateFromBackup({ format: "rauiri-backup", formatVersion: 1, state: message.backup.legacyState }) : null;
          const original = !enabled() ? (await api.storage.local.get("rauiriState")).rauiriState : null;
          await api.storage.local.set({ rauiriBeforeWorkspaceImport: data, [KEY]: next,
            ...(original ? { rauiriBeforeWindowMode: original } : {}), ...(legacy ? { rauiriState: legacy } : {}) });
          data = next;
          return { contexts: data.workspaces.length, routes: data.routes.length, records: data.workspaces.reduce((n, w) => n + w.tabs.length, 0) };
        }
        case "exportPreviousBackup": {
          const stored = await api.storage.local.get("rauiriBeforeWorkspaceImport");
          if (!stored.rauiriBeforeWorkspaceImport) throw new Error("No pre-import workspace backup exists.");
          return { format: FORMAT, formatVersion: 1, state: stored.rauiriBeforeWorkspaceImport };
        }
        default: throw new Error("This action belongs to the old group workflow. Use the workspace switcher.");
      }
      return { ok: true };
    });
  }

  api.tabs.onCreated.addListener((tab) => event(async () => { await routeTab(tab.id); scheduleCapture(); }));
  api.tabs.onUpdated.addListener((tabId, changes) => {
    if (changes.url || changes.status === "complete") event(() => routeTab(tabId));
    scheduleCapture();
  });
  api.tabs.onMoved.addListener(scheduleCapture);
  api.tabs.onDetached.addListener(scheduleCapture);
  api.tabs.onAttached.addListener((tabId, info) => {
    const internal = moves.get(tabId) === info.newWindowId;
    moves.delete(tabId);
    event(async () => {
      if (!internal && workspaceForWindow(info.newWindowId)) {
        const tab = await api.tabs.get(tabId);
        overrides.set(tabId, tab.url || tab.pendingUrl);
      }
      scheduleCapture();
    });
  });
  api.tabs.onRemoved.addListener((id, info) => {
    overrides.delete(id);
    moves.delete(id);
    if (!info.isWindowClosing) scheduleCapture();
  });
  api.windows.onRemoved.addListener((windowId) => event(async () => {
    const workspace = workspaceForWindow(windowId);
    if (workspace) { bindings.delete(workspace.id); await persist(); }
  }));
  api.runtime.onStartup.addListener(() => event(start));

  return { ready, get enabled() { return enabled(); },
    start: () => enqueue(start), enable: (legacy, windowId, recordIds) => enqueue(() => enable(legacy, windowId, recordIds)), handle };
}
