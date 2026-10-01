import test from "node:test";
import assert from "node:assert/strict";
import { WORKSPACE_COLORS } from "../src/domain.js";
import { WORKSPACE_SWATCHES, send, disableControls } from "../src/ui.js";

test("popup and Settings share a swatch for every workspace colour", () => {
  assert.deepEqual(Object.keys(WORKSPACE_SWATCHES), WORKSPACE_COLORS);
});

test("UI messages unwrap results and surface controller or connection errors", async (t) => {
  const messages = [];
  const runtime = { sendMessage: async (message) => { messages.push(message); return { ok: true, result: { managed: true } }; } };
  globalThis.chrome = { runtime };
  t.after(() => { delete globalThis.chrome; });
  assert.deepEqual(await send("snapshot", { windowId: 1 }), { managed: true });
  assert.deepEqual(messages, [{ type: "snapshot", windowId: 1 }]);
  runtime.sendMessage = async () => ({ ok: false, error: "Disk full" });
  await assert.rejects(send("saveWorkspaceDetails"), /Disk full/);
  runtime.sendMessage = async () => undefined;
  await assert.rejects(send("snapshot"), /Rauiri did not respond/);
});

test("temporary UI locks preserve disabled rules and ignore replaced controls", (t) => {
  const enabled = { disabled: false, isConnected: true };
  const builtin = { disabled: true, isConnected: true };
  const removed = { disabled: false, isConnected: true };
  globalThis.document = { querySelectorAll: () => [enabled, builtin, removed] };
  t.after(() => { delete globalThis.document; });
  const restore = disableControls();
  assert.equal(enabled.disabled, true);
  assert.equal(builtin.disabled, true);
  removed.isConnected = false;
  restore();
  assert.equal(enabled.disabled, false);
  assert.equal(builtin.disabled, true);
  assert.equal(removed.disabled, true);
});
