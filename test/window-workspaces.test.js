import test from "node:test";
import assert from "node:assert/strict";
import { createWindowWorkspaces, validateWindowState } from "../src/window-workspaces.js";
import { createInitialState } from "../src/domain.js";

function harness() {
  const legacy = createInitialState();
  const local = { rauiriState: legacy };
  const session = {};
  const calls = [];
  const windows = new Map([[1, { id: 1, type: "normal", incognito: false, focused: true, state: "normal" }]]);
  const tabs = new Map([
    [1, { id: 1, windowId: 1, url: "https://personal.example", title: "Personal", groupId: 11, pinned: false, active: true, index: 0 }],
    [2, { id: 2, windowId: 1, url: "https://work.example", title: "Work", groupId: 12, pinned: false, active: false, index: 1 }],
    [3, { id: 3, windowId: 1, url: "https://pin.example", title: "Pin", groupId: -1, pinned: true, active: false, index: 2 }],
  ]);
  let nextWindow = 10;
  let nextTab = 100;
  const event = () => {
    const listeners = [];
    return { addListener: (fn) => listeners.push(fn), emit: (...args) => listeners.forEach((fn) => fn(...args)) };
  };
  const storage = (store) => ({ get: async (key) => ({ [key]: structuredClone(store[key]) }), set: async (values) => Object.assign(store, structuredClone(values)) });
  const api = {
    storage: { local: storage(local), session: storage(session) },
    runtime: { onStartup: event() },
    commands: { onCommand: event() },
    webNavigation: { onCommitted: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async () => [{ id: 11, title: "Personal" }, { id: 12, title: "Work" }],
    },
    windows: {
      get: async (id) => {
        if (!windows.has(id)) throw new Error(`No window with id: ${id}`);
        return { ...windows.get(id), tabs: [...tabs.values()].filter((tab) => tab.windowId === id).map((tab) => ({ ...tab })) };
      },
      getAll: async () => Promise.all([...windows.keys()].map((id) => api.windows.get(id))),
      create: async (props) => {
        calls.push(["window.create", props]);
        const id = nextWindow++;
        windows.set(id, { id, type: "normal", incognito: false, focused: props.focused, state: "normal" });
        if (props.tabId) await api.tabs.move(props.tabId, { windowId: id, index: -1 });
        else await api.tabs.create({ windowId: id, url: props.url || "about:blank", active: true });
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
        for (const [tabId, tab] of tabs) if (tab.windowId === id) tabs.delete(tabId);
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
        const tab = { id: nextTab++, url: "chrome://newtab/", title: "New tab", active: false, pinned: false, groupId: -1, ...props };
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
        Object.assign(tabs.get(id), { windowId: props.windowId, pinned: false, groupId: -1, active: false });
        if (![...tabs.values()].some((tab) => tab.windowId === oldWindowId)) windows.delete(oldWindowId);
        return { ...tabs.get(id) };
      },
      ungroup: async (ids) => { ids.forEach((id) => { tabs.get(id).groupId = -1; }); },
      onCreated: event(), onUpdated: event(), onMoved: event(), onDetached: event(), onAttached: event(), onRemoved: event(),
    },
  };
  const controller = createWindowWorkspaces(api);
  const barrier = () => controller.handle({ type: "setWorkspacePreferences", minimizeOthers: true });
  return { api, controller, legacy, local, session, windows, tabs, calls, barrier };
}

async function enabled() {
  const app = harness();
  await app.controller.ready;
  await app.controller.enable(app.legacy, 1);
  app.calls.length = 0;
  return app;
}

test("worker reload reconnects windows before serving snapshots or queued mutations", async () => {
  const app = await enabled();
  const expectedBindings = structuredClone(app.session.rauiriWorkspaceWindows);
  // Inventories can change just before the worker sleeps; session IDs must win.
  app.tabs.get(1).url = "https://personal.example/changed";
  const restarted = createWindowWorkspaces(app.api);
  const mutation = restarted.handle({ type: "setWorkspacePreferences", minimizeOthers: false });
  const view = await restarted.handle({ type: "snapshot", windowId: 1 });
  await mutation;
  assert.equal(view.managed, true);
  assert.equal(view.currentWorkspaceId, "personal");
  assert.deepEqual(app.session.rauiriWorkspaceWindows, expectedBindings);
  assert.equal(app.calls.some(([name]) => name === "window.create"), false);
});

test("migration moves existing tabs, keeps pins and retains the original backup", async () => {
  const app = await enabled();
  const view = await app.controller.handle({ type: "snapshot", windowId: 1 });
  assert.equal(view.currentWorkspaceId, "personal");
  assert.equal(view.workspaces.find((w) => w.id === "work").windowId, 10);
  assert.equal(app.tabs.get(2).windowId, 10);
  assert.equal(app.tabs.get(3).pinned, true);
  assert.equal(app.tabs.size, 4, "Read Later gets its own blank window");
  assert.equal(app.local.rauiriBeforeWindowMode.contexts.length, 3);
});

test("migration keeps the original window alive when every existing tab belongs elsewhere", async () => {
  const app = harness();
  app.tabs.delete(1);
  app.tabs.delete(3);
  await app.controller.ready;
  await app.controller.enable(app.legacy, 1);
  assert.equal(app.windows.has(1), true);
  assert.equal(app.tabs.get(2).windowId, 10);
});

