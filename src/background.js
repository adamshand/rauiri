import {
  READ_LATER_ID,
  READ_LATER_TITLE,
  INACTIVE_ID,
  INACTIVE_TITLE,
  TAB_GROUP_COLORS,
  assignRecordToGroup,
  attentionForNewTab,
  cleanHostnameInput,
  contextForNewTab,
  createBackup,
  createInitialState,
  findRecoverableRecords,
  groupKeyForRecord,
  isValidRouteHostname,
  isRoutableUrl,
  makeRecord,
  migrateState,
  normalizeHostname,
  routeForUrl,
  shouldArchiveTab,
  shouldDiscardShelvedTab,
  stateFromBackup,
  updateYouTubeUrl,
} from "./domain.js";
import { createWindowWorkspaces } from "./window-workspaces.js";

const windowWorkspaces = createWindowWorkspaces(chrome);
const STATE_KEY = "rauiriState";
const SESSION_WINDOW_KEY = "rauiriManagedWindowId";
const SWEEP_ALARM = "rauiri-hourly-sweep";
const SHELF_TITLES = new Map([[READ_LATER_ID, READ_LATER_TITLE], [INACTIVE_ID, INACTIVE_TITLE]]);

let state = createInitialState();
let tabRecords = new Map();
let groupIds = new Map();
const mutedTabs = new Set();
const observedGroups = new Map();
const detachedRecords = new Map();
let operation = Promise.resolve();
let pendingBrowserEdit = null;
let browserWarning = null;

// UI reads depend only on durable state, never on tab-strip presentation.
const ready = loadState();
runEvent(initializeBrowser);
void ready.then(() => {
  if (windowWorkspaces.enabled) return windowWorkspaces.start();
}).catch((error) => { browserWarning = error.message; });

function run(task) {
  const result = operation.then(() => ready).then(() => task());
  operation = result.catch(() => {});
  return result;
}

function runEvent(task) {
  void run(() => { if (!windowWorkspaces.enabled) return task(); }).catch((error) => {
    browserWarning = error?.message || String(error);
    console.warn("Rauiri browser event failed:", error);
  });
}

function isTabEditLocked(error) {
  return /cannot be edited right now/i.test(error?.message || String(error));
}

function isMissingGroup(error) {
  return /no group with id|group not found/i.test(error?.message || String(error));
}

