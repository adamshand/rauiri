import test from "node:test";
import assert from "node:assert/strict";
import { pageOverlap, validateWindowState } from "../src/window-workspaces.js";
import { harness, connected } from "./helpers/browser.js";

test("attaching keeps the previous inventory only in the downloadable restore point", async () => {
  const app = await connected();
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  const before = structuredClone(app.local.rauiriWindowWorkspaces);
  app.windows.set(99, { id: 99, type: "normal", incognito: false, state: "normal" });
  await app.api.tabs.create({ windowId: 99, url: "https://attached.example" });
  await app.controller.handle({ type: "attachWorkspaceWindow", workspaceId: "work", windowId: 99 });
  const backup = await app.controller.handle({ type: "exportAttachBackup" });
  assert.deepEqual(backup.state, before);
  const current = app.local.rauiriWindowWorkspaces.workspaces.find((workspace) => workspace.id === "work");
  assert.deepEqual(current.tabs.map((tab) => tab.url), ["https://attached.example"]);
  assert.equal("savedBeforeAttach" in current, false);
});

test("put-away refuses to close when its fresh inventory cannot be read", async () => {
  const app = await connected();
  const tab = await app.api.tabs.create({ windowId: 10, url: "https://unsaved.example", title: "Unsaved" });
  const get = app.api.windows.get;
  app.api.windows.get = async (id) => {
    if (id === 10 && app.windows.has(id)) throw new Error("Temporary browser read failure");
    return get(id);
  };
  await assert.rejects(app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" }), /read failure/);
  assert.equal(app.windows.has(10), true);
  assert.equal(app.tabs.has(tab.id), true);
});

test("extension reload retains missing pages from an interrupted restore", async () => {
  const app = await connected();
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "personal" });
  const create = app.api.tabs.create;
  app.api.tabs.create = async (props) => {
    if (props.url === "https://pin.example") throw new Error("Interrupted restore");
    return create(props);
  };
  await assert.rejects(app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" }), /Interrupted/);
  delete app.session.rauiriWorkspaceWindows;
  app.api.tabs.create = create;
  const restarted = app.restart();
  await restarted.ready;
  const workspace = (await restarted.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "personal");
  assert.equal(workspace.restoring, true);
  assert.equal(workspace.tabCount, 2);
  await restarted.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  assert.equal([...app.tabs.values()].filter((tab) => tab.url === "https://pin.example").length, 1);
});

test("manual filing survives a worker restart without changing navigation intent", async () => {
  const app = await connected();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "personal" });
  await app.controller.handle({ type: "moveWindowTab", tabId: 1, workspaceId: "work" });
  const restarted = app.restart();
  await restarted.ready;
  const backup = await restarted.handle({ type: "exportBackup" });
  assert.equal(backup.state.workspaces.find((w) => w.id === "work").tabs.find((tab) => tab.url === "https://personal.example").routeOverride, true);
  app.api.webNavigation.onHistoryStateUpdated.emit({ tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "link" });
  await restarted.handle({ type: "setWorkspacePreferences", minimizeOthers: true });
  assert.equal(app.tabs.get(1).windowId, 10);
});

test("captures during native window closure retain the complete remembered inventory", async () => {
  const app = await connected();
  app.tabs.delete(1);
  app.api.tabs.onRemoved.emit(1, { isWindowClosing: true, windowId: 1 });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  await app.api.windows.remove(1);
  await app.barrier();
  const backup = await app.controller.handle({ type: "exportBackup" });
  assert.deepEqual(backup.state.workspaces.find((w) => w.id === "personal").tabs.map((tab) => tab.url), ["https://personal.example", "https://pin.example"]);
});

test("failed configuration saves are neither published nor committed by later commands", async () => {
  const app = await connected();
  const set = app.api.storage.local.set;
  app.api.storage.local.set = async () => { throw new Error("Disk full"); };
  await assert.rejects(app.controller.handle({ type: "addRoute", hostname: "failed.example", contextId: "work" }), /Disk full/);
  assert.deepEqual((await app.controller.handle({ type: "snapshot" })).routes, []);
  app.api.storage.local.set = set;
  await app.barrier();
  assert.deepEqual((await app.controller.handle({ type: "exportBackup" })).state.routes, []);
});

