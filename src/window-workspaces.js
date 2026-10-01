import { cleanHostnameInput, isRoutableUrl, isValidRouteHostname, routeForUrl, WORKSPACE_COLORS } from "./domain.js";

const KEY = "rauiriWindowWorkspaces";
const SESSION_KEY = "rauiriWorkspaceWindows";
const RECENT_KEY = "rauiriRecentWorkspaces";
const PROJECT_BOUNDS_KEY = "rauiriProjectBounds";
const FORMAT = "rauiri-window-workspaces";
const READ_LATER = "read-later";
const BEFORE_RECONNECT_KEY = "rauiriBeforeReconnect";
const RESTORE_KEYS = {
  exportWorkspaceDeletionBackup: "rauiriBeforeWorkspaceDelete",
  exportPreviousBackup: "rauiriBeforeWorkspaceImport",
  exportReconnectBackup: BEFORE_RECONNECT_KEY,
  exportAttachBackup: "rauiriBeforeWorkspaceAttach",
};
const isMissingWindow = (error) => /no window|not found/i.test(error.message);
// Share of pages (intersection over union) a window needs with a saved workspace.
const RECONNECT_OVERLAP = 0.5;

export function createWindowState() {
  return {
    version: 1, minimizeOthers: true, pinnedWorkspaceId: null,
    shortcutSlots: Array(9).fill(null), closedShortcutSlots: Array(9).fill(null), routes: [],
    workspaces: [
      { id: "personal", title: "Personal", color: "green", tabs: [] },
      { id: "work", title: "Work", color: "red", tabs: [] },
      { id: "groundtruth", title: "Groundtruth", color: "orange", tabs: [] },
      { id: READ_LATER, title: "Read Later", color: "grey", tabs: [] },
    ],
  };
}

// Multiset overlap of two URL lists: shared pages over all distinct page slots.
export function pageOverlap(saved, live) {
  const remaining = new Map();
  for (const url of saved) remaining.set(url, (remaining.get(url) || 0) + 1);
  let shared = 0;
  for (const url of live) {
    if (!remaining.get(url)) continue;
    remaining.set(url, remaining.get(url) - 1);
    shared++;
  }
  const total = saved.length + live.length - shared;
  return total ? shared / total : 0;
}

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
      || typeof workspace.title !== "string" || !workspace.title.trim() || !WORKSPACE_COLORS.includes(workspace.color)
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
  const pinnedWorkspaceId = value.pinnedWorkspaceId ?? null;
  if (pinnedWorkspaceId !== null && !ids.has(pinnedWorkspaceId)) throw new Error("Invalid pinned workspace.");
  const shortcutSlots = value.shortcutSlots === undefined
    ? Array.from({ length: 9 }, (_, index) => value.workspaces[index]?.id === READ_LATER ? null : value.workspaces[index]?.id || null)
    : value.shortcutSlots;
  validateShortcutSlots(shortcutSlots, ids, "Invalid workspace shortcut slots.");
  // Native window closures may be browser shutdown. Candidates only restore
  // slots when startup actually reconnects those windows; explicit resume clears them.
  const closedShortcutSlots = value.closedShortcutSlots === undefined ? Array(9).fill(null) : value.closedShortcutSlots;
  validateShortcutSlots(closedShortcutSlots, ids, "Invalid closed workspace shortcuts.");
  const workspaces = value.workspaces.map((workspace) => ({
    id: workspace.id, title: workspace.id === READ_LATER ? "Read Later" : workspace.title,
    color: workspace.color, tabs: workspace.tabs,
    ...(workspace.restorePending === true ? { restorePending: true } : {}),
  }));
  if (!ids.has(READ_LATER)) workspaces.push({ id: READ_LATER, title: "Read Later", color: "grey", tabs: [] });
  return structuredClone({ version: 1, minimizeOthers: value.minimizeOthers, routes: value.routes,
    pinnedWorkspaceId, shortcutSlots, closedShortcutSlots, workspaces });
}