test("switching live workspaces never recreates tabs and minimises only managed windows", async () => {
  const app = await enabled();
  app.windows.set(999, { id: 999, type: "normal", incognito: false, state: "normal" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  assert.equal(app.calls.some(([method]) => method === "tab.create" || method === "window.create"), false);
  assert.equal(app.windows.get(10).state, "minimized");
  assert.equal(app.windows.get(999).state, "normal");
  assert.equal(app.tabs.get(3).pinned, true);
});

test("background filing preserves source focus and pinned tabs retain pinning when explicitly moved", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "moveWindowTab", tabId: 1, workspaceId: "work" });
  assert.equal(app.tabs.get(1).windowId, 10);
  assert.equal(app.windows.get(1).focused, true);
  assert.equal(app.tabs.get(3).active, true);
  await app.controller.handle({ type: "moveWindowTab", tabId: 3, workspaceId: "work" });
  assert.equal(app.tabs.get(3).pinned, true);
  assert.equal(app.windows.has(1), true, "last-tab filing must keep the source window alive");
});

test("cleanup stays in the background even for follow rules", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "work", moveExisting: true });
  assert.equal(app.tabs.get(1).windowId, 10);
  assert.equal(app.windows.get(1).focused, true);
  await app.api.tabs.create({ windowId: 1, url: "https://follow.example", active: true });
  await app.controller.handle({ type: "addRoute", hostname: "follow.example", contextId: "work", activate: true, moveExisting: true });
  assert.equal(app.windows.get(1).focused, true);
});

test("a follow rule does not steal focus for a background tab", async () => {
  const app = await enabled();
  await app.api.tabs.create({ windowId: 1, url: "https://background.example", active: false });
  await app.controller.handle({ type: "addRoute", hostname: "background.example", contextId: "work", activate: true, moveExisting: true });
  assert.equal(app.windows.get(1).focused, true);
  assert.equal(app.windows.get(10).focused, false);
});

test("tab updates and individual closes automatically update the saved workspace", async (t) => {
  const app = await enabled();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await app.api.tabs.update(1, { pinned: true, title: "Updated title" });
  app.api.tabs.onUpdated.emit(1, { pinned: true });
  t.mock.timers.tick(100);
  await app.barrier();
  let personal = app.local.rauiriWindowWorkspaces.workspaces.find((w) => w.id === "personal");
  assert.equal(personal.tabs.find((tab) => tab.url === "https://personal.example").pinned, true);
  assert.equal(personal.tabs.find((tab) => tab.url === "https://personal.example").title, "Updated title");
  app.tabs.delete(1);
  app.api.tabs.onRemoved.emit(1, { isWindowClosing: false });
  t.mock.timers.tick(100);
  await app.barrier();
  personal = app.local.rauiriWindowWorkspaces.workspaces.find((w) => w.id === "personal");
  assert.equal(personal.tabs.length, 1);
});

test("manual assignment and native pins are not overridden by routes", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "moveWindowTab", tabId: 1, workspaceId: "work" });
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "personal", moveExisting: true });
  await app.controller.handle({ type: "addRoute", hostname: "pin.example", contextId: "work", moveExisting: true });
  assert.equal(app.tabs.get(1).windowId, 10);
  assert.equal(app.tabs.get(3).windowId, 1);
});

test("window closure retains a resumable snapshot, including native pins", async () => {
  const app = await enabled();
  for (const [id, tab] of app.tabs) if (tab.windowId === 1) app.tabs.delete(id);
  app.windows.delete(1);
  app.api.windows.onRemoved.emit(1);
  await app.barrier();
  const before = app.local.rauiriWindowWorkspaces.workspaces.find((w) => w.id === "personal");
  assert.equal(before.tabs.length, 2);
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  const pin = [...app.tabs.values()].find((tab) => tab.url === "https://pin.example");
  assert.equal(pin.pinned, true);
});

test("restarting the worker reconnects live windows without opening tabs", async () => {
  const app = await enabled();
  const restarted = createWindowWorkspaces(app.api);
  await restarted.ready;
  await restarted.start();
  assert.equal((await restarted.handle({ type: "snapshot", windowId: 10 })).currentWorkspaceId, "work");
  assert.equal(app.calls.some(([method]) => method === "window.create"), false);
});

test("a workspace backup can be imported into a fresh profile without opening windows", async () => {
  const source = await enabled();
  const backup = await source.controller.handle({ type: "exportBackup" });
  const target = harness();
  await target.controller.ready;
  await target.controller.handle({ type: "importBackup", backup });
  assert.equal(target.controller.enabled, true);
  assert.equal(target.calls.length, 0);
  assert.equal(target.local.rauiriBeforeWindowMode.version, target.legacy.version);
  assert.equal((await target.controller.handle({ type: "configurationSnapshot" })).workspaces.every((w) => w.windowId === null), true);
});

test("workspace backups validate before replacement and configuration-only export excludes URLs", async () => {
  const app = await enabled();
  const backup = await app.controller.handle({ type: "exportBackup" });
  assert.equal(validateWindowState(backup.state).workspaces.length, 5);
  const config = await app.controller.handle({ type: "exportBackup", configurationOnly: true });
  assert.equal(config.state.workspaces.every((w) => w.tabs.length === 0), true);
  assert.equal(config.legacyState, undefined);
  backup.state.workspaces[0].tabs[0].url = "javascript:alert(1)";
  assert.throws(() => validateWindowState(backup.state), /Invalid saved/);
});


