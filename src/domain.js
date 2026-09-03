export const READ_LATER_ID = "read-later";
export const READ_LATER_TITLE = "Read Later";
export const STATE_VERSION = 3;
export const BACKUP_FORMAT = "rauiri-backup";
export const BACKUP_FORMAT_VERSION = 1;

const TAB_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);

export const DEFAULT_CONTEXTS = Object.freeze([
  { id: "personal", title: "Personal", color: "green", order: 0 },
  { id: "work", title: "Work", color: "red", order: 1 },
  { id: "groundtruth", title: "Groundtruth", color: "orange", order: 2 },
]);

export const DEFAULT_SETTINGS = Object.freeze({
  archiveAfterHours: 72,
  discardReadLaterAfterHours: 2,
});

export function createInitialState() {
  return {
    version: STATE_VERSION,
    managedWindowId: null,
    activeContextId: "personal",
    contexts: DEFAULT_CONTEXTS.map((context) => ({ ...context })),
    routes: [],
    records: {},
    settings: { ...DEFAULT_SETTINGS },
    adoptedAt: null,
  };
}

export function migrateState(value) {
  const initial = createInitialState();
  if (!value || typeof value !== "object") return initial;

  const contexts = Array.isArray(value.contexts) && value.contexts.length
    ? value.contexts
        .filter((context) => context && context.id && context.title)
        .map((context, index) => ({
          id: String(context.id),
          title: String(context.title),
          color: context.color || "grey",
          order: Number.isFinite(context.order) ? context.order : index,
        }))
        .sort((a, b) => a.order - b.order)
    : initial.contexts;

  const activeContextId = contexts.some((context) => context.id === value.activeContextId)
    ? value.activeContextId
    : contexts[0].id;

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(value.settings || {}),
  };
  if ((Number(value.version) || 0) < 2 && settings.archiveAfterHours === 12) {
    settings.archiveAfterHours = 72;
  }

  const storedRecords = value.records && typeof value.records === "object" ? value.records : {};
  const records = Object.fromEntries(Object.entries(storedRecords).map(([id, record]) => [id, {
    ...record,
    pinScope: record?.pinScope === "global" ? "global" : "none",
  }]));

  return {
    ...initial,
    ...value,
    version: STATE_VERSION,
    contexts,
    activeContextId,
    routes: Array.isArray(value.routes) ? value.routes : [],
    records,
    settings,
  };
}

export function createBackup(state, { extensionVersion, exportedAt = new Date().toISOString() } = {}) {
  const current = migrateState(state);
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    extensionVersion: extensionVersion || null,
    exportedAt,
    state: {
      version: current.version,
      activeContextId: current.activeContextId,
      contexts: current.contexts,
      routes: current.routes,
      records: current.records,
      settings: current.settings,
      adoptedAt: current.adoptedAt,
    },
  };
}

export function stateFromBackup(backup, { managedWindowId = null } = {}) {
  if (!backup || backup.format !== BACKUP_FORMAT || backup.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error("This is not a supported Rauiri backup file.");
  }

  const source = backup.state;
  if (!source || !Array.isArray(source.contexts) || !source.contexts.length) {
    throw new Error("The backup does not contain any contexts.");
  }

  const restored = migrateState(source);
  const contextIds = new Set(restored.contexts.map((context) => context.id));
  const contextTitles = new Set(restored.contexts.map((context) => context.title.toLowerCase()));
  if (contextIds.size !== restored.contexts.length || contextTitles.size !== restored.contexts.length) {
    throw new Error("The backup contains duplicate context IDs or names.");
  }
  if (!restored.contexts.every((context) => TAB_GROUP_COLORS.has(context.color))) {
    throw new Error("The backup contains an invalid context colour.");
  }

  const routeIds = new Set(restored.routes.map((route) => route?.id));
  const validRoute = (route) => {
    const clean = cleanHostnameInput(route?.hostname);
    const host = clean.startsWith("*.") ? clean.slice(2) : clean;
    return route?.id && contextIds.has(route.contextId)
      && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(host);
  };
  if (routeIds.size !== restored.routes.length || !restored.routes.every(validRoute)) {
    throw new Error("The backup contains an invalid routing rule.");
  }

  const validRecords = Object.entries(restored.records).every(([id, record]) => (
    record && record.id === id && contextIds.has(record.contextId) && typeof record.url === "string"
  ));
  if (!validRecords) {
    throw new Error("The backup contains an invalid saved tab record.");
  }
  if (!Number.isFinite(restored.settings.archiveAfterHours) || restored.settings.archiveAfterHours < 1
    || !Number.isFinite(restored.settings.discardReadLaterAfterHours)
    || restored.settings.discardReadLaterAfterHours < 1) {
    throw new Error("The backup contains invalid lifecycle settings.");
  }

  restored.managedWindowId = managedWindowId;
  return restored;
}

