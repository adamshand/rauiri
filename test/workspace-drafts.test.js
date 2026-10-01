import test from "node:test";
import assert from "node:assert/strict";
import { reconcileWorkspaceDrafts } from "../src/workspace-drafts.js";

test("fresh workspace snapshots add and remove rows without losing unsaved name and colour edits", () => {
  const previous = [
    { id: "personal", title: "Personal", color: "green" },
    { id: "removed", title: "Removed", color: "grey" },
    { id: "work", title: "Work", color: "red" },
  ];
  const drafts = [
    { id: "personal", title: "My draft", color: "purple" },
    { id: "removed", title: "Removed", color: "grey" },
    { id: "work", title: "Work", color: "red" },
  ];
  const latest = [
    { id: "personal", title: "Personal", color: "green", windowId: 1 },
    { id: "work", title: "Renamed elsewhere", color: "blue", windowId: 2 },
    { id: "added", title: "Added", color: "cyan", windowId: 3 },
  ];
  assert.deepEqual(reconcileWorkspaceDrafts(drafts, previous, latest), [
    { id: "personal", title: "My draft", color: "purple", windowId: 1 },
    { id: "work", title: "Renamed elsewhere", color: "blue", windowId: 2 },
    { id: "added", title: "Added", color: "cyan", windowId: 3 },
  ]);
  assert.equal(drafts[0].title, "My draft");
  assert.equal(latest[0].title, "Personal");
});
