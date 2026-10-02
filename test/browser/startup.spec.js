import { readFile } from "node:fs/promises";
import { test, expect } from "./extension.fixture.js";

test.use({ stallStartup: true });

test("Settings keeps backup downloads available during startup and enables edits after reconnection", async ({ extension }) => {
  const { page, worker, send } = extension;
  await expect(page.locator("#connection")).toContainText("Reconnecting");
  await expect(page.locator("#save-workspaces")).toBeDisabled();
  await expect(page.locator("#import-backup")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add route", exact: true })).toBeDisabled();
  await expect(page.locator("#export-backup")).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await page.locator("#export-backup").click();
  const backup = JSON.parse(await readFile(await (await downloading).path(), "utf8"));
  expect(backup.format).toBe("rauiri-window-workspaces");
  expect(backup.snapshot.fresh).toBe(false);
  expect(backup.state.workspaces.map((w) => w.id)).toEqual(["personal", "work", "groundtruth", "read-later"]);
  await expect(page.locator("#status")).toContainText("saved state");
  await expect(page.locator("#export-backup")).toBeEnabled();
  await worker.evaluate(() => globalThis.releaseStartup());
  await expect.poll(async () => (await send("snapshot")).browserReady).toBe(true);
  await expect(page.locator("#save-workspaces")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add route", exact: true })).toBeEnabled();
  await expect(page.locator(".workspace-title:disabled")).toHaveValue("Read Later");
});