test("interrupted restoration retains the full inventory and retries only missing pages", async (t) => {
  const app = await enabled();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [id, tab] of app.tabs) if (tab.windowId === 1) app.tabs.delete(id);
  app.windows.delete(1);
  app.api.windows.onRemoved.emit(1);
  await app.barrier();
  const create = app.api.tabs.create;
  app.api.tabs.create = async (props) => {
    if (props.url === "https://pin.example") throw new Error("Temporary restore failure");
    return create(props);
  };
  await assert.rejects(app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" }), /Temporary restore failure/);
  app.api.tabs.onUpdated.emit(100, { title: "Partial restore" });
  t.mock.timers.tick(100);
  await app.barrier();
  const saved = app.local.rauiriWindowWorkspaces.workspaces.find((w) => w.id === "personal");
  assert.equal(saved.tabs.length, 2);
  assert.equal(saved.restorePending, true);
  app.api.tabs.create = create;
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  assert.equal([...app.tabs.values()].filter((tab) => tab.url === "https://personal.example").length, 1);
  assert.equal([...app.tabs.values()].filter((tab) => tab.url === "https://pin.example").length, 1);
  assert.equal(app.calls.filter(([method]) => method === "window.create").length, 1);
  assert.equal(app.local.rauiriWindowWorkspaces.workspaces.find((w) => w.id === "personal").restorePending, undefined);
});

test("changing a saved route destination preserves its identity and behavior without moving tabs", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "personal", activate: true });
  const route = (await app.controller.handle({ type: "snapshot" })).routes[0];
  const original = structuredClone(app.local.rauiriWindowWorkspaces.routes[0]);
  app.calls.length = 0;
  await app.controller.handle({ type: "updateRouteDestination", routeId: route.id, contextId: "work" });
  assert.deepEqual(app.local.rauiriWindowWorkspaces.routes[0], { ...original, contextId: "work" });
  assert.equal(app.calls.length, 0);
  await assert.rejects(app.controller.handle({ type: "updateRouteDestination", routeId: route.id, contextId: "missing" }), /Choose a workspace/);
  await assert.rejects(app.controller.handle({ type: "updateRouteDestination", routeId: "missing", contextId: "personal" }), /no longer exists/);
  assert.equal(app.local.rauiriWindowWorkspaces.routes[0].contextId, "work");
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "typed" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 10);
});

test("the single workspace pin survives export and clearing it minimises the inactive window", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  assert.equal(app.windows.get(1).state, "normal");
  const backup = await app.controller.handle({ type: "exportBackup", configurationOnly: true });
  assert.equal(validateWindowState(backup.state).pinnedWorkspaceId, "personal");
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: null });
  assert.equal(app.windows.get(1).state, "minimized");
  assert.equal(app.windows.get(10).focused, true);
  assert.equal(app.local.rauiriWindowWorkspaces.pinnedWorkspaceId, null);
  backup.state.pinnedWorkspaceId = "missing";
  assert.throws(() => validateWindowState(backup.state), /Invalid pinned workspace/);
});

test("swapping the pin focuses the new base, minimises the old one and keeps shortcuts and tabs intact", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "work" });
  const view = await app.controller.handle({ type: "snapshot", windowId: 10 });
  assert.deepEqual(view.workspaces.filter((w) => w.pinned).map((w) => w.id), ["work"]);
  assert.equal(view.workspaces[0].id, "personal");
  assert.equal(app.windows.get(1).state, "minimized");
  assert.equal(app.windows.get(10).focused, true);
  assert.equal(app.tabs.get(3).pinned, true, "native tab pins are independent");
  assert.equal(app.calls.some(([method]) => method === "tab.move" || method === "tab.create" || method === "window.create"), false);
  await assert.rejects(app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "missing" }), /Choose a workspace/);
  assert.equal(app.local.rauiriWindowWorkspaces.pinnedWorkspaceId, "work");
});

test("snapshots without a window do not mistake a closed workspace for the current one", async () => {
  const app = await enabled();
  const view = await app.controller.handle({ type: "configurationSnapshot" });
  assert.equal(view.currentWorkspaceId, null);
  assert.equal(view.managed, false);
});

test("pinning respects disabled minimisation", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "setWorkspacePreferences", minimizeOthers: false });
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "work" });
  assert.equal(app.windows.get(1).state, "normal");
  assert.equal(app.windows.get(10).focused, true);
});

test("legacy keep-available preferences migrate to one pin in stable workspace order", async () => {
  const app = await enabled();
  const state = structuredClone(app.local.rauiriWindowWorkspaces);
  delete state.pinnedWorkspaceId;
  state.workspaces[0].keepAvailable = true;
  state.workspaces[1].keepAvailable = true;
  const migrated = validateWindowState(state);
  assert.equal(migrated.pinnedWorkspaceId, "personal");
  assert.equal(migrated.workspaces.some((w) => "keepAvailable" in w), false);
  state.pinnedWorkspaceId = null;
  assert.equal(validateWindowState(state).pinnedWorkspaceId, null);
  state.workspaces[0].keepAvailable = "yes";
  assert.throws(() => validateWindowState(state), /Invalid workspace/);
});

test("previous-workspace toggles and numbered shortcuts use stable order, not recency", async () => {
  const app = await enabled();
  app.api.commands.onCommand.emit("workspace-2");
  await app.barrier();
  assert.equal(app.windows.get(10).focused, true);
  app.api.commands.onCommand.emit("previous-workspace");
  await app.barrier();
  assert.equal(app.windows.get(1).focused, true);
  app.api.commands.onCommand.emit("previous-workspace");
  await app.barrier();
  assert.equal(app.windows.get(10).focused, true);
  const restarted = createWindowWorkspaces(app.api);
  await restarted.ready;
  await restarted.start();
  const snapshot = await restarted.handle({ type: "snapshot" });
  assert.deepEqual(snapshot.recentWorkspaceIds.slice(0, 2), ["work", "personal"]);
  assert.equal(snapshot.workspaces[0].id, "personal");
});

