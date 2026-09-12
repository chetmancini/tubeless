import assert from "node:assert/strict";
import { test } from "node:test";
import { endpointFiles, responseProblems } from "./check-public-endpoints.mjs";

test("inventory covers every page and machine file, excluding assets and the 404 file", () => {
  assert.deepEqual(endpointFiles(["index.html", "docs/a/index.html", "docs/a.md", "llms.txt", "api-report.json", "sitemap.xml", "404.md", "404.html", "logo.svg"]), [
    { file: "index.html", path: "" }, { file: "docs/a/index.html", path: "docs/a" },
    { file: "docs/a.md", path: "docs/a.md" }, { file: "llms.txt", path: "llms.txt" },
    { file: "api-report.json", path: "api-report.json" }, { file: "sitemap.xml", path: "sitemap.xml" },
    { file: "404.md", path: "404.md" },
  ]);
});

test("negotiation requires Markdown and a case-insensitive Accept Vary token", () => {
  const response = { status: 200, type: "text/markdown; charset=utf-8", vary: "Accept-Encoding, ACCEPT", body: "# Content" };
  assert.deepEqual(responseProblems(response, { markdown: true }), []);
  assert.equal(responseProblems({ ...response, type: "text/html", vary: "Accept-Encoding" }, { markdown: true }).length, 2);
});

test("detects soft 404s, missing recovery links, and stale deployed content", () => {
  const response = { status: 404, type: "text/html", vary: "", body: "llms.txt sitemap.xml" };
  assert.deepEqual(responseProblems(response, { file: "404.html", missing: true }), []);
  assert.equal(responseProblems({ ...response, status: 200, body: "app shell" }, { file: "404.html", missing: true }).length, 2);
  assert.deepEqual(responseProblems({ ...response, status: 200 }, { file: "index.html", expected: "new build" }), ["Body differs from current build"]);
});