async function browserEditAttempt(task, timeoutMs = 1000) {
  if (pendingBrowserEdit) throw new Error("A browser edit is still pending. Settings and backups remain available.");
  let timeout;
  let timedOut = false;
  const request = Promise.resolve().then(task);
  pendingBrowserEdit = request;
  const settled = () => {
    pendingBrowserEdit = null;
    if (timedOut) runEvent(async () => {
      await reconcileManagedWindow();
      browserWarning = null;
    });
  };
  void request.then(settled, settled);
  try {
    return await Promise.race([
      request,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error("Browser edit timed out; waiting for its outcome before more edits."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function retryBrowserEdit(task, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await browserEditAttempt(task);
    } catch (error) {
      if (!isTabEditLocked(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }
}

async function loadState() {
  await windowWorkspaces.ready;
  const stored = await chrome.storage.local.get(STATE_KEY);
  state = migrateState(stored[STATE_KEY]);
  state.managedWindowId = null;
}

async function initializeBrowser() {
  await ensureSweepAlarm();
  const session = await chrome.storage.session.get(SESSION_WINDOW_KEY);
  const runtimeWindowId = session[SESSION_WINDOW_KEY];
  if (Number.isInteger(runtimeWindowId) && await windowExists(runtimeWindowId)) {
    state.managedWindowId = runtimeWindowId;
  } else {
    await discoverManagedWindow();
  }

  await persist();
  if (state.managedWindowId !== null) await reconcileManagedWindow();
}

async function persist() {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  if (state.managedWindowId === null) {
    await chrome.storage.session.remove(SESSION_WINDOW_KEY);
  } else {
    await chrome.storage.session.set({ [SESSION_WINDOW_KEY]: state.managedWindowId });
  }
}

async function ensureSweepAlarm() {
  const alarm = await chrome.alarms.get(SWEEP_ALARM);
  if (!alarm) {
    await chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 60 });
  }
}

async function windowExists(windowId) {
  try {
    const window = await chrome.windows.get(windowId);
    return window.type === "normal" && !window.incognito;
  } catch {
    return false;
  }
}

async function discoverManagedWindow() {
  const windows = (await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }))
    .filter((window) => !window.incognito);
  if (!windows.length) return null;

  const knownUrls = new Set(Object.values(state.records).map((record) => record.url).filter(Boolean));
  const knownTitles = new Set([
    ...state.contexts.map((context) => context.title),
    ...SHELF_TITLES.values(),
  ]);

  const scored = [];
  for (const window of windows) {
    const groups = await chrome.tabGroups.query({ windowId: window.id });
    const groupScore = groups.filter((group) => knownTitles.has(group.title)).length * 100;
    const tabScore = (window.tabs || []).filter((tab) => knownUrls.has(tab.url || tab.pendingUrl)).length;
    scored.push({ windowId: window.id, score: groupScore + tabScore });
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored[0]?.score > 0 && scored[0].score > (scored[1]?.score || 0)) {
    state.managedWindowId = scored[0].windowId;
    return scored[0].windowId;
  }
  return null;
}

function contextById(contextId) {
  return state.contexts.find((context) => context.id === contextId) || null;
}

function contextKeyForGroup(group) {
  const associated = [...groupIds].find(([, id]) => id === group.id)?.[0];
  if (associated) return associated;
  for (const [id, title] of SHELF_TITLES) if (group.title === title) return id;
  return state.contexts.find((context) => context.title === group.title)?.id || null;
}

async function refreshGroupIds() {
  if (state.managedWindowId === null) { groupIds.clear(); return []; }
  const groups = await chrome.tabGroups.query({ windowId: state.managedWindowId });
  const next = new Map();
  for (const group of groups) {
    const key = contextKeyForGroup(group);
    if (key && !next.has(key)) next.set(key, group.id);
    observedGroups.set(group.id, group.collapsed);
  }
  groupIds = next;
  return groups;
}

async function reconcileManagedWindow() {
  if (state.managedWindowId === null || !await windowExists(state.managedWindowId)) return;

  const groups = await refreshGroupIds();
  const tabs = await chrome.tabs.query({ windowId: state.managedWindowId });
  const groupKeys = new Map(groups.map((group) => [group.id, contextKeyForGroup(group)]));
  const unmatched = new Map(Object.values(state.records).map((record) => [record.id, record]));
  tabRecords = new Map();

  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl || "";
    const groupKey = groupKeys.get(tab.groupId);
    const attention = groupKey === READ_LATER_ID ? "readLater" : groupKey === INACTIVE_ID ? "inactive" : "current";
    const groupContext = groupKey && !SHELF_TITLES.has(groupKey) ? groupKey : null;
    const candidates = [...unmatched.values()].filter((record) => {
      if (record.url !== url) return false;
      if (groupContext && record.contextId !== groupContext) return false;
      if (attention !== "current" && record.attention !== attention) return false;
      return true;
    });

    let record = candidates[0] || null;
    if (!record) {
      const contextId = groupContext || state.activeContextId;
      record = makeRecord({
        tab,
        contextId,
        attention,
        pinned: tab.pinned,
      });
      state.records[record.id] = record;
    }

    unmatched.delete(record.id);
    record.url = url;
    record.title = tab.title || record.title;
    record.lastSeenAt = Date.now();
    if (groupContext) record.contextId = groupContext;
    if (attention !== "current") record.attention = attention;
    record.pinned = tab.pinned;
    tabRecords.set(tab.id, record.id);
  }

  await enforcePresentation({ activateTarget: false });
  await orderGroups();
  await persist();
}

function recordForTab(tabId) {
  const recordId = tabRecords.get(tabId);
  return recordId ? state.records[recordId] || null : null;
}

async function ensureRecord(tab) {
  const existing = recordForTab(tab.id);
  if (existing) return existing;

  const openerRecord = Number.isInteger(tab.openerTabId) ? recordForTab(tab.openerTabId) : null;
  const route = routeForUrl(state.routes, tab.pendingUrl || tab.url);
  const contextId = contextForNewTab({
    openerRecord,
    activeContextId: state.activeContextId,
    route,
  });
  const attention = attentionForNewTab(openerRecord);
  const record = makeRecord({
    tab,
    contextId,
    attention,
    originContextId: openerRecord?.originContextId || contextId,
    pinned: tab.pinned,
  });
  state.records[record.id] = record;
  tabRecords.set(tab.id, record.id);
  return record;
}

async function syncRecordToGroup(tab, groupKey) {
  if (!SHELF_TITLES.has(groupKey) && !contextById(groupKey)) return false;
  const record = await ensureRecord(tab);
  const url = tab.url || tab.pendingUrl;
  return assignRecordToGroup(record, {
    groupKey,
    route: routeForUrl(state.routes, url),
    url,
  });
}

async function syncGroupMembership(group) {
  const groupKey = contextKeyForGroup(group);
  if (!groupKey) return false;

  let changed = false;
  const tabs = await chrome.tabs.query({ windowId: group.windowId, groupId: group.id });
  for (const tab of tabs) {
    if (mutedTabs.has(tab.id)) continue;
    changed = await syncRecordToGroup(tab, groupKey) || changed;
  }
  return changed;
}

async function muteTab(tabId, task) {
  mutedTabs.add(tabId);
  try {
    return await task();
  } finally {
    setTimeout(() => mutedTabs.delete(tabId), 1000);
  }
}

async function ensureGroup(key, tabIds) {
  const ids = [...new Set(tabIds)].filter(Number.isInteger);
  if (!ids.length) return groupIds.get(key) ?? null;

  let groupId = groupIds.get(key);
  let created = false;
  if (Number.isInteger(groupId)) {
    try {
      await retryBrowserEdit(() => chrome.tabs.group({ groupId, tabIds: ids }));
    } catch (error) {
      if (!isMissingGroup(error)) throw error;
      groupId = null;
    }
  }
  if (!Number.isInteger(groupId)) {
    groupId = await retryBrowserEdit(() => chrome.tabs.group({ tabIds: ids }));
    groupIds.set(key, groupId);
    created = true;
  }

  if (created) {
    const context = contextById(key);
    await retryBrowserEdit(() => chrome.tabGroups.update(groupId, {
      title: SHELF_TITLES.get(key) || context?.title || "Context",
      color: SHELF_TITLES.has(key) ? "grey" : context?.color || "grey",
    }));
    await orderGroups();
  }
  return groupId;
}

async function setPinned(tab, pinned) {
  if (tab.pinned === pinned) return tab;
  return muteTab(tab.id, () => retryBrowserEdit(() => chrome.tabs.update(tab.id, { pinned })));
}

async function ungroupTab(tab) {
  if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  await muteTab(tab.id, () => retryBrowserEdit(() => chrome.tabs.ungroup([tab.id])));
}

async function trySetGroupCollapsed(groupId, collapsed) {
  if (observedGroups.get(groupId) === collapsed) return;
  observedGroups.set(groupId, collapsed);
  try {
    await retryBrowserEdit(() => chrome.tabGroups.update(groupId, { collapsed }));
  } catch {
    // Re-observe after uncertain outcomes rather than replaying a stale command.
    observedGroups.delete(groupId);
  }
}

async function presentTab(tab, record) {
  if (record.pinned) {
    await ungroupTab(tab);
    await setPinned(tab, true);
    return;
  }

  tab = await setPinned(tab, false);
  const key = groupKeyForRecord(record);
  let groupId = groupIds.get(key);
  if (!Number.isInteger(groupId) || tab.groupId !== groupId) {
    groupId = await ensureGroup(key, [tab.id]);
  }

  if (Number.isInteger(groupId) && key !== state.activeContextId && !tab.active) {
    await trySetGroupCollapsed(groupId, true);
  }
}

function mostRecentTab(tabs, predicate = () => true) {
  return tabs.filter(predicate).reduce((latest, tab) => (
    !latest || (tab.lastAccessed || 0) > (latest.lastAccessed || 0) ? tab : latest
  ), null);
}

async function orderGroups() {
  const desired = [...state.contexts.map((context) => context.id), ...SHELF_TITLES.keys()];
  for (const key of desired) {
    const groupId = groupIds.get(key);
    if (!Number.isInteger(groupId)) continue;
    try { await retryBrowserEdit(() => chrome.tabGroups.move(groupId, { index: -1 })); } catch { /* stale group */ }
  }
}

async function createTabInContext(contextId) {
  const tab = await chrome.tabs.create({ windowId: state.managedWindowId, active: true });
  const record = makeRecord({ tab, contextId });
  state.records[record.id] = record;
  tabRecords.set(tab.id, record.id);
  await presentTab(tab, record);
  return tab;
}

async function enforcePresentation({ activateTarget = true, preferredTabId = null } = {}) {
  if (state.managedWindowId === null) return;
  await refreshGroupIds();
  let tabs = await chrome.tabs.query({ windowId: state.managedWindowId });

  for (let tab of tabs) {
    const record = await ensureRecord(tab);
    await presentTab(tab, record);
  }

  tabs = await chrome.tabs.query({ windowId: state.managedWindowId });
  if (activateTarget) {
    let target = preferredTabId ? tabs.find((tab) => tab.id === preferredTabId) : null;
    if (!target) {
      target = mostRecentTab(tabs, (tab) => {
        const record = recordForTab(tab.id);
        return record?.attention === "current"
          && !record.pinned
          && record.contextId === state.activeContextId;
      });
    }

    if (!target) {
      target = await createTabInContext(state.activeContextId);
    } else if (!target.active) {
      await retryBrowserEdit(() => chrome.tabs.update(target.id, { active: true }));
    }
  }

  const groups = await refreshGroupIds();
  for (const group of groups) {
    const key = contextKeyForGroup(group);
    if (!key) continue;
    const collapsed = key !== state.activeContextId;
    if (group.collapsed === collapsed) continue;
    await trySetGroupCollapsed(group.id, collapsed);
  }
}

async function adoptWindow(windowId) {
  const window = await chrome.windows.get(windowId, { populate: true });
  if (window.type !== "normal" || window.incognito) throw new Error("Choose a normal browser window.");

  const initialContextId = state.contexts.find((context) => context.id === "personal")?.id || state.contexts[0].id;
  state = {
    ...createInitialState(),
    contexts: state.contexts,
    routes: state.routes,
    settings: state.settings,
    records: { ...state.records },
    workspaces: state.workspaces,
    activeContextId: initialContextId,
    managedWindowId: windowId,
  };
  tabRecords = new Map();
  groupIds = new Map();

  for (const tab of window.tabs || []) {
    const record = makeRecord({
      tab,
      contextId: initialContextId,
      pinned: tab.pinned,
    });
    state.records[record.id] = record;
    tabRecords.set(tab.id, record.id);
  }

  // Save the adoption before attempting fallible browser edits.
  await persist();
  const unpinned = (window.tabs || []).filter((tab) => !tab.pinned).map((tab) => tab.id);
  if (unpinned.length) await ensureGroup(initialContextId, unpinned);
  await enforcePresentation({ activateTarget: false });
  await persist();
}

async function switchContext(contextId, preferredTabId = null) {
  if (!contextById(contextId)) throw new Error("Unknown context.");
  state.activeContextId = contextId;
  await enforcePresentation({ activateTarget: true, preferredTabId });
  await persist();
}

async function activateMostRecentTabInGroup(group) {
  const tabs = await chrome.tabs.query({ windowId: group.windowId, groupId: group.id });
  if (tabs.some((tab) => tab.active)) return;
  const target = mostRecentTab(tabs);
  if (target) await retryBrowserEdit(() => chrome.tabs.update(target.id, { active: true }));
}

async function enforceAccordion(updatedGroup) {
  // Group events are queued while Rauiri is changing several groups. Re-read the
  // group so a stale "expanded" event cannot switch us back to an old context.
  let expandedGroup;
  try {
    expandedGroup = await chrome.tabGroups.get(updatedGroup.id);
  } catch {
    return;
  }

  if (expandedGroup.windowId !== state.managedWindowId || expandedGroup.collapsed) return;
  const key = contextKeyForGroup(expandedGroup);
  if (!key) return;

  const membershipChanged = await syncGroupMembership(expandedGroup);
  const contextChanged = !SHELF_TITLES.has(key) && key !== state.activeContextId;
  if (contextChanged) state.activeContextId = key;

  // Expanding a group label does not necessarily activate one of its tabs.
  // Chromium refuses to collapse whichever group still contains the active tab,
  // so focus the selected group before closing the others.
  await activateMostRecentTabInGroup(expandedGroup);
  if (membershipChanged || contextChanged) await persist();

  const groups = await chrome.tabGroups.query({ windowId: state.managedWindowId });
  for (const group of groups) {
    if (group.id === expandedGroup.id || group.collapsed || !contextKeyForGroup(group)) continue;
    await trySetGroupCollapsed(group.id, true);
  }
}

async function applyRouting(tab, record) {
  if (record.attention !== "current") return;
  const hostname = normalizeHostname(tab.url || tab.pendingUrl);
  if (record.routeSuppressedHostname && record.routeSuppressedHostname !== hostname) {
    record.routeSuppressedHostname = null;
  }

  const route = routeForUrl(state.routes, tab.url || tab.pendingUrl);
  if (!route || record.routeSuppressedHostname === hostname) return;

  const contextChanged = route.contextId !== record.contextId;
  record.contextId = route.contextId;
  record.originContextId = route.contextId;
  // Classification is not a focus command. Do not select a different tab.
  if (contextChanged) await presentTab(tab, record);
}

async function managedTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Choose a tab.");
  const tab = await chrome.tabs.get(tabId);
  if (state.managedWindowId === null || tab.windowId !== state.managedWindowId || tab.incognito) {
    throw new Error("This tab is not in Rauiri’s managed window.");
  }
  return tab;
}