test("settings and cached backups stay available while startup discovery hangs", async () => {
  const app = await connected();
  app.api.windows.getAll = () => new Promise(() => {});
  const restarted = app.restart();
  const snapshot = await Promise.race([
    restarted.handle({ type: "snapshot" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Settings blocked by browser discovery")), 100)),
  ]);
  assert.equal(snapshot.connecting, true);
  const backup = await restarted.handle({ type: "exportBackup" });
  assert.equal(backup.snapshot.fresh, false);
  assert.equal(backup.state.workspaces.find((w) => w.id === "personal").tabs.length, 2);
});

test("full export captures live pages before the capture debounce fires", async () => {
  const app = await connected();
  const tab = await app.api.tabs.create({ windowId: 10, url: "https://new.example", title: "New" });
  app.api.tabs.onCreated.emit(tab);
  const backup = await app.controller.handle({ type: "exportBackup" });
  assert.equal(backup.snapshot.fresh, true);
  assert.equal(backup.state.workspaces.find((w) => w.id === "work").tabs.some((page) => page.url === "https://new.example"), true);
});

test("a failed attachment save leaves the window and workspace unassigned", async () => {
  const app = await connected();
  app.windows.set(99, { id: 99, type: "normal", incognito: false, state: "normal" });
  await app.api.tabs.create({ windowId: 99, url: "https://attach.example" });
  const set = app.api.storage.local.set;
  app.api.storage.local.set = async (values) => {
    if (values.rauiriWindowWorkspaces) throw new Error("Disk full");
    return set(values);
  };
  await assert.rejects(app.controller.handle({ type: "attachWorkspaceWindow", workspaceId: "groundtruth", windowId: 99 }), /Disk full/);
  assert.equal((await app.controller.handle({ type: "snapshot", windowId: 99 })).managed, false);
});

test("fresh installations assign the focused window to Personal without recreating tabs", async () => {
  const app = harness({ fresh: true });
  await app.controller.ready;
  const view = await app.controller.handle({ type: "snapshot", windowId: 1 });
  assert.equal(view.currentWorkspaceId, "personal");
  assert.equal(view.shortcutSlots[0], "personal");
  assert.equal(view.workspaces.find((w) => w.id === "personal").tabCount, 3);
  assert.equal(view.workspaces.some((w) => w.id === "inactive"), false);
  assert.equal(app.calls.some(([method]) => method === "tab.create" || method === "tab.move"), false);
});

test("failed names, pins, shortcuts, preferences and creations do not leak into later saves", async () => {
  for (const kind of ["names", "pin", "shortcut", "preference", "create"]) {
    const app = await connected();
    const before = await app.controller.handle({ type: "snapshot" });
    const workspaces = before.workspaces.map((workspace) => ({ ...workspace, title: workspace.id === "work" ? "Changed" : workspace.title }));
    const message = {
      names: { type: "saveWorkspaceDetails", workspaces },
      pin: { type: "setPinnedWorkspace", workspaceId: "work" },
      shortcut: { type: "assignWorkspaceShortcut", slot: 1, workspaceId: "work" },
      preference: { type: "setWorkspacePreferences", minimizeOthers: false },
      create: { type: "createWindowWorkspace", title: "Failed creation" },
    }[kind];
    const set = app.api.storage.local.set;
    app.api.storage.local.set = async () => { throw new Error("Disk full"); };
    await assert.rejects(app.controller.handle(message), /Disk full/);
    app.api.storage.local.set = set;
    await app.controller.handle({ type: "removeRoute", routeId: "missing" });
    const after = await app.controller.handle({ type: "snapshot" });
    assert.deepEqual(after.workspaces, before.workspaces, kind);
    assert.deepEqual(after.shortcutSlots, before.shortcutSlots, kind);
    assert.equal(after.pinnedWorkspaceId, before.pinnedWorkspaceId, kind);
    assert.equal(after.minimizeOthers, before.minimizeOthers, kind);
  }
});

test("a hung fresh capture falls back to an explicitly cached backup without blocking Settings", async (t) => {
  const app = await connected();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  app.api.windows.get = () => new Promise(() => {});
  const exporting = app.controller.handle({ type: "exportBackup" });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(2000);
  const backup = await exporting;
  assert.equal(backup.snapshot.fresh, false);
  assert.match(backup.snapshot.reason, /timed out/);
  assert.equal(backup.state.workspaces.find((w) => w.id === "personal").tabs.length, 2);
  assert.equal((await app.controller.handle({ type: "snapshot" })).workspaces.length, 5);
});

test("restore points remain exportable while browser startup is pending", async () => {
  const app = await connected();
  const restorePoints = [
    ["rauiriBeforeWorkspaceImport", "exportPreviousBackup", "Before import"],
    ["rauiriBeforeReconnect", "exportReconnectBackup", "Before reconnect"],
    ["rauiriBeforeWorkspaceAttach", "exportAttachBackup", "Before attach"],
    ["rauiriBeforeWorkspaceDelete", "exportWorkspaceDeletionBackup", "Before deletion"],
  ];
  for (const [key, , title] of restorePoints) {
    const state = structuredClone(app.local.rauiriWindowWorkspaces);
    state.workspaces[0].title = title;
    app.local[key] = state;
  }
  app.api.windows.getAll = () => new Promise(() => {});
  const restarted = app.restart();
  for (const [, type, title] of restorePoints) {
    const backup = await restarted.handle({ type });
    assert.equal(backup.state.workspaces[0].title, title);
  }
});

test("queued mutations wait for worker reconnection without recreating windows", async () => {
  const app = await connected();
  const expectedBindings = structuredClone(app.session.rauiriWorkspaceWindows);
  // Inventories can change just before the worker sleeps; session IDs must win.
  app.tabs.get(1).url = "https://personal.example/changed";
  const restarted = app.restart();
  const mutation = restarted.handle({ type: "setWorkspacePreferences", minimizeOthers: false });
  await mutation;
  const view = await restarted.handle({ type: "snapshot", windowId: 1 });
  assert.equal(view.managed, true);
  assert.equal(view.currentWorkspaceId, "personal");
  assert.deepEqual(app.session.rauiriWorkspaceWindows, expectedBindings);
  assert.equal(app.calls.some(([name]) => name === "window.create"), false);
});

test("switching live workspaces never recreates tabs and minimises only managed windows", async () => {
  const app = await connected();
  app.windows.set(999, { id: 999, type: "normal", incognito: false, state: "normal" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  assert.equal(app.calls.some(([method]) => method === "tab.create" || method === "window.create"), false);
  assert.equal(app.windows.get(10).state, "minimized");
  assert.equal(app.windows.get(999).state, "normal");
  assert.equal(app.tabs.get(3).pinned, true);
});

test("background filing preserves source focus and pinned tabs retain pinning when explicitly moved", async () => {
  const app = await connected();
  await app.controller.handle({ type: "moveWindowTab", tabId: 1, workspaceId: "work" });
  assert.equal(app.tabs.get(1).windowId, 10);
  assert.equal(app.windows.get(1).focused, true);
  assert.equal(app.tabs.get(3).active, true);
  await app.controller.handle({ type: "moveWindowTab", tabId: 3, workspaceId: "work" });
  assert.equal(app.tabs.get(3).pinned, true);
  assert.equal(app.windows.has(1), true, "last-tab filing must keep the source window alive");
});

test("cleanup stays in the background even for follow rules", async () => {
  const app = await connected();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "work", moveExisting: true });
  assert.equal(app.tabs.get(1).windowId, 10);
  assert.equal(app.windows.get(1).focused, true);
  const tab = await app.api.tabs.create({ windowId: 1, url: "https://follow.example", active: true });
  await app.controller.handle({ type: "addRoute", hostname: "follow.example", contextId: "work", activate: true, moveExisting: true });
  assert.equal(app.tabs.get(tab.id).windowId, 10);
  assert.equal(app.windows.get(1).focused, true);
});

test("tab updates and individual closes automatically update the saved workspace", async (t) => {
  const app = await connected();
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
  const app = await connected();
  await app.controller.handle({ type: "moveWindowTab", tabId: 1, workspaceId: "work" });
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "personal", moveExisting: true });
  await app.controller.handle({ type: "addRoute", hostname: "pin.example", contextId: "work", moveExisting: true });
  assert.equal(app.tabs.get(1).windowId, 10);
  assert.equal(app.tabs.get(3).windowId, 1);
});

