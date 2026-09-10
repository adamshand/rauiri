import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import * as domain from "../src/domain.js";
import { createWindowWorkspaces } from "../src/window-workspaces.js";

const source = (await fs.readFile(new URL("../src/background.js", import.meta.url), "utf8"))
  .replace(/^import \{[\s\S]*?\} from "\.\/domain\.js";/, "")
  .replace('import { createWindowWorkspaces } from "./window-workspaces.js";', "");

async function harness({ stored = domain.createInitialState(), discover = async () => [] } = {}) {
  const storage = { rauiriState: structuredClone(stored) };
  const event = () => {
    const listeners = [];
    return { addListener: (listener) => listeners.push(listener), emit: (...args) => listeners.forEach((listener) => listener(...args)) };
  };
  const chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: structuredClone(storage[key]) }),
        set: async (value) => Object.assign(storage, structuredClone(value)),
      },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    commands: { onCommand: event() },
    webNavigation: { onCommitted: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() },
    alarms: { get: async () => ({}), onAlarm: event() },
    windows: {
      getAll: discover,
      get: async (id) => ({ id, type: "normal", incognito: false, tabs: [] }),
      onFocusChanged: event(), onRemoved: event(),
    },
    tabs: {
      query: async () => [],
      onActivated: event(), onCreated: event(), onUpdated: event(), onRemoved: event(),
      onAttached: event(), onDetached: event(), onMoved: event(),
    },
    tabGroups: { query: async () => [], onUpdated: event(), TAB_GROUP_ID_NONE: -1 },
    runtime: {
      id: "test", getURL: (path) => `chrome-extension://test/${path}`,
      getManifest: () => ({ version: "0.2.3" }),
      onInstalled: event(), onStartup: event(), onMessage: event(),
    },
  };
  const context = vm.createContext({ ...domain, createWindowWorkspaces, chrome, console: { warn() {} }, setTimeout, clearTimeout, crypto });
  vm.runInContext(source, context);
  await vm.runInContext("ready", context);
  return { storage, chrome, evaluate: (code) => vm.runInContext(code, context) };
}

test("durable state loads even while browser discovery never resolves", async () => {
  const app = await harness({ discover: () => new Promise(() => {}) });
  const snapshot = await app.evaluate("currentSnapshot(1)");
  assert.equal(snapshot.contexts.length, 3);
  assert.equal(app.evaluate("backupSnapshot().format"), "rauiri-backup");
  const response = await new Promise((resolve) => app.chrome.runtime.onMessage.emit(
    { type: "configurationSnapshot" },
    { id: "test", url: "chrome-extension://test/options/options.html" },
    resolve,
  ));
  assert.equal(response.ok, true);
  assert.equal(response.result.contexts.length, 3);
});

test("commands from non-UI senders are rejected", async () => {
  const app = await harness();
  const response = await new Promise((resolve) => app.chrome.runtime.onMessage.emit(
    { type: "adoptWindow", windowId: 1 }, { id: "test", url: "https://example.com" }, resolve,
  ));
  assert.equal(response.ok, false);
  assert.match(response.error, /popup or Settings/);
});

test("legacy route destination edits validate and preserve the saved rule", async () => {
  const stored = domain.createInitialState();
  stored.routes = [{ id: "route", hostname: "example.com", contextId: "personal" }];
  const app = await harness({ stored });
  const send = (routeId, contextId) => new Promise((resolve) => app.chrome.runtime.onMessage.emit(
    { type: "updateRouteDestination", routeId, contextId },
    { id: "test", url: "chrome-extension://test/options/options.html" }, resolve,
  ));
  assert.equal((await send("route", "work")).ok, true);
  assert.deepEqual(app.storage.rauiriState.routes, [{ ...stored.routes[0], contextId: "work" }]);
  assert.equal((await send("route", "missing")).ok, false);
  assert.equal((await send("missing", "personal")).ok, false);
  assert.equal(app.storage.rauiriState.routes[0].contextId, "work");
});

test("browser initialization rejection does not poison later commands", async () => {
  const app = await harness({ discover: async () => { throw new Error("browser unavailable"); } });
  assert.equal(await app.evaluate("run(() => 42)"), 42);
});