async function moveTabToContext(tabId, contextId) {
  if (!contextById(contextId)) throw new Error("Choose a valid context.");
  let tab = await managedTab(tabId);
  const record = await ensureRecord(tab);
  const route = routeForUrl(state.routes, tab.url);
  if (route && route.contextId !== contextId) {
    record.routeSuppressedHostname = normalizeHostname(tab.url);
  }

  // Filing the active tab into another context should not take the user there.
  // Activate a local fallback before moving the tab so the current context stays put.
  if (tab.active && contextId !== state.activeContextId) {
    await activateContextFallback(state.activeContextId, tabId);
    tab = await chrome.tabs.get(tabId);
  }

  record.contextId = contextId;
  record.originContextId = contextId;
  record.attention = "current";
  await presentTab(tab, record);
  await persist();
}

async function captureYouTubeTimestamp(tab) {
  const hostname = normalizeHostname(tab.url);
  if (hostname !== "youtube.com" && hostname !== "m.youtube.com") return tab.url;

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const video = document.querySelector("video");
        const seconds = video?.currentTime || 0;
        video?.pause();
        return seconds;
      },
    });
    const nextUrl = updateYouTubeUrl(tab.url, Number(result));
    if (nextUrl && nextUrl !== tab.url) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (url) => history.replaceState(history.state, "", url),
        args: [nextUrl],
      });
      return nextUrl;
    }
  } catch {
    // Restricted, unloaded, or not-yet-ready pages simply retain their URL.
  }
  return tab.url;
}

