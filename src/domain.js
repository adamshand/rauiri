export const READ_LATER_ID = "read-later";
export const READ_LATER_TITLE = "Read Later";
export const STATE_VERSION = 1;

export const DEFAULT_CONTEXTS = Object.freeze([
  { id: "personal", title: "Personal", color: "green", order: 0 },
  { id: "work", title: "Work", color: "red", order: 1 },
  { id: "groundtruth", title: "Groundtruth", color: "orange", order: 2 },
]);

export const DEFAULT_SETTINGS = Object.freeze({
  archiveAfterHours: 12,
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

  return {
    ...initial,
    ...value,
    version: STATE_VERSION,
    contexts,
    activeContextId,
    routes: Array.isArray(value.routes) ? value.routes : [],
    records: value.records && typeof value.records === "object" ? value.records : {},
    settings: {
      ...DEFAULT_SETTINGS,
      ...(value.settings || {}),
    },
  };
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

export function shouldArchiveTab({ tab, record, route, now, archiveAfterHours }) {
  if (!tab || !record || record.attention === "readLater") return false;
  if (tab.active || tab.audible || tab.pinned) return false;
  if (record.pinScope && record.pinScope !== "none") return false;
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
