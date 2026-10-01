import test from "node:test";
import assert from "node:assert/strict";
import { startBackground } from "../src/background.js";
import { harness } from "./helpers/browser.js";

function send(app, message, sender = { id: "test", url: "chrome-extension://test/options/options.html" }) {
  return new Promise((resolve) => app.api.runtime.onMessage.emit(message, sender, resolve));
}

test("commands from non-UI senders are rejected", async () => {
  const app = harness({ start: startBackground });
  await app.controller.ready;
  const response = await send(app, { type: "snapshot" }, { id: "test", url: "https://example.com" });
  assert.equal(response.ok, false);
  assert.match(response.error, /popup or Settings/);
});

test("popup and Settings share the window controller and its error boundary", async () => {
  const app = harness({ start: startBackground });
  await app.controller.ready;
  const popup = { id: "test", url: "chrome-extension://test/popup/popup.html" };
  assert.equal((await send(app, { type: "setWorkspacePreferences", minimizeOthers: false }, popup)).ok, true);
  assert.equal((await send(app, { type: "snapshot" })).result.minimizeOthers, false);
  assert.equal((await send(app, { type: "unknown" })).ok, false);
  assert.equal((await send(app, null)).ok, false);
});

test("browser startup cannot block trusted UI reads or backup messages", async () => {
  const app = harness({ start(api) {
    api.windows.getAll = () => new Promise(() => {});
    return startBackground(api);
  } });
  const response = await send(app, { type: "snapshot" });
  assert.equal(response.ok, true);
  assert.equal(response.result.connecting, true);
  const backup = await send(app, { type: "exportBackup" });
  assert.equal(backup.ok, true);
  assert.equal(backup.result.snapshot.fresh, false);
});
