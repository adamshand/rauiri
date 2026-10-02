import { test, expect } from "./extension.fixture.js";

async function popupInPersonal({ context, worker, send }) {
  const personal = (await send("snapshot")).workspaces.find((w) => w.id === "personal");
  const opening = context.waitForEvent("page");
  await worker.evaluate((windowId) => chrome.tabs.create({ windowId, url: chrome.runtime.getURL("popup/popup.html"), active: true }), personal.windowId);
  const popup = await opening;
  await popup.waitForURL(/\/popup\/popup.html$/);
  await expect(popup.locator("#window-search")).toBeFocused();
  return popup;
}

test("popup search and Enter resume a put-away workspace and focus its actual window", async ({ extension }) => {
  const popup = await popupInPersonal(extension);
  await expect(popup.locator('.window-workspace[data-current="true"]')).toBeDisabled();
  await popup.locator("#window-search").fill("Work");
  await expect(popup.locator("#window-list .window-workspace")).toHaveCount(1);
  const closing = popup.waitForEvent("close");
  await popup.locator("#window-search").press("Enter");
  await closing;
  const work = (await extension.send("snapshot")).workspaces.find((w) => w.id === "work");
  expect(work.windowId).not.toBeNull();
  expect(await extension.worker.evaluate((id) => chrome.windows.get(id).then((window) => window.focused), work.windowId)).toBe(true);
});

test("popup creation errors keep controls usable and a retry creates exactly one workspace", async ({ extension }) => {
  const popup = await popupInPersonal(extension);
  await popup.getByRole("button", { name: "New workspace", exact: true }).click();
  await popup.locator("#window-name").fill("Popup client");
  await extension.worker.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    globalThis.restoreWrites = () => { chrome.storage.local.set = set; };
    chrome.storage.local.set = async () => { throw new Error("Injected popup failure"); };
  });
  await popup.getByRole("button", { name: "Create", exact: true }).click();
  await expect(popup.locator("#message")).toHaveText("Injected popup failure");
  await expect(popup.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await expect(popup.locator('.window-workspace[data-current="true"]')).toBeDisabled();
  expect((await extension.send("snapshot")).workspaces.some((w) => w.title === "Popup client")).toBe(false);
  await extension.worker.evaluate(() => globalThis.restoreWrites());
  const closing = popup.waitForEvent("close");
  await popup.getByRole("button", { name: "Create", exact: true }).click();
  await closing;
  const created = (await extension.send("snapshot")).workspaces.filter((w) => w.title === "Popup client");
  expect(created).toHaveLength(1);
  expect(await extension.worker.evaluate((id) => chrome.windows.get(id).then((window) => window.focused), created[0].windowId)).toBe(true);
});
