import test from "node:test";
import assert from "node:assert/strict";
import { connected } from "./helpers/browser.js";

// Agreed seam: controller messages and Chrome events, observed through snapshots,
// backups, and the browser's tab/window state (never controller internals).

test("saved workspace names and colours survive worker reload without changing page inventories", async () => {
  const app = await connected();
  const view = await app.controller.handle({ type: "snapshot" });
  await app.controller.handle({ type: "saveWorkspaceDetails", workspaces: view.workspaces.map((workspace) =>
    workspace.id === "work" ? { ...workspace, title: "  Client work  ", color: "purple" } : workspace) });
  await app.restart().ready;
  const backup = await app.controller.handle({ type: "exportBackup" });
  const work = backup.state.workspaces.find((workspace) => workspace.id === "work");
  assert.equal(work.title, "Client work");
  assert.equal(work.color, "purple");
  assert.deepEqual(work.tabs.map((tab) => tab.url), ["https://work.example"]);
});

test("removing a real route persists across reload and stops matching pages from being filed", async () => {
  const app = await connected();
  await app.controller.handle({ type: "addRoute", hostname: "https://PERSONAL.example/path", contextId: "work" });
  const { routes } = await app.controller.handle({ type: "snapshot" });
  assert.equal(routes[0].hostname, "personal.example");
  await app.controller.handle({ type: "removeRoute", routeId: routes[0].id });
  await app.restart().ready;
  assert.deepEqual((await app.controller.handle({ type: "snapshot" })).routes, []);
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "typed" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 1);
  assert.equal(app.windows.get(1).focused, true);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("temporarily locked browser edits retry and eventually focus the requested workspace", async (t) => {
  const app = await connected();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const update = app.api.windows.update;
  let locked = 2;
  app.api.windows.update = async (id, props) => {
    if (id === 10 && props.state === "normal" && locked-- > 0) throw new Error("Tabs cannot be edited right now");
    return update(id, props);
  };
  const switching = app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  await flush();
  t.mock.timers.tick(150);
  await flush();
  t.mock.timers.tick(150);
  await switching;
  assert.equal(app.windows.get(10).focused, true);
  assert.equal(app.windows.get(10).state, "normal");
  assert.equal(app.tabs.get(2).url, "https://work.example");
});

test("a timed-out window creation blocks duplicate edits, keeps reads usable, and resumes its late result once", async (t) => {
  const app = await connected();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  const gate = deferred();
  const create = app.api.windows.create;
  app.api.windows.create = async (props) => { await gate.promise; return create(props); };
  const switching = app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  const failed = assert.rejects(switching, /timed out/);
  await flush();
  t.mock.timers.tick(2000);
  await failed;
  const view = await app.controller.handle({ type: "snapshot" });
  assert.equal(view.workspaces.find((w) => w.id === "work").tabCount, 1);
  const backup = await app.controller.handle({ type: "exportBackup" });
  assert.equal(backup.snapshot.fresh, false);
  assert.deepEqual(backup.state.workspaces.find((w) => w.id === "work").tabs.map((tab) => tab.url), ["https://work.example"]);
  await assert.rejects(app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" }), /edit is still pending/);
  gate.resolve();
  await flush();
  await app.barrier();
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  const resumed = (await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "work");
  assert.equal(app.windows.get(resumed.windowId).focused, true);
  assert.equal(app.windows.size, 3);
  assert.deepEqual([...app.tabs.values()].filter((tab) => tab.windowId === resumed.windowId).map((tab) => tab.url), ["https://work.example"]);
});

test("a late rejected browser edit releases the lock so the user can retry safely", async (t) => {
  const app = await connected();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred();
  const update = app.api.windows.update;
  app.api.windows.update = () => gate.promise;
  const switching = app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  const failed = assert.rejects(switching, /timed out/);
  await flush();
  t.mock.timers.tick(2000);
  await failed;
  gate.reject(new Error("Window restore failed"));
  app.api.windows.update = update;
  await flush();
  await app.barrier();
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  assert.equal(app.windows.get(10).focused, true);
  assert.equal(app.windows.size, 3);
  assert.equal(app.tabs.get(2).url, "https://work.example");
});

test("a failed fresh source read prevents a live merge and leaves every page in place", async () => {
  const app = await connected();
  const get = app.api.windows.get;
  app.api.windows.get = async (id) => {
    if (id === 1) throw new Error("Fresh inventory unavailable");
    return get(id);
  };
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", destinationId: "work", tabs: "move", rules: "move" }), /Fresh inventory/);
  assert.equal(app.tabs.get(1).windowId, 1);
  assert.equal(app.tabs.get(3).windowId, 1);
  assert.equal(app.tabs.get(3).pinned, true);
  assert.equal((await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "personal").tabCount, 2);
});

test("an unreadable live Read Later inventory prevents import without replacing state or closing pages", async () => {
  const app = await connected();
  const reading = await app.api.tabs.create({ windowId: 11, url: "https://reading.example/live", pinned: true });
  const incoming = await app.controller.handle({ type: "exportBackup" });
  incoming.state.workspaces.find((w) => w.id === "work").title = "Imported work";
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  const get = app.api.windows.get;
  app.api.windows.get = async (id) => {
    if (id === 11) throw new Error("Reading inventory unavailable");
    return get(id);
  };
  await assert.rejects(app.controller.handle({ type: "importBackup", backup: incoming }), /Reading inventory/);
  assert.equal((await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "work").title, "Work");
  assert.equal(app.tabs.get(reading.id).url, "https://reading.example/live");
  assert.equal(app.tabs.get(reading.id).pinned, true);
  assert.equal(app.windows.has(11), true);
  await assert.rejects(app.controller.handle({ type: "exportPreviousBackup" }), /No saved restore point/);
});

test("a failed import commit retains both the current configuration and the preceding restore point", async () => {
  const app = await connected();
  const incoming = await app.controller.handle({ type: "exportBackup" });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  await app.controller.handle({ type: "importBackup", backup: incoming });
  const before = await app.controller.handle({ type: "exportBackup" });
  const restorePoint = await app.controller.handle({ type: "exportPreviousBackup" });
  const replacement = structuredClone(before);
  replacement.state.workspaces.find((w) => w.id === "work").title = "Should not stick";
  const set = app.api.storage.local.set;
  app.api.storage.local.set = async (values) => {
    if (values.rauiriBeforeWorkspaceImport) throw new Error("Import commit failed");
    return set(values);
  };
  await assert.rejects(app.controller.handle({ type: "importBackup", backup: replacement }), /Import commit failed/);
  app.api.storage.local.set = set;
  await app.barrier();
  const after = await app.controller.handle({ type: "exportBackup" });
  assert.deepEqual(after.state, before.state);
  assert.deepEqual((await app.controller.handle({ type: "exportPreviousBackup" })).state, restorePoint.state);
  assert.equal(app.windows.has(11), true);
});

function attachmentEvents(app) {
  const move = app.api.tabs.move;
  app.api.tabs.move = async (tabId, props) => {
    const oldWindowId = app.tabs.get(tabId).windowId;
    const tab = await move(tabId, props);
    app.api.tabs.onDetached.emit(tabId, { oldWindowId });
    app.api.tabs.onAttached.emit(tabId, { newWindowId: props.windowId });
    return tab;
  };
}

test("native dragging exempts only the manually filed duplicate URL, including after worker reload", async () => {
  const app = await connected();
  attachmentEvents(app);
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "personal" });
  const ordinary = await app.api.tabs.create({ windowId: 10, url: "https://personal.example" });
  await app.api.tabs.move(1, { windowId: 10, index: -1 }); // Chrome, not a Rauiri command.
  await app.barrier();
  const backup = await app.controller.handle({ type: "exportBackup" });
  assert.deepEqual(backup.state.workspaces.find((w) => w.id === "work").tabs.filter((tab) => tab.url === "https://personal.example").map((tab) => tab.routeOverride), [false, true]);
  await app.restart().ready;
  for (const tabId of [1, ordinary.id]) {
    app.api.webNavigation.onHistoryStateUpdated.emit({ tabId, frameId: 0, url: "https://personal.example", transitionType: "link" });
  }
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 10);
  assert.equal(app.tabs.get(ordinary.id).windowId, 1);
});