async function fallbackTabForContext(contextId, excludedTabId) {
  const tabs = await chrome.tabs.query({ windowId: state.managedWindowId });
  return mostRecentTab(tabs, (tab) => {
    if (tab.id === excludedTabId) return false;
    const candidate = recordForTab(tab.id);
    return candidate?.attention === "current"
      && !candidate.pinned
      && candidate.contextId === contextId;
  });
}

async function activateContextFallback(contextId, excludedTabId) {
  const fallback = await fallbackTabForContext(contextId, excludedTabId);
  if (fallback) await retryBrowserEdit(() => chrome.tabs.update(fallback.id, { active: true }));
  else await createTabInContext(contextId);
}

async function discardTab(tabId) {
  try {
    await chrome.tabs.discard(tabId);
  } catch {
    // A tab can become active or otherwise undiscardable while an operation is in flight.
  }
}

async function moveTabToShelf(tabId, attention = "readLater") {
  let tab = await managedTab(tabId);
  const record = await ensureRecord(tab);
  // A long sweep's original snapshot may be stale by the time we reach this tab.
  if (attention === "inactive" && !shouldArchiveTab({
    tab, record, route: routeForUrl(state.routes, tab.url), now: Date.now(),
    archiveAfterHours: state.settings.archiveAfterHours,
  })) return;
  const wasActive = tab.active;
  record.originContextId = record.contextId;
  record.attention = attention;
  record.pinned = false;
  record.routeSuppressedHostname = null;
  record.url = await captureYouTubeTimestamp(tab);

  if (wasActive) await activateContextFallback(record.contextId, tabId);

  tab = await chrome.tabs.get(tabId);
  await presentTab(tab, record);
  await discardTab(tabId);
  await persist();
}