// One owner for window/tab mutations. Reads never wait for this queue.
// Browser windows are the live state; local snapshots are recovery, not instructions
// to recreate every tab on each switch.
export function createWindowWorkspaces(api) {
  let data = null;
  let committedData = null;
  let chain = Promise.resolve();
  let warning = null;
  let blockedEdit = null;
  const bindings = new Map(); // workspace id -> live window id (session only)
  const closingWindows = new Set(); // Mark synchronously, before queued captures can run.
  const overrides = new Map(); // tab id -> manually assigned URL
  const moves = new Map(); // tab id -> expected destination window
  const seeds = new Map(); // blank tabs created by us for a restore
  let timer;
  let readLaterTimer;
  let projectBounds = null;
  let recent = []; // Most recently focused first; separate from stable shortcut order.
  let fresh = false;
  let connecting = true;
  let browserReady = false;
  let pendingTasks = 0;

  // Durable reads must not depend on browser discovery or the mutation queue.
  const stateReady = (async () => {
    const stored = await api.storage.local.get(KEY);
    fresh = !stored[KEY];
    data = stored[KEY] ? validateWindowState(stored[KEY]) : createWindowState();
    committedData = structuredClone(data);
  })();
  const ready = stateReady.then(start).then(() => { browserReady = true; }).finally(() => { connecting = false; });
  void ready.catch((error) => { warning = error.message; });

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
    pendingTasks++;
    const result = chain.then(() => ready).then(() => { warning = null; return task(); }).finally(() => { pendingTasks--; });
    chain = result.catch((error) => { warning = error?.message || String(error); });
    return result;
  }
  function event(task) { void enqueue(task).catch(() => {}); }
  async function persist(next = data, extra = {}) {
    const checkpoint = structuredClone(next);
    try {
      await api.storage.local.set({ ...extra, [KEY]: checkpoint });
    } catch (error) {
      // A rejected save must not leak into snapshots or a later successful save.
      data = structuredClone(committedData);
      throw error;
    }
    data = next;
    committedData = checkpoint;
    await persistSession();
  }
  async function persistSession() {
    try {
      await api.storage.session.set({ [SESSION_KEY]: Object.fromEntries(bindings), [RECENT_KEY]: recent });
    } catch (error) {
      // Local state is already committed. Session associations can be rebuilt.
      warning = error.message;
    }
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
  async function captureAll({ requiredWorkspaceId = null } = {}) {
    let complete = true;
    for (const workspace of data.workspaces) {
      const windowId = bindings.get(workspace.id);
      if (!Number.isInteger(windowId)) continue;
      if (closingWindows.has(windowId)) {
        complete = false;
        if (workspace.id === requiredWorkspaceId) throw new Error("This workspace window is closing. Its last complete inventory is retained.");
        continue;
      }
      try {
        const window = await normalWindow(windowId);
        if (!workspace.restorePending && !closingWindows.has(windowId)) workspace.tabs = savedTabs(window.tabs || []);
        else {
          complete = false;
          if (workspace.id === requiredWorkspaceId && closingWindows.has(windowId)) throw new Error("This workspace window is closing.");
        }
      } catch (error) {
        complete = false;
        if (workspace.id === requiredWorkspaceId) throw error;
        // Only a missing window is evidence that it closed; transient read errors
        // must not turn a live workspace into a second, newly restored window.
        if (isMissingWindow(error) || /non-incognito/i.test(error.message)) unbind(workspace.id);
        else warning = error.message;
      }
    }
    if (!bindings.has(data.pinnedWorkspaceId)) data.pinnedWorkspaceId = null;
    await persist();
    return complete;
  }
  function scheduleCapture() {
    if (!data) return;
    clearTimeout(timer);
    timer = setTimeout(() => event(captureAll), 100);
  }
  async function rememberFocus(id) {
    if (recent[0] === id) return;
    recent = [id, ...recent.filter((item) => item !== id)];
    await api.storage.session.set({ [RECENT_KEY]: recent });
  }
  function bindWorkspace(workspace, window) {
    bindings.set(workspace.id, window.id);
    const remaining = [...workspace.tabs];
    for (const tab of window.tabs || []) {
      const url = tab.url || tab.pendingUrl;
      let index = remaining.findIndex((saved) => saved.url === url && saved.pinned === tab.pinned);
      if (index < 0) index = remaining.findIndex((saved) => saved.url === url);
      if (index < 0) continue;
      const [saved] = remaining.splice(index, 1);
      if (saved.routeOverride) overrides.set(tab.id, url);
      else overrides.delete(tab.id);
    }
  }
  async function normalWindows(populate = true) {
    return (await api.windows.getAll({ populate, windowTypes: ["normal"] }))
      .filter((window) => window.type === "normal" && !window.incognito);
  }
  async function start() {
    const session = await api.storage.session.get([PROJECT_BOUNDS_KEY, RECENT_KEY, SESSION_KEY]);
    projectBounds = windowBounds(session[PROJECT_BOUNDS_KEY]);
    const storedRecent = session[RECENT_KEY];
    recent = Array.isArray(storedRecent) ? [...new Set(storedRecent)].filter((id) => data.workspaces.some((w) => w.id === id)) : [];
    const windows = await normalWindows();
    const available = new Map(windows.map((window) => [window.id, window]));
    if (fresh) {
      const current = windows.find((window) => window.focused);
      if (current) {
        bindWorkspace(find("personal"), current);
        data.shortcutSlots[0] = "personal";
        available.delete(current.id);
      }
    }
    for (const workspace of data.workspaces) {
      const id = session[SESSION_KEY]?.[workspace.id];
      if (available.has(id)) { bindWorkspace(workspace, available.get(id)); available.delete(id); }
    }
    const readLater = find(READ_LATER);
    if (!bindings.has(READ_LATER) && !readLater.tabs.length) {
      const blank = [...available.values()].filter((window) => window.tabs?.length === 1
        && ["about:blank", "chrome://newtab/"].includes(window.tabs[0].url));
      if (blank.length === 1) { bindings.set(READ_LATER, blank[0].id); available.delete(blank[0].id); }
    }
    await reconnect([...available.values()]);
    const focused = windows.find((window) => window.focused);
    const current = workspaceForWindow(focused?.id);
    if (current) await rememberFocus(current.id);
    restoreShortcutSlots();
    await captureAll();
    // At browser launch, windows may still be restoring; Read Later's own window
    // must get the chance to relink before a replacement is created.
    if (bindings.has(READ_LATER)) await ensureReadLater();
    else scheduleReadLater(1000);
  }
  // Window IDs do not survive browser restarts or extension reloads, and saved
  // inventories drift from live windows. Link by page overlap, but only when the
  // workspace and window are each other's clear best match; ties stay unassigned.
  // `only` limits linking to one workspace while still ranking against all of them.
  async function reconnect(windows, { only = null, minimumPages = 1 } = {}) {
    const urls = (tabs) => tabs.map((tab) => tab.url || tab.pendingUrl).filter(isRoutableUrl);
    const unbound = windows.filter((window) => !workspaceForWindow(window.id) && urls(window.tabs || []).length >= minimumPages);
    const candidates = data.workspaces.filter((workspace) => !bindings.has(workspace.id) && urls(workspace.tabs).length)
      .flatMap((workspace) => unbound.map((window) => ({
        workspace, window, score: pageOverlap(urls(workspace.tabs), urls(window.tabs || [])),
      })));
    const clearBest = (pairs) => {
      const [first, second] = pairs.toSorted((a, b) => b.score - a.score);
      return first && first.score > (second?.score ?? 0) ? first : null;
    };
    const linked = candidates.filter((pair) => pair.score >= RECONNECT_OVERLAP
      && (!only || pair.workspace.id === only)
      && clearBest(candidates.filter((other) => other.workspace === pair.workspace)) === pair
      && clearBest(candidates.filter((other) => other.window === pair.window)) === pair);
    if (!linked.length) return false;
    // Capturing replaces saved inventories with live tabs; keep the old ones first.
    if (linked.some((pair) => pair.score < 1)) await api.storage.local.set({ [BEFORE_RECONNECT_KEY]: data });
    for (const { workspace, window } of linked) {
      // Linking a partial restore does not mean its saved inventory is complete.
      bindWorkspace(workspace, window);
    }
    return true;
  }
  function restoreShortcutSlots() {
    const previousSlots = data.shortcutSlots;
    data.shortcutSlots = previousSlots.map((id, index) => bindings.has(id) ? id
      : bindings.has(data.closedShortcutSlots[index]) ? data.closedShortcutSlots[index] : null);
    // A workspace that did not reconnect keeps a claim on its number, so attaching
    // its window later restores the shortcut.
    data.closedShortcutSlots = data.closedShortcutSlots.map((id, index) => {
      if (data.shortcutSlots[index] !== null) return data.shortcutSlots[index] === id ? null : id;
      return previousSlots[index] ?? id;
    }).map((id, index, slots) => slots.indexOf(id) === index ? id : null);
  }
  async function ensureLive(workspace) {
    const id = bindings.get(workspace.id);
    if (Number.isInteger(id)) {
      try {
        await normalWindow(id);
        if (workspace.restorePending) await finishRestore(workspace, id);
        return id;
      } catch (error) {
        if (!isMissingWindow(error)) throw error;
        unbind(workspace.id);
      }
    }
    // Its window may still be open but unlinked (browser restoring, extension
    // reloaded). Reopening every saved tab in a new window would duplicate it.
    if (await reconnect(await normalWindows(), { only: workspace.id })) {
      restoreShortcutSlots();
      const windowId = bindings.get(workspace.id);
      if (workspace.restorePending) await finishRestore(workspace, windowId);
      await captureAll();
      return windowId;
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
    // Read the outgoing window before creating/restoring the destination can
    // change focus. Geometry never comes from the pinned base or unrelated windows.
    let bounds;
    try { if (preserveProject) bounds = await replacementBounds(id); }
    catch (error) { warning = error.message; }
    const windowId = allowResume ? await ensureLive(workspace) : bindings.get(id);
    let window = await normalWindow(windowId);
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
        if (!isMissingWindow(error)) throw error;
        unbind(route.contextId);
        await persist();
        return;
      }
      const source = await normalWindow(tab.windowId);
      const follow = !cleanup && (addressBar || route.activate) && tab.active && source.focused;
      await moveTab(tabId, route.contextId, follow, false);
    }
  }
  async function ensureReadLater() {
    if (blockedEdit || bindings.has(READ_LATER)) return;
    // Do not fight browser shutdown or create a window in an otherwise closed browser.
    if (!(await normalWindows(false)).length) return;
    const id = await ensureLive(find(READ_LATER));
    await edit(() => api.windows.update(id, { state: "minimized" }));
    await captureAll();
  }
  function scheduleReadLater(delay = 300) {
    clearTimeout(readLaterTimer);
    // Let a batch of closing windows settle before deciding whether this is a
    // manual Read Later close or the browser exiting, and let restored windows
    // arrive and relink before deciding Read Later needs a new window.
    readLaterTimer = setTimeout(() => event(async () => {
      // Two pages minimum, so a single torn-off tab never claims a workspace.
      if (await reconnect(await normalWindows(), { minimumPages: 2 })) {
        restoreShortcutSlots();
        await captureAll();
      }
      await ensureReadLater();
    }), delay);
  }
  async function putAway(id) {
    const workspace = find(id);
    if (id === READ_LATER) throw new Error("Read Later is built in and cannot be put away.");
    if (blockedEdit) throw new Error("A browser edit is still pending. Try again once it completes.");
    await captureAll({ requiredWorkspaceId: id }); // A fresh, durable source inventory is mandatory.
    const windowId = bindings.get(id);
    if (!Number.isInteger(windowId)) { clearShortcut(id); await persist(); return; }
    await edit(() => api.windows.remove(windowId));
    try {
      await normalWindow(windowId);
    } catch (error) {
      if (!isMissingWindow(error)) throw error;
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
    await captureAll({ requiredWorkspaceId: source.id });
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
        if (!isMissingWindow(error)) throw error;
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
    await persist(validateWindowState(next));
    recent = recent.filter((id) => id !== source.id);
    seeds.delete(source.id);
    await persistSession();
    if (!live && message.tabs === "move" && bindings.has(destination.id)) {
      await finishRestore(find(destination.id), bindings.get(destination.id));
      await captureAll();
    }
    if (live) await focus(destination.id, { allowResume: false });
  }
  function overview(windowId) {
    const data = committedData;
    const current = Number.isInteger(windowId) ? data.workspaces.find((workspace) => bindings.get(workspace.id) === windowId) : null;
    return {
      managed: Boolean(current), currentWorkspaceId: current?.id || null,
      browserWarning: warning, connecting, browserReady, minimizeOthers: data.minimizeOthers, recentWorkspaceIds: [...recent], pinnedWorkspaceId: data.pinnedWorkspaceId,
      shortcutSlots: [...data.shortcutSlots],
      workspaces: data.workspaces.map((workspace) => {
        const { id, title, color } = workspace;
        const builtin = id === READ_LATER;
        const slot = data.shortcutSlots.indexOf(id);
        return { id, title, color, builtin, shortcut: builtin ? 0 : slot < 0 ? null : slot + 1,
          windowId: bindings.get(id) ?? null, restoring: workspace.restorePending === true,
          pinned: id === data.pinnedWorkspaceId, tabCount: workspace.tabs.length };
      }),
      routes: data.routes.map((route) => ({ ...route, active: bindings.has(route.contextId) })), hasManagedWindow: bindings.size > 0,
    };
  }
  async function handle(message) {
    await stateReady;
    if (message.type === "snapshot") return overview(message.windowId);
    if (message.type === "exportBackup") {
      let snapshot = { fresh: false, reason: "Browser work is pending; using the last successfully saved inventory." };
      if (message.configurationOnly) snapshot = { fresh: true, reason: "Saved configuration only; no page inventory included." };
      else if (browserReady && !blockedEdit && pendingTasks === 0) {
        let timeout;
        try {
          const capture = enqueue(captureAll).then(
            (complete) => ({ fresh: complete, reason: complete ? null : "Some windows could not be captured; their previous inventories are retained." }),
            (error) => ({ fresh: false, reason: `Snapshot failed: ${error.message}. Using the last successfully saved inventory.` }),
          );
          snapshot = await Promise.race([capture, new Promise((resolve) => {
            timeout = setTimeout(() => resolve({ fresh: false, reason: "Snapshot timed out; using the last successfully saved inventory." }), 2000);
          })]);
        } finally { clearTimeout(timeout); }
      }
      const state = structuredClone(committedData);
      if (message.configurationOnly) state.workspaces = state.workspaces.map(({ id, title, color }) => ({ id, title, color, tabs: [] }));
      return { format: FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(), snapshot, state };
    }
    const restoreKey = RESTORE_KEYS[message.type];
    if (typeof restoreKey === "string") {
      const stored = await api.storage.local.get(restoreKey);
      if (!stored[restoreKey]) throw new Error("No saved restore point exists for this action yet.");
      return { format: FORMAT, formatVersion: 1, state: stored[restoreKey] };
    }
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
          const window = await normalWindow(message.windowId);
          if (closingWindows.has(window.id)) throw new Error("This window is closing.");
          if (workspaceForWindow(window.id) || bindings.has(message.workspaceId)) throw new Error("The window or workspace is already assigned.");
          const next = structuredClone(data);
          const workspace = next.workspaces.find((item) => item.id === message.workspaceId);
          workspace.tabs = savedTabs(window.tabs || []);
          delete workspace.restorePending;
          // Reattaching after a failed reconnect restores the number it held.
          const remembered = next.closedShortcutSlots.indexOf(workspace.id);
          if (remembered >= 0 && next.shortcutSlots[remembered] === null && !next.shortcutSlots.includes(workspace.id)) {
            next.shortcutSlots[remembered] = workspace.id;
            next.closedShortcutSlots[remembered] = null;
          }
          await persist(next, { rauiriBeforeWorkspaceAttach: committedData });
          bindWorkspace(find(message.workspaceId), window);
          await persistSession();
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
        case "saveWorkspaceDetails": {
          if (!Array.isArray(message.workspaces) || message.workspaces.length !== data.workspaces.length) throw new Error("The workspace list changed. Refresh Settings before saving.");
          const seen = new Set();
          const updated = message.workspaces.map((details) => {
            const workspace = find(details?.id);
            if (workspace.id === READ_LATER && details.title !== "Read Later") throw new Error("Read Later’s name is fixed.");
            if (seen.has(details.id) || typeof details.title !== "string" || !details.title.trim() || !WORKSPACE_COLORS.includes(details.color)) throw new Error("Invalid workspace details.");
            seen.add(details.id);
            return { ...workspace, title: details.title.trim(), color: details.color };
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
          if (message.backup?.format !== FORMAT || message.backup.formatVersion !== 1) throw new Error("Choose a Rauiri window-workspace backup.");
          if ([...bindings.keys()].some((id) => id !== READ_LATER)) throw new Error("Put away other workspaces before importing. Read Later can stay open. Export a backup first.");
          if (blockedEdit) throw new Error("A browser edit is still pending. Try again once it completes.");
          const next = validateWindowState(message.backup.state);
          next.shortcutSlots.fill(null); // Imported workspaces are put away until explicitly resumed.
          next.closedShortcutSlots.fill(null);
          await captureAll({ requiredWorkspaceId: bindings.has(READ_LATER) ? READ_LATER : null });
          if (bindings.has(READ_LATER)) {
            const currentTabs = find(READ_LATER).tabs;
            const currentUrls = new Set(currentTabs.map((tab) => tab.url));
            const reading = next.workspaces.find((workspace) => workspace.id === READ_LATER);
            reading.tabs = [...currentTabs, ...reading.tabs.filter((tab) => !currentUrls.has(tab.url))];
            reading.restorePending = true;
          }
          if (next.pinnedWorkspaceId !== READ_LATER || !bindings.has(READ_LATER)) next.pinnedWorkspaceId = null;
          await persist(next, { rauiriBeforeWorkspaceImport: committedData });
          recent = recent.filter((id) => data.workspaces.some((workspace) => workspace.id === id));
          await persistSession();
          if (bindings.has(READ_LATER)) {
            await finishRestore(find(READ_LATER), bindings.get(READ_LATER));
            await captureAll();
          } else scheduleReadLater();
          return { workspaces: data.workspaces.length, routes: data.routes.length, tabs: data.workspaces.reduce((n, w) => n + w.tabs.length, 0) };
        }
        default: throw new Error("Unknown Rauiri action.");
      }
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
    if (info.isWindowClosing) closingWindows.add(info.windowId);
    overrides.delete(id);
    moves.delete(id);
    if (!info.isWindowClosing) scheduleCapture();
  });
  api.windows.onRemoved.addListener((windowId) => {
    closingWindows.add(windowId);
    event(async () => {
      const workspace = workspaceForWindow(windowId);
      if (workspace) { unbind(workspace.id); await persist(); }
      closingWindows.delete(windowId);
      scheduleReadLater();
    });
  });
  api.windows.onCreated.addListener((window) => {
    if (data && window.type === "normal" && !window.incognito) scheduleReadLater(1000);
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
  // Register to wake the MV3 worker at browser launch; initialization above
  // already reconnects its windows, so no second startup task is needed.
  api.runtime.onStartup.addListener(() => {});

  return { ready, handle };
}