test("native window switching updates recent workspaces but unrelated windows do not", async () => {
  const app = await enabled();
  await app.api.windows.update(10, { focused: true });
  app.api.windows.onFocusChanged.emit(10);
  await app.barrier();
  app.api.windows.onFocusChanged.emit(-1);
  await app.barrier();
  assert.deepEqual((await app.controller.handle({ type: "snapshot" })).recentWorkspaceIds.slice(0, 2), ["work", "personal"]);
});

test("project switches copy the outgoing normal window geometry, including negative monitor coordinates", async () => {
  const app = await enabled();
  const bounds = { left: -1200, top: 40, width: 1100, height: 850 };
  Object.assign(app.windows.get(1), bounds);
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  for (const [key, value] of Object.entries(bounds)) assert.equal(app.windows.get(10)[key], value);
  const updates = app.calls.filter(([method, id]) => method === "window.update" && id === 10);
  assert.equal(updates[0][2].state, "normal", "restore minimised target before setting bounds");
  assert.equal(updates[1][2].width, 1100);
});

test("switching from the pinned base uses the last project geometry without moving the base", async () => {
  const app = await enabled();
  const baseBounds = { left: 20, top: 20, width: 650, height: 700 };
  const projectBounds = { left: 700, top: 40, width: 1100, height: 900 };
  Object.assign(app.windows.get(1), baseBounds);
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  Object.assign(app.windows.get(10), projectBounds);
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  for (const [key, value] of Object.entries(baseBounds)) assert.equal(app.windows.get(1)[key], value);
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "groundtruth" });
  const target = (await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "groundtruth").windowId;
  for (const [key, value] of Object.entries(projectBounds)) assert.equal(app.windows.get(target)[key], value);
});

test("Personal inherits the project space when Work is newly pinned, even after worker restart", async () => {
  const app = await enabled();
  Object.assign(app.windows.get(1), { left: 0, top: 0, width: 600, height: 700 });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  const bounds = { left: 650, top: 40, width: 1200, height: 900 };
  Object.assign(app.windows.get(10), bounds);
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "work" });
  assert.equal(app.windows.get(1).state, "minimized");
  const restarted = createWindowWorkspaces(app.api);
  await restarted.ready;
  await restarted.start();
  await restarted.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  for (const [key, value] of Object.entries(bounds)) assert.equal(app.windows.get(1)[key], value);
  assert.equal(app.windows.get(10).state, "normal");
});

test("pinned-window resizing does not replace remembered project geometry", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "work" });
  const bounds = { left: 650, top: 40, width: 1200, height: 900 };
  Object.assign(app.windows.get(1), bounds);
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  await app.api.windows.update(1, { state: "minimized" });
  Object.assign(app.windows.get(10), { left: 0, top: 0, width: 500, height: 600 });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  for (const [key, value] of Object.entries(bounds)) assert.equal(app.windows.get(1)[key], value);
});

test("4 → 5 → Personal copies bounds even when Personal restores asynchronously", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "work" });
  for (const [slot, id] of [[4, "groundtruth"], [5, "inactive"]]) {
    await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: id });
    await app.controller.handle({ type: "assignWorkspaceShortcut", slot, workspaceId: id });
  }
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  app.api.commands.onCommand.emit("workspace-4");
  await app.barrier();
  const fourth = (await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "groundtruth").windowId;
  const bounds = { left: -1100, top: 60, width: 1000, height: 850 };
  Object.assign(app.windows.get(fourth), bounds);
  app.api.commands.onCommand.emit("workspace-5");
  await app.barrier();
  const fifth = (await app.controller.handle({ type: "snapshot" })).workspaces[4].windowId;
  for (const [key, value] of Object.entries(bounds)) assert.equal(app.windows.get(fifth)[key], value);
  const update = app.api.windows.update;
  const get = app.api.windows.get;
  let restoring = false;
  let reads = 0;
  app.api.windows.update = async (id, props) => {
    if (id === 1 && props.state === "normal") {
      restoring = true;
      return get(id); // API promise resolves before the native animation finishes.
    }
    return update(id, props);
  };
  app.api.windows.get = async (id) => {
    if (id === 1 && restoring && ++reads === 4) app.windows.get(1).state = "normal";
    return get(id);
  };
  app.api.commands.onCommand.emit("workspace-1");
  await app.barrier();
  for (const [key, value] of Object.entries(bounds)) assert.equal(app.windows.get(1)[key], value);
  assert.equal(app.windows.get(1).focused, true);
});