async function restoreReadLaterTab(tabId) {
  const tab = await managedTab(tabId);
  const record = await ensureRecord(tab);
  record.attention = "current";
  record.contextId = contextById(record.originContextId) ? record.originContextId : state.activeContextId;
  const route = routeForUrl(state.routes, tab.url);
  if (route) record.contextId = route.contextId;
  await presentTab(tab, record);
  await persist();
}

async function runSweep() {
  if (state.managedWindowId === null || !await windowExists(state.managedWindowId)) return;
  const tabs = await chrome.tabs.query({ windowId: state.managedWindowId });
  const now = Date.now();

  for (const tab of tabs) {
    const record = await ensureRecord(tab);
    const route = routeForUrl(state.routes, tab.url);
    if (shouldArchiveTab({
      tab,
      record,
      route,
      now,
      archiveAfterHours: state.settings.archiveAfterHours,
    })) {
      await moveTabToShelf(tab.id, "inactive");
      continue;
    }

    if (shouldDiscardShelvedTab({
      tab,
      record,
      now,
      discardAfterHours: state.settings.discardReadLaterAfterHours,
    })) {
      record.url = await captureYouTubeTimestamp(tab);
      await discardTab(tab.id);
    }
  }
  await persist();
}

function configurationSnapshot() {
  return {
    contexts: state.contexts,
    routes: state.routes,
    settings: state.settings,
    workspaces: state.workspaces,
    browserWarning,
    managedWindowId: state.managedWindowId,
    hasManagedWindow: state.managedWindowId !== null,
  };
}

async function currentSnapshot(windowId, tabId = null) {
  const managed = state.managedWindowId === windowId;
  let currentTab = null;
  let currentRecord = null;

  if (managed) {
    if (Number.isInteger(tabId)) {
      try { currentTab = await chrome.tabs.get(tabId); } catch { /* no-op */ }
    }
    if (!currentTab) {
      [currentTab] = await chrome.tabs.query({ windowId, active: true });
    }
    if (currentTab) currentRecord = recordForTab(currentTab.id);
  }

  return {
    managed,
    hasManagedWindow: state.managedWindowId !== null,
    managedWindowId: state.managedWindowId,
    activeContextId: state.activeContextId,
    contexts: state.contexts,
    routes: state.routes,
    settings: state.settings,
    workspaces: state.workspaces,
    currentTab: currentTab ? {
      id: currentTab.id,
      title: currentTab.title,
      url: currentTab.url,
    } : null,
    currentRecord,
    browserWarning,
  };
}

async function recoverableRecords() {
  return findRecoverableRecords({
    records: state.records,
    openTabs: await chrome.tabs.query({}),
    tabRecordEntries: [...tabRecords.entries()],
  });
}

function backupSnapshot(configurationOnly = false) {
  const source = configurationOnly ? { ...state, records: {}, workspaces: [] } : state;
  return createBackup(source, { extensionVersion: chrome.runtime.getManifest().version });
}

async function importBackup(backup) {
  const managedWindowId = state.managedWindowId !== null && await windowExists(state.managedWindowId)
    ? state.managedWindowId
    : null;
  const imported = stateFromBackup(backup, { managedWindowId });
  // A single storage write retains the previous state and commits the import.
  // Browser presentation is deliberately not part of this transaction.
  await chrome.storage.local.set({
    rauiriBeforeImport: backupSnapshot(),
    [STATE_KEY]: imported,
  });
  state = imported;
  tabRecords = new Map();
  groupIds = new Map();
  if (managedWindowId !== null) runEvent(reconcileManagedWindow);

  return {
    contexts: state.contexts.length,
    routes: state.routes.length,
    records: Object.keys(state.records).length,
  };
}

