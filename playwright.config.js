import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