test("a restore that never completes reports an error rather than silently skipping resizing", async () => {
  const app = await enabled();
  const update = app.api.windows.update;
  app.api.windows.update = async (id, props) => {
    if (props.state === "normal") return app.api.windows.get(id);
    return update(id, props);
  };
  await assert.rejects(app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" }), /still restoring/);
  assert.equal(app.windows.get(10).state, "minimized");
  const trace = (await app.controller.handle({ type: "snapshot" })).lastWindowSwitch;
  assert.equal(trace.workspaceId, "work");
  assert.equal(trace.before.state, "minimized");
  assert.equal(trace.after, undefined);
});

test("special window states do not participate in geometry copying", async () => {
  for (const state of ["maximized", "fullscreen"]) {
    for (const specialId of [1, 10]) {
      const app = await enabled();
      Object.assign(app.windows.get(1), { left: 10, top: 20, width: 900, height: 800 });
      app.windows.get(specialId).state = state;
      await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
      assert.equal(app.calls.some(([method, , props]) => method === "window.update" && props.width !== undefined), false);
      if (specialId === 10) assert.equal(app.windows.get(10).state, state);
    }
  }
});

test("failed resizing does not prevent focusing the destination", async () => {
  const app = await enabled();
  Object.assign(app.windows.get(1), { left: 10, top: 20, width: 900, height: 800 });
  const update = app.api.windows.update;
  app.api.windows.update = async (id, props) => {
    if (props.width) throw new Error("Cannot resize window");
    return update(id, props);
  };
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  assert.equal(app.windows.get(10).focused, true);
});

test("native focus changes never resize windows", async () => {
  const app = await enabled();
  Object.assign(app.windows.get(1), { left: 10, top: 20, width: 900, height: 800 });
  await app.api.windows.update(10, { state: "normal", focused: true });
  app.api.windows.onFocusChanged.emit(10);
  await app.barrier();
  assert.equal(app.calls.some(([method, , props]) => method === "window.update" && props.width !== undefined), false);
});

test("manually restoring a workspace minimises the old project and keeps the pinned base", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "groundtruth" });
  const projectWindow = (await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "groundtruth").windowId;
  await app.api.windows.update(10, { state: "normal", focused: true });
  app.api.windows.onFocusChanged.emit(10);
  await app.barrier();
  assert.equal(app.windows.get(1).state, "normal");
  assert.equal(app.windows.get(10).state, "normal");
  assert.equal(app.windows.get(projectWindow).state, "minimized");
  assert.equal(app.windows.get(10).focused, true);
  app.calls.length = 0;
  app.api.windows.onFocusChanged.emit(10);
  await app.barrier();
  assert.equal(app.calls.length, 0, "duplicate focus events must not cause repeated edits");
});

test("visiting the pinned base manually or through Rauiri preserves the visible project", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  await app.api.windows.update(1, { focused: true });
  app.api.windows.onFocusChanged.emit(1);
  await app.barrier();
  assert.equal(app.windows.get(10).state, "normal");
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  assert.equal(app.windows.get(10).state, "normal");
  await app.api.windows.update(10, { state: "minimized" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  assert.equal(app.windows.get(10).state, "minimized", "do not undo a manual minimisation");
});

test("stale and unrelated native focus events do not minimise windows", async () => {
  const app = await enabled();
  await app.api.windows.update(10, { state: "normal", focused: true });
  app.calls.length = 0;
  app.api.windows.onFocusChanged.emit(1);
  app.api.windows.onFocusChanged.emit(-1);
  app.api.windows.onFocusChanged.emit(999);
  await app.barrier();
  assert.equal(app.calls.length, 0);
});

test("native reconciliation stops if focus changes while browser reads are pending", async () => {
  const app = await enabled();
  await app.api.windows.update(10, { state: "normal", focused: true });
  let reads = 0;
  app.api.windows.getLastFocused = async () => {
    if (++reads === 1) return { id: 10, focused: true };
    return { id: 1, focused: true };
  };
  app.calls.length = 0;
  app.api.windows.onFocusChanged.emit(10);
  await app.barrier();
  assert.equal(app.calls.length, 0);
  assert.equal(app.windows.get(1).state, "normal");
});

test("native switching respects disabled minimisation", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "setWorkspacePreferences", minimizeOthers: false });
  await app.api.windows.update(10, { state: "normal", focused: true });
  app.api.windows.onFocusChanged.emit(10);
  await app.barrier();
  assert.equal(app.windows.get(1).state, "normal");
});

test("address-bar navigation waits for intent then follows; duplicate completion does not route twice", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "work" });
  app.api.tabs.onUpdated.emit(1, { url: "https://personal.example" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 1);
  const details = { tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "generated", transitionQualifiers: ["from_address_bar", "server_redirect"] };
  app.api.webNavigation.onCommitted.emit(details);
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 10);
  assert.equal(app.tabs.get(1).active, true);
  assert.equal(app.windows.get(10).focused, true);
  app.api.webNavigation.onCommitted.emit(details);
  app.api.tabs.onUpdated.emit(1, { status: "complete" });
  await app.barrier();
  assert.equal(app.calls.filter(([method]) => method === "tab.move").length, 1);
});

test("background and unfocused navigation never steal focus, even with address-bar metadata", async () => {
  for (const background of [true, false]) {
    const app = await enabled();
    await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "work", activate: true });
    if (background) await app.api.tabs.update(3, { active: true });
    else app.windows.get(1).focused = false;
    app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "typed" });
    await app.barrier();
    assert.equal(app.tabs.get(1).windowId, 10);
    assert.equal(app.windows.get(10).focused, false);
  }
});

test("navigation routing ignores subframes and stale events, and follows foreground links only by rule", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "work", activate: true });
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 3, url: "https://personal.example", transitionType: "typed" });
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://old.example", transitionType: "typed" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 1);
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "link" });
  await app.barrier();
  assert.equal(app.windows.get(10).focused, true);
});

test("explicit address-bar intent overrides manual filing but never native pins", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "moveWindowTab", tabId: 1, workspaceId: "work" });
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "personal" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  await app.api.tabs.update(1, { active: true });
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "typed" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 1);
  await app.controller.handle({ type: "addRoute", hostname: "pin.example", contextId: "work" });
  app.api.webNavigation.onCommitted.emit({ tabId: 3, frameId: 0, url: "https://pin.example", transitionType: "typed" });
  await app.barrier();
  assert.equal(app.tabs.get(3).windowId, 1);
});