async function recoverySnapshot() {
  return (await recoverableRecords()).map((record) => ({
    id: record.id,
    title: record.title,
    url: record.url,
    contextId: record.contextId,
    contextTitle: contextById(record.contextId)?.title || "Unknown context",
    attention: record.attention,
    lastSeenAt: record.lastSeenAt,
  }));
}

async function reopenRecords(recordIds, fallbackWindowId) {
  const requestedIds = [...new Set(Array.isArray(recordIds) ? recordIds : [])];
  if (!requestedIds.length) throw new Error("Select at least one saved tab.");

  const recoverableIds = new Set((await recoverableRecords()).map((record) => record.id));
  let targetWindowId = state.managedWindowId;
  if (targetWindowId === null || !await windowExists(targetWindowId)) {
    targetWindowId = await windowExists(fallbackWindowId) ? fallbackWindowId : null;
  }

  let reopened = 0;
  for (const recordId of requestedIds) {
    if (!recoverableIds.has(recordId)) continue;
    const record = state.records[recordId];

    const createProperties = { url: record.url, active: false };
    if (targetWindowId !== null) createProperties.windowId = targetWindowId;
    const tab = await chrome.tabs.create(createProperties);
    tabRecords.set(tab.id, record.id);
    record.lastSeenAt = Date.now();
    if (tab.windowId === state.managedWindowId) await presentTab(tab, record);
    reopened += 1;
  }

  await persist();
  return { reopened };
}

async function saveWorkspace({ id, title, contextId }) {
  if (!contextById(contextId)) throw new Error("Choose a bucket for this workspace.");
  if (typeof title !== "string" || !title.trim()) throw new Error("Name the workspace.");
  if (id && !state.workspaces.some((workspace) => workspace.id === id)) throw new Error("Unknown workspace.");
  if (state.managedWindowId === null) throw new Error("Manage a window before saving selected tabs.");
  const tabs = await chrome.tabs.query({ windowId: state.managedWindowId, highlighted: true });
  const pages = [...new Map(tabs.filter((tab) => !tab.incognito && isRoutableUrl(tab.url))
    .map((tab) => [tab.url, { url: tab.url, title: tab.title || tab.url }])).values()];
  if (!pages.length) throw new Error("Select at least one web page in the managed window first.");
  const workspace = { id: id || crypto.randomUUID(), title: title.trim(), contextId, pages };
  state.workspaces = [...state.workspaces.filter((candidate) => candidate.id !== workspace.id), workspace];
  await persist();
  return { saved: pages.length };
}

async function openWorkspace(workspaceId) {
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new Error("Unknown workspace.");
  if (state.managedWindowId === null || !await windowExists(state.managedWindowId)) {
    throw new Error("Manage a window before opening a workspace.");
  }
  const openTabs = await chrome.tabs.query({ windowId: state.managedWindowId });
  const urls = new Set(openTabs.map((tab) => tab.url || tab.pendingUrl));
  let opened = 0;
  let target = null;
  try {
    for (const page of workspace.pages) {
      if (urls.has(page.url)) continue;
      const tab = await chrome.tabs.create({ windowId: state.managedWindowId, url: page.url, active: false });
      const record = makeRecord({ tab, contextId: workspace.contextId });
      const route = routeForUrl(state.routes, page.url);
      record.routeSuppressedHostname = route && route.contextId !== workspace.contextId ? normalizeHostname(page.url) : null;
      state.records[record.id] = record;
      tabRecords.set(tab.id, record.id);
      urls.add(page.url);
      opened++;
      target ||= tab;
      await presentTab(tab, record);
    }
    // Opening is explicit, but never steals or reassigns an existing tab from another bucket.
    target ||= openTabs.find((tab) => workspace.pages.some((page) => page.url === tab.url)
      && recordForTab(tab.id)?.contextId === workspace.contextId);
    if (target) await retryBrowserEdit(() => chrome.tabs.update(target.id, { active: true }));
  } finally {
    await persist();
  }
  return { opened };
}

