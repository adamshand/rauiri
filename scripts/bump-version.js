import fs from "node:fs";

const paths = ["manifest.json", "package.json"];
const files = paths.map((path) => ({ path, value: JSON.parse(fs.readFileSync(path, "utf8")) }));
const versions = new Set(files.map(({ value }) => value.version));
if (versions.size !== 1) throw new Error("manifest.json and package.json versions do not match.");

const [major, minor, patch] = files[0].value.version.split(".").map(Number);
if (![major, minor, patch].every(Number.isInteger)) throw new Error("Expected a semantic x.y.z version.");

const nextVersion = `${major}.${minor}.${patch + 1}`;
for (const { path, value } of files) {
  value.version = nextVersion;
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
console.log(`Bumped Rauiri to ${nextVersion}`);
