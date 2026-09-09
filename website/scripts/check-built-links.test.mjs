import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBuiltLinks, runCheck } from "./check-built-links.mjs";

const script = fileURLToPath(new URL("./check-built-links.mjs", import.meta.url));
const temps = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "tubeless-built-links-"));
  temps.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return dir;
}

function page(links) {
  const anchors = links.map((href) => `<a href="${href}">link</a>`).join("");
  return `<!doctype html><html><body>${anchors}</body></html>`;
}

describe("checkBuiltLinks", () => {
  it("accepts local pages, directory indexes, and file assets", () => {
    const dir = fixture({
      "index.html": page(["/tubeless/docs", "/tubeless/llms.txt", "/tubeless/api-report.json"]),
      "docs/index.html": page(["/tubeless/docs/concepts"]),
      "docs/concepts/index.html": page(["/tubeless"]),
      "llms.txt": "map",
      "api-report.json": "{}",
    });

    assert.deepEqual(checkBuiltLinks(dir), { ok: true, errors: [] });
  });

  it("resolves base-prefixed paths and relative links from a leaf page", () => {
    const dir = fixture({
      "docs/concepts/index.html": page([
        "/tubeless/docs/child-pipeline-composition",
        "remote-step-composition",
        "../start",
      ]),
      "docs/child-pipeline-composition/index.html": page([]),
      "docs/remote-step-composition/index.html": page([]),
      "start/index.html": page([]),
    });

    assert.equal(checkBuiltLinks(dir).ok, true);
  });

  it("treats name.html and directory indexes as the same route", () => {
    const dir = fixture({
      "index.html": page(["/tubeless/alt", "/tubeless/dir"]),
      "alt.html": page([]),
      "dir/index.html": page([]),
    });

    assert.equal(checkBuiltLinks(dir).ok, true);
  });

  it("strips query strings and fragments before looking up files", () => {
    const dir = fixture({
      "docs/concepts/index.html": page([
        "/tubeless/docs/studio?from=nav",
        "/tubeless/docs/studio#local-event-store-and-studio",
        "#remote-steps",
      ]),
      "docs/studio/index.html": page([]),
    });

    assert.equal(checkBuiltLinks(dir).ok, true);
  });

  it("ignores external, mailto, and tel links", () => {
    const dir = fixture({
      "index.html": page([
        "https://github.com/chetmancini/tubeless",
        "http://example.test/missing",
        "mailto:docs@example.test",
        "tel:+15555550100",
        "//cdn.example.test/x",
      ]),
    });

    assert.equal(checkBuiltLinks(dir).ok, true);
  });

  it("fails a missing local route with the source page and target", () => {
    const dir = fixture({
      "docs/concepts/index.html": page(["/tubeless/docs/missing-route"]),
    });

    const result = checkBuiltLinks(dir);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].source, "/tubeless/docs/concepts");
    assert.equal(result.errors[0].target, "/tubeless/docs/missing-route");
    assert.match(result.errors[0].message, /\/tubeless\/docs\/concepts/);
    assert.match(result.errors[0].message, /\/tubeless\/docs\/missing-route/);
  });

  it("fails a remote-step-shaped missing route clearly", () => {
    const dir = fixture({
      "docs/concepts/index.html":
        '<p>See <a href="/tubeless/docs/remote-step-composition">remote-step composition</a>.</p>',
    });

    const lines = [];
    const code = runCheck(dir, (line) => lines.push(line));
    assert.equal(code, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\/tubeless\/docs\/concepts/);
    assert.match(lines[0], /\/tubeless\/docs\/remote-step-composition/);
  });

  it("does not interpret destinations outside the output root", () => {
    const dir = fixture({
      "docs/concepts/index.html": page(["../../../../../../etc/passwd", "/secret"]),
    });
    writeFileSync(join(dir, "..", "escape.html"), "no");

    const result = checkBuiltLinks(dir);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.every((error) => error.source === "/tubeless/docs/concepts"));
  });
});

describe("check-built-links CLI", () => {
  it("exits nonzero for a missing remote-step-shaped route", () => {
    const dir = fixture({
      "docs/concepts/index.html":
        '<p>See <a href="/tubeless/docs/remote-step-composition">remote-step composition</a>.</p>',
    });

    const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\/tubeless\/docs\/concepts/);
    assert.match(result.stderr, /\/tubeless\/docs\/remote-step-composition/);
  });
});