test("put away saves tabs before closing, clears the pin, and pauses routes until explicit resume", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "work.example", contextId: "work" });
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "work" });
  const remove = app.api.windows.remove;
  app.api.windows.remove = async (id) => {
    assert.equal(app.local.rauiriWindowWorkspaces.workspaces.find((w) => w.id === "work").tabs.length, 1);
    return remove(id);
  };
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  let view = await app.controller.handle({ type: "snapshot" });
  assert.equal(view.pinnedWorkspaceId, null);
  assert.equal(view.routes[0].active, false);
  assert.equal(view.workspaces.find((w) => w.id === "work").windowId, null);
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  const tab = await app.api.tabs.create({ windowId: 1, url: "https://work.example", active: true });
  app.calls.length = 0;
  app.api.webNavigation.onCommitted.emit({ tabId: tab.id, frameId: 0, url: tab.url, transitionType: "typed" });
  await app.barrier();
  assert.equal(app.tabs.get(tab.id).windowId, 1);
  assert.equal(app.calls.some(([method]) => method === "window.create"), false);
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  view = await app.controller.handle({ type: "snapshot" });
  assert.equal(view.routes[0].active, true);
  assert.equal(app.tabs.get(tab.id).windowId, 1, "resuming must not sweep existing tabs");
});

test("manual closure pauses routes and pinning cannot resume a put-away workspace", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "work.example", contextId: "work" });
  await app.api.windows.remove(10);
  await app.barrier();
  assert.equal((await app.controller.handle({ type: "snapshot" })).routes[0].active, false);
  await assert.rejects(app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "work" }), /Resume/);
});

test("put-away fails safely if storage or closing fails", async () => {
  for (const failure of ["storage", "close"]) {
    const app = await enabled();
    if (failure === "storage") app.api.storage.local.set = async () => { throw new Error("Disk full"); };
    else app.api.windows.remove = async () => {}; // A cancelled close leaves its window alive.
    await assert.rejects(app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" }), /Disk full|still open/);
    assert.equal(app.windows.has(10), true);
    assert.equal(app.tabs.has(2), true);
    assert.equal((await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "work").windowId, 10);
    assert.equal(app.calls.some(([method]) => method === "window.remove"), false);
  }
});

test("stale route bindings never restore a closed destination", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "work" });
  app.windows.delete(10);
  app.tabs.delete(2); // Simulate closure before onRemoved has been delivered.
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "typed" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 1);
  assert.equal(app.calls.some(([method]) => method === "window.create"), false);
});

test("adding a route to a put-away workspace does not move existing tabs", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "groundtruth", moveExisting: true });
  assert.equal(app.tabs.get(1).windowId, 1);
  assert.equal(app.calls.some(([method]) => method === "window.create"), false);
});

test("active workspace merge moves actual tabs and native pins, retargets rules, and retains a backup", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "personal" });
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "personal" });
  app.calls.length = 0;
  await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", destinationId: "work", tabs: "move", rules: "move" });
  const view = await app.controller.handle({ type: "snapshot" });
  assert.equal(view.workspaces.some((w) => w.id === "personal"), false);
  assert.equal(view.pinnedWorkspaceId, null);
  assert.equal(view.routes[0].contextId, "work");
  assert.equal(app.tabs.get(1).windowId, 10);
  assert.equal(app.tabs.get(3).windowId, 10);
  assert.equal(app.tabs.get(3).pinned, true);
  assert.equal(app.calls.some(([method]) => method === "tab.create" || method === "window.remove"), false);
  const backup = await app.controller.handle({ type: "exportWorkspaceDeletionBackup" });
  assert.equal(backup.state.workspaces.find((w) => w.id === "personal").tabs.length, 2);
});

test("a failed live merge leaves the source workspace and every live tab recoverable", async () => {
  const app = await enabled();
  const move = app.api.tabs.move;
  app.api.tabs.move = async (id, props) => {
    if (id === 3) throw new Error("Move failed");
    return move(id, props);
  };
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", destinationId: "work", tabs: "move", rules: "move" }), /Move failed/);
  assert.equal(app.tabs.size, 4);
  assert.equal((await app.controller.handle({ type: "snapshot" })).workspaces.some((w) => w.id === "personal"), true);
  assert.equal(app.local.rauiriBeforeWorkspaceDelete.workspaces.find((w) => w.id === "personal").tabs.length, 2);
});

test("put-away workspace tabs and rules can merge into another put-away workspace without opening windows", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "work.example", contextId: "work" });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  app.calls.length = 0;
  await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "work", destinationId: "groundtruth", tabs: "move", rules: "move" });
  assert.equal(app.calls.length, 0);
  const stored = app.local.rauiriWindowWorkspaces;
  assert.equal(stored.workspaces.find((w) => w.id === "groundtruth").tabs[0].url, "https://work.example");
  assert.equal(stored.routes[0].contextId, "groundtruth");
  assert.equal((await app.controller.handle({ type: "snapshot" })).routes[0].active, false);
});

test("put-away deletion can discard tabs while retaining rules at a chosen destination", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "work.example", contextId: "work" });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "work", destinationId: "personal", tabs: "delete", rules: "move" });
  assert.equal(app.local.rauiriWindowWorkspaces.routes[0].contextId, "personal");
  assert.equal(app.tabs.size, 3);
});

test("put-away deletion can discard both remembered tabs and rules with no browser edits", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "work.example", contextId: "work" });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  app.calls.length = 0;
  await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "work", tabs: "delete", rules: "delete" });
  assert.equal(app.calls.length, 0);
  assert.equal(app.local.rauiriWindowWorkspaces.routes.length, 0);
  assert.equal(app.local.rauiriWindowWorkspaces.workspaces.some((w) => w.id === "work"), false);
  const backup = await app.controller.handle({ type: "exportWorkspaceDeletionBackup" });
  assert.equal(backup.state.routes.length, 1);
  assert.equal(backup.state.workspaces.find((w) => w.id === "work").tabs.length, 1);
});