test("automatic attachment events do not turn routed pages into manual exemptions", async () => {
  const app = await connected();
  attachmentEvents(app);
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "work" });
  const { routes } = await app.controller.handle({ type: "snapshot" });
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "link" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 10);
  await app.controller.handle({ type: "updateRouteDestination", routeId: routes[0].id, contextId: "personal" });
  app.api.webNavigation.onHistoryStateUpdated.emit({ tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "link" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 1);
});

test("incognito and unassigned windows are never adopted, captured, or routed", async () => {
  const app = await connected();
  await app.controller.handle({ type: "addRoute", hostname: "private.example", contextId: "personal" });
  // A stale session ID now points at an incognito window after browser restart.
  app.windows.get(10).incognito = true;
  Object.assign(app.tabs.get(2), { url: "https://private.example/incognito", incognito: true });
  app.windows.set(99, { id: 99, type: "normal", incognito: false, state: "normal" });
  const unassigned = await app.api.tabs.create({ windowId: 99, url: "https://private.example/unassigned" });
  await app.restart().ready;
  for (const [tabId, url] of [[2, "https://private.example/incognito"], [unassigned.id, "https://private.example/unassigned"]]) {
    app.api.webNavigation.onCommitted.emit({ tabId, frameId: 0, url, transitionType: "typed" });
  }
  await app.barrier();
  assert.equal(app.tabs.get(2).windowId, 10);
  assert.equal(app.tabs.get(unassigned.id).windowId, 99);
  assert.equal((await app.controller.handle({ type: "snapshot", windowId: 10 })).managed, false);
  assert.equal((await app.controller.handle({ type: "snapshot", windowId: 99 })).managed, false);
  await assert.rejects(app.controller.handle({ type: "attachWorkspaceWindow", workspaceId: "work", windowId: 10 }), /non-incognito/);
  const backup = await app.controller.handle({ type: "exportBackup" });
  assert.equal(JSON.stringify(backup.state).includes("https://private.example/"), false);
});

