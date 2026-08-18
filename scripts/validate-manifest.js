import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, "module");
assert.ok(manifest.permissions.includes("tabs"));
assert.ok(manifest.permissions.includes("tabGroups"));

const paths = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
];
for (const path of paths) {
  await access(new URL(`../${path}`, import.meta.url));
}

console.log(`Manifest ${manifest.version} is internally consistent.`);