function rawHostname(input) {
  if (!input) return "";
  try {
    const value = String(input).trim();
    const candidate = value.includes("://") ? value : `https://${value}`;
    return new URL(candidate).hostname.toLowerCase().replace(/^%2a\./, "*.").replace(/\.$/, "");
  } catch {
    return String(input).trim().toLowerCase().replace(/\.$/, "");
  }
}

export function normalizeHostname(input) {
  return rawHostname(input).replace(/^www\./, "");
}

export function cleanHostnameInput(value) {
  const hostname = rawHostname(value);
  if (hostname.startsWith("*.")) return `*.${hostname.slice(2)}`;
  return hostname.replace(/^www\./, "");
}

export function routeForUrl(routes, url) {
  const hostname = rawHostname(url);
  if (!hostname) return null;

  const exactHostname = hostname.replace(/^www\./, "");
  const exact = routes.find((route) => {
    const pattern = cleanHostnameInput(route.hostname);
    return !pattern.startsWith("*.") && pattern === exactHostname;
  });
  if (exact) return exact;

  return routes
    .map((route) => ({ route, pattern: cleanHostnameInput(route.hostname) }))
    .filter(({ pattern }) => pattern.startsWith("*.") && hostname.endsWith(pattern.slice(1)))
    .sort((left, right) => right.pattern.length - left.pattern.length)[0]?.route || null;
}

export function isRoutableUrl(url) {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function contextForNewTab({ openerRecord, activeContextId, route }) {
  if (route?.contextId) return route.contextId;
  if (openerRecord?.pinScope === "global") return activeContextId;
  if (openerRecord?.contextId) return openerRecord.contextId;
  return activeContextId;
}

export function attentionForNewTab(openerRecord) {
  return openerRecord?.attention === "readLater" ? "readLater" : "current";
}

export function groupKeyForRecord(record) {
  return record?.attention === "readLater" ? READ_LATER_ID : record?.contextId || null;
}

export function assignRecordToGroup(record, { groupKey, route, url }) {
  if (!record || !groupKey || groupKeyForRecord(record) === groupKey) return false;

  if (groupKey === READ_LATER_ID) {
    record.originContextId = record.contextId;
    record.attention = "readLater";
    record.pinScope = "none";
    record.routeSuppressedHostname = null;
    return true;
  }

  record.contextId = groupKey;
  record.originContextId = groupKey;
  record.attention = "current";
  record.routeSuppressedHostname = route && route.contextId !== groupKey ? normalizeHostname(url) : null;
  return true;
}

export function shouldArchiveTab({ tab, record, route, now, archiveAfterHours }) {
  if (!tab || !record || record.attention === "readLater") return false;
  if (tab.active || tab.audible || tab.pinned) return false;
  if (record.pinScope === "global") return false;
  if (route) return false;
  if (!Number.isFinite(tab.lastAccessed)) return false;
  return now - tab.lastAccessed >= hours(archiveAfterHours);
}

export function shouldDiscardReadLater({ tab, record, now, discardAfterHours }) {
  if (!tab || !record || record.attention !== "readLater") return false;
  if (tab.active || tab.audible || tab.discarded) return false;
  if (!Number.isFinite(tab.lastAccessed)) return false;
  return now - tab.lastAccessed >= hours(discardAfterHours);
}

export function findRecoverableRecords({ records, openTabs, tabRecordEntries = [] }) {
  const openTabIds = new Set((openTabs || []).map((tab) => tab.id));
  const associatedRecordIds = new Set(tabRecordEntries
    .filter(([tabId, recordId]) => openTabIds.has(tabId) && records?.[recordId])
    .map(([, recordId]) => recordId));
  const openUrls = new Set((openTabs || []).map((tab) => tab.url || tab.pendingUrl || ""));
  const seenUrls = new Set();

  return Object.values(records || {})
    .filter((record) => !associatedRecordIds.has(record.id) && isRoutableUrl(record.url))
    .sort((left, right) => (right.lastSeenAt || 0) - (left.lastSeenAt || 0))
    .filter((record) => {
      if (openUrls.has(record.url) || seenUrls.has(record.url)) return false;
      seenUrls.add(record.url);
      return true;
    });
}

export function updateYouTubeUrl(url, seconds) {
  if (!url || !Number.isFinite(seconds) || seconds < 1) return url;

  try {
    const parsed = new URL(url);
    const hostname = normalizeHostname(parsed.hostname);
    if (hostname !== "youtube.com" && hostname !== "m.youtube.com" && hostname !== "youtu.be") {
      return url;
    }

    parsed.searchParams.set("t", `${Math.floor(seconds)}s`);
    return parsed.toString();
  } catch {
    return url;
  }
}

export function hours(value) {
  return Number(value) * 60 * 60 * 1000;
}

export function makeRecord({ tab, contextId, attention = "current", pinScope = "none", originContextId = null }) {
  return {
    id: crypto.randomUUID(),
    url: tab.url || tab.pendingUrl || "",
    title: tab.title || "Untitled tab",
    contextId,
    originContextId: originContextId || contextId,
    attention,
    pinScope,
    routeSuppressedHostname: null,
    lastSeenAt: Date.now(),
  };
}