test("window closure retains a resumable snapshot, including native pins", async () => {
  const app = await connected();
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

test("a workspace backup can be imported into a fresh profile without opening windows", async () => {
  const source = await connected();
  const backup = await source.controller.handle({ type: "exportBackup" });
  const target = harness({ fresh: true, empty: true });
  await target.controller.ready;
  await target.controller.handle({ type: "importBackup", backup });
  assert.equal(target.calls.length, 0);
  const view = await target.controller.handle({ type: "snapshot" });
  assert.equal(view.workspaces.every((w) => w.windowId === null), true);
  assert.equal(view.workspaces.find((w) => w.id === "personal").tabCount, 2);
  assert.equal(view.workspaces.find((w) => w.id === "work").tabCount, 1);
});

test("workspace backups reject non-web pages and configuration exports omit page inventories", async () => {
  const app = await connected();
  const backup = await app.controller.handle({ type: "exportBackup" });
  assert.equal(validateWindowState(backup.state).workspaces.length, 5);
  const config = await app.controller.handle({ type: "exportBackup", configurationOnly: true });
  assert.deepEqual(config.state.workspaces.map(({ id, title, tabs }) => ({ id, title, tabs })), [
    { id: "personal", title: "Personal", tabs: [] },
    { id: "work", title: "Work", tabs: [] },
    { id: "groundtruth", title: "Groundtruth", tabs: [] },
    { id: "read-later", title: "Read Later", tabs: [] },
    { id: "inactive", title: "Inactive", tabs: [] },
  ]);
  backup.state.workspaces[0].tabs[0].url = "javascript:alert(1)";
  assert.throws(() => validateWindowState(backup.state), /Invalid saved/);
});


test("interrupted restoration retains the full inventory and retries only missing pages", async (t) => {
  const app = await connected();
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
  const app = await connected();
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
  const app = await connected();
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
  const app = await connected();
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
  const app = await connected();
  const view = await app.controller.handle({ type: "snapshot" });
  assert.equal(view.currentWorkspaceId, null);
  assert.equal(view.managed, false);
});

test("pinning respects disabled minimisation", async () => {
  const app = await connected();
  await app.controller.handle({ type: "setWorkspacePreferences", minimizeOthers: false });
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "personal" });
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "work" });
  assert.equal(app.windows.get(1).state, "normal");
  assert.equal(app.windows.get(10).focused, true);
});