async function saveContexts(contexts) {
  await refreshGroupIds();
  const existingGroupIds = new Map(groupIds);
  const cleaned = contexts.map((context, index) => ({
    id: String(context.id),
    title: String(context.title || "Context").trim() || "Context",
    color: TAB_GROUP_COLORS.includes(context.color) ? context.color : "grey",
    order: index,
  }));
  if (!cleaned.length) throw new Error("Keep at least one context.");
  if (cleaned.some((context) => [...SHELF_TITLES.keys(), "__proto__", "constructor", "prototype"].includes(context.id)
    || [...SHELF_TITLES.values()].some((title) => context.title.toLowerCase() === title.toLowerCase()))) {
    throw new Error("Choose a context name and ID other than the reserved shelf names.");
  }
  if (new Set(cleaned.map((context) => context.id)).size !== cleaned.length) {
    throw new Error("Context IDs must be unique.");
  }
  if (new Set(cleaned.map((context) => context.title.toLowerCase())).size !== cleaned.length) {
    throw new Error("Context names must be unique.");
  }

  const usedIds = new Set(Object.values(state.records).map((record) => record.contextId));
  const routedIds = new Set([...state.routes, ...state.workspaces].map((item) => item.contextId));
  for (const oldContext of state.contexts) {
    if (!cleaned.some((context) => context.id === oldContext.id) && (usedIds.has(oldContext.id) || routedIds.has(oldContext.id))) {
      throw new Error(`${oldContext.title} still contains tabs or routing rules.`);
    }
  }

  state.contexts = cleaned;
  if (!contextById(state.activeContextId)) state.activeContextId = cleaned[0].id;
  for (const context of cleaned) {
    const groupId = existingGroupIds.get(context.id);
    if (Number.isInteger(groupId)) {
      await retryBrowserEdit(() => chrome.tabGroups.update(groupId, {
        title: context.title,
        color: context.color,
      }));
    }
  }
  groupIds = existingGroupIds;
  await orderGroups();
  await persist();
}

async function addRoute(hostname, contextId, moveExisting = true) {
  const clean = cleanHostnameInput(hostname);
  if (!isValidRouteHostname(clean)) {
    throw new Error("Enter a hostname such as example.com. Subdomains are included automatically.");
  }
  if (!contextById(contextId)) throw new Error("Choose a context.");

  state.routes = state.routes.filter((route) => cleanHostnameInput(route.hostname) !== clean);
  const route = { id: crypto.randomUUID(), hostname: clean, contextId };
  state.routes.push(route);

  let moved = 0;
  if (moveExisting && state.managedWindowId !== null) {
    const tabs = await chrome.tabs.query({ windowId: state.managedWindowId });
    for (const tab of tabs) {
      if (routeForUrl(state.routes, tab.url)?.id !== route.id) continue;
      const record = await ensureRecord(tab);
      if (record.attention !== "current" || record.routeSuppressedHostname === normalizeHostname(tab.url)) continue;
      record.contextId = contextId;
      record.originContextId = contextId;
      await presentTab(tab, record);
      moved += 1;
    }
  }
  await persist();
  return { route, moved };
}

async function removeRoute(routeId) {
  state.routes = state.routes.filter((route) => route.id !== routeId);
  await persist();
}

chrome.runtime.onInstalled.addListener(() => {
  runEvent(async () => {
    await ensureSweepAlarm();
    await persist();
  });
});