test("malformed imported pages, workspace IDs and routes are rejected without replacing saved state", async () => {
  const app = await connected();
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  const before = await app.controller.handle({ type: "exportBackup" });
  for (const corrupt of [
    (state) => { state.workspaces[0].tabs[0].url = "javascript:alert(1)"; },
    (state) => { state.workspaces[1].id = state.workspaces[0].id; },
    (state) => { state.routes = [{ id: "bad-route", hostname: "example.com", contextId: "missing", activate: false }]; },
  ]) {
    const backup = structuredClone(before);
    corrupt(backup.state);
    await assert.rejects(app.controller.handle({ type: "importBackup", backup }), /Invalid/);
    assert.deepEqual((await app.controller.handle({ type: "exportBackup" })).state, before.state);
  }
  await assert.rejects(app.controller.handle({ type: "exportPreviousBackup" }), /No saved restore point/);
});

test("a permanently locked browser gives up within a bounded retry budget without moving focus", async (t) => {
  const app = await connected();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  app.api.windows.update = async () => { throw new Error("Tabs cannot be edited right now"); };
  let outcome;
  void app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" }).then(
    () => { outcome = "unexpected success"; },
    (error) => { outcome = error; },
  );
  await flush();
  for (let tick = 0; tick < 10; tick++) { t.mock.timers.tick(150); await flush(); }
  assert.ok(outcome instanceof Error, "The edit must fail rather than retry indefinitely");
  assert.match(outcome.message, /cannot be edited right now/);
  assert.equal(app.windows.get(1).focused, true);
  assert.equal(app.windows.get(10).state, "minimized");
  assert.equal(app.tabs.get(2).url, "https://work.example");
});

test("creating a workspace opens and focuses its own window without touching existing pages", async () => {
  const app = await connected();
  await app.controller.handle({ type: "createWindowWorkspace", title: "  Client project  " });
  const view = await app.controller.handle({ type: "snapshot" });
  const created = view.workspaces.find((workspace) => workspace.title === "Client project");
  assert.ok(created);
  assert.ok(Number.isInteger(created.windowId));
  assert.equal(app.windows.get(created.windowId).focused, true);
  assert.equal(app.windows.get(1).focused, false);
  assert.equal(app.tabs.get(1).url, "https://personal.example");
  assert.equal(app.tabs.get(3).pinned, true);
  await app.restart().ready;
  assert.equal((await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === created.id).windowId, created.windowId);
});