test("previous-workspace toggles and numbered shortcuts use stable order, not recency", async () => {
  const app = await connected();
  app.api.commands.onCommand.emit("workspace-2");
  await app.barrier();
  assert.equal(app.windows.get(10).focused, true);
  app.api.commands.onCommand.emit("previous-workspace");
  await app.barrier();
  assert.equal(app.windows.get(1).focused, true);
  app.api.commands.onCommand.emit("previous-workspace");
  await app.barrier();
  assert.equal(app.windows.get(10).focused, true);
  const restarted = app.restart();
  await restarted.ready;
  const snapshot = await restarted.handle({ type: "snapshot" });
  assert.deepEqual(snapshot.recentWorkspaceIds.slice(0, 2), ["work", "personal"]);
  assert.equal(snapshot.workspaces[0].id, "personal");
});

test("native window switching updates recent workspaces but unrelated windows do not", async () => {
  const app = await connected();
  await app.api.windows.update(10, { focused: true });
  app.api.windows.onFocusChanged.emit(10);
  await app.barrier();
  app.api.windows.onFocusChanged.emit(-1);
  await app.barrier();
  assert.deepEqual((await app.controller.handle({ type: "snapshot" })).recentWorkspaceIds.slice(0, 2), ["work", "personal"]);
});

test("project switches copy the outgoing normal window geometry, including negative monitor coordinates", async () => {
  const app = await connected();
  const bounds = { left: -1200, top: 40, width: 1100, height: 850 };
  Object.assign(app.windows.get(1), bounds);
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  for (const [key, value] of Object.entries(bounds)) assert.equal(app.windows.get(10)[key], value);
  const updates = app.calls.filter(([method, id]) => method === "window.update" && id === 10);
  assert.equal(updates[0][2].state, "normal", "restore minimised target before setting bounds");
  assert.equal(updates[1][2].width, 1100);
});

test("switching from the pinned base uses the last project geometry without moving the base", async () => {
  const app = await connected();
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
  const app = await connected();
  Object.assign(app.windows.get(1), { left: 0, top: 0, width: 600, height: 700 });
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  const bounds = { left: 650, top: 40, width: 1200, height: 900 };
  Object.assign(app.windows.get(10), bounds);
  await app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "work" });
  assert.equal(app.windows.get(1).state, "minimized");
  const restarted = app.restart();
  await restarted.ready;
  await restarted.handle({ type: "focusWindowWorkspace", workspaceId: "personal" });
  for (const [key, value] of Object.entries(bounds)) assert.equal(app.windows.get(1)[key], value);
  assert.equal(app.windows.get(10).state, "normal");
});

