import { test, expect } from "./extension.fixture.js";

test("Settings reconciles added/deleted workspaces while keeping unsaved drafts across unrelated actions", async ({ extension }) => {
  const { page, send } = extension;
  const personal = await row(page, "Personal");
  await personal.locator(".workspace-title").fill("Unsaved personal");
  await personal.locator(".workspace-color").selectOption("cyan");
  await send("createWindowWorkspace", { title: "Temporary client" });
  const created = (await send("snapshot")).workspaces.find((w) => w.title === "Temporary client");
  await page.locator("#route-host").fill("example.test");
  await page.locator("#move-existing").uncheck();
  await page.getByRole("button", { name: "Add route", exact: true }).click();
  await expect(page.locator(".route-row")).toHaveCount(1);
  await row(page, "Temporary client");
  await row(page, "Unsaved personal");
  await send("deleteWindowWorkspace", { workspaceId: created.id, destinationId: "read-later", tabs: "move", rules: "move" });
  await page.locator(".route-row .remove").click();
  await expect(page.locator(".route-row")).toHaveCount(0);
  const names = await page.locator(".workspace-title").evaluateAll((nodes) => nodes.map((node) => node.value));
  expect(names).toContain("Unsaved personal");
  await expect((await row(page, "Unsaved personal")).locator(".workspace-color")).toHaveValue("cyan");
  expect(names).not.toContain("Temporary client");
  expect(await page.locator("body").textContent()).not.toContain("undefined");
  expect((await send("snapshot")).routes).toEqual([]);
});

test("a failed save keeps the draft, unlocks retry controls, and never unlocks Read Later's fixed name", async ({ extension }) => {
  const { page, worker, send } = extension;
  await (await row(page, "Personal")).locator(".workspace-title").fill("Retry personal");
  await worker.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    globalThis.restoreWrites = () => { chrome.storage.local.set = set; };
    chrome.storage.local.set = async () => { throw new Error("Injected storage failure"); };
  });
  await page.getByRole("button", { name: "Save workspaces", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Injected storage failure");
  await expect(page.getByRole("button", { name: "Save workspaces", exact: true })).toBeEnabled();
  await row(page, "Retry personal");
  await expect((await row(page, "Read Later")).locator(".workspace-title")).toBeDisabled();
  expect((await send("snapshot")).workspaces.find((w) => w.id === "personal").title).toBe("Personal");
  await worker.evaluate(() => globalThis.restoreWrites());
  await page.getByRole("button", { name: "Save workspaces", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Saved");
  expect((await send("snapshot")).workspaces.find((w) => w.id === "personal").title).toBe("Retry personal");
});

async function row(page, title) {
  const rows = page.locator(".workspace-row");
  await expect.poll(() => rows.evaluateAll((nodes) => nodes.map((node) => node.querySelector(".workspace-title").value))).toContain(title);
  const index = await rows.evaluateAll((nodes, name) => nodes.findIndex((node) => node.querySelector(".workspace-title").value === name), title);
  return rows.nth(index);
}

test("Settings saves names and colours and keeps Read Later's name protected after refresh", async ({ extension }) => {
  const { page, send } = extension;
  await page.locator(".put-away-workspaces summary").click();
  const work = await row(page, "Work");
  await work.locator(".workspace-title").fill("Client work");
  await work.locator(".workspace-color").selectOption("purple");
  await page.getByRole("button", { name: "Save workspaces", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Saved");
  await page.reload();
  await expect((await row(page, "Client work")).locator(".workspace-color")).toHaveValue("purple");
  await expect((await row(page, "Read Later")).locator(".workspace-title")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save workspaces", exact: true })).toBeEnabled();
  expect((await send("snapshot")).workspaces.find((w) => w.id === "work").title).toBe("Client work");
});
