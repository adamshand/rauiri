import {
  READ_LATER_ID,
  READ_LATER_TITLE,
  attentionForNewTab,
  cleanHostnameInput,
  contextForNewTab,
  createInitialState,
  makeRecord,
  migrateState,
  normalizeHostname,
  routeForUrl,
  shouldArchiveTab,
  shouldDiscardReadLater,
  updateYouTubeUrl,
} from "./domain.js";

const STATE_KEY = "rauiriState";
const SESSION_WINDOW_KEY = "rauiriManagedWindowId";
const SWEEP_ALARM = "rauiri-hourly-sweep";
const READ_LATER_COLOR = "grey";
const GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);

let state = createInitialState();
let tabRecords = new Map();
let groupIds = new Map();
let mutedTabs = new Set();
let operation = Promise.resolve();

const ready = initialize();

function run(task) {
  operation = operation.then(async () => {
    await ready;
    return task();
  }, async () => {
    await ready;
    return task();
  });
  return operation;
}

async function initialize() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  state = migrateState(stored[STATE_KEY]);
  state.managedWindowId = null;

  const session = await chrome.storage.session.get(SESSION_WINDOW_KEY);
  const runtimeWindowId = session[SESSION_WINDOW_KEY];
  if (Number.isInteger(runtimeWindowId) && await windowExists(runtimeWindowId)) {
    state.managedWindowId = runtimeWindowId;
  } else {
    await discoverManagedWindow();
  }

  if (state.managedWindowId !== null) {
    await reconcileManagedWindow();
  }

  await ensureSweepAlarm();
  await persist();
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
    READ_LATER_TITLE,
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
  if (group.title === READ_LATER_TITLE) return READ_LATER_ID;
  return state.contexts.find((context) => context.title === group.title)?.id || null;
}

async function refreshGroupIds() {
  groupIds = new Map();
  if (state.managedWindowId === null) return;
  const groups = await chrome.tabGroups.query({ windowId: state.managedWindowId });
  for (const group of groups) {
    const key = contextKeyForGroup(group);
    if (key && !groupIds.has(key)) groupIds.set(key, group.id);
  }
}

async function reconcileManagedWindow() {
  if (state.managedWindowId === null || !await windowExists(state.managedWindowId)) return;

  await refreshGroupIds();
  const tabs = await chrome.tabs.query({ windowId: state.managedWindowId });
  const groups = await chrome.tabGroups.query({ windowId: state.managedWindowId });
  const groupKeys = new Map(groups.map((group) => [group.id, contextKeyForGroup(group)]));
  const unmatched = new Map(Object.values(state.records).map((record) => [record.id, record]));
  tabRecords = new Map();

  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl || "";
    const groupKey = groupKeys.get(tab.groupId);
    const attention = groupKey === READ_LATER_ID ? "readLater" : "current";
    const groupContext = groupKey && groupKey !== READ_LATER_ID ? groupKey : null;
    const candidates = [...unmatched.values()].filter((record) => {
      if (record.url !== url) return false;
      if (groupContext && record.contextId !== groupContext) return false;
      if (attention === "readLater" && record.attention !== "readLater") return false;
      return true;
    });

    let record = candidates[0] || null;
    if (!record) {
      const contextId = groupContext || state.activeContextId;
      record = makeRecord({
        tab,
        contextId,
        attention,
        pinScope: tab.pinned ? "global" : "none",
      });
      state.records[record.id] = record;
    }

    unmatched.delete(record.id);
    record.url = url;
    record.title = tab.title || record.title;
    record.lastSeenAt = Date.now();
    if (groupContext) record.contextId = groupContext;
    if (attention === "readLater") record.attention = "readLater";
    tabRecords.set(tab.id, record.id);
  }

  await enforcePresentation({ activateTarget: false });
  await persist();
}

function recordForTab(tabId) {
  const recordId = tabRecords.get(tabId);
  return recordId ? state.records[recordId] || null : null;
}

function tabIdForRecord(recordId) {
  for (const [tabId, candidate] of tabRecords.entries()) {
    if (candidate === recordId) return tabId;
  }
  return null;
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
    pinScope: tab.pinned ? "context" : "none",
  });
  state.records[record.id] = record;
  tabRecords.set(tab.id, record.id);
  return record;
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
  try {
    if (Number.isInteger(groupId)) {
      await chrome.tabs.group({ groupId, tabIds: ids });
    } else {
      groupId = await chrome.tabs.group({ tabIds: ids });
      groupIds.set(key, groupId);
    }
  } catch {
    groupId = await chrome.tabs.group({ tabIds: ids });
    groupIds.set(key, groupId);
  }

  const context = contextById(key);
  await chrome.tabGroups.update(groupId, {
    title: key === READ_LATER_ID ? READ_LATER_TITLE : context?.title || "Context",
    color: key === READ_LATER_ID ? READ_LATER_COLOR : context?.color || "grey",
  });
  return groupId;
}