test("pinned-window resizing does not replace remembered project geometry", async () => {
  const app = await connected();
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
  const app = await connected();
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
  const app = await connected();
  const update = app.api.windows.update;
  app.api.windows.update = async (id, props) => {
    if (props.state === "normal") return app.api.windows.get(id);
    return update(id, props);
  };
  await assert.rejects(app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" }), /still restoring/);
  assert.equal(app.windows.get(10).state, "minimized");
  assert.equal(app.calls.some(([method, id, props]) => method === "window.update" && id === 10 && props.focused), false);
});

test("special window states do not participate in geometry copying", async () => {
  for (const state of ["maximized", "fullscreen"]) {
    for (const specialId of [1, 10]) {
      const app = await connected();
      Object.assign(app.windows.get(1), { left: 10, top: 20, width: 900, height: 800 });
      app.windows.get(specialId).state = state;
      await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
      assert.equal(app.calls.some(([method, , props]) => method === "window.update" && props.width !== undefined), false);
      if (specialId === 10) assert.equal(app.windows.get(10).state, state);
    }
  }
});

test("failed resizing does not prevent focusing the destination", async () => {
  const app = await connected();
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
  const app = await connected();
  Object.assign(app.windows.get(1), { left: 10, top: 20, width: 900, height: 800 });
  await app.api.windows.update(10, { state: "normal", focused: true });
  app.api.windows.onFocusChanged.emit(10);
  await app.barrier();
  assert.equal(app.calls.some(([method, , props]) => method === "window.update" && props.width !== undefined), false);
});

test("manually restoring a workspace minimises the old project and keeps the pinned base", async () => {
  const app = await connected();
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
  const app = await connected();
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
  const app = await connected();
  await app.api.windows.update(10, { state: "normal", focused: true });
  app.calls.length = 0;
  app.api.windows.onFocusChanged.emit(1);
  app.api.windows.onFocusChanged.emit(-1);
  app.api.windows.onFocusChanged.emit(999);
  await app.barrier();
  assert.equal(app.calls.length, 0);
});

test("native reconciliation stops if focus changes while browser reads are pending", async () => {
  const app = await connected();
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
  const app = await connected();
  await app.controller.handle({ type: "setWorkspacePreferences", minimizeOthers: false });
  await app.api.windows.update(10, { state: "normal", focused: true });
  app.api.windows.onFocusChanged.emit(10);
  await app.barrier();
  assert.equal(app.windows.get(1).state, "normal");
});

test("address-bar navigation waits for intent then follows; duplicate completion does not route twice", async () => {
  const app = await connected();
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
    const app = await connected();
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
  const app = await connected();
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
  const app = await connected();
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
  const app = await connected();
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
  const app = await connected();
  await app.controller.handle({ type: "addRoute", hostname: "work.example", contextId: "work" });
  await app.api.windows.remove(10);
  await app.barrier();
  assert.equal((await app.controller.handle({ type: "snapshot" })).routes[0].active, false);
  await assert.rejects(app.controller.handle({ type: "setPinnedWorkspace", workspaceId: "work" }), /Resume/);
});

test("put-away fails safely if storage or closing fails", async () => {
  for (const failure of ["storage", "close"]) {
    const app = await connected();
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
  const app = await connected();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "work" });
  app.windows.delete(10);
  app.tabs.delete(2); // Simulate closure before onRemoved has been delivered.
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://personal.example", transitionType: "typed" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 1);
  assert.equal(app.calls.some(([method]) => method === "window.create"), false);
});

test("adding a route to a put-away workspace does not move existing tabs", async () => {
  const app = await connected();
  await app.controller.handle({ type: "addRoute", hostname: "personal.example", contextId: "groundtruth", moveExisting: true });
  assert.equal(app.tabs.get(1).windowId, 1);
  assert.equal(app.calls.some(([method]) => method === "window.create"), false);
});