test("adoption saves missing records even when presentation fails", async () => {
  const stored = domain.createInitialState();
  stored.records.lost = { id: "lost", url: "https://lost.example", contextId: "work", attention: "current" };
  const app = await harness({ stored });
  await app.evaluate("operation");
  app.evaluate("enforcePresentation = async () => { throw new Error('tab strip locked'); }");
  await assert.rejects(app.evaluate("adoptWindow(1)"), /tab strip locked/);
  assert.equal(app.storage.rauiriState.records.lost.url, "https://lost.example");
});

test("invalid import leaves state and storage untouched", async () => {
  const app = await harness();
  await app.evaluate("operation");
  const before = structuredClone(app.storage);
  await assert.rejects(app.evaluate("importBackup({})"), /supported Rauiri backup/);
  assert.deepEqual(app.storage, before);
});

test("valid import retains an exportable rollback backup", async () => {
  const app = await harness();
  await app.evaluate("operation");
  await app.evaluate("importBackup(createBackup({ ...state, routes: [{ id: 'r', hostname: 'example.com', contextId: 'work' }] }))");
  assert.equal(app.storage.rauiriState.routes.length, 1);
  assert.equal(app.storage.rauiriBeforeImport.state.routes.length, 0);
});

test("only collapsed-to-expanded group transitions trigger accordion selection", async () => {
  const app = await harness();
  await app.evaluate("operation");
  app.evaluate("globalThis.selections = 0; enforceAccordion = async () => { selections++; }");
  const update = (collapsed, title) => app.chrome.tabGroups.onUpdated.emit({ id: 10, windowId: 1, collapsed, title });
  update(false, "Personal");
  update(false, "Renamed");
  await app.evaluate("operation");
  assert.equal(app.evaluate("selections"), 0);
  update(true, "Renamed");
  update(false, "Renamed");
  await app.evaluate("operation");
  assert.equal(app.evaluate("selections"), 1);
});

test("timeouts never replay an unknown edit and re-observe after late completion", async () => {
  const app = await harness();
  await app.evaluate("operation");
  app.evaluate("globalThis.reconciled = 0; reconcileManagedWindow = async () => { reconciled++; }");
  const pending = app.evaluate("browserEditAttempt(() => new Promise(resolve => { globalThis.finish = resolve; }), 5)");
  await assert.rejects(pending, /timed out/);
  await assert.rejects(app.evaluate("browserEditAttempt(() => 42)"), /still pending/);
  app.evaluate("finish()");
  await new Promise((resolve) => setImmediate(resolve));
  await app.evaluate("operation");
  assert.equal(app.evaluate("reconciled"), 1);
  assert.equal(await app.evaluate("browserEditAttempt(() => 42)"), 42);
});

test("adding a broad route does not steal tabs from a more specific route", async () => {
  const stored = domain.createInitialState();
  stored.routes = [{ id: "specific", hostname: "white.haume.nz", contextId: "work" }];
  const app = await harness({ stored });
  await app.evaluate("operation");
  app.evaluate("state.managedWindowId = 1; globalThis.presentations = 0; presentTab = async () => { presentations++; }");
  app.chrome.tabs.query = async () => [{ id: 3, windowId: 1, url: "https://app.white.haume.nz", active: false }];
  await app.evaluate("addRoute('haume.nz', 'personal', true)");
  assert.equal(app.evaluate("presentations"), 0);
});

test("tab commands reject other windows and unknown contexts", async () => {
  const app = await harness();
  await app.evaluate("operation");
  app.evaluate("state.managedWindowId = 1");
  app.chrome.tabs.get = async () => ({ id: 3, windowId: 2, url: "https://example.com" });
  await assert.rejects(app.evaluate("moveTabToShelf(3)"), /not in Rauiri/);
  await assert.rejects(app.evaluate("moveTabToContext(3, 'missing')"), /valid context/);
});

test("window transfers remove stale associations and restore them on return", async () => {
  const app = await harness();
  await app.evaluate("operation");
  app.evaluate("state.managedWindowId = 1; state.records.r = { id: 'r', contextId: 'work', url: 'https://example.com' }; tabRecords.set(3, 'r'); presentTab = async () => {};");
  app.chrome.tabs.onDetached.emit(3, { oldWindowId: 1 });
  await app.evaluate("operation");
  assert.equal(app.evaluate("tabRecords.has(3)"), false);
  app.chrome.tabs.get = async () => ({ id: 3, windowId: 1, url: "https://example.com" });
  app.chrome.tabs.onAttached.emit(3, { newWindowId: 1 });
  await app.evaluate("operation");
  assert.equal(app.evaluate("tabRecords.get(3)"), "r");
});