async function setPinned(tab, pinned) {
  if (tab.pinned === pinned) return tab;
  return muteTab(tab.id, () => chrome.tabs.update(tab.id, { pinned }));
}

async function ungroupTab(tab) {
  if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  await muteTab(tab.id, () => chrome.tabs.ungroup([tab.id]));
}

async function presentTab(tab, record) {
  if (record.pinScope === "global") {
    await ungroupTab(tab);
    await setPinned(tab, true);
    return;
  }

  if (record.pinScope === "context" && record.contextId === state.activeContextId && record.attention !== "readLater") {
    await ungroupTab(tab);
    await setPinned(tab, true);
    return;
  }

  tab = await setPinned(tab, false);
  const key = record.attention === "readLater" ? READ_LATER_ID : record.contextId;
  const groupId = await ensureGroup(key, [tab.id]);
  if (Number.isInteger(groupId) && key !== state.activeContextId && !tab.active) {
    try { await chrome.tabGroups.update(groupId, { collapsed: true }); } catch { /* transient */ }
  }
}

async function orderGroups() {
  const desired = [...state.contexts.map((context) => context.id), READ_LATER_ID];
  for (const key of desired) {
    const groupId = groupIds.get(key);
    if (!Number.isInteger(groupId)) continue;
    try { await chrome.tabGroups.move(groupId, { index: -1 }); } catch { /* transient */ }
  }
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
      target = tabs
        .filter((tab) => {
          const record = recordForTab(tab.id);
          return record?.attention === "current"
            && record.pinScope !== "global"
            && record.contextId === state.activeContextId;
        })
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    }

    if (!target) {
      const created = await chrome.tabs.create({ windowId: state.managedWindowId, active: true });
      const record = makeRecord({ tab: created, contextId: state.activeContextId });
      state.records[record.id] = record;
      tabRecords.set(created.id, record.id);
      await presentTab(created, record);
      target = created;
    } else if (!target.active) {
      await chrome.tabs.update(target.id, { active: true });
    }
  }

  await refreshGroupIds();
  await orderGroups();
  const groups = await chrome.tabGroups.query({ windowId: state.managedWindowId });
  for (const group of groups) {
    const key = contextKeyForGroup(group);
    if (!key) continue;
    const collapsed = key === READ_LATER_ID || key !== state.activeContextId;
    try {
      await chrome.tabGroups.update(group.id, { collapsed });
    } catch {
      // Chrome can briefly reject a collapse while its active tab is moving.
    }
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
    activeContextId: initialContextId,
    managedWindowId: windowId,
    adoptedAt: Date.now(),
  };
  tabRecords = new Map();
  groupIds = new Map();

  for (const tab of window.tabs || []) {
    const record = makeRecord({
      tab,
      contextId: initialContextId,
      pinScope: tab.pinned ? "global" : "none",
    });
    state.records[record.id] = record;
    tabRecords.set(tab.id, record.id);
  }

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

  if (key !== READ_LATER_ID && key !== state.activeContextId) {
    await switchContext(key);
    return;
  }

  const groups = await chrome.tabGroups.query({ windowId: state.managedWindowId });
  for (const group of groups) {
    if (group.id === expandedGroup.id || group.collapsed || !contextKeyForGroup(group)) continue;
    try {
      await chrome.tabGroups.update(group.id, { collapsed: true });
    } catch {
      // Chrome can briefly reject collapsing the group containing the active tab.
    }
  }
}

async function applyRouting(tab, record) {
  if (record.attention === "readLater") return;
  const hostname = normalizeHostname(tab.url || tab.pendingUrl);
  if (record.routeSuppressedHostname && record.routeSuppressedHostname !== hostname) {
    record.routeSuppressedHostname = null;
  }

  const route = routeForUrl(state.routes, tab.url || tab.pendingUrl);
  if (!route || record.routeSuppressedHostname === hostname) return;

  const contextChanged = route.contextId !== record.contextId;
  record.contextId = route.contextId;
  record.originContextId = route.contextId;
  if (tab.active && route.contextId !== state.activeContextId) {
    await switchContext(route.contextId, tab.id);
  } else if (contextChanged) {
    await presentTab(tab, record);
  }
}

