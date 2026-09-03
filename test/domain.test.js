import test from "node:test";
import assert from "node:assert/strict";
import {
  assignRecordToGroup,
  attentionForNewTab,
  cleanHostnameInput,
  contextForNewTab,
  createBackup,
  createInitialState,
  findRecoverableRecords,
  groupKeyForRecord,
  migrateState,
  normalizeHostname,
  routeForUrl,
  shouldArchiveTab,
  shouldDiscardReadLater,
  stateFromBackup,
  updateYouTubeUrl,
} from "../src/domain.js";

const NOW = Date.UTC(2026, 7, 18, 12);
const HOUR = 60 * 60 * 1000;

function tab(overrides = {}) {
  return {
    active: false,
    audible: false,
    pinned: false,
    discarded: false,
    lastAccessed: NOW - (13 * HOUR),
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    attention: "current",
    pinScope: "none",
    contextId: "personal",
    ...overrides,
  };
}

test("initial state starts in Personal with the agreed contexts", () => {
  const state = createInitialState();
  assert.equal(state.activeContextId, "personal");
  assert.deepEqual(state.contexts.map(({ id, color }) => [id, color]), [
    ["personal", "green"],
    ["work", "red"],
    ["groundtruth", "orange"],
  ]);
  assert.equal(state.settings.archiveAfterHours, 72);
  assert.equal(state.settings.discardReadLaterAfterHours, 2);
});

test("migration restores defaults, upgrades the old delay, and preserves custom settings", () => {
  const upgraded = migrateState({
    version: 1,
    contexts: [{ id: "home", title: "Home", color: "cyan" }],
    activeContextId: "missing",
    settings: { archiveAfterHours: 12 },
    records: {
      oldContextPin: { id: "oldContextPin", pinScope: "context" },
      globalPin: { id: "globalPin", pinScope: "global" },
    },
  });
  assert.equal(upgraded.activeContextId, "home");
  assert.equal(upgraded.settings.archiveAfterHours, 72);
  assert.equal(upgraded.settings.discardReadLaterAfterHours, 2);
  assert.equal(upgraded.records.oldContextPin.pinScope, "none");
  assert.equal(upgraded.records.globalPin.pinScope, "global");

  const customized = migrateState({ version: 1, settings: { archiveAfterHours: 24 } });
  assert.equal(customized.settings.archiveAfterHours, 24);
});

test("backup files round-trip configuration and recovery records without a window ID", () => {
  const original = createInitialState();
  original.managedWindowId = 42;
  original.routes = [{ id: "route-1", hostname: "*.example.com", contextId: "work" }];
  original.records = {
    "record-1": record({ id: "record-1", contextId: "work", url: "https://app.example.com" }),
  };

  const backup = createBackup(original, {
    extensionVersion: "0.2.0",
    exportedAt: "2026-01-02T03:04:05.000Z",
  });
  assert.equal(backup.format, "rauiri-backup");
  assert.equal(backup.state.managedWindowId, undefined);

  const restored = stateFromBackup(backup, { managedWindowId: 77 });
  assert.equal(restored.managedWindowId, 77);
  assert.deepEqual(restored.contexts, original.contexts);
  assert.deepEqual(restored.routes, original.routes);
  assert.deepEqual(restored.records, original.records);
  assert.throws(() => stateFromBackup({ format: "something-else" }), /supported Rauiri backup/);
});

test("hostname matching is exact and ignores only a leading www", () => {
  const routes = [{ id: "one", hostname: "app.example.com", contextId: "work" }];
  assert.equal(normalizeHostname("https://www.Reddit.com/r/test"), "reddit.com");
  assert.equal(routeForUrl(routes, "https://app.example.com/jobs")?.contextId, "work");
  assert.equal(routeForUrl(routes, "https://other.example.com/jobs"), null);
});

test("wildcard routes match subdomains but not the apex or lookalike domains", () => {
  const routes = [{ id: "wild", hostname: "*.hnry.io", contextId: "work" }];
  assert.equal(cleanHostnameInput("HTTPS://*.HNRY.IO/path"), "*.hnry.io");
  assert.equal(cleanHostnameInput("https://%2a.hnry.io"), "*.hnry.io");
  assert.equal(routeForUrl(routes, "https://app.hnry.io")?.id, "wild");
  assert.equal(routeForUrl(routes, "https://deep.app.hnry.io")?.id, "wild");
  assert.equal(routeForUrl(routes, "https://www.hnry.io")?.id, "wild");
  assert.equal(routeForUrl(routes, "https://hnry.io"), null);
  assert.equal(routeForUrl(routes, "https://fakehnry.io"), null);
  assert.equal(routeForUrl(routes, "https://hnry.io.attacker.example"), null);
});

test("exact routes beat wildcards and the most specific wildcard wins", () => {
  const routes = [
    { id: "broad", hostname: "*.example.com", contextId: "personal" },
    { id: "specific", hostname: "*.work.example.com", contextId: "work" },
    { id: "exact", hostname: "app.work.example.com", contextId: "groundtruth" },
  ];
  assert.equal(routeForUrl(routes, "https://app.work.example.com")?.id, "exact");
  assert.equal(routeForUrl(routes, "https://other.work.example.com")?.id, "specific");
  assert.equal(routeForUrl(routes, "https://elsewhere.example.com")?.id, "broad");
});

