import test from "node:test";
import assert from "node:assert/strict";
import { cleanHostnameInput, isValidRouteHostname, isRoutableUrl, routeForUrl } from "../src/domain.js";

test("hostname matching leaves sibling subdomains separate", () => {
  const routes = [{ id: "one", hostname: "app.example.com", contextId: "work" }];
  assert.equal(routeForUrl(routes, "https://app.example.com/jobs")?.contextId, "work");
  assert.equal(routeForUrl(routes, "https://other.example.com/jobs"), null);
});

test("hostname routes match the apex and all subdomains, but not lookalikes", () => {
  const routes = [{ id: "domain", hostname: "haume.nz", contextId: "work" }];
  assert.equal(cleanHostnameInput("HTTPS://Haume.NZ./path"), "haume.nz");
  assert.equal(isValidRouteHostname("haume.nz"), true);
  for (const invalid of ["*.haume.nz", "https://%2a.haume.nz", "not a hostname", "haume..nz"]) {
    assert.equal(isValidRouteHostname(invalid), false);
  }
  for (const host of ["haume.nz", "www.haume.nz", "app.haume.nz", "deep.app.haume.nz"]) {
    assert.equal(routeForUrl(routes, `https://${host}/page`)?.id, "domain");
  }
  assert.equal(routeForUrl(routes, "https://nothaume.nz"), null);
  assert.equal(routeForUrl(routes, "https://haume.nz.attacker.example"), null);
});

test("the most specific hostname wins regardless of rule order", () => {
  const routes = [
    { id: "broad", hostname: "haume.nz", contextId: "work" },
    { id: "specific", hostname: "musi.haume.nz", contextId: "personal" },
    { id: "www", hostname: "www.haume.nz", contextId: "groundtruth" },
  ];
  for (const ordered of [routes, [...routes].reverse()]) {
    assert.equal(routeForUrl(ordered, "https://musi.haume.nz")?.id, "specific");
    assert.equal(routeForUrl(ordered, "https://deep.musi.haume.nz")?.id, "specific");
    assert.equal(routeForUrl(ordered, "https://www.haume.nz")?.id, "www");
    assert.equal(routeForUrl(ordered, "https://elsewhere.haume.nz")?.id, "broad");
  }
});

test("internal and non-web URLs cannot be saved or automatically routed", () => {
  const routes = [{ id: "one", hostname: "example.com", contextId: "work" }];
  for (const url of ["chrome://example.com/", "file:///tmp/example.com", "javascript:alert(1)", "", null]) {
    assert.equal(isRoutableUrl(url), false);
    assert.equal(routeForUrl(routes, url), null);
  }
});
