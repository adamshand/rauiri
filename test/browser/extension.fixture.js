import { test as base, expect, chromium } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));

export const test = base.extend({
  stallStartup: [false, { option: true }],
  site: async ({}, use) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Test page</title><p>Local browser test page</p>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try { await use(`http://127.0.0.1:${server.address().port}`); }
    finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
  extension: async ({ stallStartup }, use) => {
    const temporary = await mkdtemp(join(tmpdir(), "rauiri-browser-test-"));
    const path = join(temporary, "extension");
    let context;
    try {
      for (const entry of ["manifest.json", "src", "popup", "options", "assets"]) {
        await cp(join(project, entry), join(path, entry), { recursive: true });
      }
      if (stallStartup) {
        // Fault injection at the Chrome API boundary; real UI, controller and
        // message dispatch remain untouched. Releasing the gate reconnects normally.
        const background = join(path, "src/background.js");
        const source = await readFile(background, "utf8");
        await writeFile(background, `
const originalGetAll = chrome.windows.getAll.bind(chrome.windows);
const startupGate = new Promise((resolve) => { globalThis.releaseStartup = resolve; });
chrome.windows.getAll = async (...args) => { await startupGate; return originalGetAll(...args); };
${source}`);
      }
      context = await chromium.launchPersistentContext(join(temporary, "profile"), {
        channel: "chromium", headless: true, acceptDownloads: true,
        args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
      });
      const errors = [];
      context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const id = new URL(worker.url()).host;
      const page = await context.newPage();
      const open = async (file = "options/options.html") => {
        await page.goto(`chrome-extension://${id}/${file}`);
        return page;
      };
      const send = async (type, payload = {}) => {
        const response = await page.evaluate((message) => chrome.runtime.sendMessage(message), { type, ...payload });
        if (!response?.ok) throw new Error(response?.error || "Rauiri did not respond.");
        return response.result;
      };
      await open();
      if (!stallStartup) {
        await expect.poll(async () => (await send("snapshot")).browserReady).toBe(true);
        // Chrome can report no focused window during its own launch animation.
        // Establish the user-facing baseline through a normal workspace command.
        await send("focusWindowWorkspace", { workspaceId: "personal" });
        await page.reload();
        await expect(page.locator("#save-workspaces")).toBeEnabled();
      }
      await use({ context, page, worker, open, send });
      expect(errors, "Uncaught errors in extension pages").toEqual([]);
    } finally {
      try { await context?.close(); }
      finally { await rm(temporary, { recursive: true, force: true }); }
    }
  },
});

export { expect };