async function moveTabToContext(tabId, contextId) {
  const tab = await chrome.tabs.get(tabId);
  const record = await ensureRecord(tab);
  const route = routeForUrl(state.routes, tab.url);
  if (route && route.contextId !== contextId) {
    record.routeSuppressedHostname = normalizeHostname(tab.url);
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
      func: () => document.querySelector("video")?.currentTime || 0,
    });
    const nextUrl = updateYouTubeUrl(tab.url, Number(result));
    if (nextUrl && nextUrl !== tab.url) {
      await muteTab(tab.id, () => chrome.tabs.update(tab.id, { url: nextUrl }));
      return nextUrl;
    }
  } catch {
    // Restricted, unloaded, or not-yet-ready pages simply retain their URL.
  }
  return tab.url;
}

async function fallbackTabFor(record, excludedTabId) {
  const tabs = await chrome.tabs.query({ windowId: state.managedWindowId });
  return tabs
    .filter((tab) => {
      if (tab.id === excludedTabId) return false;
      const candidate = recordForTab(tab.id);
      return candidate?.attention === "current" && candidate.contextId === record.contextId;
    })
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

async function moveTabToReadLater(tabId) {
  let tab = await chrome.tabs.get(tabId);
  const record = await ensureRecord(tab);
  const wasActive = tab.active;
  const previousContextId = record.contextId;
  record.originContextId = record.contextId;
  record.attention = "readLater";
  record.pinScope = "none";
  record.routeSuppressedHostname = null;
  record.url = await captureYouTubeTimestamp(tab);
  tab = await chrome.tabs.get(tabId);

  if (wasActive) {
    let fallback = await fallbackTabFor(record, tabId);
    if (!fallback) {
      const created = await chrome.tabs.create({ windowId: state.managedWindowId, active: true });
      const createdRecord = makeRecord({ tab: created, contextId: previousContextId });
      state.records[createdRecord.id] = createdRecord;
      tabRecords.set(created.id, createdRecord.id);
      await presentTab(created, createdRecord);
    } else {
      await chrome.tabs.update(fallback.id, { active: true });
    }
  }

  tab = await chrome.tabs.get(tabId);
  await presentTab(tab, record);
  await persist();
}

async function restoreReadLaterTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const record = await ensureRecord(tab);
  record.attention = "current";
  record.contextId = contextById(record.originContextId) ? record.originContextId : state.activeContextId;
  const route = routeForUrl(state.routes, tab.url);
  if (route) record.contextId = route.contextId;
  await presentTab(tab, record);
  await persist();
}

async function setTabPinScope(tabId, pinScope) {
  const tab = await chrome.tabs.get(tabId);
  const record = await ensureRecord(tab);
  record.attention = "current";
  record.pinScope = pinScope;
  if (pinScope === "context") record.contextId = state.activeContextId;
  await presentTab(tab, record);
  await persist();
}

async function runSweep() {
  if (state.managedWindowId === null || !await windowExists(state.managedWindowId)) return;
  const tabs = await chrome.tabs.query({ windowId: state.managedWindowId });
  const now = Date.now();

  for (let tab of tabs) {
    const record = await ensureRecord(tab);
    const route = routeForUrl(state.routes, tab.url);
    if (shouldArchiveTab({
      tab,
      record,
      route,
      now,
      archiveAfterHours: state.settings.archiveAfterHours,
    })) {
      await moveTabToReadLater(tab.id);
      continue;
    }

    if (shouldDiscardReadLater({
      tab,
      record,
      now,
      discardAfterHours: state.settings.discardReadLaterAfterHours,
    })) {
      record.url = await captureYouTubeTimestamp(tab);
      tab = await chrome.tabs.get(tab.id);
      try {
        await chrome.tabs.discard(tab.id);
      } catch {
        // A tab can become active or otherwise undiscardable during the sweep.
      }
    }
  }
  await persist();
}

async function currentSnapshot(windowId, tabId = null) {
  if (state.managedWindowId === null) await discoverManagedWindow();
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
    if (currentTab) currentRecord = await ensureRecord(currentTab);
  }

  const readLaterCount = Object.values(state.records).filter((record) => record.attention === "readLater").length;
  return {
    managed,
    hasManagedWindow: state.managedWindowId !== null,
    managedWindowId: state.managedWindowId,
    activeContextId: state.activeContextId,
    contexts: state.contexts,
    routes: state.routes,
    settings: state.settings,
    readLaterCount,
    currentTab: currentTab ? {
      id: currentTab.id,
      title: currentTab.title,
      url: currentTab.url,
      pinned: currentTab.pinned,
    } : null,
    currentRecord,
  };
}