chrome.runtime.onStartup.addListener(() => {
  runEvent(async () => {
    if (state.managedWindowId === null) await discoverManagedWindow();
    if (state.managedWindowId !== null) await reconcileManagedWindow();
    await ensureSweepAlarm();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) runEvent(runSweep);
});

chrome.tabGroups.onUpdated.addListener((group) => {
  const wasCollapsed = observedGroups.get(group.id);
  observedGroups.set(group.id, group.collapsed);
  // Metadata changes and our own writes are not user selection commands.
  if (wasCollapsed === true && group.collapsed === false) runEvent(() => enforceAccordion(group));
});

chrome.tabs.onDetached.addListener((tabId) => {
  runEvent(() => {
    const recordId = tabRecords.get(tabId);
    if (recordId) detachedRecords.set(tabId, recordId);
    tabRecords.delete(tabId);
  });
});

chrome.tabs.onAttached.addListener((tabId, info) => {
  runEvent(async () => {
    if (info.newWindowId !== state.managedWindowId) return;
    const tab = await managedTab(tabId);
    const recordId = detachedRecords.get(tabId);
    detachedRecords.delete(tabId);
    if (state.records[recordId]) tabRecords.set(tabId, recordId);
    const record = await ensureRecord(tab);
    await presentTab(tab, record);
    await persist();
  });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  runEvent(async () => {
    if (windowId !== state.managedWindowId) return;
    const tab = await chrome.tabs.get(tabId);
    // Activation events can also be stale by the time queued orchestration runs.
    if (!tab.active || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
    const group = await chrome.tabGroups.get(tab.groupId);
    if (contextKeyForGroup(group)) await enforceAccordion(group);
  });
});

chrome.tabs.onCreated.addListener((createdTab) => {
  runEvent(async () => {
    const tab = await chrome.tabs.get(createdTab.id);
    if (tab.windowId !== state.managedWindowId) return;
    const record = await ensureRecord(tab);
    await presentTab(tab, record);
    await applyRouting(tab, record);
    await persist();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  runEvent(async () => {
    if (tab.windowId !== state.managedWindowId) return;
    const record = await ensureRecord(tab);
    record.url = tab.url || tab.pendingUrl || record.url;
    record.title = tab.title || record.title;
    record.lastSeenAt = Date.now();

    if (Number.isInteger(changeInfo.groupId) && !mutedTabs.has(tabId)
      && changeInfo.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      try {
        const group = await chrome.tabGroups.get(changeInfo.groupId);
        const groupKey = contextKeyForGroup(group);
        if (groupKey) await syncRecordToGroup(tab, groupKey);
      } catch {
        // The group may disappear before its queued tab update is handled.
      }
    }

    if (typeof changeInfo.pinned === "boolean" && !mutedTabs.has(tabId)) {
      record.pinned = changeInfo.pinned;
      record.attention = "current";
      if (!changeInfo.pinned) {
        record.contextId = state.activeContextId;
        record.originContextId = state.activeContextId;
      }
      await presentTab(tab, record);
    }

    if (changeInfo.url || changeInfo.status === "complete") {
      await applyRouting(tab, record);
    }
    await persist();
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  runEvent(async () => {
    const recordId = tabRecords.get(tabId);
    tabRecords.delete(tabId);
    detachedRecords.delete(tabId);
    if (recordId && !removeInfo.isWindowClosing) delete state.records[recordId];
    await persist();
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  runEvent(async () => {
    if (windowId !== state.managedWindowId) return;
    state.managedWindowId = null;
    tabRecords = new Map();
    groupIds = new Map();
    await persist();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const trustedPages = ["popup/popup.html", "options/options.html"].map((path) => chrome.runtime.getURL(path));
  if (sender.id !== chrome.runtime.id || !trustedPages.includes(sender.url?.split(/[?#]/)[0])) {
    sendResponse({ ok: false, error: "Rauiri commands must come from its popup or Settings." });
    return false;
  }
  const readOnly = new Set(["snapshot", "configurationSnapshot", "recoverySnapshot", "exportBackup", "exportPreviousBackup", "exportLegacyBackup", "openOptions"]);
  const execute = readOnly.has(message?.type) ? (task) => ready.then(task) : run;
  execute(async () => {
    if (message?.type === "enableWindowWorkspaces") {
      await windowWorkspaces.enable(structuredClone(state), message.windowId, Object.fromEntries(tabRecords));
      return windowWorkspaces.handle({ type: "snapshot", windowId: message.windowId });
    }
    if (windowWorkspaces.enabled || (message?.type === "importBackup" && message.backup?.format === "rauiri-window-workspaces")) {
      return windowWorkspaces.handle(message);
    }
    switch (message?.type) {
      case "snapshot":
        return currentSnapshot(message.windowId, message.tabId);
      case "configurationSnapshot":
        return configurationSnapshot();
      case "adoptWindow":
        await adoptWindow(message.windowId);
        return currentSnapshot(message.windowId, message.tabId);
      case "switchContext":
        await switchContext(message.contextId);
        return { ok: true };
      case "moveTabToContext":
        await moveTabToContext(message.tabId, message.contextId);
        return { ok: true };
      case "moveTabToReadLater":
        await moveTabToShelf(message.tabId);
        return { ok: true };
      case "restoreReadLaterTab":
        await restoreReadLaterTab(message.tabId);
        return { ok: true };
      case "saveWorkspace":
        return saveWorkspace(message.workspace);
      case "openWorkspace":
        return openWorkspace(message.workspaceId);
      case "deleteWorkspace":
        state.workspaces = state.workspaces.filter((workspace) => workspace.id !== message.workspaceId);
        await persist();
        return { ok: true };
      case "saveContexts":
        await saveContexts(message.contexts);
        return { ok: true };
      case "addRoute":
        return addRoute(message.hostname, message.contextId, message.moveExisting);
      case "updateRouteDestination": {
        const route = state.routes.find((item) => item.id === message.routeId);
        if (!route) throw new Error("This route no longer exists. Refresh Settings.");
        if (!contextById(message.contextId)) throw new Error("Choose a context.");
        route.contextId = message.contextId;
        await persist();
        return { ok: true };
      }
      case "removeRoute":
        await removeRoute(message.routeId);
        return { ok: true };
      case "saveSettings": {
        const archiveAfterHours = Number(message.settings?.archiveAfterHours);
        const discardReadLaterAfterHours = Number(message.settings?.discardReadLaterAfterHours);
        if (!Number.isFinite(archiveAfterHours) || archiveAfterHours < 1) {
          throw new Error("Archive delay must be at least one hour.");
        }
        if (!Number.isFinite(discardReadLaterAfterHours) || discardReadLaterAfterHours < 1) {
          throw new Error("Read Later delay must be at least one hour.");
        }
        state.settings = { archiveAfterHours, discardReadLaterAfterHours };
        await persist();
        return { ok: true };
      }
      case "runSweep":
        await runSweep();
        return { ok: true };
      case "recoverySnapshot":
        return recoverySnapshot();
      case "exportBackup":
        return backupSnapshot(message.configurationOnly === true);
      case "exportPreviousBackup": {
        const stored = await chrome.storage.local.get("rauiriBeforeImport");
        if (!stored.rauiriBeforeImport) throw new Error("No pre-import backup is available yet.");
        return stored.rauiriBeforeImport;
      }
      case "importBackup":
        return importBackup(message.backup);
      case "reopenRecords":
        return reopenRecords(message.recordIds, message.windowId);
      case "openOptions":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      default:
        throw new Error("Unknown Rauiri action.");
    }
  }).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
  );
  return true;
});