test("a put-away merge into an active destination keeps the full inventory if opening a tab fails", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  const create = app.api.tabs.create;
  app.api.tabs.create = async () => { throw new Error("Cannot create tab"); };
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "work", destinationId: "personal", tabs: "move", rules: "move" }), /Cannot create tab/);
  const target = app.local.rauiriWindowWorkspaces.workspaces.find((w) => w.id === "personal");
  assert.equal(target.tabs.length, 3);
  assert.equal(target.restorePending, true);
  assert.equal(app.local.rauiriWindowWorkspaces.workspaces.some((w) => w.id === "work"), false);
  app.api.tabs.create = create;
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  assert.equal([...app.tabs.values()].filter((tab) => tab.url === "https://work.example").length, 1);
});

test("live merging stops if new tabs appear in its source window", async () => {
  const app = await enabled();
  const move = app.api.tabs.move;
  let added = false;
  app.api.tabs.move = async (id, props) => {
    if (!added) {
      added = true;
      await app.api.tabs.create({ windowId: 1, url: "https://new.example" });
    }
    return move(id, props);
  };
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", destinationId: "work", tabs: "move", rules: "move" }), /New tabs appeared/);
  assert.equal((await app.controller.handle({ type: "snapshot" })).workspaces.some((w) => w.id === "personal"), true);
  assert.equal(app.tabs.size, 5);
});

test("deletion backup failure prevents live tab moves", async () => {
  const app = await enabled();
  const set = app.api.storage.local.set;
  app.api.storage.local.set = async (value) => {
    if (value.rauiriBeforeWorkspaceDelete) throw new Error("Backup failed");
    return set(value);
  };
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", destinationId: "work", tabs: "move", rules: "move" }), /Backup failed/);
  assert.equal(app.calls.some(([method]) => method === "tab.move"), false);
  assert.equal(app.tabs.get(1).windowId, 1);
});

test("a broader active route can match when the more specific workspace is put away", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "addRoute", hostname: "example.com", contextId: "work" });
  await app.controller.handle({ type: "addRoute", hostname: "app.example.com", contextId: "groundtruth" });
  await app.api.tabs.update(1, { url: "https://app.example.com" });
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://app.example.com", transitionType: "typed" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 10);
});

test("deletion rejects live-tab disposal, self-merges, missing choices, and deleting built-in Read Later", async () => {
  const app = await enabled();
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", tabs: "delete", rules: "delete" }), /active workspace/);
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", destinationId: "personal", tabs: "move", rules: "move" }), /different destination/);
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal" }), /Choose what/);
  await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "work", destinationId: "personal", tabs: "move", rules: "move" });
  for (const id of ["groundtruth", "inactive"]) await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: id, tabs: "delete", rules: "delete" });
  await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", destinationId: "read-later", tabs: "move", rules: "move" });
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "read-later", tabs: "delete", rules: "delete" }), /built in/);
});

test("shortcut slots migrate without compacting gaps and validate independently of list order", async () => {
  const app = await enabled();
  const state = structuredClone(app.local.rauiriWindowWorkspaces);
  delete state.shortcutSlots;
  const migrated = validateWindowState(state);
  assert.deepEqual(migrated.shortcutSlots.slice(0, 5), ["personal", "work", "groundtruth", null, "inactive"]);
  migrated.shortcutSlots = ["work", null, "personal", null, null, null, null, null, null];
  migrated.workspaces.reverse();
  assert.equal(validateWindowState(migrated).shortcutSlots[0], "work");
  for (const field of ["shortcutSlots", "closedShortcutSlots"]) {
    for (const invalid of [null, Array(9), ["personal"], ["read-later", ...Array(8).fill(null)], ["personal", "personal", ...Array(7).fill(null)], ["missing", ...Array(8).fill(null)]]) {
      assert.throws(() => validateWindowState({ ...migrated, [field]: invalid }), /shortcut/);
    }
  }
});

test("slot assignment swaps occupied slots, supports gaps, and does not depend on workspace order", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "assignWorkspaceShortcut", slot: 1, workspaceId: "work" });
  let view = await app.controller.handle({ type: "snapshot" });
  assert.deepEqual(view.shortcutSlots.slice(0, 2), ["work", "personal"]);
  await app.controller.handle({ type: "saveContexts", contexts: [...view.contexts].reverse() });
  app.api.commands.onCommand.emit("workspace-1");
  await app.barrier();
  assert.equal(app.windows.get(10).focused, true);
  await app.controller.handle({ type: "assignWorkspaceShortcut", slot: 1, workspaceId: null });
  app.calls.length = 0;
  app.api.commands.onCommand.emit("workspace-1");
  await app.barrier();
  assert.equal(app.calls.length, 0);
  view = await app.controller.handle({ type: "snapshot" });
  assert.equal(view.shortcutSlots[1], "personal");
  assert.equal(view.workspaces.find((w) => w.id === "read-later").shortcut, 0);
  assert.equal(view.workspaces.find((w) => w.id === "work").shortcut, null);
});

test("putting away clears only its own slot and resume does not reclaim it", async () => {
  const app = await enabled();
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  assert.deepEqual((await app.controller.handle({ type: "snapshot" })).shortcutSlots.slice(0, 2), ["personal", null]);
  app.calls.length = 0;
  app.api.commands.onCommand.emit("workspace-2");
  await app.barrier();
  assert.equal(app.calls.length, 0);
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  assert.equal((await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "work").shortcut, null);
});