async function saveContexts(contexts) {
  await refreshGroupIds();
  const existingGroupIds = new Map(groupIds);
  const cleaned = contexts.map((context, index) => ({
    id: String(context.id),
    title: String(context.title || "Context").trim() || "Context",
    color: GROUP_COLORS.has(context.color) ? context.color : "grey",
    order: index,
  }));
  if (!cleaned.length) throw new Error("Keep at least one context.");
  if (new Set(cleaned.map((context) => context.id)).size !== cleaned.length) {
    throw new Error("Context IDs must be unique.");
  }
  if (new Set(cleaned.map((context) => context.title.toLowerCase())).size !== cleaned.length) {
    throw new Error("Context names must be unique.");
  }

  const usedIds = new Set(Object.values(state.records).map((record) => record.contextId));
  const routedIds = new Set(state.routes.map((route) => route.contextId));
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
      await chrome.tabGroups.update(groupId, { title: context.title, color: context.color });
    }
  }
  groupIds = existingGroupIds;
  await persist();
}

async function addRoute(hostname, contextId, moveExisting = true) {
  const clean = cleanHostnameInput(hostname);
  if (!clean || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(clean)) {
    throw new Error("Enter a hostname such as app.example.com.");
  }
  if (!contextById(contextId)) throw new Error("Choose a context.");

  state.routes = state.routes.filter((route) => cleanHostnameInput(route.hostname) !== clean);
  const route = { id: crypto.randomUUID(), hostname: clean, contextId };
  state.routes.push(route);

  let moved = 0;
  if (moveExisting && state.managedWindowId !== null) {
    const tabs = await chrome.tabs.query({ windowId: state.managedWindowId });
    for (const tab of tabs) {
      if (normalizeHostname(tab.url) !== clean) continue;
      const record = await ensureRecord(tab);
      if (record.attention === "readLater") continue;
      record.contextId = contextId;
      record.originContextId = contextId;
      if (tab.active && contextId !== state.activeContextId) {
        await switchContext(contextId, tab.id);
      } else {
        await presentTab(tab, record);
      }
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
  run(async () => {
    await ensureSweepAlarm();
    await persist();
  });
});

chrome.runtime.onStartup.addListener(() => {
  run(async () => {
    if (state.managedWindowId === null) await discoverManagedWindow();
    if (state.managedWindowId !== null) await reconcileManagedWindow();
    await ensureSweepAlarm();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) run(runSweep);
});

chrome.tabGroups.onUpdated.addListener((group) => {
  run(() => enforceAccordion(group));
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  run(async () => {
    if (windowId !== state.managedWindowId) return;
    const tab = await chrome.tabs.get(tabId);
    // Activation events can also be stale by the time queued orchestration runs.
    if (!tab.active || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
    const group = await chrome.tabGroups.get(tab.groupId);
    const key = contextKeyForGroup(group);
    if (key && key !== READ_LATER_ID && key !== state.activeContextId) {
      await switchContext(key, tabId);
    }
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  run(async () => {
    if (tab.windowId !== state.managedWindowId) return;
    const record = await ensureRecord(tab);
    await presentTab(tab, record);
    await applyRouting(tab, record);
    await persist();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  run(async () => {
    if (tab.windowId !== state.managedWindowId) return;
    const record = await ensureRecord(tab);
    record.url = tab.url || tab.pendingUrl || record.url;
    record.title = tab.title || record.title;
    record.lastSeenAt = Date.now();

    if (typeof changeInfo.pinned === "boolean" && !mutedTabs.has(tabId)) {
      if (changeInfo.pinned) {
        record.pinScope = "context";
        record.contextId = state.activeContextId;
        record.attention = "current";
      } else if (record.pinScope !== "none") {
        record.pinScope = "none";
        await presentTab(tab, record);
      }
    }

    if (changeInfo.url || changeInfo.status === "complete") {
      await applyRouting(tab, record);
    }
    await persist();
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  run(async () => {
    const recordId = tabRecords.get(tabId);
    tabRecords.delete(tabId);
    if (recordId && !removeInfo.isWindowClosing) delete state.records[recordId];
    await persist();
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  run(async () => {
    if (windowId !== state.managedWindowId) return;
    state.managedWindowId = null;
    tabRecords = new Map();
    groupIds = new Map();
    await persist();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  run(async () => {
    switch (message?.type) {
      case "snapshot":
        return currentSnapshot(message.windowId, message.tabId);
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
        await moveTabToReadLater(message.tabId);
        return { ok: true };
      case "restoreReadLaterTab":
        await restoreReadLaterTab(message.tabId);
        return { ok: true };
      case "setTabPinScope":
        await setTabPinScope(message.tabId, message.pinScope);
        return { ok: true };
      case "saveContexts":
        await saveContexts(message.contexts);
        return { ok: true };
      case "addRoute":
        return addRoute(message.hostname, message.contextId, message.moveExisting);
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