test("active workspace merge moves actual tabs and native pins, retargets rules, and retains a backup", async () => {
  const app = await connected();
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
  const app = await connected();
  const move = app.api.tabs.move;
  app.api.tabs.move = async (id, props) => {
    if (id === 3) throw new Error("Move failed");
    return move(id, props);
  };
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", destinationId: "work", tabs: "move", rules: "move" }), /Move failed/);
  assert.deepEqual([...app.tabs.keys()].sort((a, b) => a - b), [1, 2, 3, 100]);
  assert.equal(app.tabs.get(1).url, "https://personal.example");
  assert.equal(app.tabs.get(3).url, "https://pin.example");
  assert.equal(app.tabs.get(3).pinned, true);
  assert.equal((await app.controller.handle({ type: "snapshot" })).workspaces.some((w) => w.id === "personal"), true);
  assert.equal(app.local.rauiriBeforeWorkspaceDelete.workspaces.find((w) => w.id === "personal").tabs.length, 2);
});

test("put-away workspace tabs and rules can merge into another put-away workspace without opening windows", async () => {
  const app = await connected();
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
  const app = await connected();
  await app.controller.handle({ type: "addRoute", hostname: "work.example", contextId: "work" });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "work", destinationId: "personal", tabs: "delete", rules: "move" });
  assert.equal(app.local.rauiriWindowWorkspaces.routes[0].contextId, "personal");
  assert.equal(app.tabs.size, 3);
});

test("put-away deletion can discard both remembered tabs and rules with no browser edits", async () => {
  const app = await connected();
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
  const app = await connected();
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
  const app = await connected();
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
  assert.equal([...app.tabs.values()].find((tab) => tab.url === "https://new.example").windowId, 1);
});

test("deletion backup failure prevents live tab moves", async () => {
  const app = await connected();
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
  const app = await connected();
  await app.controller.handle({ type: "addRoute", hostname: "example.com", contextId: "work" });
  await app.controller.handle({ type: "addRoute", hostname: "app.example.com", contextId: "groundtruth" });
  await app.api.tabs.update(1, { url: "https://app.example.com" });
  app.api.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: "https://app.example.com", transitionType: "typed" });
  await app.barrier();
  assert.equal(app.tabs.get(1).windowId, 10);
});

test("deletion rejects live-tab disposal, self-merges, missing choices, and deleting built-in Read Later", async () => {
  const app = await connected();
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", tabs: "delete", rules: "delete" }), /active workspace/);
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", destinationId: "personal", tabs: "move", rules: "move" }), /different destination/);
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal" }), /Choose what/);
  await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "work", destinationId: "personal", tabs: "move", rules: "move" });
  for (const id of ["groundtruth", "inactive"]) await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: id, tabs: "delete", rules: "delete" });
  await app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "personal", destinationId: "read-later", tabs: "move", rules: "move" });
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "read-later", tabs: "delete", rules: "delete" }), /built in/);
});

test("shortcut slots migrate without compacting gaps and validate independently of list order", async () => {
  const app = await connected();
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
  const app = await connected();
  await app.controller.handle({ type: "assignWorkspaceShortcut", slot: 1, workspaceId: "work" });
  let view = await app.controller.handle({ type: "snapshot" });
  assert.deepEqual(view.shortcutSlots.slice(0, 2), ["work", "personal"]);
  await app.controller.handle({ type: "saveWorkspaceDetails", workspaces: [...view.workspaces].reverse() });
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
  const app = await connected();
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  assert.deepEqual((await app.controller.handle({ type: "snapshot" })).shortcutSlots.slice(0, 2), ["personal", null]);
  app.calls.length = 0;
  app.api.commands.onCommand.emit("workspace-2");
  await app.barrier();
  assert.equal(app.calls.length, 0);
  await app.controller.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  assert.equal((await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "work").shortcut, null);
});

test("native browser restoration restores shortcut slots", async (t) => {
  const app = await connected();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const restoredWindows = structuredClone([...app.windows.entries()]);
  const restoredTabs = structuredClone([...app.tabs.entries()]);
  for (const id of [...app.windows.keys()]) await app.api.windows.remove(id);
  await app.barrier();
  assert.deepEqual(app.local.rauiriWindowWorkspaces.shortcutSlots.slice(0, 2), [null, null]);
  for (const [id, window] of restoredWindows) app.windows.set(id, window);
  for (const [id, tab] of restoredTabs) app.tabs.set(id, tab);
  delete app.session.rauiriWorkspaceWindows;
  const restarted = app.restart();
  await restarted.ready;
  assert.deepEqual((await restarted.handle({ type: "snapshot" })).shortcutSlots.slice(0, 2), ["personal", "work"]);
  assert.equal(app.local.rauiriWindowWorkspaces.closedShortcutSlots.every((id) => id === null), true);
});

