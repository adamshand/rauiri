import { readFile } from "node:fs/promises";
import { test, expect } from "./extension.fixture.js";

async function downloadBackup(page, button = "#export-backup") {
  const downloading = page.waitForEvent("download");
  await page.locator(button).click();
  const download = await downloading;
  const path = await download.path();
  return { path, backup: JSON.parse(await readFile(path, "utf8")) };
}

test("UI backup/import round-trip preserves live reading pages, saved order and native pins without leaking URLs in config exports", async ({ extension, site }) => {
  const { page, worker, send } = extension;
  await send("focusWindowWorkspace", { workspaceId: "read-later" });
  const view = await send("snapshot");
  const personal = view.workspaces.find((w) => w.id === "personal").windowId;
  const reading = view.workspaces.find((w) => w.id === "read-later").windowId;
  const settingsTab = await page.evaluate(() => chrome.tabs.getCurrent());
  await worker.evaluate(({ tabId, windowId }) => chrome.tabs.move(tabId, { windowId, index: -1 }), { tabId: settingsTab.id, windowId: reading });
  const urls = [`${site}/pinned?private-token=one`, `${site}/second`, `${site}/third`];
  await worker.evaluate(async ({ windowId, urls }) => {
    for (const [index, url] of urls.entries()) await chrome.tabs.create({ windowId, url, pinned: index === 0, active: false });
  }, { windowId: personal, urls });
  await expect.poll(async () => (await send("exportBackup")).state.workspaces.find((w) => w.id === "personal").tabs.map((tab) => tab.url)).toEqual(urls);
  const full = await downloadBackup(page);
  expect(full.backup.state.workspaces.find((w) => w.id === "personal").tabs.map((tab) => [tab.url, tab.pinned])).toEqual([
    [urls[0], true], [urls[1], false], [urls[2], false],
  ]);
  await page.locator("#configuration-only").check();
  const configuration = await downloadBackup(page);
  expect(configuration.backup.state.workspaces.every((w) => w.tabs.length === 0)).toBe(true);
  expect(JSON.stringify(configuration.backup)).not.toContain("private-token");
  expect(JSON.stringify(configuration.backup)).not.toContain(site);
  const live = await worker.evaluate(({ windowId, url }) => chrome.tabs.create({ windowId, url, pinned: true, active: false }), { windowId: reading, url: `${site}/live-reading` });
  await send("putAwayWorkspace", { workspaceId: "personal" });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#backup-file").setInputFiles(full.path);
  await expect(page.locator("#status")).toContainText("Imported 4 workspaces");
  expect(await worker.evaluate((tabId) => chrome.tabs.get(tabId).then((tab) => ({ url: tab.url || tab.pendingUrl, pinned: tab.pinned, windowId: tab.windowId })), live.id)).toEqual({ url: `${site}/live-reading`, pinned: true, windowId: reading });
  const restore = await downloadBackup(page, "#export-previous-backup");
  expect(restore.backup.state.workspaces.find((w) => w.id === "read-later").tabs.map((tab) => tab.url)).toContain(`${site}/live-reading`);
  await send("focusWindowWorkspace", { workspaceId: "personal" });
  const resumed = (await send("snapshot")).workspaces.find((w) => w.id === "personal").windowId;
  expect(await worker.evaluate((windowId) => chrome.tabs.query({ windowId }).then((tabs) => tabs.map((tab) => [tab.url || tab.pendingUrl, tab.pinned])), resumed)).toEqual([
    [urls[0], true], [urls[1], false], [urls[2], false],
  ]);
});