test("workspace capture saves only selected web URLs and deduplicates them", async () => {
  const app = await harness();
  await app.evaluate("operation");
  app.evaluate("state.managedWindowId = 1");
  app.chrome.tabs.query = async (query) => {
    assert.equal(query.windowId, 1);
    assert.equal(query.highlighted, true);
    return [
      { id: 1, url: "https://client.example", title: "Client" },
      { id: 2, url: "https://client.example", title: "Client copy" },
      { id: 3, url: "chrome://settings", title: "Settings" },
    ];
  };
  const result = await app.evaluate("saveWorkspace({ title: 'Client A', contextId: 'work' })");
  assert.equal(result.saved, 1);
  assert.equal(app.storage.rauiriState.workspaces[0].pages[0].url, "https://client.example");
  assert.equal(app.evaluate("backupSnapshot(true).state.workspaces.length"), 0);
});

test("opening a workspace adds missing pages once without reassigning existing tabs", async () => {
  const stored = domain.createInitialState();
  stored.workspaces = [{ id: "client", title: "Client A", contextId: "work", pages: [
    { url: "https://existing.example", title: "Existing" },
    { url: "https://new.example", title: "New" },
  ] }];
  const app = await harness({ stored });
  await app.evaluate("operation");
  const tabs = [{ id: 1, windowId: 1, url: "https://existing.example", active: true }];
  app.chrome.tabs.query = async () => tabs;
  app.chrome.tabs.create = async (props) => {
    const tab = { ...props, id: tabs.length + 1 };
    tabs.push(tab);
    return tab;
  };
  app.chrome.tabs.update = async (id) => tabs.find((tab) => tab.id === id);
  app.evaluate("state.managedWindowId = 1; state.records.existing = { id: 'existing', contextId: 'personal', url: 'https://existing.example' }; tabRecords.set(1, 'existing'); globalThis.presented = []; presentTab = async (tab) => { presented.push(tab.id); }");
  assert.equal((await app.evaluate("openWorkspace('client')")).opened, 1);
  assert.equal((await app.evaluate("openWorkspace('client')")).opened, 0);
  assert.equal(tabs.length, 2);
  assert.equal(app.evaluate("recordForTab(1).contextId"), "personal");
  assert.equal(app.evaluate("recordForTab(2).contextId"), "work");
  assert.equal(app.evaluate("presented.includes(1)"), false);
});

test("automatic shelving rechecks eligibility before moving a newly active tab", async () => {
  const app = await harness();
  await app.evaluate("operation");
  app.evaluate("state.managedWindowId = 1; presentTab = async () => { throw new Error('must not move active tab'); }");
  app.chrome.tabs.get = async () => ({ id: 1, windowId: 1, url: "https://example.com", active: true, lastAccessed: 0 });
  await app.evaluate("moveTabToShelf(1, 'inactive')");
  assert.equal(app.evaluate("recordForTab(1).attention"), "current");
});

test("automatic shelving uses Inactive and routing does not issue a focus switch", async () => {
  const app = await harness();
  await app.evaluate("operation");
  app.evaluate("state.managedWindowId = 1; globalThis.shelf = null; moveTabToShelf = async (_, attention) => { shelf = attention; };");
  app.chrome.tabs.query = async () => [{ id: 1, windowId: 1, url: "https://old.example", lastAccessed: 0 }];
  await app.evaluate("runSweep()");
  assert.equal(app.evaluate("shelf"), "inactive");
  app.evaluate("state.routes = [{ id: 'route', hostname: 'old.example', contextId: 'work' }]; presentTab = async () => {}; switchContext = async () => { throw new Error('routing must not focus'); }");
  await app.evaluate("applyRouting({ id: 1, url: 'https://old.example', active: true }, recordForTab(1))");
  assert.equal(app.evaluate("recordForTab(1).contextId"), "work");
  assert.equal(app.evaluate("state.activeContextId"), "personal");
});