test("backup import remains usable with built-in Read Later open and preserves its live tabs", async () => {
  const app = await connected();
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
  const app = await connected();
  await assert.rejects(app.controller.handle({ type: "assignWorkspaceShortcut", slot: 0, workspaceId: "work" }), /1 to 9/);
  await assert.rejects(app.controller.handle({ type: "assignWorkspaceShortcut", slot: 3, workspaceId: "read-later" }), /slot 0/);
  await assert.rejects(app.controller.handle({ type: "assignWorkspaceShortcut", slot: 3, workspaceId: "groundtruth" }), /Resume/);
});

test("Read Later is restored to old state, protected from removal, and permanently uses slot zero", async () => {
  const app = await connected();
  const state = structuredClone(app.local.rauiriWindowWorkspaces);
  state.workspaces = state.workspaces.filter((w) => w.id !== "read-later");
  assert.equal(validateWindowState(state).workspaces.at(-1).id, "read-later");
  await assert.rejects(app.controller.handle({ type: "putAwayWorkspace", workspaceId: "read-later" }), /built in/);
  await assert.rejects(app.controller.handle({ type: "deleteWindowWorkspace", workspaceId: "read-later", destinationId: "work", tabs: "move", rules: "move" }), /built in/);
  const view = await app.controller.handle({ type: "snapshot" });
  view.workspaces.find((w) => w.id === "read-later").title = "Other name";
  await assert.rejects(app.controller.handle({ type: "saveWorkspaceDetails", workspaces: view.workspaces }), /name is fixed/);
  app.api.commands.onCommand.emit("workspace-10");
  await app.barrier();
  const windowId = (await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "read-later").windowId;
  assert.equal(app.windows.get(windowId).focused, true);
});

test("manually closing Read Later recreates it without stealing focus and preserves its remembered tabs", async (t) => {
  const app = await connected();
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
  const app = await connected();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const id of [...app.windows.keys()]) await app.api.windows.remove(id);
  await app.barrier();
  t.mock.timers.tick(300);
  await app.barrier();
  assert.equal(app.windows.size, 0);
  const window = await app.api.windows.create({ focused: true });
  app.api.windows.onCreated.emit(window);
  await app.barrier();
  t.mock.timers.tick(1000); // New windows get time to relink before Read Later is recreated.
  await app.barrier();
  assert.notEqual((await app.controller.handle({ type: "snapshot" })).workspaces.find((w) => w.id === "read-later").windowId, null);
});

test("page overlap counts duplicate pages and ignores order", () => {
  assert.equal(pageOverlap(["a", "b"], ["b", "a"]), 1);
  assert.equal(pageOverlap(["a", "a", "b"], ["a", "b"]), 2 / 3);
  assert.equal(pageOverlap(["a", "b", "c", "d"], ["a", "b", "c", "e"]), 3 / 5);
  assert.equal(pageOverlap([], []), 0);
});

test("extension reload reconnects windows whose tabs drifted and keeps their shortcut numbers", async () => {
  const app = await connected();
  for (const page of ["a", "b", "c"]) await app.api.tabs.create({ windowId: 1, url: `https://personal.example/${page}` });
  // A worker restart keeps session bindings, so it captures the larger inventory.
  await app.restart().ready;
  assert.equal(app.local.rauiriWindowWorkspaces.workspaces.find((w) => w.id === "personal").tabs.length, 5);
  // Extension reload wipes session storage; meanwhile one page changed and one opened.
  delete app.session.rauiriWorkspaceWindows;
  [...app.tabs.values()].find((tab) => tab.url === "https://personal.example/a").url = "https://personal.example/changed";
  await app.api.tabs.create({ windowId: 1, url: "https://personal.example/new" });
  const saved = structuredClone(app.local.rauiriWindowWorkspaces);
  const restarted = app.restart();
  await restarted.ready;
  const view = await restarted.handle({ type: "snapshot", windowId: 1 });
  assert.equal(view.currentWorkspaceId, "personal");
  assert.deepEqual(view.shortcutSlots.slice(0, 2), ["personal", "work"]);
  assert.deepEqual(app.local.rauiriBeforeReconnect.workspaces, saved.workspaces);
  assert.equal(app.calls.some(([name]) => name === "window.create"), false);
});

