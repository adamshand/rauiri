import { cleanHostnameInput, isRoutableUrl, isValidRouteHostname, routeForUrl, TAB_GROUP_COLORS, createBackup, stateFromBackup } from "./domain.js";

const KEY = "rauiriWindowWorkspaces";
const SESSION_KEY = "rauiriWorkspaceWindows";
const RECENT_KEY = "rauiriRecentWorkspaces";
const PROJECT_BOUNDS_KEY = "rauiriProjectBounds";
const FORMAT = "rauiri-window-workspaces";
const READ_LATER = "read-later";

function validateShortcutSlots(slots, workspaceIds, message) {
  const assigned = Array.isArray(slots) ? slots.filter((id) => id !== null) : [];
  if (!Array.isArray(slots) || slots.length !== 9
    || Array.from(slots).some((id) => id !== null && (!workspaceIds.has(id) || id === READ_LATER))
    || new Set(assigned).size !== assigned.length) throw new Error(message);
}

export function validateWindowState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.workspaces) || !value.workspaces.length
    || !Array.isArray(value.routes) || typeof value.minimizeOthers !== "boolean") throw new Error("Unsupported workspace backup.");
  const ids = new Set();
  for (const workspace of value.workspaces) {
    if (!workspace || typeof workspace.id !== "string" || !workspace.id || ids.has(workspace.id)
      || typeof workspace.title !== "string" || !workspace.title.trim() || !TAB_GROUP_COLORS.includes(workspace.color)
      || (workspace.keepAvailable !== undefined && typeof workspace.keepAvailable !== "boolean")
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
  // Older backups allowed multiple minimisation exemptions. Keep the first in
  // workspace order as the single pin; an explicit null means no pin.
  const pinnedWorkspaceId = value.pinnedWorkspaceId === undefined
    ? value.workspaces.find((workspace) => workspace.keepAvailable)?.id || null
    : value.pinnedWorkspaceId;
  if (pinnedWorkspaceId !== null && !ids.has(pinnedWorkspaceId)) throw new Error("Invalid pinned workspace.");
  const shortcutSlots = value.shortcutSlots === undefined
    ? Array.from({ length: 9 }, (_, index) => value.workspaces[index]?.id === READ_LATER ? null : value.workspaces[index]?.id || null)
    : value.shortcutSlots;
  validateShortcutSlots(shortcutSlots, ids, "Invalid workspace shortcut slots.");
  // Native window closures may be browser shutdown. Candidates only restore
  // slots when startup actually reconnects those windows; explicit resume clears them.
  const closedShortcutSlots = value.closedShortcutSlots === undefined ? Array(9).fill(null) : value.closedShortcutSlots;
  validateShortcutSlots(closedShortcutSlots, ids, "Invalid closed workspace shortcuts.");
  const workspaces = value.workspaces.map(({ keepAvailable, ...workspace }) => workspace.id === READ_LATER ? { ...workspace, title: "Read Later" } : workspace);
  if (!ids.has(READ_LATER)) workspaces.push({ id: READ_LATER, title: "Read Later", color: "grey", tabs: [] });
  return structuredClone({ ...value, enabled: true, pinnedWorkspaceId, shortcutSlots, closedShortcutSlots, workspaces });
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
  let readLaterTimer;
  let projectBounds = null;
  let lastWindowSwitch = null;
  let recent = []; // Most recently focused first; separate from stable shortcut order.

  const ready = (async () => {
    const stored = await api.storage.local.get(KEY);
    if (stored[KEY]?.enabled) {
      data = validateWindowState(stored[KEY]);
      // Reconnect before any snapshot or event can observe/persist empty bindings.
      // Service workers restart independently of the browser's onStartup event.
      await start();
    }
  })();
  // Keep load failures visible without overwriting a malformed stored state.
  void ready.catch((error) => { warning = error.message; });

  const enabled = () => data?.enabled === true;
  const workspaceForWindow = (windowId) => Number.isInteger(windowId)
    ? data?.workspaces.find((workspace) => bindings.get(workspace.id) === windowId)
    : undefined;
  const activeRoutes = () => data.routes.filter((route) => bindings.has(route.contextId));
  function clearShortcut(id, remember = false) {
    data.shortcutSlots = data.shortcutSlots.map((workspaceId, index) => {
      if (workspaceId !== id) return workspaceId;
      data.closedShortcutSlots[index] = remember ? id : null;
      return null;
    });
    if (!remember) data.closedShortcutSlots = data.closedShortcutSlots.map((workspaceId) => workspaceId === id ? null : workspaceId);
  }
  function unbind(id, rememberShortcut = true) {
    bindings.delete(id);
    clearShortcut(id, rememberShortcut);
    if (data.pinnedWorkspaceId === id) data.pinnedWorkspaceId = null;
  }
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
    await api.storage.session.set({ [SESSION_KEY]: Object.fromEntries(bindings), [RECENT_KEY]: recent });
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
        if (/no window|not found|non-incognito/i.test(error.message)) unbind(workspace.id);
        else warning = error.message;
      }
    }
    if (!bindings.has(data.pinnedWorkspaceId)) data.pinnedWorkspaceId = null;
    await persist();
  }
  function scheduleCapture() {
    if (!enabled()) return;
    clearTimeout(timer);
    timer = setTimeout(() => event(captureAll), 100);
  }
  async function rememberFocus(id) {
    if (recent[0] === id) return;
    recent = [id, ...recent.filter((item) => item !== id)];
    await api.storage.session.set({ [RECENT_KEY]: recent });
  }
  async function start() {
    projectBounds = windowBounds((await api.storage.session.get(PROJECT_BOUNDS_KEY))[PROJECT_BOUNDS_KEY]);
    const storedRecent = (await api.storage.session.get(RECENT_KEY))[RECENT_KEY];
    recent = Array.isArray(storedRecent) ? [...new Set(storedRecent)].filter((id) => data.workspaces.some((w) => w.id === id)) : [];
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
      if (bindings.has(workspace.id)) continue;
      if (workspace.id === READ_LATER && !workspace.tabs.length) {
        const blank = [...available.values()].filter((window) => window.tabs?.length === 1
          && ["about:blank", "chrome://newtab/"].includes(window.tabs[0].url));
        if (blank.length === 1) { bindings.set(workspace.id, blank[0].id); available.delete(blank[0].id); }
      }
      if (!workspace.tabs.length) continue;
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
    const focused = windows.find((window) => window.focused);
    const current = workspaceForWindow(focused?.id);
    if (current) await rememberFocus(current.id);
    data.shortcutSlots = data.shortcutSlots.map((id, index) => bindings.has(id) ? id
      : bindings.has(data.closedShortcutSlots[index]) ? data.closedShortcutSlots[index] : null);
    data.closedShortcutSlots = data.closedShortcutSlots.map((id, index) => data.shortcutSlots[index] === id ? null : id);
    await captureAll();
    await ensureReadLater();
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
        unbind(workspace.id);
      }
    }
    clearShortcut(workspace.id);
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
  function windowBounds(window) {
    const { left, top, width, height } = window || {};
    if (![left, top, width, height].every(Number.isInteger) || width <= 0 || height <= 0) return null;
    return { left, top, width, height };
  }
  async function rememberProjectBounds(window) {
    const workspace = workspaceForWindow(window.id);
    const bounds = windowBounds(window);
    if (!workspace || workspace.id === data.pinnedWorkspaceId || window.state !== "normal" || !bounds) return;
    projectBounds = bounds;
    await api.storage.session.set({ [PROJECT_BOUNDS_KEY]: bounds });
  }
  async function replacementBounds(id) {
    const current = await api.windows.getLastFocused({ windowTypes: ["normal"] });
    const source = workspaceForWindow(current.id);
    if (lastWindowSwitch) lastWindowSwitch.source = { workspaceId: source?.id || null, state: current.state, bounds: windowBounds(current) };
    if (!source) return null;
    await rememberProjectBounds(current);
    if (id === data.pinnedWorkspaceId || source.id === id) return null;
    if (source.id !== data.pinnedWorkspaceId) return current.state === "normal" ? windowBounds(current) : null;
    for (const candidate of recent) {
      if (candidate === data.pinnedWorkspaceId || !bindings.has(candidate)) continue;
      let window;
      try { window = await normalWindow(bindings.get(candidate)); }
      catch { continue; }
      if (window.state === "minimized") continue;
      if (window.state !== "normal") return null;
      // An already-visible destination should keep its current geometry.
      if (candidate === id) return null;
      await rememberProjectBounds(window);
      return windowBounds(window);
    }
    return projectBounds;
  }
  async function focus(id, { preserveProject = true, allowResume = true } = {}) {
    const workspace = find(id);
    lastWindowSwitch = { workspaceId: id, pinnedWorkspaceId: data.pinnedWorkspaceId };
    // Read the outgoing window before creating/restoring the destination can
    // change focus. Geometry never comes from the pinned base or unrelated windows.
    let bounds;
    try { if (preserveProject) bounds = await replacementBounds(id); }
    catch (error) { warning = error.message; }
    lastWindowSwitch.requestedBounds = bounds || null;
    const windowId = allowResume ? await ensureLive(workspace) : bindings.get(id);
    let window = await normalWindow(windowId);
    lastWindowSwitch.before = { state: window.state, bounds: windowBounds(window) };
    if (window.state === "minimized") {
      await edit(() => api.windows.update(windowId, { state: "normal" }));
      // Chromium can resolve update() before macOS finishes restoring the
      // window. Wait for the observed state instead of silently skipping bounds.
      for (let attempt = 0; attempt < 20; attempt++) {
        window = await normalWindow(windowId);
        if (window.state !== "minimized") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (window.state === "minimized") throw new Error(`“${workspace.title}” is still restoring. Please try switching again.`);
    }
    if (bounds && window.state === "normal") {
      try { await edit(() => api.windows.update(windowId, bounds)); }
      catch (error) { warning = error.message; }
    }
    await edit(() => api.windows.update(windowId, { focused: true }));
    window = await normalWindow(windowId);
    lastWindowSwitch.after = { state: window.state, bounds: windowBounds(window) };
    await rememberProjectBounds(window);
    await rememberFocus(id);
    await minimizeOtherWindows(id, { preserveProject });
    await captureAll();
  }
  async function minimizeOtherWindows(id, { preserveProject = true, expectedWindowId } = {}) {
    if (!data.minimizeOthers) return;
    const keep = new Set([id, data.pinnedWorkspaceId]);
    // Visiting the pinned base is not leaving the current project. Keep the most
    // recently used visible project, but never reopen a closed or minimised one.
    if (preserveProject && id === data.pinnedWorkspaceId) {
      for (const projectId of recent) {
        if (keep.has(projectId) || !bindings.has(projectId)) continue;
        try {
          if ((await normalWindow(bindings.get(projectId))).state === "minimized") continue;
          keep.add(projectId);
          break;
        } catch { /* A closed window is not a project to keep visible. */ }
      }
    }
    for (const [otherId, otherWindowId] of bindings) {
      if (keep.has(otherId)) continue;
      try {
        if ((await normalWindow(otherWindowId)).state === "minimized") continue;
        if (expectedWindowId !== undefined) {
          const current = await api.windows.getLastFocused({ windowTypes: ["normal"] });
          if (!current.focused || current.id !== expectedWindowId) return;
        }
        await edit(() => api.windows.update(otherWindowId, { state: "minimized" }));
      } catch (error) { warning = error.message; }
    }
  }
  async function moveTab(tabId, destinationId, follow = false, manual = true) {
    const tab = await api.tabs.get(tabId);
    if (!workspaceForWindow(tab.windowId) || tab.incognito) throw new Error("This tab is not in a live workspace.");
    const destination = find(destinationId);
    if (bindings.get(destinationId) === tab.windowId) return;
    const sourceId = tab.windowId;
    const destinationWindowId = manual ? await ensureLive(destination) : bindings.get(destinationId);
    await normalWindow(destinationWindowId);
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
      await focus(destinationId, { allowResume: manual });
    }
  }
  async function routeTab(tabId, { addressBar = false, cleanup = false, url: committedUrl } = {}) {
    let tab;
    try { tab = await api.tabs.get(tabId); } catch { return; }
    if (!workspaceForWindow(tab.windowId) || tab.incognito || tab.pinned) return;
    const url = tab.pendingUrl || tab.url;
    // Ignore a queued event if this tab has since navigated elsewhere.
    if (committedUrl && committedUrl !== url) return;
    if (!addressBar && overrides.get(tabId) === url) return;
    overrides.delete(tabId);
    const route = routeForUrl(activeRoutes(), url);
    if (route) {
      // A stale binding must never turn background routing into a resume.
      try { await normalWindow(bindings.get(route.contextId)); }
      catch (error) {
        if (!/no window|not found/i.test(error.message)) throw error;
        unbind(route.contextId);
        await persist();
        return;
      }
      const source = await normalWindow(tab.windowId);
      const follow = !cleanup && (addressBar || route.activate) && tab.active && source.focused;
      await moveTab(tabId, route.contextId, follow, false);
    }
  }
  async function enable(legacy, windowId, recordIds = {}) {
    if (enabled()) throw new Error("Window workspaces are already enabled.");
    const source = await normalWindow(windowId);
    const groups = await api.tabGroups.query({ windowId });
    const byGroup = new Map(groups.map((group) => [group.id, group.title]));
    const activeId = legacy.activeContextId || legacy.contexts[0].id;
    const definitions = [...legacy.contexts.map((context) => ({ ...context, tabs: [] })),
      { id: READ_LATER, title: "Read Later", color: "grey", tabs: [] },
      { id: "inactive", title: "Inactive", color: "grey", tabs: [] }];
    const plan = new Map(definitions.map((workspace) => [workspace.id, []]));
    for (const tab of source.tabs || []) {
      const workspace = !tab.pinned && definitions.find((item) => item.title === byGroup.get(tab.groupId));
      const record = legacy.records?.[recordIds[tab.id]];
      const recordedId = record?.attention === "readLater" ? READ_LATER : record?.attention === "inactive" ? "inactive" : record?.contextId;
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
    data.shortcutSlots = data.shortcutSlots.map((id) => bindings.has(id) ? id : null);
    await captureAll();
    await ensureReadLater();
    await focus(activeId);
  }
  async function ensureReadLater() {
    if (!enabled() || blockedEdit || bindings.has(READ_LATER)) return;
    const windows = await api.windows.getAll({ windowTypes: ["normal"] });
    // Do not fight browser shutdown or create a window in an otherwise closed browser.
    if (!windows.some((window) => window.type === "normal" && !window.incognito)) return;
    const id = await ensureLive(find(READ_LATER));
    await edit(() => api.windows.update(id, { state: "minimized" }));
    await captureAll();
  }
  function scheduleReadLater() {
    clearTimeout(readLaterTimer);
    // Let a batch of closing windows settle before deciding whether this is a
    // manual Read Later close or the browser exiting.
    readLaterTimer = setTimeout(() => event(ensureReadLater), 300);
  }
  async function putAway(id) {
    const workspace = find(id);
    if (id === READ_LATER) throw new Error("Read Later is built in and cannot be put away.");
    if (blockedEdit) throw new Error("A browser edit is still pending. Try again once it completes.");
    await captureAll(); // Durable inventory must succeed before closing anything.
    const windowId = bindings.get(id);
    if (!Number.isInteger(windowId)) { clearShortcut(id); await persist(); return; }
    await edit(() => api.windows.remove(windowId));
    try {
      await normalWindow(windowId);
    } catch (error) {
      if (!/no window|not found/i.test(error.message)) throw error;
      unbind(workspace.id, false);
      await persist();
      return;
    }
    throw new Error("The window is still open. Its workspace and routes remain active.");
  }
  async function deleteWorkspace(message) {
    const source = find(message.workspaceId);
    if (source.id === READ_LATER) throw new Error("Read Later is built in and cannot be deleted or merged away.");
    if (blockedEdit) throw new Error("A browser edit is still pending. Try again once it completes.");
    if (!["move", "delete"].includes(message.tabs) || !["move", "delete"].includes(message.rules)) throw new Error("Choose what happens to this workspace’s tabs and rules.");
    const destination = message.tabs === "move" || message.rules === "move" ? find(message.destinationId) : null;
    if (destination?.id === source.id) throw new Error("Choose a different destination workspace.");
    await captureAll();
    const sourceWindowId = bindings.get(source.id);
    const live = Number.isInteger(sourceWindowId);
    if (live && (message.tabs !== "move" || message.rules !== "move")) throw new Error("An active workspace must be merged. Its live tabs and rules must move to another workspace.");
    if (live && source.restorePending) throw new Error("Finish restoring this workspace, or put it away, before deleting or merging it.");
    await api.storage.local.set({ rauiriBeforeWorkspaceDelete: data });
    if (live) {
      const destinationWindowId = await ensureLive(destination);
      const tabs = await api.tabs.query({ windowId: sourceWindowId });
      for (const tab of tabs) {
        moves.set(tab.id, destinationWindowId);
        overrides.set(tab.id, tab.url || tab.pendingUrl);
        await edit(async () => {
          await api.tabs.move(tab.id, { windowId: destinationWindowId, index: -1 });
          if (tab.pinned) await api.tabs.update(tab.id, { pinned: true });
        });
      }
      // Moving the last tab closes its now-empty window. New tabs appearing
      // during the merge must not be abandoned by deleting their workspace.
      try {
        const remaining = await normalWindow(sourceWindowId);
        if (remaining.tabs?.length) throw new Error("New tabs appeared in the source workspace. Review them and try merging again.");
        await edit(() => api.windows.remove(sourceWindowId));
      } catch (error) {
        if (!/no window|not found/i.test(error.message)) throw error;
      }
      unbind(source.id);
      await captureAll();
    }
    const next = structuredClone(data);
    if (!live && message.tabs === "move") {
      const target = next.workspaces.find((workspace) => workspace.id === destination.id);
      target.tabs.push(...source.tabs);
      if (bindings.has(target.id)) target.restorePending = true;
    }
    next.workspaces = next.workspaces.filter((workspace) => workspace.id !== source.id);
    next.shortcutSlots = next.shortcutSlots.map((id) => id === source.id ? null : id);
    next.closedShortcutSlots = next.closedShortcutSlots.map((id) => id === source.id ? null : id);
    next.routes = next.routes.flatMap((route) => route.contextId !== source.id ? [route]
      : message.rules === "move" ? [{ ...route, contextId: destination.id }] : []);
    if (next.pinnedWorkspaceId === source.id) next.pinnedWorkspaceId = null;
    await api.storage.local.set({ [KEY]: validateWindowState(next) });
    data = next;
    recent = recent.filter((id) => id !== source.id);
    seeds.delete(source.id);
    await persist();
    if (!live && message.tabs === "move" && bindings.has(destination.id)) {
      await finishRestore(find(destination.id), bindings.get(destination.id));
      await captureAll();
    }
    if (live) await focus(destination.id, { allowResume: false });
  }
  function overview(windowId) {
    return {
      mode: "windows", managed: Boolean(workspaceForWindow(windowId)), currentWorkspaceId: workspaceForWindow(windowId)?.id || null,
      browserWarning: warning, lastWindowSwitch, minimizeOthers: data.minimizeOthers, recentWorkspaceIds: [...recent], pinnedWorkspaceId: data.pinnedWorkspaceId,
      shortcutSlots: [...data.shortcutSlots],
      workspaces: data.workspaces.map((workspace) => {
        const { id, title, color } = workspace;
        const builtin = id === READ_LATER;
        const slot = data.shortcutSlots.indexOf(id);
        return { id, title, color, builtin, shortcut: builtin ? 0 : slot < 0 ? null : slot + 1,
          windowId: bindings.get(id) ?? null, restoring: workspace.restorePending === true,
          pinned: id === data.pinnedWorkspaceId, tabCount: workspace.tabs.length };
      }),
      contexts: data.workspaces.map(({ id, title, color }, order) => ({ id, title, color, order })),
      routes: data.routes.map((route) => ({ ...route, active: bindings.has(route.contextId) })), settings: {}, hasManagedWindow: bindings.size > 0, managedWindowId: null,
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
    if (message.type === "exportWorkspaceDeletionBackup") {
      const stored = await api.storage.local.get("rauiriBeforeWorkspaceDelete");
      if (!stored.rauiriBeforeWorkspaceDelete) throw new Error("No workspace deletion backup exists.");
      return { format: FORMAT, formatVersion: 1, state: stored.rauiriBeforeWorkspaceDelete };
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
        case "setPinnedWorkspace": {
          if (message.workspaceId !== null) {
            find(message.workspaceId);
            if (!bindings.has(message.workspaceId)) throw new Error("Resume this workspace before pinning it.");
            await normalWindow(bindings.get(message.workspaceId));
          }
          // Capture the old project before changing which window is the base.
          await rememberProjectBounds(await api.windows.getLastFocused({ windowTypes: ["normal"] }));
          data.pinnedWorkspaceId = message.workspaceId;
          await persist();
          if (message.workspaceId !== null) {
            await focus(message.workspaceId, { preserveProject: false, allowResume: false });
          } else {
            const window = await api.windows.getLastFocused({ windowTypes: ["normal"] });
            const current = workspaceForWindow(window.id);
            if (current) await minimizeOtherWindows(current.id);
          }
          break;
        }
        case "putAwayWorkspace": await putAway(message.workspaceId); break;
        case "deleteWindowWorkspace": await deleteWorkspace(message); break;
        case "assignWorkspaceShortcut": {
          const index = message.slot - 1;
          if (!Number.isInteger(message.slot) || index < 0 || index >= 9) throw new Error("Choose a shortcut slot from 1 to 9. Slot 0 is Read Later.");
          const id = message.workspaceId;
          if (id !== null) {
            find(id);
            if (id === READ_LATER) throw new Error("Read Later always uses slot 0.");
            if (!bindings.has(id)) throw new Error("Resume this workspace before assigning a shortcut.");
            await normalWindow(bindings.get(id));
          }
          const previousIndex = data.shortcutSlots.indexOf(id);
          const displaced = data.shortcutSlots[index];
          data.shortcutSlots[index] = id;
          data.closedShortcutSlots[index] = null;
          if (id !== null && previousIndex >= 0 && previousIndex !== index) {
            data.shortcutSlots[previousIndex] = displaced;
            data.closedShortcutSlots[previousIndex] = null;
          }
          await persist();
          break;
        }
        case "setWorkspacePreferences": data.minimizeOthers = message.minimizeOthers === true; await persist(); break;
        case "saveContexts": {
          if (!Array.isArray(message.contexts) || message.contexts.length !== data.workspaces.length) throw new Error("The workspace list changed. Refresh Settings before saving.");
          const seen = new Set();
          const updated = message.contexts.map((context) => {
            const workspace = find(context.id);
            if (workspace.id === READ_LATER && context.title !== "Read Later") throw new Error("Read Later’s name is fixed.");
            if (seen.has(context.id) || !String(context.title || "").trim() || !TAB_GROUP_COLORS.includes(context.color)) throw new Error("Invalid workspace details.");
            seen.add(context.id);
            return { ...workspace, title: context.title.trim(), color: context.color };
          });
          data.workspaces = updated; await persist(); break;
        }
        case "addRoute": {
          find(message.contextId);
          const hostname = cleanHostnameInput(message.hostname);
          if (!isValidRouteHostname(hostname)) throw new Error("Enter a hostname such as example.com. Subdomains are included automatically.");
          data.routes = [...data.routes.filter((route) => route.hostname !== hostname),
            { id: crypto.randomUUID(), hostname, contextId: message.contextId, activate: message.activate === true }];
          await persist();
          if (message.moveExisting) {
            for (const id of [...bindings.values()]) {
              for (const tab of await api.tabs.query({ windowId: id })) {
                if (routeForUrl(activeRoutes(), tab.url)?.id === data.routes.at(-1).id) await routeTab(tab.id, { cleanup: true });
              }
            }
          }
          break;
        }
        case "updateRouteDestination": {
          const route = data.routes.find((item) => item.id === message.routeId);
          if (!route) throw new Error("This route no longer exists. Refresh Settings.");
          find(message.contextId);
          route.contextId = message.contextId;
          await persist();
          break;
        }
        case "removeRoute": data.routes = data.routes.filter((route) => route.id !== message.routeId); await persist(); break;
        case "importBackup": {
          if (message.backup?.format !== FORMAT || message.backup.formatVersion !== 1) throw new Error("Choose a window-workspace backup. Your original group backup is retained separately.");
          if ([...bindings.keys()].some((id) => id !== READ_LATER)) throw new Error("Put away other workspaces before importing. Read Later can stay open. Export a backup first.");
          if (blockedEdit) throw new Error("A browser edit is still pending. Try again once it completes.");
          const next = validateWindowState(message.backup.state);
          next.shortcutSlots.fill(null); // Imported workspaces are put away until explicitly resumed.
          next.closedShortcutSlots.fill(null);
          const legacy = message.backup.legacyState ? stateFromBackup({ format: "rauiri-backup", formatVersion: 1, state: message.backup.legacyState }) : null;
          const original = !enabled() ? (await api.storage.local.get("rauiriState")).rauiriState : null;
          if (enabled()) await captureAll();
          if (bindings.has(READ_LATER)) {
            const currentTabs = find(READ_LATER).tabs;
            const currentUrls = new Set(currentTabs.map((tab) => tab.url));
            const reading = next.workspaces.find((workspace) => workspace.id === READ_LATER);
            reading.tabs = [...currentTabs, ...reading.tabs.filter((tab) => !currentUrls.has(tab.url))];
            reading.restorePending = true;
          }
          if (next.pinnedWorkspaceId !== READ_LATER || !bindings.has(READ_LATER)) next.pinnedWorkspaceId = null;
          await api.storage.local.set({ rauiriBeforeWorkspaceImport: data, [KEY]: next,
            ...(original ? { rauiriBeforeWindowMode: original } : {}), ...(legacy ? { rauiriState: legacy } : {}) });
          data = next;
          recent = recent.filter((id) => data.workspaces.some((workspace) => workspace.id === id));
          await persist();
          if (bindings.has(READ_LATER)) {
            await finishRestore(find(READ_LATER), bindings.get(READ_LATER));
            await captureAll();
          } else scheduleReadLater();
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

  // Route only once navigation intent is known. tabs.onUpdated can arrive before
  // onCommitted; moving there would lose address-bar intent and source focus.
  const navigation = (details) => {
    if (details.frameId !== 0 || (details.documentLifecycle && details.documentLifecycle !== "active")) return;
    event(async () => {
      await routeTab(details.tabId, {
        url: details.url,
        addressBar: details.transitionQualifiers?.includes("from_address_bar") || details.transitionType === "typed",
      });
      scheduleCapture();
    });
  };
  api.webNavigation.onCommitted.addListener(navigation);
  api.webNavigation.onHistoryStateUpdated.addListener(navigation);
  api.webNavigation.onReferenceFragmentUpdated.addListener(navigation);
  api.tabs.onCreated.addListener(scheduleCapture);
  api.tabs.onUpdated.addListener(scheduleCapture);
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
    if (workspace) { unbind(workspace.id); await persist(); }
    scheduleReadLater();
  }));
  api.windows.onCreated.addListener((window) => {
    if (enabled() && window.type === "normal" && !window.incognito) scheduleReadLater();
  });
  api.windows.onFocusChanged.addListener((windowId) => event(async () => {
    const workspace = workspaceForWindow(windowId);
    if (!workspace) return;
    // A queued focus event may describe an intermediate window we have already left.
    const current = await api.windows.getLastFocused({ windowTypes: ["normal"] });
    if (!current.focused || current.id !== windowId) return;
    await rememberProjectBounds(current);
    await rememberFocus(workspace.id);
    await minimizeOtherWindows(workspace.id, { expectedWindowId: windowId });
  }));
  api.commands.onCommand.addListener((command) => event(async () => {
    if (command === "previous-workspace") {
      const currentWindow = await api.windows.getLastFocused({ windowTypes: ["normal"] });
      const current = workspaceForWindow(currentWindow.id);
      const target = recent.find((id) => id !== current?.id && bindings.has(id));
      if (target) await focus(target);
    } else if (/^workspace-(10|[1-9])$/.test(command)) {
      const slot = Number(command.slice(10));
      const id = slot === 10 ? READ_LATER : data.shortcutSlots[slot - 1];
      if (id && (id === READ_LATER || bindings.has(id))) await focus(id, { allowResume: id === READ_LATER });
    }
  }));
  api.runtime.onStartup.addListener(() => event(start));

  return { ready, get enabled() { return enabled(); },
    start: () => enqueue(start), enable: (legacy, windowId, recordIds) => enqueue(() => enable(legacy, windowId, recordIds)), handle };
}