test("new tabs prefer strict routes, then opener, then active context", () => {
  assert.equal(contextForNewTab({
    route: { contextId: "work" },
    openerRecord: { contextId: "personal" },
    activeContextId: "groundtruth",
  }), "work");

  assert.equal(contextForNewTab({
    openerRecord: { contextId: "personal" },
    activeContextId: "groundtruth",
  }), "personal");

  assert.equal(contextForNewTab({ activeContextId: "groundtruth" }), "groundtruth");
});

test("children of global pins use the active context", () => {
  assert.equal(contextForNewTab({
    openerRecord: { contextId: "personal", pinScope: "global" },
    activeContextId: "work",
  }), "work");
});

test("children of Read Later tabs remain in Read Later", () => {
  assert.equal(attentionForNewTab({ attention: "readLater" }), "readLater");
  assert.equal(attentionForNewTab({ attention: "current" }), "current");
});

test("native group moves update context, routing suppression, and Read Later state", () => {
  const moved = record({ contextId: "personal", originContextId: "personal" });
  assert.equal(assignRecordToGroup(moved, {
    groupKey: "work",
    route: { contextId: "personal" },
    url: "https://www.example.com/page",
  }), true);
  assert.equal(groupKeyForRecord(moved), "work");
  assert.equal(moved.originContextId, "work");
  assert.equal(moved.routeSuppressedHostname, "example.com");

  assert.equal(assignRecordToGroup(moved, { groupKey: "work" }), false);
  assert.equal(assignRecordToGroup(moved, { groupKey: "read-later" }), true);
  assert.equal(groupKeyForRecord(moved), "read-later");
  assert.equal(moved.originContextId, "work");
  assert.equal(moved.pinScope, "none");
});

test("ordinary tabs archive after the configured delay", () => {
  assert.equal(shouldArchiveTab({
    tab: tab(),
    record: record(),
    route: null,
    now: NOW,
    archiveAfterHours: 12,
  }), true);

  assert.equal(shouldArchiveTab({
    tab: tab({ lastAccessed: NOW - (11 * HOUR) }),
    record: record(),
    route: null,
    now: NOW,
    archiveAfterHours: 12,
  }), false);
});

test("active, audible, pinned, routed, and already-shelved tabs do not auto-archive", () => {
  const candidates = [
    { tab: tab({ active: true }), record: record(), route: null },
    { tab: tab({ audible: true }), record: record(), route: null },
    { tab: tab({ pinned: true }), record: record(), route: null },
    { tab: tab(), record: record({ pinScope: "global" }), route: null },
    { tab: tab(), record: record(), route: { contextId: "work" } },
    { tab: tab(), record: record({ attention: "readLater" }), route: null },
  ];

  for (const candidate of candidates) {
    assert.equal(shouldArchiveTab({ ...candidate, now: NOW, archiveAfterHours: 12 }), false);
  }
});

test("Read Later tabs discard after two idle hours but not while active or audible", () => {
  assert.equal(shouldDiscardReadLater({
    tab: tab({ lastAccessed: NOW - (3 * HOUR) }),
    record: record({ attention: "readLater" }),
    now: NOW,
    discardAfterHours: 2,
  }), true);

  assert.equal(shouldDiscardReadLater({
    tab: tab({ active: true, lastAccessed: NOW - (3 * HOUR) }),
    record: record({ attention: "readLater" }),
    now: NOW,
    discardAfterHours: 2,
  }), false);
});

test("recovery lists each missing URL once and ignores URLs already open", () => {
  const records = {
    associated: { id: "associated", url: "https://previous.example", lastSeenAt: 4 },
    openCopy: { id: "open-copy", url: "https://duplicate.example", lastSeenAt: 3 },
    missingCopy: { id: "missing-copy", url: "https://duplicate.example", lastSeenAt: 2 },
    newerMissing: { id: "newer-missing", url: "https://lost.example", lastSeenAt: 6 },
    missing: { id: "missing", url: "https://lost.example", lastSeenAt: 1 },
    internal: { id: "internal", url: "chrome://newtab", lastSeenAt: 5 },
  };
  const result = findRecoverableRecords({
    records,
    openTabs: [
      { id: 10, url: "https://current.example" },
      { id: 11, url: "https://duplicate.example" },
    ],
    tabRecordEntries: [[10, "associated"]],
  });

  assert.deepEqual(result.map(({ id }) => id), ["newer-missing"]);
});

test("YouTube state is made durable in the URL", () => {
  const updated = new URL(updateYouTubeUrl("https://www.youtube.com/watch?v=abc&t=20s", 1247.8));
  assert.equal(updated.searchParams.get("v"), "abc");
  assert.equal(updated.searchParams.get("t"), "1247s");
  assert.equal(updateYouTubeUrl("https://example.com/watch?v=abc", 60), "https://example.com/watch?v=abc");
});