test("a workspace that fails to reconnect remembers its number for a later attach", async () => {
  const app = await connected();
  delete app.session.rauiriWorkspaceWindows;
  for (const tab of app.tabs.values()) if (tab.windowId === 10) tab.url = "https://unrelated.example/";
  const restarted = app.restart();
  await restarted.ready;
  let view = await restarted.handle({ type: "snapshot", windowId: 10 });
  assert.equal(view.currentWorkspaceId, null);
  assert.equal(view.shortcutSlots[1], null);
  await restarted.handle({ type: "attachWorkspaceWindow", workspaceId: "work", windowId: 10 });
  view = await restarted.handle({ type: "snapshot", windowId: 10 });
  assert.equal(view.currentWorkspaceId, "work");
  assert.equal(view.shortcutSlots[1], "work");
});

// Simulates a browser that restores some windows after the worker has started.
async function restartWithLateWindow(app, windowId) {
  delete app.session.rauiriWorkspaceWindows;
  const late = app.windows.get(windowId);
  const lateTabs = [...app.tabs.values()].filter((tab) => tab.windowId === windowId);
  app.windows.delete(windowId);
  for (const tab of lateTabs) app.tabs.delete(tab.id);
  const restarted = app.restart();
  await restarted.ready;
  app.windows.set(windowId, late);
  for (const tab of lateTabs) app.tabs.set(tab.id, tab);
  app.calls.length = 0;
  return restarted;
}

test("resuming a workspace whose window is open but unlinked reuses that window", async () => {
  const app = await connected();
  const restarted = await restartWithLateWindow(app, 10);
  assert.equal((await restarted.handle({ type: "snapshot", windowId: 10 })).currentWorkspaceId, null);
  await restarted.handle({ type: "focusWindowWorkspace", workspaceId: "work" });
  const view = await restarted.handle({ type: "snapshot", windowId: 10 });
  assert.equal(view.currentWorkspaceId, "work");
  assert.equal(view.shortcutSlots[1], "work");
  assert.equal(app.calls.some(([name]) => name === "window.create" || name === "tab.create"), false);
});

test("a window restored after startup relinks instead of being duplicated", async (t) => {
  const app = await connected();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await app.api.tabs.create({ windowId: 10, url: "https://work.example/second" });
  await app.restart().ready; // capture the two-page inventory
  const restarted = await restartWithLateWindow(app, 10);
  app.api.windows.onCreated.emit(app.windows.get(10));
  t.mock.timers.tick(1000);
  await restarted.handle({ type: "setWorkspacePreferences", minimizeOthers: true });
  assert.equal((await restarted.handle({ type: "snapshot", windowId: 10 })).currentWorkspaceId, "work");
  assert.equal(app.calls.some(([name]) => name === "window.create"), false);
});

test("a torn-off single tab never claims a put-away workspace", async (t) => {
  const app = await connected();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await app.controller.handle({ type: "putAwayWorkspace", workspaceId: "work" });
  app.windows.set(50, { id: 50, type: "normal", incognito: false, state: "normal" });
  await app.api.tabs.create({ windowId: 50, url: "https://work.example" });
  app.api.windows.onCreated.emit(app.windows.get(50));
  t.mock.timers.tick(1000);
  await app.barrier();
  assert.equal((await app.controller.handle({ type: "snapshot", windowId: 50 })).currentWorkspaceId, null);
});

test("browser restart reconnects exact inventories but leaves ambiguous windows unassigned", async () => {
  const app = await connected();
  delete app.session.rauiriWorkspaceWindows;
  const restarted = app.restart();
  await restarted.ready;
  assert.equal((await restarted.handle({ type: "snapshot", windowId: 10 })).currentWorkspaceId, "work");
  delete app.session.rauiriWorkspaceWindows;
  app.windows.set(99, { id: 99, type: "normal", incognito: false, state: "normal" });
  await app.api.tabs.create({ windowId: 99, url: "https://work.example" });
  const ambiguous = app.restart();
  await ambiguous.ready;
  const view = await ambiguous.handle({ type: "snapshot", windowId: 10 });
  assert.equal(view.workspaces.find((w) => w.id === "work").windowId, null);
  assert.equal(app.calls.some(([method]) => method === "window.create"), false);
});
