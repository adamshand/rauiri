import { test, expect } from "./extension.fixture.js";

test("Chrome drag events and a real worker restart preserve only the manually filed duplicate", async ({ extension, site }) => {
  const { context, page, worker, send } = extension;
  await send("focusWindowWorkspace", { workspaceId: "work" });
  const view = await send("snapshot");
  const personal = view.workspaces.find((w) => w.id === "personal").windowId;
  const work = view.workspaces.find((w) => w.id === "work").windowId;
  const url = `${site}/duplicate`;
  const [manual, ordinary] = await worker.evaluate(async ({ personal, work, url }) => [
    await chrome.tabs.create({ windowId: personal, url, active: false }),
    await chrome.tabs.create({ windowId: work, url, active: false }),
  ], { personal, work, url });
  await expect.poll(() => worker.evaluate(async (ids) => (await Promise.all(ids.map((id) => chrome.tabs.get(id)))).every((tab) => tab.status === "complete"), [manual.id, ordinary.id])).toBe(true);
  await send("addRoute", { hostname: "127.0.0.1", contextId: "personal" });
  await worker.evaluate(({ id, windowId }) => chrome.tabs.move(id, { windowId, index: -1 }), { id: manual.id, windowId: work });
  await expect.poll(async () => (await send("exportBackup")).state.workspaces.find((w) => w.id === "work").tabs.filter((tab) => tab.url === url).map((tab) => tab.routeOverride)).toEqual([false, true]);

  // Stop the actual MV3 worker, not a second controller in the same process.
  const cdp = await context.newCDPSession(page);
  const versions = [];
  cdp.on("ServiceWorker.workerVersionUpdated", (event) => versions.push(...event.versions));
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => versions.find((version) => version.scriptURL === worker.url() && version.runningStatus === "running")?.versionId).toBeTruthy();
  const version = versions.find((item) => item.scriptURL === worker.url() && item.runningStatus === "running");
  await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
  expect((await send("snapshot")).connecting).toBe(true);
  await expect.poll(async () => (await send("snapshot")).browserReady).toBe(true);
  // Chromium reuses the service-worker target; Playwright updates its execution
  // context rather than emitting a second Worker object.
  await worker.evaluate(async (ids) => { for (const id of ids) await chrome.tabs.reload(id); }, [manual.id, ordinary.id]);
  await expect.poll(() => worker.evaluate(async (ids) => (await Promise.all(ids.map((id) => chrome.tabs.get(id)))).map((tab) => tab.windowId), [manual.id, ordinary.id])).toEqual([work, personal]);
  await cdp.detach();
});
