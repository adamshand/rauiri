import { createWindowWorkspaces } from "../../src/window-workspaces.js";

export function harness({ fresh = false, empty = false, start = createWindowWorkspaces } = {}) {
  const state = {
    version: 1, minimizeOthers: true, pinnedWorkspaceId: null,
    shortcutSlots: ["personal", "work", ...Array(7).fill(null)], closedShortcutSlots: Array(9).fill(null), routes: [],
    workspaces: [
      { id: "personal", title: "Personal", color: "green", tabs: [
        { url: "https://personal.example", title: "Personal", pinned: false, routeOverride: false },
        { url: "https://pin.example", title: "Pin", pinned: true, routeOverride: false },
      ] },
      { id: "work", title: "Work", color: "red", tabs: [{ url: "https://work.example", title: "Work", pinned: false, routeOverride: false }] },
      { id: "groundtruth", title: "Groundtruth", color: "orange", tabs: [] },
      { id: "read-later", title: "Read Later", color: "grey", tabs: [] },
      { id: "inactive", title: "Inactive", color: "grey", tabs: [] },
    ],
  };
  const local = fresh ? {} : { rauiriWindowWorkspaces: state };
  const session = fresh ? {} : { rauiriWorkspaceWindows: { personal: 1, work: 10, "read-later": 11 } };
  const calls = [];
  const window = (id, focused = false) => ({ id, type: "normal", incognito: false, focused, state: id === 10 || id === 11 ? "minimized" : "normal" });
  const windows = new Map(empty ? [] : fresh ? [[1, window(1, true)]] : [[1, window(1, true)], [10, window(10)], [11, window(11)]]);
  const tabs = new Map(empty ? [] : [
    [1, { id: 1, windowId: 1, url: "https://personal.example", title: "Personal", pinned: false, active: true, index: 0 }],
    [2, { id: 2, windowId: fresh ? 1 : 10, url: "https://work.example", title: "Work", pinned: false, active: !fresh, index: 0 }],
    [3, { id: 3, windowId: 1, url: "https://pin.example", title: "Pin", pinned: true, active: false, index: 1 }],
    ...fresh ? [] : [[100, { id: 100, windowId: 11, url: "about:blank", title: "New tab", pinned: false, active: true, index: 0 }]],
  ]);
  let nextWindow = 12;
  let nextTab = 101;
  const event = () => {
    const listeners = [];
    return { addListener: (fn) => listeners.push(fn), emit: (...args) => listeners.forEach((fn) => fn(...args)) };
  };
  const storage = (store) => ({
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
      .map((key) => [key, structuredClone(store[key])])),
    set: async (values) => Object.assign(store, structuredClone(values)),
  });
  const api = {
    storage: { local: storage(local), session: storage(session) },
    runtime: {
      id: "test", getURL: (path) => `chrome-extension://test/${path}`,
      onStartup: event(), onMessage: event(),
    },
    commands: { onCommand: event() },
    webNavigation: { onCommitted: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() },
    windows: {
      get: async (id) => {
        if (!windows.has(id)) throw new Error(`No window with id: ${id}`);
        return { ...windows.get(id), tabs: [...tabs.values()].filter((tab) => tab.windowId === id).map((tab) => ({ ...tab })) };
      },
      getAll: async () => Promise.all([...windows.keys()].map((id) => api.windows.get(id))),
      create: async (props) => {
        calls.push(["window.create", props]);
        const id = nextWindow++;
        windows.set(id, window(id, props.focused));
        await api.tabs.create({ windowId: id, url: props.url || "about:blank", active: true });
        return api.windows.get(id);
      },
      update: async (id, props) => {
        calls.push(["window.update", id, props]);
        if (props.focused) for (const window of windows.values()) window.focused = false;
        Object.assign(windows.get(id), props);
        return api.windows.get(id);
      },
      remove: async (id) => {
        calls.push(["window.remove", id]);
        for (const [tabId, tab] of tabs) if (tab.windowId === id) {
          tabs.delete(tabId);
          api.tabs.onRemoved.emit(tabId, { windowId: id, isWindowClosing: true });
        }
        windows.delete(id);
        api.windows.onRemoved.emit(id);
      },
      getLastFocused: async () => ({ ...[...windows.values()].find((window) => window.focused) }),
      onFocusChanged: event(), onRemoved: event(), onCreated: event(),
    },
    tabs: {
      get: async (id) => { if (!tabs.has(id)) throw new Error("No tab"); return { ...tabs.get(id) }; },
      query: async ({ windowId }) => [...tabs.values()].filter((tab) => tab.windowId === windowId).map((tab) => ({ ...tab })),
      create: async (props) => {
        calls.push(["tab.create", props]);
        const tab = { id: nextTab++, url: "chrome://newtab/", title: "New tab", active: false, pinned: false, ...props };
        if (tab.active) for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      update: async (id, props) => {
        calls.push(["tab.update", id, props]);
        if (props.active) for (const other of tabs.values()) if (other.windowId === tabs.get(id).windowId) other.active = false;
        Object.assign(tabs.get(id), props);
        return { ...tabs.get(id) };
      },
      move: async (id, props) => {
        calls.push(["tab.move", id, props]);
        const oldWindowId = tabs.get(id).windowId;
        Object.assign(tabs.get(id), { windowId: props.windowId, pinned: false, active: false });
        if (![...tabs.values()].some((tab) => tab.windowId === oldWindowId)) windows.delete(oldWindowId);
        return { ...tabs.get(id) };
      },
      onCreated: event(), onUpdated: event(), onMoved: event(), onDetached: event(), onAttached: event(), onRemoved: event(),
    },
  };
  const controller = start(api);
  const barrier = () => controller.handle({ type: "setWorkspacePreferences", minimizeOthers: true });
  return { api, controller, local, session, windows, tabs, calls, barrier };
}

export async function connected() {
  const app = harness();
  await app.controller.ready;
  app.calls.length = 0;
  return app;
}