test("native browser restoration restores shortcut slots, but explicit resume does not", async (t) => {
  const app = await enabled();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const restoredWindows = structuredClone([...app.windows.entries()]);
  const restoredTabs = structuredClone([...app.tabs.entries()]);
  for (const id of [...app.windows.keys()]) await app.api.windows.remove(id);
  await app.barrier();
  assert.deepEqual(app.local.rauiriWindowWorkspaces.shortcutSlots.slice(0, 2), [null, null]);
  for (const [id, window] of restoredWindows) app.windows.set(id, window);
  for (const [id, tab] of restoredTabs) app.tabs.set(id, tab);
  delete app.session.rauiriWorkspaceWindows;
  const restarted = createWindowWorkspaces(app.api);
  await restarted.ready;
  await restarted.start();
  assert.deepEqual((await restarted.handle({ type: "snapshot" })).shortcutSlots.slice(0, 2), ["personal", "work"]);
  assert.equal(app.local.rauiriWindowWorkspaces.closedShortcutSlots.every((id) => id === null), true);
});

test("backup import remains usable with built-in Read Later open and preserves its live tabs", async () => {
  const app = await enabled();
  const readingId = (await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "read-later").windowId;
  const live = await app.api.tabs.create({ windowId: readingId, url: "https://reading.example/live", pinned: true });
  const backup = structuredClone(await app.controller.handle({ type: "exportBackup" }));
  backup.state.workspaces.find((w) => w.id === "read-later").tabs = [{ url: "https://reading.example/imported", title: "Imported", pinned: false, routeOverride: false }];
  await assert.rejects(app.controller.handle({ type: "importBackup", backup }), /Put away other/);
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  await app.controller.handle({ type: "importBackup", backup });
  assert.equal(app.tabs.get(live.id).pinned, true);
  assert.equal(app.tabs.get(live.id).windowId, readingId);
  assert.equal([...app.tabs.values()].filter((tab) => tab.url === "https://reading.example/imported").length, 1);
  assert.equal(app.windows.size, 1);
  assert.equal((await app.controller.handle({ type: "snapshot" })).shortcutSlots.every((id) => id === null), true);
});

test("inactive workspaces and Read Later cannot be assigned to ordinary slots", async () => {
  const app = await enabled();
  await assert.rejects(app.controller.handle({ type: "assignWorkspaceShortcut", slot: 0, workspaceId: "work" }), /1 to 9/);
  await assert.rejects(app.controller.handle({ type: "assignWorkspaceShortcut", slot: 3, workspaceId: "read-later" }), /slot 0/);
  await assert.rejects(app.controller.handle({ type: "assignWorkspaceShortcut", slot: 3, workspaceId: "groundtruth" }), /Resume/);
});

test("Read Later is restored to old state, protected from removal, and permanently uses slot zero", async () => {
  const app = await enabled();
  const state = structuredClone(app.local.rauiriWindowWorkspaces);
  state.workspaces = state.workspaces.filter((w) => w.id !== "read-later");
  assert.equal(validateWindowState(state).workspaces.at(-1).id, "read-later");
  await assert.rejects(app.controller.handle({ type: "putAwayWorkspace", workspaceId: "read-later" }), /built in/);
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "read-later", destinationId: "work", tabs: "move", rules: "move" }), /built in/);
  const view = await app.controller.handle({ type: "snapshot" });
  view.contexts.find((w) => w.id === "read-later").title = "Other name";
  await assert.rejects(app.controller.handle({ type: "saveContexts", contexts: view.contexts }), /name is fixed/);
  app.api.commands.onCommand.emit("workspace-10");
  await app.barrier();
  const windowId = (await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "read-later").windowId;
  assert.equal(app.windows.get(windowId).focused, true);
});

test("manually closing Read Later recreates it without stealing focus and preserves its remembered tabs", async (t) => {
  const app = await enabled();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldId = (await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "read-later").windowId;
  const tab = await app.api.tabs.create({ windowId: oldId, url: "https://reading.example" });
  app.api.tabs.onUpdated.emit(tab.id, { title: "Reading" });
  t.mock.timers.tick(100);
  await app.barrier();
  await app.api.windows.remove(oldId);
  await app.barrier();
  t.mock.timers.tick(300);
  await app.barrier();
  const newId = (await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "read-later").windowId;
  assert.notEqual(newId, oldId);
  assert.equal(app.windows.get(newId).state, "minimized");
  assert.equal(app.windows.get(1).focused, true);
  assert.equal([...app.tabs.values()].filter((item) => item.url === "https://reading.example").length, 1);
});

test("closing every window does not make Read Later fight browser shutdown", async (t) => {
  const app = await enabled();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const id of [...app.windows.keys()]) await app.api.windows.remove(id);
  await app.barrier();
  t.mock.timers.tick(300);
  await app.barrier();
  assert.equal(app.windows.size, 0);
  const window = await app.api.windows.create({ focused: true });
  app.api.windows.onCreated.emit(window);
  await app.barrier();
  t.mock.timers.tick(300);
  await app.barrier();
  assert.notEqual((await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "read-later").windowId, null);
});

test("browser restart reconnects exact inventories but leaves ambiguous windows unassigned", async () => {
  const app = await enabled();
  delete app.session.rauiriWorkspaceWindows;
  const restarted = createWindowWorkspaces(app.api);
  await restarted.ready;
  await restarted.start();
  assert.equal((await restarted.handle({ type: "snapshot", windowId: 10 })).currentWorkspaceId, "work");
  delete app.session.rauiriWorkspaceWindows;
  app.windows.set(99, { id: 99, type: "normal", incognito: false, state: "normal" });
  await app.api.tabs.create({ windowId: 99, url: "https://work.example" });
  const ambiguous = createWindowWorkspaces(app.api);
  await ambiguous.ready;
  await ambiguous.start();
  const view = await ambiguous.handle({ type: "snapshot", windowId: 10 });
  assert.equal(view.workspaces.find((w) => w.id === "work").windowId, null);
  assert.equal(app.calls.some(([method]) => method === "window.create"), false);
});
