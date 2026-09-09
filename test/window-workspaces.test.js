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
      getLastFocused: async () => ({ ...[...windows.values()].find((window) => window.focused) }),
      onFocusChanged: event(), onRemoved: event(),
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

test("migration moves existing tabs, keeps pins and retains the original backup", async () => {
  const app = await enabled();
  const view = await app.controller.handle({ type: "snapshot", windowId: 1 });
  assert.equal(view.currentWorkspaceId, "personal");
  assert.equal(view.workspaces.find((w) => w.id === "work").windowId, 10);
  assert.equal(app.tabs.get(2).windowId, 10);
  assert.equal(app.tabs.get(3).pinned, true);
  assert.equal(app.tabs.size, 3);
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
  const original = structuredClone(route);
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
